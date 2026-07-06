import { randomUUID } from "node:crypto";
import type { Finding, RunSummary } from "../findings.js";
import { countFindings, specUrl } from "../findings.js";
import { schemaCheck, specMeta } from "../schemas/validator.js";
import { AcpClient, looksLikeTestTarget, type Exchange } from "./client.js";
import { VERSION } from "../version.js";

const CHECKOUT_SPEC = "spec/2026-04-17/openapi/openapi.agentic_checkout.yaml";

/**
 * Clearly-fake payment token. acp-check has NO real-payment code path: this is
 * the only token it will ever send, and only when allowComplete is true.
 */
export const TEST_PAYMENT_TOKEN = "spt_acpcheck_test_do_not_charge";

export interface EndpointsOptions {
  baseUrl: string;
  authToken?: string;
  /** Item/variant id to check out (from the merchant's feed). */
  itemId: string;
  /** Optional known out-of-stock item id to probe the out_of_stock path. */
  outOfStockItemId?: string;
  currency?: string;
  quantity?: number;
  apiVersion?: string;
  /** Actually POST /complete with the test token. Default: dry-run (skipped). */
  allowComplete?: boolean;
  timeoutMs?: number;
  /** Skip the auth-required probe (for merchants who whitelist by IP instead). */
  skipAuthProbe?: boolean;
}

const TEST_ADDRESS = {
  name: "ACP Check",
  line_one: "548 Market St",
  line_two: "PMB 91234",
  city: "San Francisco",
  state: "CA",
  country: "US",
  postal_code: "94104",
};

const TEST_BUYER = {
  first_name: "ACP",
  last_name: "Check",
  email: "acp-check-test@example.com",
  phone_number: "15550100000",
};

interface Ctx {
  client: AcpClient;
  opts: Required<Pick<EndpointsOptions, "itemId" | "currency" | "quantity">> & EndpointsOptions;
  findings: Finding[];
  scenariosRun: string[];
}

function ref(section: string, quote: string) {
  return { section, quote, url: specUrl(specMeta.upstreamCommit, CHECKOUT_SPEC) };
}

function add(ctx: Ctx, f: Finding): void {
  ctx.findings.push(f);
}

function endpointPath(ex: Exchange): string {
  return `${ex.method} ${ex.path}`;
}

/** Response-contract checks applied to every exchange (scenario group 4). */
function contract(
  ctx: Ctx,
  ex: Exchange,
  expect: {
    status: number[];
    schema?: "CheckoutSession" | "CheckoutSessionWithOrder" | "Error";
    /** For POSTs: whether the Idempotency-Key echo header should be present. */
    idempotencyEcho?: boolean;
  }
): boolean {
  const where = endpointPath(ex);
  if (ex.networkError) {
    add(ctx, {
      id: "endpoints.network",
      layer: "conformance",
      severity: "fail",
      path: where,
      message: `Request failed before a response was received: ${ex.networkError}`,
      fix: "Check the base URL, TLS certificate, and that the endpoint is reachable from the public internet.",
    });
    return false;
  }
  let ok = true;
  if (!expect.status.includes(ex.status)) {
    add(ctx, {
      id: "endpoints.status",
      layer: "conformance",
      severity: "fail",
      path: where,
      message: `Expected HTTP ${expect.status.join(" or ")}, got ${ex.status}.${ex.status >= 500 ? " 5xx responses on client-triggerable paths fail conformance — return a structured 4xx Error instead." : ""}`,
      spec: ref("Agentic Checkout OpenAPI — responses", `Expected: ${expect.status.join("/")} for ${where}`),
      fix: "Match the status codes declared in openapi.agentic_checkout.yaml for this operation.",
      detail: { scenario: ex.scenario, status: ex.status, body: ex.bodyText?.slice(0, 300) },
    });
    ok = false;
  }
  const isJson = (ex.contentType ?? "").includes("application/json");
  if (!isJson) {
    const looksHtml = (ex.bodyText ?? "").trimStart().toLowerCase().startsWith("<");
    add(ctx, {
      id: "endpoints.content-type",
      layer: "conformance",
      severity: "fail",
      path: where,
      message: `Response Content-Type is "${ex.contentType ?? "(none)"}"${looksHtml ? " and the body looks like HTML" : ""}. Every Agentic Checkout response must be application/json — agents cannot parse HTML error pages.`,
      fix: "Return JSON (including for errors) with Content-Type: application/json.",
      spec: ref("Agentic Checkout OpenAPI", "content: application/json (all responses)"),
    });
    return false;
  }
  if (expect.schema && ex.body !== null && ok) {
    const schemaFindings = schemaCheck("checkout", expect.schema, ex.body, {
      pathPrefix: where,
      idPrefix: "endpoints",
      maxFindings: 15,
    });
    schemaFindings.forEach((f) => add(ctx, { ...f, detail: { scenario: ex.scenario } }));
    if (schemaFindings.length > 0) ok = false;
  }
  if (expect.idempotencyEcho && ex.idempotencyKeySent) {
    const echoed = ex.responseHeaders["idempotency-key"];
    if (!echoed) {
      add(ctx, {
        id: "endpoints.idempotency.echo-missing",
        layer: "conformance",
        severity: "warn",
        path: where,
        message: "Response does not echo the Idempotency-Key header (see SPEC_NOTES.md §9 — the OpenAPI documents the echo but does not mark it required).",
        fix: "Echo the request's Idempotency-Key value as a response header.",
        spec: ref("Responses — headers", "Idempotency-Key: Echo of the request idempotency key"),
      });
    } else if (echoed !== ex.idempotencyKeySent) {
      add(ctx, {
        id: "endpoints.idempotency.echo-mismatch",
        layer: "conformance",
        severity: "fail",
        path: where,
        message: `Idempotency-Key echo (${echoed}) does not match the key that was sent.`,
        fix: "Echo the exact key received.",
      });
    }
  }
  return ok;
}

