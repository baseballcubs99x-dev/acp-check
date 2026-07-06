#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { startMockMerchant } from "./server.js";
import { feedProducts, feedMetadata } from "./catalog.js";
import { BROKEN_SCENARIOS, isBrokenScenario, type BrokenScenario } from "./broken.js";

function parseArgs(argv: string[]) {
  const out: { port?: number; broken: BrokenScenario[]; token?: string; emitFeed?: string; help?: boolean } = { broken: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--token") out.token = argv[++i];
    else if (a === "--emit-feed") out.emitFeed = argv[++i];
    else if (a === "--broken") {
      const s = argv[++i] ?? "";
      for (const scenario of s.split(",").map((x) => x.trim()).filter(Boolean)) {
        if (isBrokenScenario(scenario)) out.broken.push(scenario);
        else {
          process.stderr.write(`Unknown --broken scenario: ${scenario}\n`);
          process.exit(2);
        }
      }
    }
  }
  return out;
}

function usage() {
  process.stdout.write(
    [
      "acp-mock-merchant — in-memory reference ACP merchant for testing acp-check",
      "",
      "Usage: acp-mock-merchant [--port <n>] [--token <t>] [--broken <a,b,...>] [--emit-feed <file.jsonl>]",
      "",
      "Broken scenarios:",
      ...Object.entries(BROKEN_SCENARIOS).map(([k, v]) => `  ${k.padEnd(26)} ${v}`),
      "",
    ].join("\n")
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();

  if (args.emitFeed) {
    const jsonl = feedProducts().map((p) => JSON.stringify(p)).join("\n") + "\n";
    await writeFile(args.emitFeed, jsonl);
    await writeFile(args.emitFeed.replace(/[^/]*$/, "metadata.json"), JSON.stringify(feedMetadata(), null, 2));
    process.stdout.write(`Wrote ${args.emitFeed} (+ metadata.json)\n`);
    return;
  }

  const merchant = await startMockMerchant({ port: args.port, broken: args.broken, authToken: args.token });
  process.stdout.write(`Mock ACP merchant listening on ${merchant.url}\n`);
  process.stdout.write(`  Auth token: ${args.token ?? "test_merchant_token"}\n`);
  process.stdout.write(`  Feed item id: item_123 (in stock), item_oos (out of stock)\n`);
  if (args.broken.length) process.stdout.write(`  BROKEN modes: ${args.broken.join(", ")}\n`);
  const shutdown = () => merchant.close().then(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.stack : e}\n`);
  process.exit(1);
});
