# SPEC_NOTES

Ambiguities, self-inconsistencies, and interpretation decisions made while
building acp-check against the ACP spec snapshot in
[`spec-snapshots/2026-07-05/`](./spec-snapshots/2026-07-05/SNAPSHOT.md)
(release `2026-04-17`, upstream commit `c2afc86`).

Policy: where the spec is ambiguous we implement the **strict** interpretation
and emit a **WARN** (not FAIL) pointing at the ambiguous section. Where the
spec contradicts itself, schemas win over embedded examples.

---

## 1. `items` vs `line_items` in embedded OpenAPI examples

`openapi.agentic_checkout.yaml` embeds request examples using an `items` key
(e.g. the `minimal` example on `POST /checkout_sessions`), but
`CheckoutSessionCreateRequest` declares `line_items` (required) with
`additionalProperties: false` — the embedded examples are invalid against their
own schema. The curated `examples/2026-04-17/examples.agentic_checkout.json`
uses `line_items`.

**Decision:** the schema and curated examples win. acp-check sends and expects
`line_items`.

## 2. `order_notes` in curated examples is not in any schema

`examples.agentic_checkout.json` includes `order_notes` on create / update /
complete requests, but all three request schemas set
`additionalProperties: false`, which forbids it.

**Decision:** acp-check never sends `order_notes`. When validating *merchant
responses* we validate strictly against the schemas; this only affects
requests, which we control.

## 3. `PaymentHandler.display_order` is misplaced in the OpenAPI source

In `openapi.agentic_checkout.yaml` the `display_order` field of
`PaymentHandler` is indented as a sibling of `properties:` / `required:`
rather than inside `properties:`. As written it is an unknown JSON-Schema
keyword (ignored by validators), so `display_order` is effectively **not** a
declared property — and because `additionalProperties: false` is set, a
handler that includes it would be schema-invalid.

**Decision (strict + WARN):** our schema extractor hoists `display_order` into
`properties` (integer) so merchants who follow the RFC prose are not failed.
acp-check emits a WARN referencing this note when the field is present.

## 4. Invalid item at session create: 4xx `Error` or 201 + `MessageError`?

The spec supports both patterns: `error_400_invalid_item` shows a 400 protocol
`Error` (`code: invalid_item_id`), while `checkout_session_with_out_of_stock`
shows a 201 session whose `messages[]` carries a `MessageError`
(`code: out_of_stock`, status `not_ready_for_payment`). The `Error` schema
description says to use `MessageError` "when you can return a valid
CheckoutSession and the problem is conversational".

**Decision:** acp-check accepts **either** — a structured 4xx `Error` or a 2xx
session containing at least one `MessageError` / blocking status. It FAILs on:
5xx, non-JSON (HTML) bodies, or a 2xx "clean" session for an unknown SKU.

## 5. Feed file formats

`rfc.product_feeds.md` §3.4 defines exactly one offline snapshot format:
`products.jsonl` (one `Product` per line) plus `metadata.json`
(`FeedMetadata`). The Feed API uses JSON envelopes
(`{"products": [...]}` — `ProductsResponse` / `UpsertProductsRequest`).
No CSV/TSV/XML format is defined.

**Decision:** `acp-check feed` accepts:
- `.jsonl` / `.ndjson` — one `Product` per line (spec snapshot format), streamed
- `.json` — either a `{"products": [...]}` envelope or a bare `Product[]`
  array (bare arrays are not spec-defined; accepted with an INFO note), streamed

No other formats. CSV/XML inputs are a tool error (exit 2).

## 6. `updated_at` staleness

`FeedMetadata.updated_at` is optional and lives on the feed resource, not in
`products.jsonl`. Staleness is checked only when metadata is available (a
`metadata.json` next to the products file, or `--metadata <file>`).
Thresholds (>7 days INFO, >30 days WARN) are acp-check heuristics, not spec
requirements — labeled QUALITY, never FAIL.

## 7. `Availability.status` and other "extensible" enums

Several fields ("known values include…", "MUST accept unrecognized values
gracefully": `Availability.status`, `Order.status`, `Fulfillment.status`,
`WebhookEvent.type`, `IntentTrace.reason_code`) are deliberately open enums.

**Decision:** unrecognized values never FAIL; values outside the documented
set emit a WARN listing the known values.

## 8. `MessageError.param: nullable: true` (OpenAPI 3.0-ism in a 3.1 doc)

`nullable` is not a JSON Schema 2020-12 keyword. Our extractor rewrites it to
`type: ["string", "null"]`.

## 9. Idempotency-echo response headers

The OpenAPI marks the `Idempotency-Key` response-header echo on 201/200
responses without `required: true` (OpenAPI headers default to optional), and
`Idempotent-Replayed` is explicitly optional. The RFC prose treats replay
detection as the merchant's obligation but does not mandate the echo headers.

**Decision:** missing `Idempotency-Key` echo → WARN; replay returning a
*different session id* → FAIL (double-create, unambiguous); replay returning
the same session without `Idempotent-Replayed: true` → WARN.

## 10. Session-expiry scenario is not remotely inducible

`status: expired` exists, but nothing in the spec lets a client force
expiry. acp-check probes a **fabricated/unknown session id** (must be 404
`Error`) and, when the merchant returns `expires_at` in the past on GET,
flags inconsistent status. True expiry behavior is listed in README under
"what this does NOT test".

## 11. Feed quality checks are not spec requirements

The QUALITY layer (thin descriptions, missing GTIN/barcodes, missing media,
zero-amount prices, `http://` media URLs, title heuristics, etc.) affects
discovery ranking but is **not** normative. Reported as WARN/INFO only and
clearly labeled; only CONFORMANCE findings affect the exit code (unless
`--fail-on-warn`).
