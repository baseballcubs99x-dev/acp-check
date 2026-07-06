import pc from "picocolors";
import type { Finding, RunSummary } from "@acp-check/core";

export interface RenderOptions {
  quiet?: boolean;
  verbose?: boolean;
}

const SEV = {
  fail: (s: string) => pc.red(pc.bold(s)),
  warn: (s: string) => pc.yellow(s),
  info: (s: string) => pc.blue(s),
};
const SEV_TAG: Record<Finding["severity"], string> = { fail: "FAIL", warn: "WARN", info: "INFO" };
const LAYER_TAG: Record<Finding["layer"], string> = { conformance: "CONFORMANCE", quality: "QUALITY" };

function rank(f: Finding): number {
  return f.severity === "fail" ? 0 : f.severity === "warn" ? 1 : 2;
}

function renderFinding(f: Finding, verbose: boolean): string {
  const color = SEV[f.severity];
  const layer = f.layer === "conformance" ? pc.magenta(LAYER_TAG[f.layer]) : pc.dim(LAYER_TAG[f.layer]);
  const lines: string[] = [];
  lines.push(`  ${color(SEV_TAG[f.severity])} ${layer}  ${pc.cyan(f.path)}`);
  lines.push(`    ${f.message}`);
  if (f.fix) lines.push(`    ${pc.green("fix:")} ${f.fix}`);
  if (f.spec?.quote && (verbose || f.severity === "fail")) {
    lines.push(`    ${pc.dim(`spec: ${f.spec.section}`)}`);
    lines.push(`    ${pc.dim(`      “${f.spec.quote}”`)}`);
    if (verbose && f.spec.url) lines.push(`    ${pc.dim(`      ${f.spec.url}`)}`);
  } else if (f.spec?.section && verbose) {
    lines.push(`    ${pc.dim(`spec: ${f.spec.section}`)}`);
  }
  return lines.join("\n");
}

export function renderSummary(summary: RunSummary, opts: RenderOptions = {}): string {
  const out: string[] = [];
  const { fail, warn, info } = summary.counts;
  const findings = [...summary.findings].sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));

  const shown = opts.quiet ? findings.filter((f) => f.severity === "fail") : findings;
  if (shown.length > 0) out.push("");
  for (const f of shown) {
    if (opts.quiet && f.severity !== "fail") continue;
    out.push(renderFinding(f, Boolean(opts.verbose)));
    out.push("");
  }

  const verdict = fail > 0 ? pc.red(pc.bold("✗ CONFORMANCE FAILURES")) : warn > 0 ? pc.yellow("✓ conformance passed (with warnings)") : pc.green(pc.bold("✓ PASSED"));
  out.push(
    `${verdict}  ${pc.red(`${fail} fail`)} · ${pc.yellow(`${warn} warn`)} · ${pc.blue(`${info} info`)}`
  );
  if (opts.verbose) {
    out.push(pc.dim(`  spec ${summary.specRelease} (commit ${summary.specCommit.slice(0, 10)}) · acp-check ${summary.toolVersion}`));
    out.push(pc.dim(`  ${JSON.stringify(summary.stats)}`));
  }
  return out.join("\n");
}

export function banner(text: string): string {
  const line = "─".repeat(Math.min(text.length + 2, 60));
  return `${pc.dim(line)}\n ${pc.bold(text)}\n${pc.dim(line)}`;
}

export function warnBanner(text: string): string {
  return pc.bgYellow(pc.black(` ⚠ ${text} `));
}
