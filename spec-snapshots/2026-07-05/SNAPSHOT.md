# Spec snapshot — 2026-07-05

Source of truth for every validator in this repository.

| Field | Value |
| --- | --- |
| Repository | https://github.com/agentic-commerce-protocol/agentic-commerce-protocol |
| Commit | `c2afc863b46b6bb64fbc2be969bff25ee6eab652` |
| Commit date | 2026-06-15 16:51:11 -0700 |
| Spec release used | `2026-04-17` (latest released version at snapshot time) |
| Snapshot taken | 2026-07-05 |
| License | Apache-2.0 (upstream) |

## Contents

- `json-schema/` — verbatim copies of `spec/2026-04-17/json-schema/*.json`
- `openapi/` — verbatim copies of:
  - `spec/2026-04-17/openapi/openapi.agentic_checkout.yaml`
  - `spec/2026-04-17/openapi/openapi.agentic_checkout_webhook.yaml`
  - `spec/2026-04-17/openapi/openapi.feed.yaml`
- `examples/` — curated example payloads from `examples/2026-04-17/`
- `rfcs/` — `rfc.product_feeds.md`, `rfc.agentic_checkout.md` (normative prose:
  MUST/SHOULD requirements, JSONL snapshot format, state semantics)

## How validators consume this snapshot

Runtime schemas in `packages/core/src/schemas/generated/` are produced by
`packages/core/scripts/extract-schemas.mjs`, which reads **only** files in this
directory. Do not hand-edit generated schemas; re-run
`npm run gen:schemas -w @acp-check/core` after refreshing a snapshot.

To refresh: clone the upstream repo, copy the newest released `spec/<version>/`
files into a new `spec-snapshots/<date>/` directory, update this file, re-run
the generator, and review `SPEC_NOTES.md` for resolved/new ambiguities.
