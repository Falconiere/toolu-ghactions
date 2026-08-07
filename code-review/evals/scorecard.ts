// evals/scorecard.ts — the AC-16 scorecard: its shape, the pure functions that
// derive each field from what a live run actually produced (never invented),
// and the human-table / JSON renderers. Kept free of gh/git/network so every
// function here is directly unit-testable with synthetic data.
//
// AC-16 (spec): "prints a scorecard — files, strata counts, packages, model
// calls, findings raw vs clustered, coverage statuses, marker bytes vs
// BODY_SIZE_LIMIT, wall time".
import type { Stratum, PatternGroup } from "@/git/distill.js";
import type { ReviewState, Finding } from "@/state.js";

/** Mirrors the PRIVATE `BODY_SIZE_LIMIT` in src/review/verdict.ts (not
 *  exported) — keep this in sync if that constant ever changes. */
export const BODY_SIZE_LIMIT = 65000;

/** Every Layer-0 stratum, zero-filled so the table always shows every row. */
export type StrataCounts = Record<Stratum, number>;

/** The full AC-16 scorecard for one live run. */
export interface Scorecard {
  pr: { owner: string; repo: string; number: number };
  provider: string;
  model: string;
  changedFiles: number;
  strata: StrataCounts;
  patternGroups: { count: number; biggestExemplar: string | null; biggestMembers: number };
  /** Layer-2 model calls observed (cartographer excluded) — see the `notes`
   *  field for why this cannot be split from bisection retries externally. */
  packages: number;
  modelCalls: { cartographer: number; packageLayer: number; total: number };
  /** `raw`: every individual finding the marker persisted (one fp each, pre-
   *  cluster — clustering never removes a member, per review/cluster.ts).
   *  `clustered`: distinct posted bodies (cluster exemplars + singletons). */
  findings: { raw: number; clustered: number };
  /** Parsed from the rendered comment's own `### Coverage` summary line —
   *  empty when that section was not found (e.g. an empty-diff run). */
  coverage: Record<string, number>;
  markerBytes: { body: number; limit: number };
  wallMs: number;
  verdict: string;
  /** Caveats surfaced at render time — approximations, or a section this run
   *  did not produce (e.g. no cartographer call observed). */
  notes: string[];
}

/** Zero-filled strata counts, then tallied from a distillation's per-path map. */
export function strataCounts(strata: Readonly<Record<string, Stratum>>): StrataCounts {
  const counts: StrataCounts = {
    substantive: 0,
    pattern: 0,
    rename: 0,
    formatting: 0,
    vendored: 0,
    generated: 0,
  };
  for (const s of Object.values(strata)) counts[s] += 1;
  return counts;
}

/** The pattern group with the most members, or null when there are none. */
export function biggestPatternGroup(
  groups: readonly PatternGroup[],
): { exemplar: string; members: number } | null {
  let best: PatternGroup | null = null;
  for (const g of groups) {
    if (best === null || g.members.length > best.members.length) best = g;
  }
  return best === null ? null : { exemplar: best.exemplar, members: best.members.length };
}

/** Parse the `### Coverage` summary line (review/ledger.ts's `renderSummary`
 *  shape: `status: N · status: N ...`) out of the REAL rendered comment body.
 *  `{}` when the section is absent — never throws on an unexpected shape. */
export function parseCoverageSummary(body: string): Record<string, number> {
  const match = body.match(/^### Coverage\n\n(.+)$/m);
  if (!match) return {};
  const line = match[1] ?? "";
  const out: Record<string, number> = {};
  for (const part of line.split(" · ")) {
    const kv = part.match(/^([a-z]+): (\d+)$/);
    if (kv) out[kv[1] ?? ""] = Number(kv[2] ?? "0");
  }
  return out;
}

/** `raw` (every individual finding the marker persisted, fp-deduped) vs
 *  `clustered` (distinct posted bodies) — derived entirely from the REAL
 *  decoded state marker (see the {@link Scorecard.findings} doc). */
export function computeFindingCounts(state: ReviewState | Record<string, never>): {
  raw: number;
  clustered: number;
} {
  const findings: Finding[] = "findings" in state ? state.findings : [];
  const clusterMap: Record<string, string> = "clusters" in state ? (state.clusters ?? {}) : {};
  const raw = findings.length;
  const exemplarFps = new Set(Object.values(clusterMap));
  const memberFps = new Set(Object.keys(clusterMap));
  let clustered = exemplarFps.size;
  for (const f of findings) {
    const fp = f.fp ?? "";
    if (fp === "" || !memberFps.has(fp)) clustered += 1;
  }
  return { raw, clustered };
}

/** Render `{a: 1, b: 0, c: 2}` as `"a: 1 · c: 2"` — zero counts dropped, insertion order kept. */
function formatCounts(counts: Readonly<Record<string, number>>): string {
  const parts = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}: ${n}`);
  return parts.length > 0 ? parts.join(" · ") : "(none)";
}

function pad(label: string): string {
  return label.padEnd(20, " ");
}

/** The human-readable table `run.ts` prints to stdout. */
export function renderTable(sc: Scorecard): string {
  const biggest =
    sc.patternGroups.biggestExemplar === null
      ? "none"
      : `${sc.patternGroups.biggestExemplar} × ${sc.patternGroups.biggestMembers}`;
  const lines = [
    `Eval scorecard — ${sc.pr.owner}/${sc.pr.repo}#${sc.pr.number} (${sc.provider}/${sc.model})`,
    "",
    `${pad("Changed files")}${sc.changedFiles}`,
    `${pad("Strata")}${formatCounts(sc.strata)}`,
    `${pad("Pattern groups")}${sc.patternGroups.count} (biggest: ${biggest})`,
    `${pad("Packages (Layer 2)")}${sc.packages}`,
    `${pad("Model calls")}cartographer: ${sc.modelCalls.cartographer} · package-layer: ${sc.modelCalls.packageLayer} · total: ${sc.modelCalls.total}`,
    `${pad("Findings")}raw: ${sc.findings.raw} · clustered: ${sc.findings.clustered}`,
    `${pad("Coverage")}${formatCounts(sc.coverage)}`,
    `${pad("Marker bytes")}${sc.markerBytes.body} / ${sc.markerBytes.limit}`,
    `${pad("Wall time")}${sc.wallMs} ms`,
    `${pad("Verdict")}${sc.verdict}`,
  ];
  if (sc.notes.length > 0) {
    lines.push("", "Notes:");
    for (const note of sc.notes) lines.push(`  - ${note}`);
  }
  return `${lines.join("\n")}\n`;
}

/** The `--out <file>` JSON form — the same data, machine-readable. */
export function renderJson(sc: Scorecard): string {
  return `${JSON.stringify(sc, null, 2)}\n`;
}
