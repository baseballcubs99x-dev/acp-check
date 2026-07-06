#!/usr/bin/env node
import { Command } from "commander";
import pc from "picocolors";
import { readFile } from "node:fs/promises";
import {
  validateFeed,
  FeedInputError,
  runEndpoints,
  looksLikeTestTarget,
  verifySignature,
  startReceiver,
  buildReport,
  loadRunArtifact,
  saveRunArtifact,
  renderMarkdownReport,
  passed,
  VERSION,
  specMeta,
  type RunSummary,
} from "@acp-check/core";
import { renderSummary, banner, warnBanner } from "./render.js";

const program = new Command();

program
  .name("acp-check")
  .description("Validate Agentic Commerce Protocol (ACP) integrations before OpenAI conformance certification.")
  .version(VERSION, "-V, --version")
  .addHelpText(
    "after",
    `\nSpec: ACP release ${specMeta.specRelease} (commit ${specMeta.upstreamCommit.slice(0, 10)}).` +
      `\nIndependent tool — not affiliated with OpenAI or Stripe.\n`
  );

/** Emit machine-readable output and pick the process exit code. */
function finish(summary: RunSummary, opts: { json?: boolean; failOnWarn?: boolean; quiet?: boolean; verbose?: boolean }): never {
  if (opts.json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  } else {
    process.stdout.write(renderSummary(summary, { quiet: opts.quiet, verbose: opts.verbose }) + "\n");
  }
  process.exit(passed(summary.findings, opts.failOnWarn) ? 0 : 1);
}

