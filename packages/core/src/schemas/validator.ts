import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";

// ajv-formats ships CJS; under NodeNext the callable lives on .default in some
// resolutions and is the module itself in others. Normalize to the function.
const addFormats = (
  (addFormatsImport as unknown as { default?: unknown }).default ?? addFormatsImport
) as (ajv: Ajv2020, opts?: unknown) => Ajv2020;
import { feedSchemas } from "./generated/feed.schemas.js";
import { checkoutSchemas } from "./generated/checkout.schemas.js";
import { webhookSchemas } from "./generated/webhook.schemas.js";
import { specMeta } from "./generated/meta.js";
import type { Finding, FindingSeverity } from "../findings.js";
import { specUrl } from "../findings.js";

export { specMeta };

export type SchemaBundle = "feed" | "checkout" | "webhook";

const bundles: Record<SchemaBundle, { doc: Record<string, unknown>; source: string }> = {
  feed: { doc: feedSchemas as never, source: "spec/2026-04-17/json-schema/schema.feed.json" },
  checkout: {
    doc: checkoutSchemas as never,
    source: "spec/2026-04-17/openapi/openapi.agentic_checkout.yaml",
  },
  webhook: {
    doc: webhookSchemas as never,
    source: "spec/2026-04-17/openapi/openapi.agentic_checkout_webhook.yaml",
  },
};

const ajv = new Ajv2020({
  strict: false, // spec files carry OpenAPI-isms (example:, x- keys) — do not fail on them
  allErrors: true,
  allowUnionTypes: true,
  validateFormats: true,
});
addFormats(ajv);
for (const { doc } of Object.values(bundles)) ajv.addSchema(doc as never);

const cache = new Map<string, ValidateFunction>();

/** Compile (and cache) a validator for one $def in a bundle. */
export function getValidator(bundle: SchemaBundle, defName: string): ValidateFunction {
  const key = `${bundle}#${defName}`;
  let fn = cache.get(key);
  if (!fn) {
    const id = (bundles[bundle].doc as { $id: string }).$id;
    fn = ajv.getSchema(`${id}#/$defs/${defName}`);
    if (!fn) throw new Error(`Unknown schema: ${key}`);
    cache.set(key, fn);
  }
  return fn;
}

function humanizeAjvError(e: ErrorObject): string {
  switch (e.keyword) {
    case "required":
      return `missing required field "${(e.params as { missingProperty: string }).missingProperty}"`;
    case "additionalProperties":
      return `unexpected field "${(e.params as { additionalProperty: string }).additionalProperty}" (schema sets additionalProperties: false)`;
    case "type":
      return `expected ${(e.params as { type: string }).type}`;
    case "enum":
      return `must be one of: ${((e.params as { allowedValues: unknown[] }).allowedValues ?? []).join(", ")}`;
    case "pattern":
      return `must match pattern ${(e.params as { pattern: string }).pattern}`;
    case "format":
      return `is not a valid ${(e.params as { format: string }).format}`;
    case "const":
      return `must be "${(e.params as { allowedValue: unknown }).allowedValue}"`;
    case "minimum":
    case "maximum":
    case "minLength":
    case "maxLength":
    case "minItems":
    case "minProperties":
      return e.message ?? e.keyword;
    default:
      return e.message ?? e.keyword;
  }
}

// Keyed on "<parent>/<leaf>:<keyword>" or "<leaf>:<keyword>" from the instance
// path (defName is the top-level schema, e.g. Product, so we key on the field
// name rather than the def).
const FIX_HINTS: Record<string, string> = {
  "price/amount:type": "Serialize amounts as integers in ISO 4217 minor units (e.g. 1999 for $19.99), not decimal strings or floats.",
  "list_price/amount:type": "Serialize amounts as integers in minor units (e.g. 2499 for $24.99).",
  "unit_price/amount:type": "Serialize amounts as integers in minor units.",
  "price/currency:pattern": 'Use an uppercase three-letter ISO 4217 code, e.g. "USD".',
  "list_price/currency:pattern": 'Use an uppercase three-letter ISO 4217 code, e.g. "USD".',
  "amount:type": "Amounts are integers in minor units (cents): 1999, not 19.99.",
  "currency:pattern": 'Use an uppercase three-letter ISO 4217 code, e.g. "USD".',
  "url:format": "Provide an absolute https:// URL.",
};

function fixHintFor(_defName: string, e: ErrorObject): string | undefined {
  const segs = e.instancePath.split("/").filter(Boolean).filter((s) => !/^\d+$/.test(s));
  const leaf = segs.at(-1);
  const parent = segs.at(-2);
  return (
    (parent && leaf ? FIX_HINTS[`${parent}/${leaf}:${e.keyword}`] : undefined) ??
    (leaf ? FIX_HINTS[`${leaf}:${e.keyword}`] : undefined)
  );
}

export interface SchemaCheckOptions {
  /** Prefix prepended to every finding path (e.g. "products[3]"). */
  pathPrefix?: string;
  idPrefix?: string;
  severity?: FindingSeverity;
  /** Cap the number of findings produced per call (schema errors can explode). */
  maxFindings?: number;
}

/**
 * Validate `data` against `bundle#/$defs/defName`, translating Ajv errors into
 * actionable Findings that quote the saved spec source.
 */
export function schemaCheck(
  bundle: SchemaBundle,
  defName: string,
  data: unknown,
  opts: SchemaCheckOptions = {}
): Finding[] {
  const validate = getValidator(bundle, defName);
  if (validate(data)) return [];
  const { pathPrefix = "", idPrefix = bundle, severity = "fail", maxFindings = 25 } = opts;
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const e of validate.errors ?? []) {
    // Skip noisy branch errors from oneOf/anyOf—keep the discriminating message.
    if (e.keyword === "oneOf" || e.keyword === "anyOf" || e.keyword === "if") continue;
    const jsonPath = e.instancePath
      .split("/")
      .filter(Boolean)
      .map((seg) => (/^\d+$/.test(seg) ? `[${seg}]` : `.${seg}`))
      .join("");
    const path = `${pathPrefix}${jsonPath}` || pathPrefix || defName;
    const message = `${path}: ${humanizeAjvError(e)}`;
    if (seen.has(message)) continue;
    seen.add(message);
    findings.push({
      id: `${idPrefix}.schema.${defName}.${e.keyword}`,
      layer: "conformance",
      severity,
      path,
      message,
      spec: {
        section: `${defName} schema (${bundles[bundle].source})`,
        quote: `schema path: ${e.schemaPath}`,
        url: specUrl(specMeta.upstreamCommit, bundles[bundle].source),
      },
      fix: fixHintFor(defName, e),
    });
    if (findings.length >= maxFindings) break;
  }
  return findings;
}
