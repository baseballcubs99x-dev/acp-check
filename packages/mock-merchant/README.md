# @acp-check/mock-merchant

In-memory reference [Agentic Commerce Protocol](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol) merchant server, used to test [`acp-check`](https://www.npmjs.com/package/acp-check). Passes every acp-check scenario in clean mode, and can deliberately violate specific rules via `--broken`.

```bash
npx --package @acp-check/mock-merchant acp-mock-merchant --port 4319
npx --package @acp-check/mock-merchant acp-mock-merchant --broken missing-total,no-auth
npx --package @acp-check/mock-merchant acp-mock-merchant --emit-feed ./products.jsonl
```

Run `acp-mock-merchant --help` for the full list of `--broken` scenarios. Independent tool — not affiliated with OpenAI or Stripe. MIT.
