# acp-check

**Validate your [Agentic Commerce Protocol](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol) (ACP) integration before you submit it for OpenAI conformance certification.**

ACP is the open standard (co-developed by OpenAI and Stripe) behind "Buy it in ChatGPT." If you're a merchant not on Shopify or Etsy, you have to build three things yourself — a **product feed**, an **Agentic Checkout API**, and a **delegated payment** integration — and then pass OpenAI's conformance checks. There's no good public tooling to catch spec violations *before* you submit. That's what this is.

`acp-check` acts as a simulated agent against your integration and reports every violation it can detect from the outside, each tied to the exact spec requirement and a concrete fix.

```
npx acp-check feed https://shop.example.com/feed.jsonl
npx acp-check endpoints https://api.shop.example.com --auth-token $TOKEN
```

- ✅ **Zero install** — runs with `npx`, Node ≥ 20.
- ✅ **Spec-traceable** — every check is generated from a pinned copy of the official ACP JSON Schemas / OpenAPI, not from memory. See [`spec-snapshots/`](./spec-snapshots).
- ✅ **Actionable** — no "schema validation failed." Every finding says what broke, which spec clause, and how to fix it.
- ✅ **CI-friendly** — clean exit codes, `--json`, `--fail-on-warn`.
- ✅ **Safe** — test-mode only, no real payment code paths, `complete` is dry-run by default.

