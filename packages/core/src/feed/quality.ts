/**
 * QUALITY layer for product feeds. Nothing here fails certification — these
 * checks flag content that hurts discovery/ranking inside agent surfaces.
 * Spec basis: rfc.product_feeds.md §1.1 ("What Agents Do With a Feed") —
 * agents match intent using title, description, category, price, availability,
 * media, barcodes, seller, and URLs. Missing signals = fewer matches.
 */
import type { Finding } from "../findings.js";
import { specUrl } from "../findings.js";
import { specMeta } from "../schemas/validator.js";

const RFC = "rfcs/rfc.product_feeds.md";

interface Media {
  type?: string;
  url?: string;
}
interface Price {
  amount?: number;
  currency?: string;
}
interface Variant {
  id?: string;
  title?: string;
  description?: { plain?: string; html?: string; markdown?: string };
  url?: string;
  barcodes?: { type?: string; value?: string }[];
  price?: Price;
  list_price?: Price;
  availability?: { available?: boolean; status?: string };
  variant_options?: unknown[];
  media?: Media[];
  seller?: { name?: string };
}
interface Product {
  id?: string;
  title?: string;
  description?: { plain?: string; html?: string; markdown?: string };
  url?: string;
  media?: Media[];
  variants?: Variant[];
}

/** "Known values include…" — open enum, see SPEC_NOTES §7. */
const KNOWN_AVAILABILITY = ["in_stock", "limited_stock", "backorder", "preorder", "out_of_stock", "discontinued"];
const THIN_DESCRIPTION_CHARS = 50;
const LONG_TITLE_CHARS = 150;

function rfcRef(section: string, quote: string) {
  return { section: `Product Feeds RFC — ${section}`, quote, url: specUrl(specMeta.upstreamCommit, RFC) };
}

function q(id: string, severity: "warn" | "info", path: string, message: string, fix: string, spec?: Finding["spec"]): Finding {
  return { id, layer: "quality", severity, path, message, fix, spec };
}

function descriptionLength(d?: { plain?: string; html?: string; markdown?: string }): number {
  if (!d) return 0;
  const text = d.plain ?? d.markdown ?? d.html?.replace(/<[^>]*>/g, "") ?? "";
  return text.trim().length;
}