function sessionOf(ex: Exchange): { id?: string; status?: string } & Record<string, unknown> {
  return (ex.body ?? {}) as never;
}

/**
 * True when the session carries an explicit error MESSAGE. We deliberately do
 * NOT treat status alone as a signal: a freshly created session is legitimately
 * "not_ready_for_payment" (no address yet), so status would mask a silently
 * accepted bad SKU. The spec's own out_of_stock example pairs the blocking
 * status WITH a messages[] error, so the message is the reliable signal.
 */
function hasErrorMessage(body: unknown): boolean {
  const session = body as { messages?: { type?: string }[] };
  return (session?.messages ?? []).some((m) => m?.type === "error");
}

function isStructuredError(ex: Exchange): boolean {
  return (
    ex.status >= 400 &&
    ex.status < 500 &&
    schemaCheck("checkout", "Error", ex.body, { maxFindings: 1 }).length === 0
  );
}

function createBody(ctx: Ctx, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    line_items: [{ id: ctx.opts.itemId, quantity: ctx.opts.quantity }],
    currency: ctx.opts.currency,
    capabilities: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Scenario group 1: happy path
// ---------------------------------------------------------------------------
async function happyPath(ctx: Ctx): Promise<void> {
  ctx.scenariosRun.push("happy-path");
  const { client } = ctx;

  const create = await client.request({
    scenario: "happy-path",
    method: "POST",
    path: "/checkout_sessions",
    body: createBody(ctx, { fulfillment_details: { ...TEST_BUYER, name: "ACP Check", address: TEST_ADDRESS } }),
  });
  const createOk = contract(ctx, create, { status: [201], schema: "CheckoutSession", idempotencyEcho: true });
  if (create.status === 200) {
    add(ctx, {
      id: "endpoints.create.status-200",
      layer: "conformance",
      severity: "fail",
      path: "POST /checkout_sessions",
      message: "Session create returned 200; the spec requires 201 Created with the authoritative cart state.",
      spec: ref("POST /checkout_sessions", "MUST return 201 with a rich, authoritative cart state."),
      fix: "Return HTTP 201 on successful session creation.",
    });
  }
  if (!createOk && !create.body) return;
  const session = sessionOf(create);
  const sessionId = session.id;
  if (!sessionId) return;

  // Rich checkout state checks (totals / line items / fulfillment options).
  const checkRichState = (ex: Exchange, phase: string) => {
    const s = sessionOf(ex);
    const totals = (s.totals ?? []) as { type?: string; amount?: number }[];
    if (!totals.some((t) => t.type === "total")) {
      add(ctx, {
        id: "endpoints.state.total-missing",
        layer: "conformance",
        severity: "fail",
        path: endpointPath(ex),
        message: `${phase}: totals[] has no entry with type "total". Agents display the total on every screen; it must be present in every response.`,
        spec: ref("Total.type enum", "items_base_amount | … | total | amount_refunded"),
        fix: 'Always include {"type": "total", "display_text": …, "amount": <minor units>} in totals.',
      });
    }
    const lineItems = (s.line_items ?? []) as unknown[];
    if (lineItems.length === 0) {
      add(ctx, {
        id: "endpoints.state.line-items-empty",
        layer: "conformance",
        severity: "fail",
        path: endpointPath(ex),
        message: `${phase}: line_items[] is empty although the session was created with 1 item.`,
        fix: "Return the authoritative line items (with ids and totals) on every response.",
      });
    }
  };
  checkRichState(create, "create");

  // GET retrieve
  const get = await client.request({
    scenario: "happy-path",
    method: "GET",
    path: `/checkout_sessions/${sessionId}`,
  });
  if (contract(ctx, get, { status: [200], schema: "CheckoutSession" })) {
    if (sessionOf(get).id !== sessionId) {
      add(ctx, {
        id: "endpoints.get.id-mismatch",
        layer: "conformance",
        severity: "fail",
        path: endpointPath(get),
        message: `GET returned session id "${sessionOf(get).id}" instead of "${sessionId}".`,
        fix: "Return the requested session.",
      });
    }
  }

  // Update with fulfillment address
  const update = await client.request({
    scenario: "happy-path",
    method: "POST",
    path: `/checkout_sessions/${sessionId}`,
    body: { fulfillment_details: { name: TEST_ADDRESS.name, email: TEST_BUYER.email, phone_number: TEST_BUYER.phone_number, address: TEST_ADDRESS } },
  });
  const updateOk = contract(ctx, update, { status: [200], schema: "CheckoutSession", idempotencyEcho: true });
  checkRichState(update, "update(address)");

  let readyForComplete = updateOk;
  const options = (sessionOf(update).fulfillment_options ?? []) as {
    type?: string;
    id?: string;
  }[];
  if (options.length === 0) {
    add(ctx, {
      id: "endpoints.state.fulfillment-options-empty",
      layer: "conformance",
      severity: "warn",
      path: endpointPath(update),
      message:
        "fulfillment_options[] is still empty after a complete US shipping address was provided. Agents cannot let the buyer pick shipping, so checkout stalls.",
      fix: "Return at least one fulfillment option (type shipping/digital/pickup/local_delivery with id, title, totals) once a valid address is known.",
      spec: ref("CheckoutSessionBase.required", "fulfillment_options is a required field of the session"),
    });
  } else {
    const lineItemIds = ((sessionOf(update).line_items ?? []) as { id?: string }[])
      .map((li) => li.id)
      .filter((id): id is string => typeof id === "string");
    const chosen = options[0]!;
    const select = await client.request({
      scenario: "happy-path",
      method: "POST",
      path: `/checkout_sessions/${sessionId}`,
      body: {
        selected_fulfillment_options: [{ type: chosen.type, option_id: chosen.id, item_ids: lineItemIds }],
      },
    });
    const selectOk = contract(ctx, select, { status: [200], schema: "CheckoutSession", idempotencyEcho: true });
    checkRichState(select, "update(select fulfillment)");
    readyForComplete = readyForComplete && selectOk;
    const status = sessionOf(select).status;
    if (selectOk && status && status !== "ready_for_payment") {
      add(ctx, {
        id: "endpoints.state.not-ready",
        layer: "conformance",
        severity: "warn",
        path: endpointPath(select),
        message: `After items + address + fulfillment selection the session status is "${status}", not "ready_for_payment". Messages: ${JSON.stringify(
          ((sessionOf(select).messages as unknown[]) ?? []).slice(0, 3)
        )}`,
        fix: "Once nothing else is required from the buyer, set status to ready_for_payment so the agent can proceed to payment.",
        spec: ref("CheckoutSessionBase.status", "incomplete | not_ready_for_payment | … | ready_for_payment | …"),
      });
    }
  }

  // Complete — dry-run unless explicitly allowed.
  if (!ctx.opts.allowComplete) {
    add(ctx, {
      id: "endpoints.complete.dry-run",
      layer: "quality",
      severity: "info",
      path: `POST /checkout_sessions/${sessionId}/complete`,
      message:
        "Complete step SKIPPED (dry run). No payment token was sent. Re-run with --allow-complete against a test/sandbox environment to exercise order creation.",
    });
  } else if (readyForComplete) {
    const complete = await client.request({
      scenario: "happy-path",
      method: "POST",
      path: `/checkout_sessions/${sessionId}/complete`,
      body: {
        buyer: TEST_BUYER,
        payment_data: {
          handler_id: "acp_check_test_handler",
          instrument: { type: "card", credential: { type: "spt", token: TEST_PAYMENT_TOKEN } },
        },
      },
    });
    if (contract(ctx, complete, { status: [200], schema: "CheckoutSessionWithOrder", idempotencyEcho: true })) {
      const order = (sessionOf(complete) as { order?: Record<string, unknown> }).order;
      if (order) {
        if (order.checkout_session_id && order.checkout_session_id !== sessionId) {
          add(ctx, {
            id: "endpoints.order.session-mismatch",
            layer: "conformance",
            severity: "fail",
            path: endpointPath(complete),
            message: `order.checkout_session_id ("${order.checkout_session_id}") does not reference the completed session ("${sessionId}").`,
            fix: "Set order.checkout_session_id to the id of the session that produced the order.",
          });
        }
        const status = sessionOf(complete).status;
        if (status !== "completed") {
          add(ctx, {
            id: "endpoints.complete.status",
            layer: "conformance",
            severity: "fail",
            path: endpointPath(complete),
            message: `Session status after complete is "${status}"; expected "completed".`,
            spec: ref("POST …/complete", "MUST create an order and return completed state on success."),
            fix: 'Return the session with status "completed" and the order object.',
          });
        }
      }
    }
    // Idempotent replay of complete must not double-charge / double-create.
    const completeKey = complete.idempotencyKeySent;
    if (completeKey) {
      const replay = await client.request({
        scenario: "idempotency",
        method: "POST",
        path: `/checkout_sessions/${sessionId}/complete`,
        idempotencyKey: completeKey,
        body: {
          buyer: TEST_BUYER,
          payment_data: {
            handler_id: "acp_check_test_handler",
            instrument: { type: "card", credential: { type: "spt", token: TEST_PAYMENT_TOKEN } },
          },
        },
      });
      if (replay.status === 200) {
        const orig = (sessionOf(complete) as { order?: { id?: string } }).order?.id;
        const replayed = (sessionOf(replay) as { order?: { id?: string } }).order?.id;
        if (orig && replayed && orig !== replayed) {
          add(ctx, {
            id: "endpoints.idempotency.double-order",
            layer: "conformance",
            severity: "fail",
            path: endpointPath(replay),
            message: `Replaying complete with the same Idempotency-Key created a SECOND order (${replayed} vs ${orig}). This double-charges buyers on network retries.`,
            spec: ref("Idempotency-Key parameter", "Idempotency key. MUST be present on all POST requests."),
            fix: "Cache the response by (identity, endpoint, Idempotency-Key) and replay it for retries.",
          });
        }
      }
    }
  } else {
    add(ctx, {
      id: "endpoints.complete.skipped-not-ready",
      layer: "quality",
      severity: "info",
      path: `POST /checkout_sessions/${sessionId}/complete`,
      message: "Complete step skipped because earlier happy-path steps failed.",
    });
  }

  // Cancel flow on a fresh session.
  const cancelTarget = await client.request({
    scenario: "happy-path",
    method: "POST",
    path: "/checkout_sessions",
    body: createBody(ctx),
  });
  const cancelSessionId = sessionOf(cancelTarget).id;
  if (cancelTarget.status === 201 && cancelSessionId) {
    const cancel = await client.request({
      scenario: "happy-path",
      method: "POST",
      path: `/checkout_sessions/${cancelSessionId}/cancel`,
      body: {},
    });
    if (contract(ctx, cancel, { status: [200], schema: "CheckoutSession" })) {
      if (sessionOf(cancel).status !== "canceled") {
        add(ctx, {
          id: "endpoints.cancel.status",
          layer: "conformance",
          severity: "fail",
          path: endpointPath(cancel),
          message: `Session status after cancel is "${sessionOf(cancel).status}"; expected "canceled".`,
          fix: 'Return the session with status "canceled".',
        });
      }
      // Canceling again must be rejected as not-cancelable.
      const cancelAgain = await client.request({
        scenario: "error-handling",
        method: "POST",
        path: `/checkout_sessions/${cancelSessionId}/cancel`,
        body: {},
      });
      if (cancelAgain.status !== 405) {
        add(ctx, {
          id: "endpoints.cancel.repeat",
          layer: "conformance",
          severity: cancelAgain.status >= 500 ? "fail" : "warn",
          path: endpointPath(cancelAgain),
          message: `Canceling an already-canceled session returned ${cancelAgain.status}; the spec defines 405 "Not cancelable (already completed/canceled)".`,
          spec: ref("POST …/cancel responses", '405: Not cancelable (already completed/canceled)'),
          fix: "Return 405 with a structured Error when the session is already completed or canceled.",
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Scenario group 2: idempotency
// ---------------------------------------------------------------------------
async function idempotency(ctx: Ctx): Promise<void> {
  ctx.scenariosRun.push("idempotency");
  const { client } = ctx;
  const key = client.newIdempotencyKey();
  const body = createBody(ctx);

  const first = await client.request({
    scenario: "idempotency",
    method: "POST",
    path: "/checkout_sessions",
    body,
    idempotencyKey: key,
  });
  if (!contract(ctx, first, { status: [201], schema: "CheckoutSession", idempotencyEcho: true })) return;
  const firstId = sessionOf(first).id;

  const replay = await client.request({
    scenario: "idempotency",
    method: "POST",
    path: "/checkout_sessions",
    body,
    idempotencyKey: key,
  });
  contract(ctx, replay, { status: [201], schema: "CheckoutSession" });
  const replayId = sessionOf(replay).id;
  if (firstId && replayId && firstId !== replayId) {
    add(ctx, {
      id: "endpoints.idempotency.double-create",
      layer: "conformance",
      severity: "fail",
      path: "POST /checkout_sessions",
      message: `Replaying create with the SAME Idempotency-Key returned a different session (${replayId} vs ${firstId}). Network retries will create duplicate carts (and, at complete, duplicate orders).`,
      spec: ref(
        "Idempotency-Key parameter",
        "Idempotency key. MUST be present on all POST requests. … Scoped to authenticated identity + endpoint."
      ),
      fix: "Store the first response keyed by (identity, endpoint, Idempotency-Key) and return it for replays, ideally with Idempotent-Replayed: true.",
    });
  } else if (firstId && replayId && firstId === replayId) {
    if (replay.responseHeaders["idempotent-replayed"] !== "true") {
      add(ctx, {
        id: "endpoints.idempotency.replay-header",
        layer: "conformance",
        severity: "warn",
        path: "POST /checkout_sessions",
        message: 'Replay returned the same session (good) but without the Idempotent-Replayed: "true" response header.',
        spec: ref("Responses — headers", "Idempotent-Replayed: true when the response is a cached replay"),
        fix: 'Set Idempotent-Replayed: "true" on cached replays.',
      });
    }
  }

  const fresh = await client.request({
    scenario: "idempotency",
    method: "POST",
    path: "/checkout_sessions",
    body,
    idempotencyKey: client.newIdempotencyKey(),
  });
  if (fresh.status === 201 && firstId && sessionOf(fresh).id === firstId) {
    add(ctx, {
      id: "endpoints.idempotency.over-dedup",
      layer: "conformance",
      severity: "fail",
      path: "POST /checkout_sessions",
      message: "A create with a DIFFERENT Idempotency-Key returned the same session id. Deduplication must be keyed on the Idempotency-Key, not the request body.",
      fix: "Different keys must create distinct sessions even for identical bodies.",
      spec: ref("Idempotency-Key parameter", "Scoped to authenticated identity + endpoint."),
    });
  }

  // Same key, different body → 422 idempotency_conflict.
  const conflict = await client.request({
    scenario: "idempotency",
    method: "POST",
    path: "/checkout_sessions",
    body: createBody(ctx, { currency: ctx.opts.currency === "usd" ? "eur" : "usd" }),
    idempotencyKey: key,
  });
  if (conflict.status !== 422) {
    add(ctx, {
      id: "endpoints.idempotency.conflict",
      layer: "conformance",
      severity: conflict.status >= 500 ? "fail" : "warn",
      path: "POST /checkout_sessions",
      message: `Reusing an Idempotency-Key with a different body returned ${conflict.status}; the spec defines 422 with code "idempotency_conflict".`,
      spec: ref("422 IdempotencyConflict", "Idempotency-Key has already been used with a different request body"),
      fix: 'Return 422 {"type": "invalid_request", "code": "idempotency_conflict", …} when a key is reused with a different payload.',
    });
  } else if (isStructuredError(conflict)) {
    const code = (conflict.body as { code?: string }).code;
    if (code !== "idempotency_conflict") {
      add(ctx, {
        id: "endpoints.idempotency.conflict-code",
        layer: "conformance",
        severity: "warn",
        path: "POST /checkout_sessions",
        message: `422 conflict returned code "${code}"; the spec example uses "idempotency_conflict".`,
        fix: 'Use code "idempotency_conflict" for programmatic handling.',
      });
    }
  }

  // Missing Idempotency-Key → spec defines 400 idempotency_key_required.
  const missing = await client.request({
    scenario: "idempotency",
    method: "POST",
    path: "/checkout_sessions",
    body,
    idempotencyKey: null,
  });
  if (missing.status === 400) {
    if (!isStructuredError(missing)) {
      add(ctx, {
        id: "endpoints.idempotency.missing-key-shape",
        layer: "conformance",
        severity: "fail",
        path: "POST /checkout_sessions",
        message: "400 for missing Idempotency-Key is not a structured Error object.",
        fix: 'Return {"type": "invalid_request", "code": "idempotency_key_required", "message": …}.',
      });
    }
  } else if (missing.status < 400) {
    add(ctx, {
      id: "endpoints.idempotency.missing-key-accepted",
      layer: "conformance",
      severity: "warn",
      path: "POST /checkout_sessions",
      message: `POST without an Idempotency-Key was accepted (${missing.status}). The spec marks the header as required on all POSTs and defines a 400 idempotency_key_required rejection.`,
      spec: ref("400 IdempotencyKeyRequired", "Idempotency-Key header is required"),
      fix: "Reject POSTs that lack the header with 400 idempotency_key_required.",
    });
  } else if (missing.status >= 500) {
    add(ctx, {
      id: "endpoints.idempotency.missing-key-5xx",
      layer: "conformance",
      severity: "fail",
      path: "POST /checkout_sessions",
      message: `POST without an Idempotency-Key caused a ${missing.status}. Missing headers must produce a structured 400, never a server error.`,
      fix: 'Return 400 {"code": "idempotency_key_required"}.',
    });
  }
}

// ---------------------------------------------------------------------------
// Scenario group 3: error handling
// ---------------------------------------------------------------------------
async function errorHandling(ctx: Ctx): Promise<void> {
  ctx.scenariosRun.push("error-handling");
  const { client } = ctx;

  // Unknown SKU — SPEC_NOTES §4: structured 4xx Error OR 2xx session with MessageError.
  const badSku = await client.request({
    scenario: "error-handling",
    method: "POST",
    path: "/checkout_sessions",
    body: createBody(ctx, { line_items: [{ id: `acp_check_nonexistent_${randomUUID().slice(0, 8)}`, quantity: 1 }] }),
  });
  if (badSku.status >= 500) {
    add(ctx, {
      id: "endpoints.errors.invalid-sku-5xx",
      layer: "conformance",
      severity: "fail",
      path: "POST /checkout_sessions",
      message: `Creating a session with an unknown item id caused HTTP ${badSku.status}. Bad input must never 5xx.`,
      spec: ref("Error schema", "invalid_request — malformed request, missing required fields…"),
      fix: 'Return 400 {"type": "invalid_request", "code": "invalid_item_id", "message": …, "param": "$.line_items[0].item.id"} or a 201 session with a messages[] error.',
    });
  } else if (badSku.status >= 400) {
    if (!isStructuredError(badSku)) {
      add(ctx, {
        id: "endpoints.errors.invalid-sku-shape",
        layer: "conformance",
        severity: "fail",
        path: "POST /checkout_sessions",
        message: `The ${badSku.status} response for an unknown item id is not a structured Error ({type, code, message}). Body starts: ${(badSku.bodyText ?? "").slice(0, 120)}`,
        spec: ref("Error schema", 'required: ["type", "code", "message"]'),
        fix: "Return the spec Error shape so agents can react programmatically.",
      });
    }
  } else if (!hasErrorMessage(badSku.body)) {
    add(ctx, {
      id: "endpoints.errors.invalid-sku-silent",
      layer: "conformance",
      severity: "fail",
      path: "POST /checkout_sessions",
      message: `Creating a session with an unknown item id returned a clean ${badSku.status} session with no error message and a non-blocking status — the buyer would be checking out a product that does not exist.`,
      spec: ref("MessageError", 'out of stock → code "out_of_stock" and param "$.items[0]"'),
      fix: "Reject with a 4xx Error or return the session with a messages[] error and a blocking status.",
    });
  }

  // Malformed JSON body.
  const badJson = await client.request({
    scenario: "error-handling",
    method: "POST",
    path: "/checkout_sessions",
    rawBody: '{"line_items": [',
  });
  if (badJson.status >= 500 || badJson.status < 400) {
    add(ctx, {
      id: "endpoints.errors.malformed-json",
      layer: "conformance",
      severity: "fail",
      path: "POST /checkout_sessions",
      message: `Malformed JSON body returned HTTP ${badJson.status}; expected a structured 400 invalid_request.`,
      spec: ref("Error schema", "invalid_request — malformed request, … invalid JSON"),
      fix: "Catch JSON parse failures and return 400 with the Error shape.",
    });
  } else if (!isStructuredError(badJson)) {
    add(ctx, {
      id: "endpoints.errors.malformed-json-shape",
      layer: "conformance",
      severity: "fail",
      path: "POST /checkout_sessions",
      message: "The 4xx for malformed JSON is not a structured Error object.",
      fix: 'Return {"type": "invalid_request", "code": …, "message": …}.',
    });
  }

  // Missing required field (currency).
  const noCurrency = await client.request({
    scenario: "error-handling",
    method: "POST",
    path: "/checkout_sessions",
    body: { line_items: [{ id: ctx.opts.itemId, quantity: 1 }], capabilities: {} },
  });
  if (noCurrency.status >= 500) {
    add(ctx, {
      id: "endpoints.errors.missing-field-5xx",
      layer: "conformance",
      severity: "fail",
      path: "POST /checkout_sessions",
      message: `Omitting the required "currency" field caused HTTP ${noCurrency.status}; must be a structured 400.`,
      spec: ref("CheckoutSessionCreateRequest.required", "line_items, currency, capabilities"),
      fix: "Validate required fields and return 400 invalid_request with param pointing at the missing field.",
    });
  } else if (noCurrency.status < 400) {
    add(ctx, {
      id: "endpoints.errors.missing-field-accepted",
      layer: "conformance",
      severity: "warn",
      path: "POST /checkout_sessions",
      message: `Create without the required "currency" field was accepted (${noCurrency.status}). Lenient acceptance may mask integration bugs.`,
      spec: ref("CheckoutSessionCreateRequest.required", "required: line_items, currency, capabilities"),
      fix: "Reject requests missing required fields with 400 invalid_request.",
    });
  } else if (!isStructuredError(noCurrency)) {
    add(ctx, {
      id: "endpoints.errors.missing-field-shape",
      layer: "conformance",
      severity: "fail",
      path: "POST /checkout_sessions",
      message: 'The 4xx for a missing required field is not a structured Error object.',
      fix: 'Return {"type": "invalid_request", "code": "missing_required_field", "message": …, "param": "$.currency"}.',
    });
  }

  // Malformed address on update.
  const forAddr = await client.request({ scenario: "error-handling", method: "POST", path: "/checkout_sessions", body: createBody(ctx) });
  const addrSessionId = sessionOf(forAddr).id;
  if (forAddr.status === 201 && addrSessionId) {
    const badAddr = await client.request({
      scenario: "error-handling",
      method: "POST",
      path: `/checkout_sessions/${addrSessionId}`,
      body: { fulfillment_details: { name: "ACP Check", address: { name: "ACP Check", line_one: "1 Test St", city: "Nowhere", state: "??", country: "USA", postal_code: "" } } },
    });
    if (badAddr.status >= 500) {
      add(ctx, {
        id: "endpoints.errors.bad-address-5xx",
        layer: "conformance",
        severity: "fail",
        path: endpointPath(badAddr),
        message: `An invalid address (country "USA" is not ISO 3166-1 alpha-2) caused HTTP ${badAddr.status}; must be a structured 4xx or a 200 session with a messages[] error.`,
        spec: ref("Address.country", "ISO 3166-1 alpha-2 country code"),
        fix: "Validate addresses and respond with MessageError (code invalid, param $.fulfillment_details.address.country) or 400 Error.",
      });
    } else if (badAddr.status < 400 && !hasErrorMessage(badAddr.body)) {
      add(ctx, {
        id: "endpoints.errors.bad-address-silent",
        layer: "conformance",
        severity: "warn",
        path: endpointPath(badAddr),
        message: "An invalid address was accepted with no error message and a non-blocking status; fulfillment would fail after payment.",
        fix: 'Surface address problems via messages[] with resolution "requires_buyer_input".',
      });
    }
  }

  // Unknown session id.
  const ghostId = `acp_check_nonexistent_${randomUUID().slice(0, 8)}`;
  const ghostGet = await client.request({ scenario: "error-handling", method: "GET", path: `/checkout_sessions/${ghostId}` });
  if (ghostGet.status !== 404) {
    // A 2xx here means the merchant fabricated a session for an id it never
    // issued (data-integrity bug); a 5xx is an unhandled error. Both fail.
    // Other 4xx (e.g. 400/403) merely deviate from the spec's 404 → warn.
    const fabricated = ghostGet.status >= 200 && ghostGet.status < 300;
    add(ctx, {
      id: "endpoints.errors.unknown-session",
      layer: "conformance",
      severity: fabricated || ghostGet.status >= 500 ? "fail" : "warn",
      path: endpointPath(ghostGet),
      message: fabricated
        ? `GET for a nonexistent session id returned ${ghostGet.status} with a session body — the merchant is inventing sessions for ids it never issued. The spec requires 404.`
        : `GET for a nonexistent session returned ${ghostGet.status}; the spec defines 404 with an Error body.`,
      spec: ref("GET /checkout_sessions/{id}", "404: Session not found"),
      fix: "Return 404 with a structured Error for unknown session ids.",
    });
  } else if (!isStructuredError(ghostGet)) {
    add(ctx, {
      id: "endpoints.errors.unknown-session-shape",
      layer: "conformance",
      severity: "fail",
      path: endpointPath(ghostGet),
      message: "404 for an unknown session is not a structured Error object.",
      fix: 'Return {"type": "invalid_request", "code": "not_found", "message": …}.',
    });
  }

  // Optional: known out-of-stock item.
  if (ctx.opts.outOfStockItemId) {
    const oos = await client.request({
      scenario: "error-handling",
      method: "POST",
      path: "/checkout_sessions",
      body: createBody(ctx, { line_items: [{ id: ctx.opts.outOfStockItemId, quantity: 1 }] }),
    });
    if (oos.status >= 500) {
      add(ctx, {
        id: "endpoints.errors.oos-5xx",
        layer: "conformance",
        severity: "fail",
        path: "POST /checkout_sessions",
        message: `Out-of-stock item caused HTTP ${oos.status}.`,
        fix: 'Return a 201 session with messages[] code "out_of_stock" and status not_ready_for_payment.',
      });
    } else if (oos.status < 400 && !hasErrorMessage(oos.body)) {
      add(ctx, {
        id: "endpoints.errors.oos-silent",
        layer: "conformance",
        severity: "fail",
        path: "POST /checkout_sessions",
        message: "Out-of-stock item produced a clean session with no out_of_stock message and a non-blocking status.",
        spec: ref("MessageError", 'out of stock → code "out_of_stock"'),
        fix: 'Add a messages[] error with code "out_of_stock" and set status not_ready_for_payment.',
      });
    }
  } else {
    add(ctx, {
      id: "endpoints.errors.oos-skipped",
      layer: "quality",
      severity: "info",
      path: "POST /checkout_sessions",
      message: "Out-of-stock scenario skipped (no known OOS item id). Pass --oos-item <id> to exercise it.",
    });
  }
}

// ---------------------------------------------------------------------------
// Scenario group 5: security surface
// ---------------------------------------------------------------------------
async function security(ctx: Ctx): Promise<void> {
  ctx.scenariosRun.push("security");
  const { client } = ctx;

  const url = new URL(ctx.opts.baseUrl);
  const isLocal = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !isLocal) {
    add(ctx, {
      id: "endpoints.security.tls",
      layer: "conformance",
      severity: "fail",
      path: ctx.opts.baseUrl,
      message: "Base URL is not HTTPS. Checkout traffic carries buyer PII and payment tokens; TLS is mandatory.",
      fix: "Serve the Agentic Checkout API exclusively over https://.",
    });
  }

  if (ctx.opts.skipAuthProbe) {
    add(ctx, {
      id: "endpoints.security.auth-skipped",
      layer: "quality",
      severity: "info",
      path: "POST /checkout_sessions",
      message: "Auth probes skipped (--skip-auth-probe).",
    });
    return;
  }

  const noAuth = await client.request({
    scenario: "security",
    method: "POST",
    path: "/checkout_sessions",
    body: createBody(ctx),
    auth: "none",
  });
  if (noAuth.status < 400 || noAuth.status >= 500) {
    add(ctx, {
      id: "endpoints.security.auth-not-required",
      layer: "conformance",
      severity: noAuth.status < 400 ? "fail" : "warn",
      path: "POST /checkout_sessions",
      message:
        noAuth.status < 400
          ? `A request WITHOUT an Authorization header was accepted (${noAuth.status}). Anyone on the internet can create checkout sessions.`
          : `A request without Authorization caused HTTP ${noAuth.status}; expected a structured 401.`,
      spec: ref("securitySchemes.bearerAuth / Authorization parameter", "Bearer token for API authentication — required: true"),
      fix: "Require and validate the Authorization: Bearer token on every endpoint; reject with 401 + Error body.",
    });
  }

  const wrongAuth = await client.request({
    scenario: "security",
    method: "POST",
    path: "/checkout_sessions",
    body: createBody(ctx),
    auth: "invalid",
  });
  if (wrongAuth.status < 400) {
    add(ctx, {
      id: "endpoints.security.token-not-validated",
      layer: "conformance",
      severity: "fail",
      path: "POST /checkout_sessions",
      message: `A request with a bogus bearer token was accepted (${wrongAuth.status}). The token is not actually validated.`,
      fix: "Validate bearer tokens against your issued API keys; reject unknown tokens with 401.",
    });
  }
}

/**
 * Runs the full simulated-agent scenario suite against a merchant's Agentic
 * Checkout API. Test-mode only: never sends real payment credentials.
 */
export async function runEndpoints(options: EndpointsOptions): Promise<RunSummary & { exchanges: Exchange[] }> {
  const startedAt = new Date().toISOString();
  const opts = {
    currency: "usd",
    quantity: 1,
    ...options,
  };
  const client = new AcpClient({
    baseUrl: opts.baseUrl,
    authToken: opts.authToken,
    apiVersion: opts.apiVersion ?? specMeta.specRelease,
    timeoutMs: opts.timeoutMs,
  });
  const ctx: Ctx = { client, opts, findings: [], scenariosRun: [] };

  await happyPath(ctx);
  await idempotency(ctx);
  await errorHandling(ctx);
  // group 4 (response contract) is enforced on every exchange via contract()
  ctx.scenariosRun.push("response-contract");
  await security(ctx);

  return {
    command: "endpoints",
    target: opts.baseUrl,
    startedAt,
    finishedAt: new Date().toISOString(),
    toolVersion: VERSION,
    specRelease: specMeta.specRelease,
    specCommit: specMeta.upstreamCommit,
    counts: countFindings(ctx.findings),
    stats: {
      scenarios: ctx.scenariosRun,
      requests: client.exchanges.length,
      itemId: opts.itemId,
      allowComplete: Boolean(opts.allowComplete),
      isTestTarget: looksLikeTestTarget(opts.baseUrl),
    },
    findings: ctx.findings,
    exchanges: client.exchanges,
  };
}

export { looksLikeTestTarget };
