# @acp-check/core

The validation engine behind [`acp-check`](https://www.npmjs.com/package/acp-check) — a pre-certification validator for [Agentic Commerce Protocol](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol) (ACP) integrations.

UI-free and importable. Every validator is generated from a pinned snapshot of the official ACP JSON Schemas / OpenAPI documents.

```ts
import { validateFeed, runEndpoints, verifySignature, buildReport } from "@acp-check/core";

const feed = await validateFeed("./products.jsonl");
console.log(feed.counts, feed.findings);

const endpoints = await runEndpoints({
  baseUrl: "https://api.shop.com",
  authToken: process.env.ACP_CHECK_TOKEN,
  itemId: "SKU123",
});
```

See the [main README](https://github.com/acp-check/acp-check#readme) for the full CLI and documentation. Independent tool — not affiliated with OpenAI or Stripe.

## License

MIT