export function qualityChecks(product: Product, path: string): Finding[] {
  const findings: Finding[] = [];
  const push = (f: Finding | null) => f && findings.push(f);

  // ---------- product level ----------
  if (!product.title) {
    push(
      q(
        "feed.product.title.missing",
        "warn",
        `${path}.title`,
        "Product has no title. Agents match buyer intent primarily on title; untitled products are effectively undiscoverable.",
        "Add a concise, descriptive title (brand + product type + key attribute).",
        rfcRef("§1.1", "Match buyer intent to concrete purchasable variants, using attributes such as title, description, category…")
      )
    );
  } else {
    if (product.title.length > LONG_TITLE_CHARS) {
      push(
        q(
          "feed.product.title.long",
          "info",
          `${path}.title`,
          `Product title is ${product.title.length} chars; long titles get truncated in agent UIs.`,
          `Keep titles under ~${LONG_TITLE_CHARS} characters; move details into description.`
        )
      );
    }
    if (product.title.length > 12 && product.title === product.title.toUpperCase() && /[A-Z]/.test(product.title)) {
      push(
        q(
          "feed.product.title.allcaps",
          "info",
          `${path}.title`,
          "Product title is ALL CAPS, which reads as low-quality in agent surfaces.",
          "Use sentence or title case."
        )
      );
    }
  }

  const productDescLen = descriptionLength(product.description);
  const productMedia = product.media ?? [];
  if (!product.url) {
    push(
      q(
        "feed.product.url.missing",
        "info",
        `${path}.url`,
        "Product has no canonical URL; agents cannot link buyers to a product page for review.",
        "Add the canonical product detail page URL.",
        rfcRef("§1.1", "…explain choices to buyers… canonical product URLs.")
      )
    );
  }

  const variants = product.variants ?? [];
  if (variants.length > 1) {
    const anyOptions = variants.some((v) => (v.variant_options ?? []).length > 0);
    if (!anyOptions) {
      push(
        q(
          "feed.variant.options.missing",
          "info",
          `${path}.variants`,
          `Product has ${variants.length} variants but none declare variant_options; agents cannot tell them apart (size? color?).`,
          'Add variant_options like {"name": "Size", "value": "M"} to each variant.'
        )
      );
    }
  }

  // currency consistency within a product
  const currencies = new Set(variants.map((v) => v.price?.currency).filter(Boolean));
  if (currencies.size > 1) {
    push(
      q(
        "feed.product.currency.mixed",
        "warn",
        `${path}.variants`,
        `Variants of one product use ${currencies.size} different currencies (${[...currencies].join(", ")}); most agents treat this as inconsistent data.`,
        "Use one currency per feed (create per-market feeds via target_country instead).",
        rfcRef("§3.1", "Merchants MAY create multiple feeds for different markets…")
      )
    );
  }

  const seenBarcodes = new Map<string, string>();

  // ---------- variant level ----------
  variants.forEach((v, vi) => {
    const vp = `${path}.variants[${vi}]`;

    const descLen = Math.max(descriptionLength(v.description), productDescLen);
    if (descLen === 0) {
      push(
        q(
          "feed.variant.description.missing",
          "warn",
          `${vp}.description`,
          "No description on variant or parent product. Descriptions drive semantic matching in agent search.",
          "Add a description ({\"plain\": …}); aim for 2–3 informative sentences.",
          rfcRef("§1.1", "Match buyer intent … using attributes such as title, description, category, condition…")
        )
      );
    } else if (descLen < THIN_DESCRIPTION_CHARS) {
      push(
        q(
          "feed.variant.description.thin",
          "warn",
          `${vp}.description`,
          `Description is only ${descLen} chars (<${THIN_DESCRIPTION_CHARS}). Thin descriptions rank poorly in discovery.`,
          "Expand to at least a couple of sentences covering material, use case, and fit."
        )
      );
    }

    if (!v.barcodes || v.barcodes.length === 0) {
      push(
        q(
          "feed.variant.barcode.missing",
          "warn",
          `${vp}.barcodes`,
          "Variant has no barcode (GTIN/UPC/EAN). Barcodes let agents match your product to reviews, price history, and cross-merchant comparisons.",
          'Add {"type": "GTIN", "value": "<14-digit GTIN>"} where available.',
          rfcRef("$defs/Barcode", "Machine-readable identifier attached to a variant, such as a GTIN or UPC.")
        )
      );
    } else {
      for (const b of v.barcodes) {
        if (!b.value) continue;
        const key = `${b.type ?? ""}:${b.value}`;
        const prior = seenBarcodes.get(key);
        if (prior) {
          push(
            q(
              "feed.variant.barcode.duplicate",
              "warn",
              `${vp}.barcodes`,
              `Barcode ${b.value} is also used by ${prior}; distinct purchasable variants should not share a GTIN.`,
              "Assign each purchasable variant its own GTIN, or merge duplicate variants."
            )
          );
        } else seenBarcodes.set(key, v.id ?? vp);
        if (b.type?.toUpperCase() === "GTIN" && !/^\d{8}(\d{4,6})?$/.test(b.value)) {
          push(
            q(
              "feed.variant.barcode.malformed",
              "warn",
              `${vp}.barcodes`,
              `"${b.value}" does not look like a valid GTIN (expected 8, 12, 13, or 14 digits).`,
              "Provide the numeric GTIN exactly as registered (include leading zeros)."
            )
          );
        }
      }
    }

    if (!v.price) {
      push(
        q(
          "feed.variant.price.missing",
          "warn",
          `${vp}.price`,
          "Variant has no price. Agents filter by price before recommending; unpriced variants are usually skipped.",
          'Add {"amount": <minor units>, "currency": "USD"}.',
          rfcRef("§1.2", "The agent filters variants by price, availability, condition…")
        )
      );
    } else {
      if (v.price.amount === 0) {
        push(
          q(
            "feed.variant.price.zero",
            "warn",
            `${vp}.price.amount`,
            "Price amount is 0. Unless this item is genuinely free, a zero price is treated as bad data by agents.",
            "Set the real selling price in minor units (1999 = $19.99)."
          )
        );
      }
      if (v.list_price?.amount !== undefined && v.price.amount !== undefined && v.list_price.amount < v.price.amount) {
        push(
          q(
            "feed.variant.listprice.below",
            "warn",
            `${vp}.list_price.amount`,
            `list_price (${v.list_price.amount}) is lower than price (${v.price.amount}); list_price is the pre-discount reference price and should be ≥ price.`,
            "Swap the values or drop list_price when there is no discount."
          )
        );
      }
    }

    if (!v.availability) {
      push(
        q(
          "feed.variant.availability.missing",
          "warn",
          `${vp}.availability`,
          "Variant has no availability. Agents will not recommend items they cannot confirm are purchasable.",
          'Add {"available": true, "status": "in_stock"} and keep it fresh.',
          rfcRef("§1.2 Availability Change Before Checkout", "The agent sees the updated availability and asks the buyer to choose a substitute…")
        )
      );
    } else if (v.availability.status && !KNOWN_AVAILABILITY.includes(v.availability.status)) {
      push(
        q(
          "feed.variant.availability.unknown-status",
          "warn",
          `${vp}.availability.status`,
          `availability.status "${v.availability.status}" is not one of the documented values (${KNOWN_AVAILABILITY.join(", ")}). The enum is extensible, but unknown values may be ignored by agents.`,
          "Prefer a documented status value. See SPEC_NOTES.md §7."
        )
      );
    }

    const media = (v.media ?? []).concat(productMedia);
    if (media.length === 0) {
      push(
        q(
          "feed.variant.media.missing",
          "warn",
          `${vp}.media`,
          "No media on variant or parent product. Buyers are shown images before choosing; imageless items convert poorly.",
          'Add at least one {"type": "image", "url": "https://…"} (first item is the primary listing asset).',
          rfcRef("$defs/Variant.media", "Media assets specific to this variant. The first item is the primary listing asset.")
        )
      );
    } else {
      media
        .filter((m) => m.url?.startsWith("http://"))
        .forEach((m) => {
          push(
            q(
              "feed.media.insecure-url",
              "warn",
              `${vp}.media`,
              `Media URL uses http:// (${m.url}); agents may refuse to proxy non-TLS assets.`,
              "Serve all media over https://."
            )
          );
        });
    }

    if (!v.url) {
      push(
        q(
          "feed.variant.url.missing",
          "info",
          `${vp}.url`,
          "Variant has no canonical URL.",
          "Add the variant detail page URL (may include a variant query param)."
        )
      );
    }
  });

  return findings;
}
