/**
 * Finding model shared by every validator (feed, endpoints, webhook).
 *
 * Layers:
 *  - CONFORMANCE: violates the ACP spec; will plausibly fail OpenAI
 *    conformance certification. Severity FAIL affects the exit code.
 *  - QUALITY: does not violate the spec, but hurts product discovery /
 *    ranking or operational robustness. WARN/INFO only.
 */
export type FindingLayer = "conformance" | "quality";
export type FindingSeverity = "fail" | "warn" | "info";

export interface SpecReference {
  /** Human-readable pointer, e.g. "Product Feed schema — $defs/Variant" */
  section: string;
  /** Short verbatim quote from the saved spec file. */
  quote?: string;
  /** Link to the spec source (upstream repo path pinned to the snapshot commit). */
  url?: string;
}

export interface Finding {
  /** Stable machine id, e.g. "feed.variant.price.missing" */
  id: string;
  layer: FindingLayer;
  severity: FindingSeverity;
  /** Where: JSON path for feeds ("products[3].variants[0].price"), or "POST /checkout_sessions" for endpoints. */
  path: string;
  /** What failed, in one actionable sentence. */
  message: string;
  /** Which spec requirement, quoted. */
  spec?: SpecReference;
  /** Concrete fix suggestion. */
  fix?: string;
  /** Extra structured context (never contains secrets). */
  detail?: Record<string, unknown>;
}

export interface RunSummary {
  command: "feed" | "endpoints" | "webhook";
  target: string;
  startedAt: string;
  finishedAt: string;
  toolVersion: string;
  specRelease: string;
  specCommit: string;
  counts: { fail: number; warn: number; info: number };
  /** Command-specific stats, e.g. itemsChecked for feed, scenarios for endpoints. */
  stats: Record<string, unknown>;
  findings: Finding[];
}

export function countFindings(findings: Finding[]): RunSummary["counts"] {
  const counts = { fail: 0, warn: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  return counts;
}

export function passed(findings: Finding[], failOnWarn = false): boolean {
  return !findings.some(
    (f) => f.severity === "fail" || (failOnWarn && f.severity === "warn")
  );
}

const SPEC_REPO_BASE =
  "https://github.com/agentic-commerce-protocol/agentic-commerce-protocol/blob";

/** Builds a permalink into the upstream spec pinned at the snapshot commit. */
export function specUrl(commit: string, path: string): string {
  return `${SPEC_REPO_BASE}/${commit}/${path}`;
}
