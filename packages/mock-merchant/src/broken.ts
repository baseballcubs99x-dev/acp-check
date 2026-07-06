/**
 * Deliberate spec violations the mock merchant can be told to commit, so
 * acp-check's own test suite can assert it catches each one. Each mode maps to
 * one or more finding ids the endpoints prober should raise.
 */
export const BROKEN_SCENARIOS = {
  "double-create": "Idempotent replay of create returns a NEW session id (double-create).",
  "no-idempotency-required": "Accepts POSTs with no Idempotency-Key instead of 400.",
  "no-idempotency-conflict": "Reusing a key with a different body does not 422.",
  "missing-total": "Session totals[] omits the type:'total' entry.",
  "empty-line-items": "Session omits line_items even though items were sent.",
  "wrong-create-status": "Create returns 200 instead of 201.",
  "never-ready": "Session never reaches ready_for_payment.",
  "no-fulfillment-options": "Never returns fulfillment_options, even with a valid address.",
  "sku-500": "Unknown item id returns HTTP 500 instead of a structured 4xx.",
  "sku-silent": "Unknown item id returns a clean session with no error message.",
  "html-errors": "Errors are returned as HTML pages, not JSON.",
  "bad-error-shape": "Errors are JSON but not the {type, code, message} shape.",
  "no-auth": "Does not require an Authorization header.",
  "accept-any-token": "Accepts any bearer token without validating it.",
  "malformed-json-500": "Malformed JSON body returns 500 instead of 400.",
  "double-order": "Idempotent replay of complete creates a second order.",
  "unknown-session-200": "GET for an unknown session returns 200 instead of 404.",
  "cancel-no-405": "Canceling an already-canceled session does not return 405.",
  "invalid-schema-session": "Returns a session that violates the CheckoutSession schema (bad enum).",
} as const;

export type BrokenScenario = keyof typeof BROKEN_SCENARIOS;

export function isBrokenScenario(x: string): x is BrokenScenario {
  return x in BROKEN_SCENARIOS;
}