> **Independent tool.** acp-check is not affiliated with, endorsed by, or connected to OpenAI or Stripe. Passing acp-check does **not** guarantee you'll pass OpenAI's certification — it catches the violations detectable from outside your system. See [What this does *not* test](#what-this-does-not-test).

---

## Spec Findings

While building this tool, I found three self-contradictions in the official
ACP spec — cases where the spec's own schema disagrees with its own examples
or its own prose. Filed upstream:

- [#277](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol/issues/277) — CheckoutSessionWithOrder rejects its own documented example
- [#278](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol/issues/278) — "items" vs "line_items" — inline example contradicts request schema
- [#279](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol/issues/279) — PaymentHandler.display_order documented but structurally excluded (indentation bug)

Full technical writeup with line numbers and repro steps: [SPEC_NOTES.md](./SPEC_NOTES.md)

---

## 60-second quickstart

```bash
# 1. Validate a product feed (URL or local .jsonl / .json)
npx acp-check feed ./products.jsonl

# 2. Probe your Agentic Checkout API as a simulated agent
export ACP_CHECK_TOKEN=sk_test_your_merchant_token
npx acp-check endpoints https://api.your-shop.com --item SKU123 --oos-item SKU_OOS

# 3. Verify a webhook signature you captured
npx acp-check webhook verify \
  --secret whsec_... --payload ./event.json \
  --signature "t=1709123456,v1=e3b0c442..."

# 4. Roll it all into one shareable readiness report
npx acp-check report --md > acp-readiness.md
```

No merchant to test against yet? Run the bundled reference merchant and point acp-check at it:

```bash
npx --package @acp-check/mock-merchant acp-mock-merchant --port 4319
npx acp-check endpoints http://localhost:4319 --auth-token test_merchant_token --oos-item item_oos --allow-complete
```

### What a finding looks like

```
  FAIL CONFORMANCE  products[0].variants[0].price.amount
    products[0].variants[0].price.amount: expected integer
    fix: Serialize amounts as integers in ISO 4217 minor units (e.g. 1999 for $19.99), not decimal strings or floats.
    spec: Product schema (spec/2026-04-17/json-schema/schema.feed.json)
          “schema path: #/$defs/Price/properties/amount/type”
```

---

## Commands

### `acp-check feed <url-or-file>`

Validates a product feed against the [Product Feed spec](./spec-snapshots/2026-07-05/rfcs/rfc.product_feeds.md). Accepts a URL or local path in the spec's `products.jsonl` format (one `Product` per line), a `{"products": [...]}` JSON envelope, or a bare array. Streams the file — a 500 MB feed never loads into memory. Caps at the first 5,000 products by default (`--full` to lift).

Two layers:

- **CONFORMANCE** (pass/fail): schema validity, required fields, type correctness (prices are integer minor units!), enum values, currency patterns, valid URLs, and **product/variant ID uniqueness**.
- **QUALITY** (warn/info): missing GTINs, thin descriptions (< 50 chars), missing images, missing availability, stale `updated_at`, `list_price` below `price`, insecure `http://` media, ALL-CAPS / overlong titles. These don't fail certification but hurt discovery ranking — and acp-check says so.

```bash
acp-check feed ./products.jsonl --full            # validate everything
acp-check feed ./products.jsonl --conformance-only # skip quality checks
acp-check feed ./products.jsonl --json             # machine-readable
```

### `acp-check endpoints <base-url>`

Drives your Agentic Checkout API through an ordered, five-group scenario suite as a simulated agent. Reads the bearer token from `--auth-token` or `ACP_CHECK_TOKEN` (**never logged**).

| Group | What it checks |
| --- | --- |
| **Happy path** | create → GET → update (address) → select fulfillment → (complete) → cancel. Verifies rich cart state (`totals` with a `total`, `line_items`, `fulfillment_options`) on **every** response, and the order shape on completion. |
| **Idempotency** | Same `Idempotency-Key` must not double-create (or double-order). Different key ⇒ new session. Reused key + different body ⇒ 422. Missing key ⇒ 400. |
| **Error handling** | Invalid SKU, out-of-stock, malformed address, missing required fields, unknown session — each must return the spec's structured error, **never a 500 or an HTML page**. |
| **Response contract** | Status codes, `application/json` content type, and response-schema validity on every single call. |
| **Security** | TLS enforced; auth actually required (probes without a token, and with a bogus token). |

```bash
acp-check endpoints https://api.shop.com --item SKU123
acp-check endpoints https://api.shop.com --oos-item SKU_OOS   # enable the out-of-stock scenario
acp-check endpoints https://api.shop.com --allow-complete     # actually POST /complete (test token)
```

**Safety:** by default the `complete` step is a **dry run** — no payment token is sent and no order is created. Pass `--allow-complete` (against a test/sandbox environment) to exercise order creation; even then, the *only* token ever sent is the clearly-fake `spt_acpcheck_test_do_not_charge`. Hitting a production-looking URL prints a warning banner. All requests carry `User-Agent: acp-check/<version>`.

### `acp-check webhook`

```bash
# Offline: verify a captured signature against the spec's HMAC scheme
acp-check webhook verify --secret whsec_... --payload event.json --signature "t=...,v1=..."

# Live: spin up a local receiver that validates payload schema + signatures
acp-check webhook listen --port 4319 --secret whsec_...
#   then expose it:  ngrok http 4319   (or cloudflared tunnel --url http://localhost:4319)
```

Implements the exact spec scheme: `Merchant-Signature: t=<unix>,v1=<64-hex>`, HMAC-SHA256 over `` `${timestamp}.${rawBody}` ``, constant-time comparison, 300-second replay window.

### `acp-check report`

Aggregates the latest `feed`, `endpoints`, and `webhook` runs (stored in `.acp-check/`) into one graded **READY / NOT READY** report with per-section scores and, for every failure, (a) what failed, (b) the exact spec requirement quoted + linked, (c) a concrete fix.

```bash
acp-check report          # pretty terminal summary
acp-check report --md     # shareable Markdown — the artifact you send a client
acp-check report --json   # machine-readable
```

---

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | All conformance checks passed (warnings allowed unless `--fail-on-warn`). |
| `1` | Conformance failures found. |
| `2` | Tool error (bad input, unreachable URL, invalid flags). |

Global flags: `--json`, `--quiet` (failures only), `--verbose` (spec quotes + links on everything), `--fail-on-warn`.

### GitHub Actions example

```yaml
- name: ACP pre-flight
  run: |
    npx acp-check feed ./dist/products.jsonl --fail-on-warn
    npx acp-check endpoints https://staging.api.shop.com --oos-item SKU_OOS
  env:
    ACP_CHECK_TOKEN: ${{ secrets.ACP_STAGING_TOKEN }}
```

---

## What this does *not* test

acp-check is an outside-in pre-flight check. It **cannot** and does not:

- **Guarantee OpenAI certification.** OpenAI runs its own conformance suite against criteria it controls; this catches the subset detectable externally.
- **Process real payments** or validate your Stripe Shared Payment Token / delegated-payment plumbing end-to-end. It never sends a real token.
- **Force true session expiry** — there's no client-triggerable way to expire a session, so `expired`-state behavior is not exercised (it probes fabricated/unknown session ids instead).
- **Verify tax, shipping-rate, or inventory *correctness*** — only that the required fields and shapes are present and internally consistent.
- **Test private webhook delivery from OpenAI to you** beyond signature/schema validation of deliveries you capture.
- **Audit your storefront, fraud, or 3DS/intervention flows** beyond schema conformance of the fields involved.

When the spec is ambiguous, acp-check implements the strict reading and emits a **WARN** (not a FAIL) pointing at the ambiguous section. All such decisions are documented in [`SPEC_NOTES.md`](./SPEC_NOTES.md).

---

## How it stays honest

Every validator is generated from a pinned snapshot of the official spec in [`spec-snapshots/`](./spec-snapshots) — the JSON Schemas and OpenAPI documents, verbatim, with the upstream commit recorded. Findings quote and link back to those exact files. When a new ACP release ships, we re-snapshot, regenerate, and re-review; CI fails if generated schemas drift from the snapshot. See [`ARCHITECTURE.md`](./ARCHITECTURE.md).

Current snapshot: ACP release **2026-04-17** (upstream commit `c2afc86`).

## Using the engine as a library

The validation engine ([`@acp-check/core`](./packages/core)) is UI-free and importable — the CLI is a thin wrapper.

```ts
import { validateFeed, runEndpoints, verifySignature, buildReport } from "@acp-check/core";

const summary = await validateFeed("./products.jsonl");
console.log(summary.counts, summary.findings);
```

## Development

```bash
npm install
npm run gen:schemas   # regenerate validators from spec-snapshots/
npm run build
npm test              # vitest, incl. the endpoints suite vs. the mock merchant
npm run test:coverage # >80% on core
```

Monorepo: `packages/core` (engine), `packages/cli` (`acp-check`), `packages/mock-merchant` (reference merchant + `--broken` modes used by the test suite).

## License

[MIT](./LICENSE). Not affiliated with OpenAI or Stripe. "Agentic Commerce Protocol" and the spec are the work of their respective maintainers, used here under Apache-2.0.
