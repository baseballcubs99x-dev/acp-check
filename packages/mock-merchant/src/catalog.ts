/** Tiny in-memory catalog. item_123 is the default happy-path SKU. */
export interface CatalogItem {
  id: string;
  name: string;
  unitAmount: number; // minor units
  inStock: boolean;
}

export const CATALOG: Record<string, CatalogItem> = {
  item_123: { id: "item_123", name: "Aeropress Go Travel Coffee Press", unitAmount: 3999, inStock: true },
  item_456: { id: "item_456", name: "Fellow Stagg EKG Electric Kettle", unitAmount: 16500, inStock: true },
  item_oos: { id: "item_oos", name: "Limited Edition Ceramic Dripper", unitAmount: 5400, inStock: false },
};

export const DEFAULT_ITEM = "item_123";
export const DEFAULT_OOS_ITEM = "item_oos";

/** Product feed (JSONL-ready Product objects) matching the catalog. */
export function feedProducts(): unknown[] {
  return [
    {
      id: "prod_aeropress",
      title: "Aeropress Go Travel Coffee Press",
      description: {
        plain: "A compact, near-indestructible coffee press that brews rich, smooth cups anywhere. Includes a stirrer, scoop, and 350 micro-filters that pack neatly inside the mug.",
      },
      url: "https://shop.example.com/products/aeropress-go",
      media: [{ type: "image", url: "https://cdn.example.com/aeropress-go/main.jpg", alt_text: "Aeropress Go on a kitchen counter" }],
      variants: [
        {
          id: "item_123",
          title: "Aeropress Go — Standard",
          description: { plain: "The standard Aeropress Go kit with travel mug and lid. Brews 1–3 cups in under a minute." },
          url: "https://shop.example.com/products/aeropress-go",
          barcodes: [{ type: "GTIN", value: "00819693010203" }],
          price: { amount: 3999, currency: "USD" },
          availability: { available: true, status: "in_stock" },
          variant_options: [{ name: "Kit", value: "Standard" }],
          media: [{ type: "image", url: "https://cdn.example.com/aeropress-go/standard.jpg", alt_text: "Standard kit" }],
        },
      ],
    },
    {
      id: "prod_stagg_ekg",
      title: "Fellow Stagg EKG Electric Kettle",
      description: {
        plain: "A precision pour-over kettle with variable temperature control to the degree, a built-in brew stopwatch, and a counterbalanced handle for a steady, controlled pour.",
      },
      url: "https://shop.example.com/products/stagg-ekg",
      media: [{ type: "image", url: "https://cdn.example.com/stagg-ekg/main.jpg", alt_text: "Stagg EKG kettle" }],
      variants: [
        {
          id: "item_456",
          title: "Stagg EKG — Matte Black",
          description: { plain: "Matte black finish. 0.9 L capacity, 1200 W, temperature control from 135–212°F." },
          url: "https://shop.example.com/products/stagg-ekg?variant=matte-black",
          barcodes: [{ type: "GTIN", value: "00860003790011" }],
          price: { amount: 16500, currency: "USD" },
          list_price: { amount: 19500, currency: "USD" },
          availability: { available: true, status: "in_stock" },
          variant_options: [{ name: "Color", value: "Matte Black" }],
          media: [{ type: "image", url: "https://cdn.example.com/stagg-ekg/black.jpg", alt_text: "Matte black kettle" }],
        },
      ],
    },
  ];
}

export function feedMetadata(): unknown {
  return { id: "feed_mock_merchant", target_country: "US", updated_at: new Date().toISOString() };
}
