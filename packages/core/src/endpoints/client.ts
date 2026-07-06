import { randomUUID } from "node:crypto";
import { USER_AGENT } from "../version.js";

/** One HTTP exchange, recorded for the run artifact. Token is never stored. */
export interface Exchange {
  scenario: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  contentType: string | null;
  idempotencyKeySent?: string;
  responseHeaders: Record<string, string>;
  /** Parsed JSON body, or null when the body was not JSON. Capped for artifacts. */
  body: unknown;
  bodyText?: string;
  networkError?: string;
}

export interface AcpClientOptions {
  baseUrl: string;
  authToken?: string;
  apiVersion: string;
  timeoutMs?: number;
}

const RECORDED_HEADERS = ["content-type", "idempotency-key", "idempotent-replayed", "request-id", "retry-after"];
const BODY_TEXT_CAP = 2048;

export interface RequestOptions {
  scenario: string;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  /** Raw body override (for malformed-JSON probes). */
  rawBody?: string;
  idempotencyKey?: string | null; // null = deliberately omit
  auth?: "bearer" | "none" | "invalid";
  headers?: Record<string, string>;
}

/**
 * Simulated-agent HTTP client for the Agentic Checkout API.
 * Sends the spec-required headers on every request; never logs or stores the
 * auth token.
 */
export class AcpClient {
  readonly exchanges: Exchange[] = [];
  readonly baseUrl: string;
  private readonly getAuthHeader: () => string | undefined;
  private readonly apiVersion: string;
  private readonly timeoutMs: number;

  constructor(opts: AcpClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    const token = opts.authToken; // held in closure; not a property → won't serialize
    this.getAuthHeader = () => (token ? `Bearer ${token}` : undefined);
    this.apiVersion = opts.apiVersion;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  newIdempotencyKey(): string {
    return randomUUID();
  }

  async request(opts: RequestOptions): Promise<Exchange> {
    const url = `${this.baseUrl}${opts.path}`;
    const headers: Record<string, string> = {
      "user-agent": USER_AGENT,
      accept: "application/json",
      "api-version": this.apiVersion,
      "accept-language": "en-US",
      "request-id": `acpcheck_${randomUUID()}`,
      ...opts.headers,
    };
    const auth = opts.auth ?? "bearer";
    if (auth === "bearer") {
      const h = this.getAuthHeader();
      if (h) headers.authorization = h;
    } else if (auth === "invalid") {
      headers.authorization = "Bearer acp-check-invalid-token-for-auth-probe";
    }
    let body: string | undefined;
    if (opts.method === "POST") {
      headers["content-type"] = "application/json";
      body = opts.rawBody ?? JSON.stringify(opts.body ?? {});
      if (opts.idempotencyKey !== null) {
        headers["idempotency-key"] = opts.idempotencyKey ?? this.newIdempotencyKey();
      }
    }

    const started = Date.now();
    const exchange: Exchange = {
      scenario: opts.scenario,
      method: opts.method,
      path: opts.path,
      status: 0,
      durationMs: 0,
      contentType: null,
      responseHeaders: {},
      body: null,
    };
    if (headers["idempotency-key"]) exchange.idempotencyKeySent = headers["idempotency-key"];

    try {
      const res = await fetch(url, {
        method: opts.method,
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      exchange.status = res.status;
      exchange.contentType = res.headers.get("content-type");
      for (const h of RECORDED_HEADERS) {
        const v = res.headers.get(h);
        if (v !== null) exchange.responseHeaders[h] = v;
      }
      const text = await res.text();
      exchange.bodyText = text.slice(0, BODY_TEXT_CAP);
      try {
        exchange.body = text ? JSON.parse(text) : null;
      } catch {
        exchange.body = null;
      }
    } catch (err) {
      exchange.networkError = err instanceof Error ? err.message : String(err);
    }
    exchange.durationMs = Date.now() - started;
    this.exchanges.push(exchange);
    return exchange;
  }
}

/** True when the URL looks like a local/test target (no production banner needed). */
export function looksLikeTestTarget(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl);
    const host = u.hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host.endsWith(".local") ||
      host.endsWith(".test") ||
      host.endsWith(".localhost") ||
      /(^|[.-])(test|sandbox|staging|dev)([.-]|$)/.test(host)
    );
  } catch {
    return false;
  }
}
