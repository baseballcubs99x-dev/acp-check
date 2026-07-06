#!/usr/bin/env node
/**
 * Generates runtime JSON Schemas for @acp-check/core from the pinned ACP spec
 * snapshot. This script is the ONLY producer of src/schemas/generated/*;
 * validators must never encode spec knowledge that does not come from here.
 *
 * Inputs (see spec-snapshots/<date>/SNAPSHOT.md):
 *   - json-schema/schema.feed.json                (JSON Schema 2020-12, verbatim)
 *   - openapi/openapi.agentic_checkout.yaml       (OpenAPI 3.1 components.schemas)
 *   - openapi/openapi.agentic_checkout_webhook.yaml
 *
 * Transformations applied to OpenAPI schemas (documented in SPEC_NOTES.md):
 *   - "#/components/schemas/X" refs   -> "#/$defs/X"
 *   - cross-file Order ref in webhook -> "#/$defs/Order" (checkout defs merged in)
 *   - nullable: true                  -> type: [..., "null"]        (SPEC_NOTES §8)
 *   - PaymentHandler.display_order hoisted into properties          (SPEC_NOTES §3)
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const snapshotsDir = join(repoRoot, "spec-snapshots");
const snapshotDate = readdirSync(snapshotsDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().at(-1);
if (!snapshotDate) throw new Error(`No spec snapshot found in ${snapshotsDir}`);
const snap = join(snapshotsDir, snapshotDate);
const snapshotMeta = readFileSync(join(snap, "SNAPSHOT.md"), "utf8");
const commit = snapshotMeta.match(/Commit \| `([0-9a-f]+)`/)?.[1] ?? "unknown";
const specRelease = snapshotMeta.match(/Spec release used \| `([^`]+)`/)?.[1] ?? "unknown";

const outDir = join(here, "../src/schemas/generated");
mkdirSync(outDir, { recursive: true });

/** Recursively rewrite OpenAPI-isms into JSON Schema 2020-12. */
function toJsonSchema(node, path = []) {
  if (Array.isArray(node)) return node.map((n, i) => toJsonSchema(n, [...path, i]));
  if (node === null || typeof node !== "object") return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string") {
      out.$ref = value
        .replace(/^\.\/openapi\.agentic_checkout\.yaml#\/components\/schemas\//, "#/$defs/")
        .replace(/^#\/components\/schemas\//, "#/$defs/");
      continue;
    }
    if (key === "nullable") continue; // handled below
    out[key] = toJsonSchema(value, [...path, key]);
  }
  if (node.nullable === true) {
    if (typeof out.type === "string") out.type = [out.type, "null"];
    else if (Array.isArray(out.type) && !out.type.includes("null")) out.type = [...out.type, "null"];
  }
  return out;
}

function extractComponents(yamlPath) {
  const doc = parseYaml(readFileSync(yamlPath, "utf8"));
  const defs = {};
  for (const [name, schema] of Object.entries(doc.components?.schemas ?? {})) {
    defs[name] = toJsonSchema(schema);
  }
  return { version: doc.info?.version, defs };
}

/**
 * SPEC_NOTES §12: several response schemas extend a base via `allOf`
 * (CheckoutSession, CheckoutSessionWithOrder = allOf[CheckoutSessionBase, …]).
 * CheckoutSessionBase sets `additionalProperties: false`, and JSON Schema's
 * additionalProperties cannot see properties contributed by sibling allOf
 * branches — so the composed schema rejects its own fields (e.g. `order`),
 * and the spec's own examples fail their own schema.
 *
 * We flatten these compositions: union the members' properties/required and,
 * when any member forbids additional properties, keep that constraint against
 * the *combined* property set. This preserves the spec's strictness intent
 * while letting the intended fields validate.
 */
