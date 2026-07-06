import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startMockMerchant, type MockMerchant, type BrokenScenario } from "@acp-check/mock-merchant";
import { runEndpoints, TEST_PAYMENT_TOKEN } from "../src/index.js";

const TOKEN = "test_merchant_token";

async function probe(broken: BrokenScenario[] = [], opts: Record<string, unknown> = {}) {
  const merchant = await startMockMerchant({ port: 0, authToken: TOKEN, broken });
  try {
    const summary = await runEndpoints({
      baseUrl: merchant.url,
      authToken: TOKEN,
      itemId: "item_123",
      outOfStockItemId: "item_oos",
      allowComplete: true,
      ...opts,
    });
    return { summary, merchant };
  } finally {
    await merchant.close();
  }
}

const failIds = (findings: { id: string; severity: string }[]) =>
  new Set(findings.filter((f) => f.severity === "fail").map((f) => f.id));
const anyIds = (findings: { id: string }[]) => new Set(findings.map((f) => f.id));

describe("endpoints — clean merchant", () => {
  let merchant: MockMerchant;
  beforeAll(async () => {
    merchant = await startMockMerchant({ port: 0, authToken: TOKEN });
  });
  afterAll(async () => merchant.close());

  it("passes every scenario group against a clean merchant", async () => {
    const summary = await runEndpoints({
      baseUrl: merchant.url,
      authToken: TOKEN,
      itemId: "item_123",
      outOfStockItemId: "item_oos",
      allowComplete: true,
    });
    expect(summary.counts.fail, JSON.stringify([...failIds(summary.findings)])).toBe(0);
    expect(summary.stats.scenarios).toEqual(
      expect.arrayContaining(["happy-path", "idempotency", "error-handling", "response-contract", "security"])
    );
  });

  it("dry-run mode does not send the complete request", async () => {
    const summary = await runEndpoints({ baseUrl: merchant.url, authToken: TOKEN, itemId: "item_123" });
    expect(anyIds(summary.findings)).toContain("endpoints.complete.dry-run");
    expect(summary.counts.fail).toBe(0);
  });
});

// One targeted assertion per broken mode: the intended finding must appear.
const MATRIX: Array<[BrokenScenario, string, "fail" | "warn"]> = [
  ["double-create", "endpoints.idempotency.double-create", "fail"],
  ["double-order", "endpoints.idempotency.double-order", "fail"],
  ["no-idempotency-required", "endpoints.idempotency.missing-key-accepted", "warn"],
  ["no-idempotency-conflict", "endpoints.idempotency.conflict", "warn"],
  ["missing-total", "endpoints.state.total-missing", "fail"],
  ["empty-line-items", "endpoints.state.line-items-empty", "fail"],
  ["wrong-create-status", "endpoints.create.status-200", "fail"],
  ["never-ready", "endpoints.state.not-ready", "warn"],
  ["no-fulfillment-options", "endpoints.state.fulfillment-options-empty", "warn"],
  ["sku-500", "endpoints.errors.invalid-sku-5xx", "fail"],
  ["sku-silent", "endpoints.errors.invalid-sku-silent", "fail"],
  ["malformed-json-500", "endpoints.errors.malformed-json", "fail"],
  ["bad-error-shape", "endpoints.errors.invalid-sku-shape", "fail"],
  ["no-auth", "endpoints.security.auth-not-required", "fail"],
  ["accept-any-token", "endpoints.security.token-not-validated", "fail"],
  ["unknown-session-200", "endpoints.errors.unknown-session", "fail"],
  ["cancel-no-405", "endpoints.cancel.repeat", "warn"],
  ["invalid-schema-session", "endpoints.schema.CheckoutSession.enum", "fail"],
];

describe("endpoints — targeted failures per broken mode", () => {
  for (const [mode, expectedId, severity] of MATRIX) {
    it(`--broken ${mode} raises ${expectedId} (${severity})`, async () => {
      const { summary } = await probe([mode]);
      const match = summary.findings.find((f) => f.id === expectedId);
      expect(match, `expected ${expectedId}; got ${JSON.stringify([...anyIds(summary.findings)])}`).toBeTruthy();
      expect(match?.severity).toBe(severity);
      if (severity === "fail") expect(summary.counts.fail).toBeGreaterThan(0);
    });
  }
});

describe("endpoints — html error pages fail the content-type contract", () => {
  it("flags non-JSON error bodies", async () => {
    const { summary } = await probe(["html-errors"]);
    const shapeOrType = [...failIds(summary.findings)].some(
      (id) => id.includes("shape") || id === "endpoints.content-type"
    );
    expect(shapeOrType).toBe(true);
  });
});

describe("endpoints — safety", () => {
  it("uses only a clearly-fake test payment token", () => {
    // The one and only token acp-check will ever send at /complete.
    expect(TEST_PAYMENT_TOKEN).toMatch(/test/);
    expect(TEST_PAYMENT_TOKEN).toContain("acpcheck");
    expect(TEST_PAYMENT_TOKEN).not.toMatch(/^spt_[0-9a-f]{8,}$/); // not a realistic Stripe token shape
  });

  it("does not leak the auth token into the summary", async () => {
    const merchant = await startMockMerchant({ port: 0, authToken: "super-secret-token-xyz" });
    const summary = await runEndpoints({ baseUrl: merchant.url, authToken: "super-secret-token-xyz", itemId: "item_123" });
    await merchant.close();
    expect(JSON.stringify(summary)).not.toContain("super-secret-token-xyz");
  });
});
