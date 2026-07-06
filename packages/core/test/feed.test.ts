import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { validateFeed, FeedInputError } from "../src/index.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const ids = (findings: { id: string }[]) => new Set(findings.map((f) => f.id));

describe("feed validator — clean feed", () => {
  it("passes a spec-compliant feed with zero findings", async () => {
    const summary = await validateFeed(join(fixtures, "feed-clean.jsonl"));
    expect(summary.counts.fail).toBe(0);
    expect(summary.counts.warn).toBe(0);
    expect(summary.stats.itemsChecked).toBe(2);
    expect(summary.stats.format).toBe("jsonl");
  });
});

describe("feed validator — catches distinct violation types", () => {
  it("detects 10+ distinct violation types in one feed", async () => {
    const summary = await validateFeed(join(fixtures, "feed-violations.jsonl"));
    const found = ids(summary.findings);

    // CONFORMANCE (fail)
    const conformance = [
      "feed.schema.Product.type", //      price 19.99 is not an integer
      "feed.schema.Product.pattern", //   currency "usd" fails ^[A-Z]{3}$
      "feed.schema.Product.required", //  missing variant id / title
      "feed.schema.Product.additionalProperties", // unexpected "colour"
      "feed.schema.Product.format", //    "not a url" fails uri format
      "feed.product.id.duplicate",
      "feed.variant.id.duplicate",
      "feed.jsonl.parse-error",
    ];
    for (const id of conformance) expect(found, `expected conformance finding ${id}`).toContain(id);

    // QUALITY (warn/info)
    const quality = [
      "feed.variant.barcode.missing",
      "feed.variant.description.thin",
      "feed.variant.price.zero",
      "feed.variant.availability.missing",
      "feed.variant.media.missing",
      "feed.media.insecure-url",
      "feed.variant.listprice.below",
      "feed.variant.availability.unknown-status",
    ];
    for (const id of quality) expect(found, `expected quality finding ${id}`).toContain(id);

    // At least 10 DISTINCT violation ids total.
    const distinctViolations = [...found].filter((id) => id !== "feed.truncated");
    expect(distinctViolations.length).toBeGreaterThanOrEqual(10);
    expect(summary.counts.fail).toBeGreaterThan(0);
  });

  it("every finding carries an actionable message and most carry a fix", async () => {
    const summary = await validateFeed(join(fixtures, "feed-violations.jsonl"));
    for (const f of summary.findings) {
      expect(f.message.length).toBeGreaterThan(10);
      expect(f.path).toBeTruthy();
    }
    const withFix = summary.findings.filter((f) => f.fix).length;
    expect(withFix / summary.findings.length).toBeGreaterThan(0.7);
  });

  it("conformance findings trace to a saved spec file", async () => {
    const summary = await validateFeed(join(fixtures, "feed-violations.jsonl"));
    const conformance = summary.findings.filter((f) => f.layer === "conformance" && f.spec);
    expect(conformance.length).toBeGreaterThan(0);
    for (const f of conformance) {
      expect(f.spec?.section).toBeTruthy();
    }
  });
});

describe("feed validator — formats and inputs", () => {
  it("accepts a JSON envelope {\"products\": [...]}", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acpc-"));
    const file = join(dir, "feed.json");
    await writeFile(
      file,
      JSON.stringify({
        products: [
          {
            id: "p1",
            title: "Env Product",
            variants: [
              {
                id: "v1",
                title: "Env Variant",
                description: { plain: "A sufficiently long description to avoid the thin-description warning entirely." },
                price: { amount: 1000, currency: "USD" },
                availability: { available: true, status: "in_stock" },
                barcodes: [{ type: "GTIN", value: "00012345678905" }],
                media: [{ type: "image", url: "https://cdn.example.com/v1.jpg" }],
              },
            ],
          },
        ],
      })
    );
    const summary = await validateFeed(file);
    expect(summary.stats.format).toBe("json-envelope");
    expect(summary.counts.fail).toBe(0);
  });

  it("flags a bare JSON array as non-spec but still validates it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acpc-"));
    const file = join(dir, "feed.json");
    await writeFile(file, JSON.stringify([{ id: "p1", variants: [{ id: "v1", title: "T" }] }]));
    const summary = await validateFeed(file);
    expect(summary.stats.format).toBe("json-array");
    expect(ids(summary.findings)).toContain("feed.format.bare-array");
  });

  it("rejects CSV as a tool error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acpc-"));
    const file = join(dir, "feed.csv");
    await writeFile(file, "id,title\n1,x\n");
    await expect(validateFeed(file)).rejects.toBeInstanceOf(FeedInputError);
  });

  it("respects the item cap and flags truncation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acpc-"));
    const file = join(dir, "big.jsonl");
    const lines = Array.from({ length: 20 }, (_, i) =>
      JSON.stringify({ id: `p${i}`, title: `P${i}`, variants: [{ id: `v${i}`, title: `V${i}` }] })
    );
    await writeFile(file, lines.join("\n"));
    const summary = await validateFeed(file, { maxItems: 5 });
    expect(summary.stats.itemsChecked).toBe(5);
    expect(summary.stats.truncated).toBe(true);
    expect(ids(summary.findings)).toContain("feed.truncated");
  });

  it("validates the full feed with --full past the cap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acpc-"));
    const file = join(dir, "big.jsonl");
    const lines = Array.from({ length: 20 }, (_, i) =>
      JSON.stringify({ id: `p${i}`, title: `P${i}`, variants: [{ id: `v${i}`, title: `V${i}` }] })
    );
    await writeFile(file, lines.join("\n"));
    const summary = await validateFeed(file, { maxItems: 5, full: true });
    expect(summary.stats.itemsChecked).toBe(20);
    expect(summary.stats.truncated).toBe(false);
  });
});

describe("feed metadata staleness", () => {
  it("warns on very stale updated_at", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acpc-"));
    const file = join(dir, "products.jsonl");
    await writeFile(file, JSON.stringify({ id: "p", title: "P", variants: [{ id: "v", title: "V" }] }));
    const meta = join(dir, "metadata.json");
    await writeFile(meta, JSON.stringify({ id: "feed_x", updated_at: "2020-01-01T00:00:00Z" }));
    const summary = await validateFeed(file);
    expect(ids(summary.findings)).toContain("feed.metadata.stale");
  });
});
