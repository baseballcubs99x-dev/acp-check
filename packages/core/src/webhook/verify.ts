import { createHmac, timingSafeEqual } from "node:crypto";
import type { Finding } from "../findings.js";
import { specUrl } from "../findings.js";
import { schemaCheck, specMeta } from "../schemas/validator.js";

const WEBHOOK_SPEC = "spec/2026-04-17/openapi/openapi.agentic_checkout_webhook.yaml";
/** "Recommended timestamp tolerance is 300 seconds." */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export interface SignatureParts {
  timestamp: number;
  v1: string;
}

const SIGNATURE_PATTERN = /^t=(\d+),v1=([a-fA-F0-9]{64})$/;

/** Parses `Merchant-Signature: t=<unix_seconds>,v1=<64_hex>`. Returns null if malformed. */
export function parseSignature(header: string): SignatureParts | null {
  const m = SIGNATURE_PATTERN.exec(header.trim());
  if (!m) return null;
  return { timestamp: Number(m[1]), v1: m[2]!.toLowerCase() };
}

/** HMAC-SHA256(timestamp + "." + raw_body, secret), per the webhook OpenAPI description. */
export function computeSignature(secret: string, timestamp: number, rawBody: string | Buffer): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(`${timestamp}.`);
  hmac.update(rawBody);
  return hmac.digest("hex");
}

export function signaturesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export interface VerifyOptions {
  toleranceSeconds?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface VerifyResult {
  valid: boolean;
  findings: Finding[];
  parts?: SignatureParts;
}

function specRef(quote: string) {
  return {
    section: "Agentic Checkout Webhooks — Merchant-Signature",
    quote,
    url: specUrl(specMeta.upstreamCommit, WEBHOOK_SPEC),
  };
}

/**
 * Verifies a webhook signature the way the OpenAI receiver will: format,
 * timestamp window, then constant-time HMAC comparison.
 */
export function verifySignature(
  secret: string,
  rawBody: string | Buffer,
  signatureHeader: string | undefined,
  opts: VerifyOptions = {}
): VerifyResult {
  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const now = opts.now ?? (() => Date.now());
  const findings: Finding[] = [];

  if (!signatureHeader) {
    findings.push({
      id: "webhook.signature.missing",
      layer: "conformance",
      severity: "fail",
      path: "Merchant-Signature",
      message: "Merchant-Signature header is missing. The receiver rejects unsigned webhook deliveries with 401.",
      fix: "Sign every delivery: Merchant-Signature: t=<unix_seconds>,v1=HMAC_SHA256(`${t}.${rawBody}`, secret) hex.",
      spec: specRef("Requests MUST be signed with an HMAC signature in the `Merchant-Signature` header."),
    });
    return { valid: false, findings };
  }

  const parts = parseSignature(signatureHeader);
  if (!parts) {
    findings.push({
      id: "webhook.signature.malformed",
      layer: "conformance",
      severity: "fail",
      path: "Merchant-Signature",
      message: `Merchant-Signature is malformed (got "${signatureHeader.slice(0, 64)}"). Expected exactly t=<unix_seconds>,v1=<64 hex chars>.`,
      fix: "Format the header as t=1709123456,v1=<lowercase hex sha256>. No spaces, no extra fields.",
      spec: specRef('pattern: "^t=\\\\d+,v1=[a-fA-F0-9]{64}$"'),
    });
    return { valid: false, findings };
  }

  const ageSeconds = Math.abs(now() / 1000 - parts.timestamp);
  if (ageSeconds > tolerance) {
    findings.push({
      id: "webhook.signature.timestamp-window",
      layer: "conformance",
      severity: "fail",
      path: "Merchant-Signature",
      message: `Signature timestamp is ${Math.round(ageSeconds)}s from now (tolerance ${tolerance}s); the receiver treats this as a replay and rejects with 401.`,
      fix: "Use the current unix time when signing and send immediately; check server clock skew (NTP).",
      spec: specRef("Recommended timestamp tolerance is 300 seconds."),
      detail: { timestamp: parts.timestamp, toleranceSeconds: tolerance },
    });
    return { valid: false, findings, parts };
  }

  const expected = computeSignature(secret, parts.timestamp, rawBody);
  if (!signaturesEqual(expected, parts.v1)) {
    findings.push({
      id: "webhook.signature.mismatch",
      layer: "conformance",
      severity: "fail",
      path: "Merchant-Signature",
      message: "HMAC verification failed: v1 does not match HMAC-SHA256(timestamp + \".\" + raw_body, secret).",
      fix: "Sign the RAW request body bytes (before any JSON re-serialization), concatenated as `${timestamp}.${rawBody}`, with the shared secret. Verify you are using the right secret for this environment.",
      spec: specRef('Signed payload is `timestamp + "." + raw_body`; HMAC-SHA256.'),
    });
    return { valid: false, findings, parts };
  }

  return { valid: true, findings, parts };
}

/** Validates a webhook event body against the pinned WebhookEvent schema. */
export function validateWebhookPayload(payload: unknown): Finding[] {
  const findings = schemaCheck("webhook", "WebhookEvent", payload, {
    pathPrefix: "$",
    idPrefix: "webhook",
  });
  const type = (payload as { type?: string })?.type;
  if (type && !["order_create", "order_update"].includes(type)) {
    findings.push({
      id: "webhook.event.unknown-type",
      layer: "quality",
      severity: "warn",
      path: "$.type",
      message: `Event type "${type}" is not a defined value (order_create, order_update). Receivers must accept it gracefully, but it likely will not be processed.`,
      fix: "Use order_create for new orders and order_update for changes.",
      spec: {
        section: "Webhooks — WebhookEvent.type",
        quote: "Defined values: 'order_create', 'order_update'.",
        url: specUrl(specMeta.upstreamCommit, WEBHOOK_SPEC),
      },
    });
  }
  return findings;
}
