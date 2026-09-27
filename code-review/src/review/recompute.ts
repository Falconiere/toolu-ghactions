// review/recompute.ts — recompute a review's verdict and label DETERMINISTICALLY from
// the last completed round's stored findings minus the ones settled on their threads.
// No model, no git, no I/O: the shared primitive behind the `@toolu dismiss` settle
// pass (pipeline/dismissRecompute.ts) and, later, merge-gate's recompute (#123).
//
// FAIL CLOSED (epic #126 invariant): no stored state, an incomplete round, a stored
// head that is not the PR's current head, or a last verdict other than "changes" all
// leave everything unchanged. Settlement reuses reconcile.ts's `dropSettled` — so a
// blocker settles only on an exact match and never on an argued-out thread, and
// dismissing a cluster's exemplar dismisses its members — and the label rule is #124's
// `resolveLabelVerdict` (APPROVE_BELOW), applied to what remains.
import { fingerprint } from "@/state.js";
import type { Finding, ReviewState } from "@/state.js";
import type { PriorThread } from "@/github/threads.js";
import type { Severity } from "@/llm/schema.js";
import { dropSettled } from "./reconcile.js";
import type { ReconcileFinding } from "./reconcile.js";
import { resolveLabelVerdict } from "./gate.js";

/** Why a recompute changed nothing. */
export type UnchangedReason =
  | "no-state"
  | "incomplete"
  | "no-completed-round"
  | "stale-head"
  | "not-changes"
  | "nothing-settled"
  | "still-blocking";

/** The recompute's decision: leave everything as it is, or approve the label. */
export type RecomputeOutcome =
  | { kind: "unchanged"; reason: UnchangedReason }
  | {
      kind: "approve";
      /** The comment verdict: "approved" when nothing remains, else "changes" (an
       *  APPROVE_BELOW-advisory remainder approves the label, not the verdict). */
      verdict: "approved" | "changes";
      /** Stored findings still standing after settlement (cluster members expanded). */
      remaining: ReconcileFinding[];
      settled: number;
      total: number;
    };

/** What {@link recomputeVerdict} reads. `threads` are already classified
 *  (review/dismissal.ts) and limited to the bot's own threads by the caller. */
export interface RecomputeInput {
  state: ReviewState | null;
  /** The PR's CURRENT head sha (a live lookup, not the event payload's). */
  headSha: string;
  threads: PriorThread[];
  approveBelow: Severity;
}

/** Recompute the verdict for the stored round at `headSha`; see the module header. */
export function recomputeVerdict(input: RecomputeInput): RecomputeOutcome {
  const { state } = input;
  const blocked = freshness(state, input.headSha);
  if (blocked !== null || state === null)
    return { kind: "unchanged", reason: blocked ?? "no-state" };

  const findings = state.findings.map(normalise);
  const groups = clusterGroups(findings, state.clusters ?? {});
  const representatives = [...groups.keys()].flatMap((fp) => groups.get(fp)?.slice(0, 1) ?? []);
  const { kept } = dropSettled(representatives, input.threads, {
    members: groups,
    priorClusters: state.clusters,
  });
  const remaining = kept.flatMap((f) => groups.get(f.fp) ?? [f]);
  const settled = findings.length - remaining.length;
  if (settled === 0) return { kind: "unchanged", reason: "nothing-settled" };

  const verdict = remaining.length === 0 ? "approved" : "changes";
  const label = resolveLabelVerdict({
    verdict,
    findings: remaining,
    approveBelow: input.approveBelow,
  });
  if (label !== "approved") return { kind: "unchanged", reason: "still-blocking" };
  return { kind: "approve", verdict, remaining, settled, total: findings.length };
}

/** The first guard the stored round fails, or null when it is the complete
 *  "changes" round for exactly `headSha`. */
function freshness(state: ReviewState | null, headSha: string): UnchangedReason | null {
  if (state === null) return "no-state";
  if ((state.unreviewed_paths?.length ?? 0) > 0 || (state.pending_paths?.length ?? 0) > 0) {
    return "incomplete";
  }
  const reviewed = state.reviewed_sha ?? "";
  const last = state.history.at(-1);
  // Only a COMPLETE round advances reviewed_sha and appends history (state.ts), so the
  // last entry must be that round — same short sha — or no round finished here.
  if (reviewed === "" || last === undefined || last.sha !== reviewed.slice(0, 7)) {
    return "no-completed-round";
  }
  if (headSha === "" || reviewed !== headSha) return "stale-head";
  return last.verdict === "changes" ? null : "not-changes";
}

/** A stored (loosely typed, marker-decoded) finding as a ReconcileFinding. A missing
 *  field degrades to a value that can only keep the finding standing: no path/line
 *  matches no thread, and an absent severity stays blocking in resolveLabelVerdict. */
function normalise(f: Finding): ReconcileFinding {
  const severity = f["severity"];
  return {
    path: typeof f.path === "string" ? f.path : "",
    line: typeof f.line === "number" ? f.line : 0,
    fp: typeof f.fp === "string" && f.fp !== "" ? f.fp : fingerprint(f),
    text: typeof f.text === "string" ? f.text : "",
    ...(typeof f.category === "string" ? { category: f.category } : {}),
    ...(typeof severity === "string" ? { severity } : {}),
  };
}

/** Group findings by stored cluster identity (member fp → exemplar fp), keyed by
 *  each group's representative fp — the exemplar when present, else its first member
 *  — with the representative first, as reconcile.ts's ClusterContext expects. */
function clusterGroups(
  findings: ReconcileFinding[],
  clusters: Record<string, string>,
): Map<string, ReconcileFinding[]> {
  const byExemplar = new Map<string, ReconcileFinding[]>();
  for (const f of findings) {
    const key = clusters[f.fp] ?? f.fp;
    byExemplar.set(key, [...(byExemplar.get(key) ?? []), f]);
  }
  const groups = new Map<string, ReconcileFinding[]>();
  for (const [exemplar, members] of byExemplar) {
    const lead = members.find((m) => m.fp === exemplar) ?? members[0];
    if (lead === undefined) continue;
    groups.set(lead.fp, [lead, ...members.filter((m) => m !== lead)]);
  }
  return groups;
}
