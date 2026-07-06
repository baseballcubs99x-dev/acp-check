import { describe, it, expect } from "vitest";
import { schemaCheck, specMeta } from "../src/index.js";

describe("schema provenance", () => {
  it("pins the spec snapshot metadata", () => {
    expect(specMeta.specRelease).toBe("2026-04-17");
    expect(specMeta.upstreamCommit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(specMeta.upstreamRepo).toContain("agentic-commerce-protocol");
  });
});

describe("checkout schema validates the spec's own composed shapes", () => {
  it("accepts a minimal valid CheckoutSession", () => {
    const session = {
      id: "cs_1",
      status: "ready_for_payment",
      currency: "usd",
      line_items: [],
      totals: [{ type: "total", display_text: "Total", amount: 100 }],
      fulfillment_options: [],
      messages: [],
      links: [],
      capabilities: {},
    };
    expect(schemaCheck("checkout", "CheckoutSession", session)).toHaveLength(0);
  });

  it("accepts CheckoutSessionWithOrder including the order field (allOf flattening)", () => {
    const withOrder = {
      id: "cs_1",
      status: "completed",
      currency: "usd",
      line_items: [],
      totals: [{ type: "total", display_text: "Total", amount: 100 }],
      fulfillment_options: [],
      messages: [],
      links: [],
      capabilities: {},
      order: { id: "ord_1", checkout_session_id: "cs_1", permalink_url: "https://x.com/o/1" },
    };
    const findings = schemaCheck("checkout", "CheckoutSessionWithOrder", withOrder);
    expect(findings, JSON.stringify(findings)).toHaveLength(0);
  });

  it("rejects an invalid status enum", () => {
    const bad = {
      id: "cs_1",
      status: "bogus",
      currency: "usd",
      line_items: [],
      totals: [],
      fulfillment_options: [],
      messages: [],
      links: [],
      capabilities: {},
    };
    const findings = schemaCheck("checkout", "CheckoutSession", bad);
    expect(findings.some((f) => f.id.includes("enum"))).toBe(true);
  });

  it("produces an actionable fix hint for decimal prices in feeds", () => {
    const product = { id: "p", title: "P", variants: [{ id: "v", title: "V", price: { amount: 19.99, currency: "USD" } }] };
    const findings = schemaCheck("feed", "Product", product);
    const priceFinding = findings.find((f) => f.path.includes("price"));
    expect(priceFinding?.fix).toMatch(/minor units/i);
  });
});