function flattenAllOf(defs) {
  const isPlainExtension = (schema) =>
    schema && typeof schema === "object" && Array.isArray(schema.allOf) &&
    !schema.properties && !schema.$ref;

  const merged = {};
  const resolve = (schema, seen = new Set()) => {
    if (!schema || typeof schema !== "object") return schema;
    if (schema.$ref) {
      const name = schema.$ref.replace("#/$defs/", "");
      if (defs[name] && !seen.has(name)) return resolve(defs[name], new Set([...seen, name]));
      return {};
    }
    if (!Array.isArray(schema.allOf)) return schema;
    const out = { type: "object", properties: {}, required: [], additionalProperties: true };
    let anyClosed = false;
    const members = [...schema.allOf];
    // fold in same-level constraints (properties/required declared next to allOf)
    if (schema.properties || schema.required) members.push({ properties: schema.properties, required: schema.required, additionalProperties: schema.additionalProperties });
    for (const member of members) {
      const r = resolve(member, seen);
      if (!r || typeof r !== "object") continue;
      Object.assign(out.properties, r.properties ?? {});
      if (Array.isArray(r.required)) out.required.push(...r.required);
      if (r.additionalProperties === false) anyClosed = true;
    }
    out.required = [...new Set(out.required)];
    out.additionalProperties = anyClosed ? false : true;
    if (schema.description) out.description = schema.description;
    return out;
  };

  for (const [name, schema] of Object.entries(defs)) {
    merged[name] = isPlainExtension(schema) ? resolve(schema) : schema;
  }
  return merged;
}

function fixPaymentHandler(defs) {
  // SPEC_NOTES §3: display_order is mis-indented in the spec YAML (sibling of
  // `properties`). Hoist it into properties so spec-following merchants who
  // send it are not failed by additionalProperties: false.
  const handler = defs.PaymentHandler;
  if (handler && handler.display_order && !handler.properties?.display_order) {
    handler.properties.display_order = handler.display_order;
    delete handler.display_order;
  }
}

function writeGenerated(basename, title, bundle) {
  const banner = `/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source: spec-snapshots/${snapshotDate}/ (ACP release ${specRelease}, upstream commit ${commit})
 * Generator: packages/core/scripts/extract-schemas.mjs
 * Regenerate with: npm run gen:schemas -w @acp-check/core
 */
`;
  const body = `export const ${title} = ${JSON.stringify(bundle, null, 2)} as const;

export default ${title} as Record<string, unknown>;
`;
  writeFileSync(join(outDir, `${basename}.ts`), banner + body);
  console.log(`wrote src/schemas/generated/${basename}.ts (${Object.keys(bundle.$defs).length} defs)`);
}

// ---- feed: already JSON Schema 2020-12; keep verbatim (minus $id collisions) ----
const feed = JSON.parse(readFileSync(join(snap, "json-schema/schema.feed.json"), "utf8"));
writeGenerated("feed.schemas", "feedSchemas", {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "acp-check://feed",
  "x-acp-source": `spec-snapshots/${snapshotDate}/json-schema/schema.feed.json`,
  $defs: feed.$defs,
});

// ---- agentic checkout: extract from OpenAPI components ----
const checkout = extractComponents(join(snap, "openapi/openapi.agentic_checkout.yaml"));
fixPaymentHandler(checkout.defs);
checkout.defs = flattenAllOf(checkout.defs);
writeGenerated("checkout.schemas", "checkoutSchemas", {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "acp-check://checkout",
  "x-acp-source": `spec-snapshots/${snapshotDate}/openapi/openapi.agentic_checkout.yaml (info.version ${checkout.version})`,
  $defs: checkout.defs,
});

// ---- webhook: merge checkout defs so the cross-file Order $ref resolves ----
const webhook = extractComponents(join(snap, "openapi/openapi.agentic_checkout_webhook.yaml"));
const webhookDefs = flattenAllOf({ ...checkout.defs, ...webhook.defs });
writeGenerated("webhook.schemas", "webhookSchemas", {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "acp-check://webhook",
  "x-acp-source": `spec-snapshots/${snapshotDate}/openapi/openapi.agentic_checkout_webhook.yaml (info.version ${webhook.version})`,
  $defs: webhookDefs,
});

writeFileSync(
  join(outDir, "meta.ts"),
  `/** GENERATED FILE — DO NOT EDIT. See extract-schemas.mjs */
export const specMeta = {
  snapshotDate: ${JSON.stringify(snapshotDate)},
  specRelease: ${JSON.stringify(specRelease)},
  upstreamCommit: ${JSON.stringify(commit)},
  upstreamRepo: "https://github.com/agentic-commerce-protocol/agentic-commerce-protocol",
} as const;
`
);
console.log("wrote src/schemas/generated/meta.ts");
