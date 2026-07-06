import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Finding, RunSummary } from "../findings.js";
import { specMeta } from "../schemas/validator.js";
import { VERSION } from "../version.js";

export const ARTIFACT_DIR = ".acp-check";

export async function saveRunArtifact(cwd: string, summary: RunSummary): Promise<string> {
  const dir = join(cwd, ARTIFACT_DIR);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${summary.command}-latest.json`);
  await writeFile(file, JSON.stringify(summary, null, 2));
  return file;
}

export async function loadRunArtifact(cwd: string, command: "feed" | "endpoints" | "webhook"): Promise<RunSummary | null> {
  try {
    return JSON.parse(await readFile(join(cwd, ARTIFACT_DIR, `${command}-latest.json`), "utf8")) as RunSummary;
  } catch {
    return null;
  }
}

export interface ReportSection {
  name: "Product feed" | "Checkout endpoints" | "Webhooks";
  command: "feed" | "endpoints" | "webhook";
  present: boolean;
  target?: string;
  finishedAt?: string;
  counts?: RunSummary["counts"];
  /** 0–100. Conformance failures dominate; warnings shave points. */
  score?: number;
  findings: Finding[];
}

export interface ReadinessReport {
  overall: "READY" | "NOT READY" | "INCOMPLETE";
  generatedAt: string;
  toolVersion: string;
  specRelease: string;
  specCommit: string;
  sections: ReportSection[];
  notes: string[];
}

export function scoreRun(summary: RunSummary): number {
  const { fail, warn } = summary.counts;
  if (fail > 0) return Math.max(0, 45 - 5 * (fail - 1) - warn);
  return Math.max(50, 100 - 4 * warn);
}

export function buildReport(runs: { feed?: RunSummary | null; endpoints?: RunSummary | null; webhook?: RunSummary | null }): ReadinessReport {
  const sections: ReportSection[] = (
    [
      ["Product feed", "feed", runs.feed],
      ["Checkout endpoints", "endpoints", runs.endpoints],
      ["Webhooks", "webhook", runs.webhook],
    ] as const
  ).map(([name, command, run]) => ({
    name,
    command,
    present: Boolean(run),
    target: run?.target,
    finishedAt: run?.finishedAt,
    counts: run?.counts,
    score: run ? scoreRun(run) : undefined,
    findings: run?.findings ?? [],
  }));

  const present = sections.filter((s) => s.present);
  const anyFail = present.some((s) => (s.counts?.fail ?? 0) > 0);
  const notes: string[] = [];
  if (present.length < sections.length) {
    const missing = sections.filter((s) => !s.present).map((s) => s.name.toLowerCase());
    notes.push(
      `No run recorded for: ${missing.join(", ")}. Run the corresponding acp-check command(s) first for a complete readiness picture.`
    );
  }
  const dryRun = runs.endpoints?.findings.some((f) => f.id === "endpoints.complete.dry-run");
  if (dryRun) {
    notes.push("The checkout complete step ran in dry-run mode (no order was created). Re-run endpoints with --allow-complete against a test environment before certifying.");
  }
  notes.push(
    "acp-check is an independent pre-flight tool and is not affiliated with OpenAI or Stripe. Passing here does not guarantee OpenAI conformance certification — it catches the violations detectable from outside."
  );

  const overall: ReadinessReport["overall"] =
    present.length === 0 ? "INCOMPLETE" : anyFail ? "NOT READY" : present.length < sections.length ? "INCOMPLETE" : "READY";

  return {
    overall,
    generatedAt: new Date().toISOString(),
    toolVersion: VERSION,
    specRelease: specMeta.specRelease,
    specCommit: specMeta.upstreamCommit,
    sections,
    notes,
  };
}
