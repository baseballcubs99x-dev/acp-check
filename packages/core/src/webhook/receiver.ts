import { createServer, type Server } from "node:http";
import type { Finding, RunSummary } from "../findings.js";
import { countFindings } from "../findings.js";
import { specMeta } from "../schemas/validator.js";
import { verifySignature, validateWebhookPayload } from "./verify.js";
import { VERSION } from "../version.js";

export interface CapturedDelivery {
  receivedAt: string;
  method: string;
  path: string;
  signatureValid: boolean;
  eventType?: string;
  findings: Finding[];
}

export interface ReceiverOptions {
  port?: number;
  host?: string;
  secret?: string;
  toleranceSeconds?: number;
  onDelivery?: (delivery: CapturedDelivery) => void;
}

export interface WebhookReceiver {
  url: string;
  port: number;
  deliveries: CapturedDelivery[];
  close(): Promise<void>;
  summary(): RunSummary;
  server: Server;
}

/**
 * Local webhook receiver. Captures POSTed order events, verifies the
 * Merchant-Signature (when a secret is provided), validates payload schema,
 * and responds the way the real receiver would (200 / 400 / 401).
 */
export async function startReceiver(opts: ReceiverOptions = {}): Promise<WebhookReceiver> {
  const { port = 0, host = "127.0.0.1", secret, toleranceSeconds, onDelivery } = opts;
  const deliveries: CapturedDelivery[] = [];
  const startedAt = new Date().toISOString();

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks);
      const findings: Finding[] = [];
      const requestId = req.headers["request-id"];

      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "application/json" }).end(
          JSON.stringify({ type: "invalid_request", code: "method_not_allowed", message: "POST only" })
        );
        return;
      }

      const contentType = req.headers["content-type"] ?? "";
      if (!contentType.includes("application/json")) {
        findings.push({
          id: "webhook.content-type",
          layer: "conformance",
          severity: "fail",
          path: "Content-Type",
          message: `Content-Type is "${contentType || "(missing)"}"; webhook deliveries must be application/json.`,
          fix: "Send Content-Type: application/json.",
        });
      }

      let signatureValid = false;
      if (secret) {
        const sig = verifySignature(secret, rawBody, req.headers["merchant-signature"] as string | undefined, {
          toleranceSeconds,
        });
        signatureValid = sig.valid;
        findings.push(...sig.findings);
      }

      let payload: unknown;
      let parseFailed = false;
      try {
        payload = JSON.parse(rawBody.toString("utf8"));
      } catch {
        parseFailed = true;
        findings.push({
          id: "webhook.body.invalid-json",
          layer: "conformance",
          severity: "fail",
          path: "$",
          message: "Webhook body is not valid JSON.",
          fix: "POST the WebhookEvent object as JSON.",
        });
      }
      if (!parseFailed) findings.push(...validateWebhookPayload(payload));

      const delivery: CapturedDelivery = {
        receivedAt: new Date().toISOString(),
        method: req.method ?? "POST",
        path: req.url ?? "/",
        signatureValid: secret ? signatureValid : true,
        eventType: (payload as { type?: string })?.type,
        findings,
      };
      deliveries.push(delivery);
      onDelivery?.(delivery);

      if (secret && !signatureValid) {
        res.writeHead(401, { "content-type": "application/json" }).end(
          JSON.stringify({
            type: "invalid_request",
            code: "invalid_signature",
            message: "Webhook signature verification failed.",
          })
        );
        return;
      }
      if (parseFailed) {
        res.writeHead(400, { "content-type": "application/json" }).end(
          JSON.stringify({ type: "invalid_request", code: "invalid_json", message: "Body is not valid JSON" })
        );
        return;
      }
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ received: true, ...(requestId ? { request_id: requestId } : {}) }));
    });
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolvePromise());
  });
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;

  return {
    url: `http://${host}:${boundPort}/agentic_checkout/webhooks/order_events`,
    port: boundPort,
    deliveries,
    server,
    close: () =>
      new Promise<void>((resolvePromise, reject) =>
        server.close((err) => (err ? reject(err) : resolvePromise()))
      ),
    summary(): RunSummary {
      const findings = deliveries.flatMap((d) => d.findings);
      return {
        command: "webhook",
        target: `local receiver :${boundPort}`,
        startedAt,
        finishedAt: new Date().toISOString(),
        toolVersion: VERSION,
        specRelease: specMeta.specRelease,
        specCommit: specMeta.upstreamCommit,
        counts: countFindings(findings),
        stats: {
          deliveries: deliveries.length,
          validSignatures: deliveries.filter((d) => d.signatureValid).length,
        },
        findings,
      };
    },
  };
}