function toolError(message: string): never {
  process.stderr.write(pc.red(`error: ${message}`) + "\n");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// feed
// ---------------------------------------------------------------------------
program
  .command("feed")
  .argument("<url-or-file>", "product feed URL or local file (.jsonl / .ndjson / .json)")
  .description("Validate a product feed against the ACP Product Feed spec")
  .option("--full", "validate every item (default caps at 5,000)", false)
  .option("--max-items <n>", "cap on items validated", (v) => parseInt(v, 10), 5000)
  .option("--metadata <file>", "FeedMetadata JSON (for updated_at / target_country checks)")
  .option("--conformance-only", "skip the QUALITY layer", false)
  .option("--json", "output machine-readable JSON", false)
  .option("--quiet", "only show failures", false)
  .option("--verbose", "show spec quotes and links for every finding", false)
  .option("--fail-on-warn", "exit non-zero on warnings too", false)
  .option("--no-save", "do not write .acp-check/feed-latest.json")
  .action(async (target, opts) => {
    try {
      if (!opts.json && !opts.quiet) process.stdout.write(banner(`acp-check feed · ${target}`) + "\n");
      const summary = await validateFeed(target, {
        full: opts.full,
        maxItems: opts.maxItems,
        metadata: opts.metadata,
        conformanceOnly: opts.conformanceOnly,
      });
      if (opts.save !== false) await saveRunArtifact(process.cwd(), summary).catch(() => {});
      finish(summary, opts);
    } catch (err) {
      if (err instanceof FeedInputError) toolError(err.message);
      toolError(err instanceof Error ? err.message : String(err));
    }
  });

// ---------------------------------------------------------------------------
// endpoints
// ---------------------------------------------------------------------------
program
  .command("endpoints")
  .argument("<base-url>", "base URL of the Agentic Checkout API")
  .description("Probe an Agentic Checkout API as a simulated agent (5 scenario groups)")
  .option("--auth-token <token>", "bearer token (or set ACP_CHECK_TOKEN)")
  .option("--item <id>", "an in-stock item/variant id from the merchant's feed", "item_123")
  .option("--oos-item <id>", "a known out-of-stock item id (enables the OOS scenario)")
  .option("--currency <code>", "ISO 4217 currency", "usd")
  .option("--api-version <v>", "API-Version header", specMeta.specRelease)
  .option("--allow-complete", "actually POST /complete with a TEST token (order will be created)", false)
  .option("--skip-auth-probe", "do not send unauthenticated probes", false)
  .option("--timeout <ms>", "per-request timeout", (v) => parseInt(v, 10), 15000)
  .option("--json", "output machine-readable JSON", false)
  .option("--quiet", "only show failures", false)
  .option("--verbose", "show spec quotes, links, and request stats", false)
  .option("--fail-on-warn", "exit non-zero on warnings too", false)
  .option("--no-save", "do not write .acp-check/endpoints-latest.json")
  .action(async (baseUrl, opts) => {
    const token = opts.authToken ?? process.env.ACP_CHECK_TOKEN;
    if (!opts.json) {
      process.stdout.write(banner(`acp-check endpoints · ${baseUrl}`) + "\n");
      if (!looksLikeTestTarget(baseUrl)) {
        process.stdout.write(
          warnBanner(`${baseUrl} looks like a PRODUCTION endpoint. acp-check will send test traffic (User-Agent: acp-check/${VERSION}).`) + "\n"
        );
        if (opts.allowComplete)
          process.stdout.write(warnBanner("--allow-complete is set: a real order may be created. Use a test/sandbox environment.") + "\n");
      }
      if (!token) process.stdout.write(pc.yellow("note: no auth token provided; auth-required probes will still run.\n"));
    }
    try {
      const summary = await runEndpoints({
        baseUrl,
        authToken: token,
        itemId: opts.item,
        outOfStockItemId: opts.oosItem,
        currency: opts.currency,
        apiVersion: opts.apiVersion,
        allowComplete: opts.allowComplete,
        skipAuthProbe: opts.skipAuthProbe,
        timeoutMs: opts.timeout,
      });
      if (opts.save !== false) await saveRunArtifact(process.cwd(), summary).catch(() => {});
      finish(summary, opts);
    } catch (err) {
      toolError(err instanceof Error ? err.message : String(err));
    }
  });

// ---------------------------------------------------------------------------
// webhook
// ---------------------------------------------------------------------------
const webhook = program.command("webhook").description("Webhook signature verification and local capture");

webhook
  .command("verify")
  .description("Verify a Merchant-Signature offline")
  .requiredOption("--secret <secret>", "shared signing secret")
  .requiredOption("--payload <file>", "raw request body file")
  .requiredOption("--signature <sig>", "Merchant-Signature header value (t=…,v1=…)")
  .option("--tolerance <seconds>", "timestamp window", (v) => parseInt(v, 10), 300)
  .option("--json", "output machine-readable JSON", false)
  .option("--verbose", "show spec quotes", false)
  .action(async (opts) => {
    try {
      const raw = await readFile(opts.payload);
      const result = verifySignature(opts.secret, raw, opts.signature, { toleranceSeconds: opts.tolerance });
      if (opts.json) {
        process.stdout.write(JSON.stringify({ valid: result.valid, findings: result.findings }, null, 2) + "\n");
      } else if (result.valid) {
        process.stdout.write(pc.green(pc.bold("✓ signature valid")) + "\n");
      } else {
        for (const f of result.findings) {
          process.stdout.write(`${pc.red("✗")} ${f.message}\n`);
          if (f.fix) process.stdout.write(`  ${pc.green("fix:")} ${f.fix}\n`);
          if (opts.verbose && f.spec?.quote) process.stdout.write(`  ${pc.dim(`spec: “${f.spec.quote}”`)}\n`);
        }
      }
      process.exit(result.valid ? 0 : 1);
    } catch (err) {
      toolError(err instanceof Error ? err.message : String(err));
    }
  });

webhook
  .command("listen")
  .description("Start a local webhook receiver that validates payloads and signatures")
  .option("--port <n>", "port (0 = random)", (v) => parseInt(v, 10), 4319)
  .option("--secret <secret>", "shared secret to verify Merchant-Signature (optional)")
  .option("--tolerance <seconds>", "timestamp window", (v) => parseInt(v, 10), 300)
  .action(async (opts) => {
    const receiver = await startReceiver({
      port: opts.port,
      secret: opts.secret,
      toleranceSeconds: opts.tolerance,
      onDelivery: (d) => {
        const ok = d.findings.every((f) => f.severity !== "fail");
        const tag = ok ? pc.green("✓") : pc.red("✗");
        process.stdout.write(`${tag} ${new Date(d.receivedAt).toLocaleTimeString()} ${d.eventType ?? "(no type)"}${opts.secret ? (d.signatureValid ? pc.dim(" [signature ok]") : pc.red(" [signature FAILED]")) : ""}\n`);
        for (const f of d.findings.filter((x) => x.severity !== "info")) {
          process.stdout.write(`   ${f.severity === "fail" ? pc.red("FAIL") : pc.yellow("WARN")} ${f.message}\n`);
          if (f.fix) process.stdout.write(`     ${pc.green("fix:")} ${f.fix}\n`);
        }
      },
    });
    process.stdout.write(banner("acp-check webhook listener") + "\n");
    process.stdout.write(`Receiver URL:  ${pc.cyan(receiver.url)}\n`);
    process.stdout.write(`Signature:     ${opts.secret ? "verifying with provided secret" : pc.yellow("NOT verifying (pass --secret to enable)")}\n\n`);
    process.stdout.write(pc.dim("Expose to the internet for real deliveries, e.g.:\n"));
    process.stdout.write(pc.dim(`  ngrok http ${receiver.port}\n`));
    process.stdout.write(pc.dim(`  cloudflared tunnel --url http://localhost:${receiver.port}\n\n`));
    process.stdout.write(pc.dim("Waiting for deliveries… (Ctrl+C to stop)\n"));
    const shutdown = async () => {
      process.stdout.write(`\n${banner("summary")}\n`);
      process.stdout.write(renderSummary(receiver.summary()) + "\n");
      await receiver.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
program
  .command("report")
  .description("Aggregate the latest feed + endpoints + webhook runs into a readiness report")
  .option("--json", "output machine-readable JSON", false)
  .option("--md", "output a shareable Markdown report", false)
  .option("--dir <dir>", "directory containing .acp-check artifacts", process.cwd())
  .action(async (opts) => {
    const [feed, endpoints, wh] = await Promise.all([
      loadRunArtifact(opts.dir, "feed"),
      loadRunArtifact(opts.dir, "endpoints"),
      loadRunArtifact(opts.dir, "webhook"),
    ]);
    if (!feed && !endpoints && !wh) {
      toolError(`No run artifacts found in ${opts.dir}/.acp-check. Run 'acp-check feed' and/or 'acp-check endpoints' first.`);
    }
    const report = buildReport({ feed, endpoints, webhook: wh });
    if (opts.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    } else if (opts.md) {
      process.stdout.write(renderMarkdownReport(report) + "\n");
    } else {
      process.stdout.write(renderTerminalReport(report) + "\n");
    }
    process.exit(report.overall === "NOT READY" ? 1 : 0);
  });

function renderTerminalReport(report: ReturnType<typeof buildReport>): string {
  const out: string[] = [];
  const badge =
    report.overall === "READY" ? pc.bgGreen(pc.black(" READY ")) : report.overall === "NOT READY" ? pc.bgRed(pc.white(" NOT READY ")) : pc.bgYellow(pc.black(" INCOMPLETE "));
  out.push(banner("ACP Readiness Report"));
  out.push(`\nOverall: ${badge}\n`);
  for (const s of report.sections) {
    if (!s.present) {
      out.push(`  ${pc.dim("○")} ${s.name.padEnd(20)} ${pc.dim("not run")}`);
      continue;
    }
    const c = s.counts!;
    const mark = c.fail > 0 ? pc.red("✗") : pc.green("✓");
    out.push(`  ${mark} ${s.name.padEnd(20)} score ${String(s.score).padStart(3)}/100   ${pc.red(`${c.fail} fail`)} · ${pc.yellow(`${c.warn} warn`)} · ${pc.blue(`${c.info} info`)}`);
  }
  const fails = report.sections.flatMap((s) => s.findings).filter((f) => f.severity === "fail");
  if (fails.length) {
    out.push(`\n${pc.bold("Blocking failures:")}`);
    for (const f of fails.slice(0, 20)) out.push(`  ${pc.red("✗")} ${pc.cyan(f.path)} — ${f.message}`);
    if (fails.length > 20) out.push(pc.dim(`  …and ${fails.length - 20} more (see 'acp-check report --md').`));
  }
  out.push("");
  for (const n of report.notes) out.push(pc.dim(`• ${n}`));
  return out.join("\n");
}

program.parseAsync().catch((err) => toolError(err instanceof Error ? err.message : String(err)));
