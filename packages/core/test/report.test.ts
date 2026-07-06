import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RunSummary } from "../src/index.js";
import { buildReport, renderMarkdownReport, saveRunArtifact, loadRunArtifact, scoreRun } from "../src/index.js";

function run(command: RunSummary["command"], fail: number, warn = 0, info = 0): RunSummary {
  return {
    command,
    target: `mock-${command}`,
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: "2026-01-01T00:00:01Z",
    toolVersion: "0.1.0",
    specRelease: "2026-04-17",
    specCommit: "c2afc86",
    counts: { fail, warn, info },
    stats: {},
    findings: [
      ...Array.from({ length: fail }, (_, i) => ({ id: `f${i}`, layer: "conformance" as const, severity: "fail" as const, path: `p${i}`, message: `fail ${i}`, fix: `fix ${i}` })),
      ...Array.from({ length: warn }, (_, i) => ({ id: `w${i}`, layer: "quality" as const, severity: "warn" as const, path: `p${i}`, message: `warn ${i}` })),
    ],
  };
}

describe("report scoring", () => {
  it("scores a clean run at 100", () => {
    expect(scoreRun(run("feed", 0))).toBe(100);
  });
  it("penalizes failures below passing threshold", () => {
    expect(scoreRun(run("endpoints", 3))).toBeLessThan(50);
  });
  it("shaves points for warnings on an otherwise clean run", () => {
    expect(scoreRun(run("feed", 0, 5))).toBeLessThan(100);
    expect(scoreRun(run("feed", 0, 5))).toBeGreaterThanOrEqual(50);
  });
});

describe("buildReport", () => {
  it("marks NOT READY when any section fails", () => {
    const report = buildReport({ feed: run("feed", 0), endpoints: run("endpoints", 2), webhook: run("webhook", 0) });
    expect(report.overall).toBe("NOT READY");
  });
  it("marks READY when all three sections pass", () => {
    const report = buildReport({ feed: run("feed", 0), endpoints: run("endpoints", 0), webhook: run("webhook", 0) });
    expect(report.overall).toBe("READY");
  });
  it("marks INCOMPLETE when a section is missing", () => {
    const report = buildReport({ feed: run("feed", 0), endpoints: null, webhook: null });
    expect(report.overall).toBe("INCOMPLETE");
    expect(report.notes.join(" ")).toMatch(/checkout endpoints|webhooks/i);
  });
  it("always includes the independence disclaimer", () => {
    const report = buildReport({ feed: run("feed", 0) });
    expect(report.notes.join(" ")).toMatch(/not affiliated with OpenAI or Stripe/i);
  });
});

describe("markdown rendering", () => {
  it("renders a shareable report with badge, table, and fixes", () => {
    const md = renderMarkdownReport(buildReport({ feed: run("feed", 0), endpoints: run("endpoints", 1, 1) }));
    expect(md).toContain("# ACP Readiness Report");
    expect(md).toContain("NOT READY");
    expect(md).toContain("| Section | Status |");
    expect(md).toContain("**Fix:**");
  });
});

describe("artifacts round-trip", () => {
  it("saves and loads a run artifact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acpc-"));
    const summary = run("feed", 1);
    const file = await saveRunArtifact(dir, summary);
    expect(file).toMatch(/feed-latest\.json$/);
    const loaded = await loadRunArtifact(dir, "feed");
    expect(loaded?.counts.fail).toBe(1);
    expect(await loadRunArtifact(dir, "endpoints")).toBeNull();
  });
});
