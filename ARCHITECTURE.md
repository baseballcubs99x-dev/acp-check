# Architecture

## Layout

```
acp-check/
├── spec-snapshots/<date>/     # verbatim copies of the official ACP spec (source of truth)
├── packages/
│   ├── core/                  # @acp-check/core — validation engine, importable library, no CLI deps
│   ├── cli/                   # acp-check — commander-based CLI wrapping core
│   └── mock-merchant/         # @acp-check/mock-merchant — reference ACP merchant + --broken modes
├── SPEC_NOTES.md              # spec ambiguities and how we resolved them
└── ARCHITECTURE.md
```

`core` is dependency-light and UI-free so the future hosted product can wrap it
directly. The CLI is a thin presentation layer: it parses flags, calls core,
renders findings, and maps results to exit codes.

## Schema validation: Ajv, not Zod

Chosen: **Ajv 8** (+ `ajv-formats`).

The mandate is that every validator traces to a saved spec file, never to our
memory of the spec. The ACP spec *is* JSON Schema (2020-12) and OpenAPI 3.1
(whose schemas are JSON Schema 2020-12 dialect). Ajv consumes those documents
verbatim. Zod would require hand-transcribing ~4,000 lines of schema into
TypeScript — a transcription step where drift and memory-of-the-spec errors
creep in, and which must be redone on every spec release.

Trade-off accepted: Zod gives nicer inferred TS types. We recover ergonomics
with a small typed wrapper (`SchemaValidator`) that turns Ajv errors into
acp-check `Finding`s with JSON-path, spec quote, and fix suggestion.

## Schema generation pipeline

`packages/core/scripts/extract-schemas.mjs` (run via `npm run gen:schemas`):

1. Reads `spec-snapshots/<date>/json-schema/schema.feed.json` → emits
   `generated/feed.schemas.json` (Product/Variant/FeedMetadata/Error defs).
2. Reads `openapi.agentic_checkout.yaml` + `openapi.agentic_checkout_webhook.yaml`,
   extracts `components.schemas`, rewrites OpenAPI-isms
   (`nullable: true` → `type: [..., "null"]`, cross-file `$ref` →
   local `#/$defs/...`, the misplaced `PaymentHandler.display_order` — see
   SPEC_NOTES §3) → emits `generated/checkout.schemas.json` and
   `generated/webhook.schemas.json`.
3. Stamps every generated file with the snapshot date + upstream commit.

Generated files are committed (so `npx acp-check` needs no build step against
the spec repo) and regenerated only when a new snapshot is taken. CI runs the
generator and fails if the output drifts from what is committed.

## Core modules

| Module | Responsibility |
| --- | --- |
| `findings` | `Finding` model: layer (CONFORMANCE/QUALITY), severity (FAIL/WARN/INFO), JSON path, message, spec reference (quote + link), fix suggestion |
| `feed` | Streaming feed validation. JSONL via `readline`, JSON via `stream-json` (products array streamed item-by-item). Default cap 5,000 items, `--full` to lift. Per-item schema validation + cross-item checks (ID uniqueness, duplicate barcodes) with bounded memory (a `Set` of ids only) |
| `endpoints` | Scenario runner. `AcpClient` (undici-style `fetch`, auth header, `User-Agent: acp-check/<v>`, timeouts, never logs tokens) + ordered scenario suite (happy path, idempotency, error handling, response contract, security). Each HTTP exchange is schema-validated |
| `webhook` | HMAC verify (`t=<ts>,v1=<hex>`, SHA-256 over `` `${t}.${rawBody}` ``, constant-time compare, timestamp window) + local receiver server + payload schema validation |
| `report` | Aggregates run artifacts from `.acp-check/` into READY / NOT READY with section scores; renderers for JSON and Markdown live here so the hosted product can reuse them |

## Run artifacts

Each command writes its machine-readable result to
`.acp-check/<command>-latest.json` (stateless otherwise; no merchant data
retained beyond these local artifacts). `acp-check report` reads whatever
artifacts exist and grades overall readiness.

## Safety invariants

- No real payment code paths exist. The only token ever sent is the clearly
  fake `spt_acpcheck_test_…` and only when `--allow-complete` is passed;
  otherwise `complete` is skipped (dry run) and reported as such.
- Auth tokens come from `--auth-token` / `ACP_CHECK_TOKEN`, are held in a
  closure, and are redacted from every log/artifact (`Authorization: Bearer
  ***`).
- Production-looking base URLs (no `localhost`/`127.0.0.1`/`*.test`/`:port`
  heuristics + no `test|sandbox|staging` in hostname) print a warning banner.

## Exit codes

`0` all conformance checks passed (warnings allowed unless `--fail-on-warn`) ·
`1` conformance failures · `2` tool error (bad input, network down, invalid
flags).

## Extensibility (v2+)

Protocol surface is isolated behind `core/src/protocols/acp/`. A future
adapter (e.g. Google UCP/AP2) implements the same `FeedValidator` /
`EndpointSuite` interfaces; findings, report, and CLI are protocol-agnostic.
