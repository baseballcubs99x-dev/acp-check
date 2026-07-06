import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  verifySignature,
  parseSignature,
  computeSignature,
  validateWebhookPayload,
  startReceiver,
  DEFAULT_TOLERANCE_SECONDS,
} from "../src/index.js";

const SECRET = "whsec_test_1234567890";
const NOW_MS = 1_780_000_000_000; // fixed clock
const nowSeconds = Math.floor(NOW_MS / 1000);

function sign(body: string, secret = SECRET, ts = nowSeconds): string {
  return `t=${ts},v1=${computeSignature(secret, ts, body)}`;
}

const validEvent = JSON.stringify({
  type: "order_update",
  data: { type: "order", id: "ord_1", checkout_session_id: "cs_1", permalink_url: "https://x.com/o/1", status: "shipped" },
});

describe("webhook signature parsing", () => {
  it("parses a well-formed signature", () => {
    const p = parseSignature(`t=123,v1=${"a".repeat(64)}`);
    expect(p).toEqual({ timestamp: 123, v1: "a".repeat(64) });
  });
  it("rejects malformed signatures", () => {
    expect(parseSignature("garbage")).toBeNull();
    expect(parseSignature(`t=abc,v1=${"a".repeat(64)}`)).toBeNull();
    expect(parseSignature("t=1,v1=tooshort")).toBeNull();
  });
});

describe("webhook signature verification", () => {
  const now = () => NOW_MS;

  it("accepts a valid signature", () => {
    const r = verifySignature(SECRET, validEvent, sign(validEvent), { now });
    expect(r.valid).toBe(true);
    expect(r.findings).toHaveLength(0);
  });

  it("rejects a wrong secret", () => {
    const badSig = `t=${nowSeconds},v1=${createHmac("sha256", "wrong").update(`${nowSeconds}.${validEvent}`).digest("hex")}`;
    const r = verifySignature(SECRET, validEvent, badSig, { now });
    expect(r.valid).toBe(false);
    expect(r.findings[0]!.id).toBe("webhook.signature.mismatch");
  });

  it("rejects a tampered body", () => {
    const r = verifySignature(SECRET, validEvent + " ", sign(validEvent), { now });
    expect(r.valid).toBe(false);
    expect(r.findings[0]!.id).toBe("webhook.signature.mismatch");
  });

  it("rejects a missing signature header", () => {
    const r = verifySignature(SECRET, validEvent, undefined, { now });
    expect(r.findings[0]!.id).toBe("webhook.signature.missing");
  });

  it("rejects a malformed signature header", () => {
    const r = verifySignature(SECRET, validEvent, "t=,v1=x", { now });
    expect(r.findings[0]!.id).toBe("webhook.signature.malformed");
  });

  it("rejects a stale timestamp outside the window", () => {
    const staleTs = nowSeconds - DEFAULT_TOLERANCE_SECONDS - 60;
    const r = verifySignature(SECRET, validEvent, sign(validEvent, SECRET, staleTs), { now });
    expect(r.valid).toBe(false);
    expect(r.findings[0]!.id).toBe("webhook.signature.timestamp-window");
  });

  it("accepts a signature within the tolerance window", () => {
    const ts = nowSeconds - 100;
    const r = verifySignature(SECRET, validEvent, sign(validEvent, SECRET, ts), { now });
    expect(r.valid).toBe(true);
  });
});

describe("webhook payload schema", () => {
  it("passes a valid order event", () => {
    expect(validateWebhookPayload(JSON.parse(validEvent))).toHaveLength(0);
  });
  it("flags a missing required field", () => {
    const bad = { type: "order_update", data: { type: "order", id: "x" } }; // missing checkout_session_id etc.
    const findings = validateWebhookPayload(bad);
    expect(findings.some((f) => f.severity === "fail")).toBe(true);
  });
  it("warns on unknown event type but does not fail", () => {
    const evt = { type: "order_frobnicated", data: JSON.parse(validEvent).data };
    const findings = validateWebhookPayload(evt);
    expect(findings.some((f) => f.id === "webhook.event.unknown-type" && f.severity === "warn")).toBe(true);
  });
});

describe("webhook receiver (integration)", () => {
  it("returns 200 for a valid signed delivery and 401 for a bad one", async () => {
    const receiver = await startReceiver({ port: 0, secret: SECRET });
    try {
      const good = await fetch(receiver.url, {
        method: "POST",
        headers: { "content-type": "application/json", "merchant-signature": sign(validEvent, SECRET, Math.floor(Date.now() / 1000)) },
        body: validEvent,
      });
      expect(good.status).toBe(200);
      expect((await good.json()).received).toBe(true);

      const bad = await fetch(receiver.url, {
        method: "POST",
        headers: { "content-type": "application/json", "merchant-signature": `t=1,v1=${"0".repeat(64)}` },
        body: validEvent,
      });
      expect(bad.status).toBe(401);

      expect(receiver.deliveries).toHaveLength(2);
      expect(receiver.summary().counts.fail).toBeGreaterThan(0);
    } finally {
      await receiver.close();
    }
  });
});
