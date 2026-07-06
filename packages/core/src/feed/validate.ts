import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Finding, RunSummary } from "../findings.js";
import { countFindings, specUrl } from "../findings.js";
import { schemaCheck, specMeta } from "../schemas/validator.js";
import { qualityChecks } from "./quality.js";
import { openFeed, FeedInputError } from "./stream.js";
import { VERSION } from "../version.js";

export { FeedInputError };

export interface FeedValidateOptions {
  /** Validate every item; default caps at `maxItems`. */
  full?: boolean;
  /** Default 5,000 (spec feeds can be huge; keep pre-flight checks fast). */
  maxItems?: number;
  /** Path/URL to a FeedMetadata JSON (metadata.json). Auto-discovered next to local products files. */
  metadata?: string;
  /** Skip the QUALITY layer. */
  conformanceOnly?: boolean;
  /** Cap on stored findings (counts keep accumulating past it). */
  maxFindings?: number;
}

const FEED_SCHEMA_SOURCE = "spec/2026-04-17/json-schema/schema.feed.json";
const STALE_INFO_DAYS = 7;
const STALE_WARN_DAYS = 30;

interface ProductLike {
  id?: unknown;
  variants?: { id?: unknown }[];
}

async function loadMetadata(target: string, explicit?: string): Promise<{ raw: unknown; source: string } | null> {
  if (explicit) {
    return { raw: JSON.parse(await readFile(explicit, "utf8")), source: explicit };
  }
  if (/^https?:\/\//.test(target)) return null;
  const candidate = join(dirname(target), "metadata.json");
  try {
    await stat(candidate);
    return { raw: JSON.parse(await readFile(candidate, "utf8")), source: candidate };
  } catch {
    return null;
  }
}

function checkMetadata(raw: unknown, source: string): Finding[] {
  const findings = schemaCheck("feed", "FeedMetadata", raw, {
    pathPrefix: "metadata",
    idPrefix: "feed",
  });
  const updatedAt = (raw as { updated_at?: string })?.updated_at;
  if (updatedAt) {
    const ageDays = (Date.now() - Date.parse(updatedAt)) / 86_400_000;
    if (Number.isFinite(ageDays) && ageDays > STALE_INFO_DAYS) {
      findings.push({
        id: "feed.metadata.stale",
        layer: "quality",
        severity: ageDays > STALE_WARN_DAYS ? "warn" : "info",
        path: "metadata.updated_at",
        message: `Feed metadata says it was last updated ${Math.floor(ageDays)} days ago (${updatedAt}). Stale feeds get down-ranked and produce failed checkouts on price/stock drift.`,
        fix: "Republish the feed (full snapshot or PATCH upsert) and update updated_at after every successful publish.",
        spec: {
          section: "Product Feeds RFC — SHOULD requirements",
          quote: "Sellers SHOULD update `updated_at` after successful full replacements or partial upserts.",
          url: specUrl(specMeta.upstreamCommit, "rfcs/rfc.product_feeds.md"),
        },
        detail: { source },
      });
    }
  } else {
    findings.push({
      id: "feed.metadata.updated_at.missing",
      layer: "quality",
      severity: "info",
      path: "metadata.updated_at",
      message: "Feed metadata has no updated_at; agents cannot tell how fresh the catalog is.",
      fix: "Set updated_at (RFC 3339) whenever the feed is republished.",
    });
  }
  return findings;
}

/**
 * Validates an ACP product feed (URL or local file, JSONL or JSON) against the
 * pinned Product Feed schema, plus cross-item conformance checks and the
 * QUALITY layer.
 */
export async function validateFeed(target: string, opts: FeedValidateOptions = {}): Promise<RunSummary> {
  const startedAt = new Date().toISOString();
  const { full = false, maxItems = 5000, conformanceOnly = false, maxFindings = 1000 } = opts;

  const source = await openFeed(target);
  const findings: Finding[] = [];
  const overflowCounts = new Map<string, number>();
  const add = (f: Finding) => {
    if (findings.length < maxFindings) findings.push(f);
    else overflowCounts.set(f.id, (overflowCounts.get(f.id) ?? 0) + 1);
  };

  const productIds = new Set<string>();
  const variantIds = new Set<string>();
  let itemsChecked = 0;
  let truncated = false;

  if (source.format === "json-array") {
    add({
      id: "feed.format.bare-array",
      layer: "quality",
      severity: "info",
      path: "$",
      message:
        'Feed is a bare JSON array. The spec defines products.jsonl (one Product per line) or a {"products": [...]} envelope; a bare array is accepted by acp-check but is not a spec-defined shape.',
      fix: 'Publish products.jsonl for snapshots, or wrap the array: {"products": [...]}.',
      spec: {
        section: "Product Feeds RFC — §3.4 file ingestion",
        quote: "`products.jsonl` contains one `Product` object per line.",
        url: specUrl(specMeta.upstreamCommit, "rfcs/rfc.product_feeds.md"),
      },
    });
  }

  for await (const item of source.items) {
    if (!full && itemsChecked >= maxItems) {
      truncated = true;
      break;
    }
    itemsChecked++;
    const path = `products[${item.index}]`;

    if (item.parseError !== undefined) {
      add({
        id: "feed.jsonl.parse-error",
        layer: "conformance",
        severity: "fail",
        path,
        message: `Line ${item.index + 1} is not valid JSON: ${item.parseError}`,
        fix: "Each products.jsonl line must be exactly one complete JSON Product object (no trailing commas, no comments, no multi-line records).",
        spec: {
          section: "Product Feeds RFC — §3.4",
          quote: "`products.jsonl` contains one `Product` object per line.",
          url: specUrl(specMeta.upstreamCommit, "rfcs/rfc.product_feeds.md"),
        },
      });
      continue;
    }

    // CONFORMANCE: schema validation against the saved spec schema.
    const schemaFindings = schemaCheck("feed", "Product", item.value, {
      pathPrefix: path,
      idPrefix: "feed",
      maxFindings: 10,
    });
    schemaFindings.forEach(add);

    const product = item.value as ProductLike;

    // CONFORMANCE: ID uniqueness ("Stable global identifier").
    if (typeof product?.id === "string") {
      if (productIds.has(product.id)) {
        add({
          id: "feed.product.id.duplicate",
          layer: "conformance",
          severity: "fail",
          path: `${path}.id`,
          message: `Duplicate product id "${product.id}". Product ids must be stable, unique identifiers — agents key their index on them.`,
          fix: "De-duplicate the feed; if two records describe the same product, merge their variants under one Product.id.",
          spec: {
            section: "Feed schema — $defs/Product.id",
            quote: "Stable global identifier for this product.",
            url: specUrl(specMeta.upstreamCommit, FEED_SCHEMA_SOURCE),
          },
        });
      }
      productIds.add(product.id);
    }
    for (const [vi, v] of (Array.isArray(product?.variants) ? product.variants : []).entries()) {
      if (typeof v?.id !== "string") continue;
      if (variantIds.has(v.id)) {
        add({
          id: "feed.variant.id.duplicate",
          layer: "conformance",
          severity: "fail",
          path: `${path}.variants[${vi}].id`,
          message: `Duplicate variant id "${v.id}" (variant ids must be globally unique — they are the item identifiers passed to checkout).`,
          fix: "Give every purchasable variant a unique, stable id across the whole feed.",
          spec: {
            section: "Feed schema — $defs/Variant.id",
            quote: "Stable global identifier for this variant.",
            url: specUrl(specMeta.upstreamCommit, FEED_SCHEMA_SOURCE),
          },
        });
      }
      variantIds.add(v.id);
    }

    // QUALITY layer (skipped for records that failed schema at the root—noise).
    if (!conformanceOnly && item.value && typeof item.value === "object") {
      qualityChecks(item.value as never, path).forEach(add);
    }
  }

  if (itemsChecked === 0) {
    add({
      id: "feed.empty",
      layer: "conformance",
      severity: "fail",
      path: "$",
      message: "No products found in the feed.",
      fix: 'Check the feed shape: products.jsonl (one Product per line) or {"products": [...]}.',
    });
  }

  if (truncated) {
    add({
      id: "feed.truncated",
      layer: "quality",
      severity: "info",
      path: "$",
      message: `Validation stopped after ${itemsChecked} products (default cap). Later products were NOT checked.`,
      fix: "Re-run with --full to validate the entire feed.",
    });
  }

  const meta = await loadMetadata(target, opts.metadata).catch((err) => {
    add({
      id: "feed.metadata.unreadable",
      layer: "conformance",
      severity: "fail",
      path: "metadata",
      message: `Could not read feed metadata: ${(err as Error).message}`,
      fix: "Pass a valid FeedMetadata JSON file via --metadata.",
    });
    return null;
  });
  if (meta) checkMetadata(meta.raw, meta.source).forEach(add);

  let overflowTotal = 0;
  for (const n of overflowCounts.values()) overflowTotal += n;
  if (overflowTotal > 0) {
    findings.push({
      id: "feed.findings.truncated",
      layer: "quality",
      severity: "info",
      path: "$",
      message: `${overflowTotal} additional findings were suppressed (cap ${maxFindings}). Top suppressed: ${[...overflowCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([id, n]) => `${id} ×${n}`)
        .join(", ")}.`,
    });
  }

  return {
    command: "feed",
    target,
    startedAt,
    finishedAt: new Date().toISOString(),
    toolVersion: VERSION,
    specRelease: specMeta.specRelease,
    specCommit: specMeta.upstreamCommit,
    counts: countFindings(findings),
    stats: {
      format: source.format,
      itemsChecked,
      productIds: productIds.size,
      variantIds: variantIds.size,
      truncated,
      suppressedFindings: overflowTotal,
    },
    findings,
  };
}
