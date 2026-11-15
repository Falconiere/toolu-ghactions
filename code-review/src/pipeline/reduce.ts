// pipeline/reduce.ts — Layer 3's deterministic reduction, run at the top of
// `publish()` and BEFORE `reconcile`/`diffState` (spec §Layer 3, §Carry-forward).
// Two jobs, in this order:
//
//  1. CARRY FORWARD (pipeline/carry.ts). Every path whose ledger status is not
//     `reviewed` gets its prior findings re-injected. Without this, `reconcile()`
//     would resolve those paths' open threads and `diffState` would drop them from
//     the marker — reporting code nobody re-read as fixed.
//  2. CLUSTER (review/cluster.ts). The same defect repeated across ≥3 files
//     collapses to one exemplar-led cluster. Everything downstream that speaks to
//     GitHub (reconcile, postInlineReview) works on cluster REPRESENTATIVES; the
//     marker, the comment and the toolu.sh report work on the expanded MEMBER
//     lists — {@link expandRepresentatives} is how a representative-carrying array
//     crosses back, and `partitionFindings`'s exhaustiveness check (report/
//     partition.ts) is why both sides must be expanded with the SAME map.
import { clusterFindings, type FindingCluster } from "@/review/cluster.js";
import { clusterMemberNote } from "@/review/sections.js";
import type { ClusterContext, Reconciliation } from "@/review/reconcile.js";
import { expandClusters } from "@/report/expand.js";
import type { CoverageEntry, CoverageLedger } from "@/review/ledger.js";
import type { Finding } from "@/llm/schema.js";
import type { ReviewState } from "@/state.js";
import { carryForward } from "./carry.js";
import type { StampedFinding } from "./reviewCall.js";

/** The reduced round: what publish posts, persists, and reports. */
export interface Reduction {
  /** Model findings ∪ re-injected carried findings — every member, deduped by fp. */
  findings: StampedFinding[];
  /** One representative (the exemplar) per cluster — the array `reconcile`,
   *  `dropSettled` and `postInlineReview` operate on. */
  representatives: StampedFinding[];
  /** The cluster view `reconcile`/`dropSettled` need to read at cluster level. */
  ctx: ClusterContext<StampedFinding>;
  /** Member fp → exemplar fp for MULTI-member clusters only — the marker's
   *  `clusters` field, and the map {@link expandRepresentatives} expands by. */
  clusters: Record<string, string>;
  /** Every finding by fp, so expansion can only ever re-attach findings this
   *  round actually produced. */
  byFp: Map<string, StampedFinding>;
  /** Paths whose prior finding failed carry-forward's strict shape check — the
   *  caller ledgers them `carried` with no finding attached. */
  carriedWithoutFinding: string[];
  /** Fps of findings RE-INJECTED from the prior marker rather than produced this
   *  round. No model call examined their code, so this round's verdict cannot
   *  claim to have cleared them (pipeline/settle.ts). */
  carriedFps: ReadonlySet<string>;
  /** The clusters themselves, for the sticky comment's cluster section. */
  clustered: FindingCluster[];
}

/**
 * True when these cluster members span MORE THAN ONE file — the only shape the
 * cluster machinery speaks about. `clusterFindings` guarantees one cluster per
 * fingerprint, and a fingerprint excludes `line`, so two findings for one defect
 * at two lines of the SAME file now share one cluster without being a cross-file
 * repeat: they must not enter the marker's `clusters` identity map (a fp→itself
 * entry is noise that would make reconcile's prior-cluster link match on it) and
 * must not be rendered with the "Same finding in N files" note, which would name
 * one file twice and claim a repeat across files that did not happen.
 */
export function spansFiles(members: ReadonlyArray<{ path: string }>): boolean {
  return new Set(members.map((m) => m.path)).size > 1;
}

/** Carry forward, then cluster. Pure (no I/O); every input is already validated. */
export function reduceFindings(input: {
  /** This round's validated + stamped model findings. */
  modelFindings: StampedFinding[];
  /** Prior state — its `findings` are re-injected, its `clusters` pin exemplars. */
  prior: ReviewState | null;
  /** This round's coverage ledger: only non-`reviewed` paths carry. */
  ledger: CoverageLedger;
}): Reduction {
  const carried = carryForward({
    modelFindings: input.modelFindings,
    priorFindings: input.prior?.findings ?? [],
    ledger: input.ledger,
  });
  const priorClusters = input.prior?.clusters;
  const clustered = clusterFindings(carried.findings, priorClusters);

  const clusters: Record<string, string> = {};
  for (const cluster of clustered) {
    // Singletons stay out of the map: `clusters` is cluster IDENTITY across rounds,
    // and a one-member "cluster" carries none — persisting them would bloat the
    // marker and make `linkedByPriorCluster` (reconcile.ts) match on noise. Neither
    // does a same-fingerprint group, which spans no files (see `spansFiles`).
    if (cluster.members.length < 2 || !spansFiles(cluster.members)) continue;
    for (const member of cluster.members) clusters[member.fp] = cluster.exemplar.fp;
  }

  const modelFps = new Set(input.modelFindings.map((f) => f.fp));
  return {
    findings: carried.findings,
    carriedFps: new Set(carried.findings.filter((f) => !modelFps.has(f.fp)).map((f) => f.fp)),
    representatives: clustered.map((c) => c.exemplar),
    ctx: {
      members: new Map(clustered.map((c) => [c.exemplar.fp, c.members])),
      ...(priorClusters !== undefined ? { priorClusters } : {}),
    },
    clusters,
    byFp: new Map(carried.findings.map((f) => [f.fp, f])),
    carriedWithoutFinding: carried.carriedWithoutFinding,
    clustered,
  };
}

/**
 * Expand cluster representatives to their FULL member lists for a SEVERITY
 * decision — `applyRoundCap`'s blocker check and `resolveLabelVerdict`'s
 * APPROVE_BELOW ranking (review/gate.ts). Severity is deliberately NOT part of
 * the cluster key, so an exemplar picked by lowest fingerprint can be `low`
 * while a member is `blocker`; feeding the gate representatives alone let that
 * blocker be hidden by its own cluster and downgraded a "changes" to
 * "approved". This is the same expansion review/recompute.ts performs before its
 * own `resolveLabelVerdict`, so the review path and the settle recompute
 * answer identically for the same commit state.
 *
 * Rendering is NOT affected: the comment body and the inline threads still speak
 * in representatives (pipeline/publish.ts).
 */
export function expandForSeverityGate(
  findings: StampedFinding[],
  reduction: Reduction,
): StampedFinding[] {
  return findings.flatMap((f) => reduction.ctx.members.get(f.fp) ?? [f]);
}

/** Expand cluster representatives back to representative + members, in place of
 *  the representative (report/expand.ts). Used on BOTH sides of the report
 *  partition: this round's findings and the applied plan's `toCreate`. */
export function expandRepresentatives(
  findings: StampedFinding[],
  reduction: Reduction,
): StampedFinding[] {
  return expandClusters(findings, reduction.clusters, reduction.byFp);
}

/**
 * Add a `carried` row for every carry-forward-rejected path the ledger does not
 * already mention — a prior finding about a path that is not in this round's diff
 * at all. A path the ledger DOES account for keeps its own status: overwriting an
 * `unreviewed`/`pending` row with the softer `carried` would hide a coverage
 * failure and flip the round to "complete".
 */
export function withCarriedWithoutFinding(ledger: CoverageLedger, paths: string[]): CoverageLedger {
  const additions: Record<string, CoverageEntry> = {};
  for (const path of paths) {
    if (ledger.entries[path] === undefined) additions[path] = { status: "carried" };
  }
  if (Object.keys(additions).length === 0) return ledger;
  return { entries: { ...ledger.entries, ...additions } };
}

/**
 * Decorate each multi-member cluster exemplar's text with the members it stands
 * for (AC-4). The exemplar's INLINE comment is the body the author reads before
 * deciding to dismiss the thread, and dismissing it dismisses the whole pattern
 * (review/reconcile.ts) — so the file list and that warning must be IN it, not
 * only in the sticky comment's "Repeated findings" section.
 *
 * Applied to the copy handed to `postInlineReview` ONLY; `fp` is carried through
 * untouched and github/review.ts stamps the marker from it, so a decorated body
 * can never rotate the thread's identity. A cluster that spans only ONE file is
 * returned as-is — a singleton, or two findings sharing a fingerprint because the
 * same defect sits at two lines of one file: the note names FILES, so there is
 * nothing for it to say (see `spansFiles`).
 */
export function decorateExemplars(
  findings: StampedFinding[],
  reduction: Reduction,
): StampedFinding[] {
  return findings.map((f) => {
    const members = reduction.ctx.members.get(f.fp);
    if (members === undefined || !spansFiles(members)) return f;
    return { ...f, text: `${f.text}\n\n${clusterMemberNote(members)}` };
  });
}

/**
 * Undo {@link decorateExemplars} for findings coming back OUT of the publish path
 * (`InlineReviewResult.unanchored`, rendered into the sticky comment): the sticky
 * enumerates a cluster's members in its own "Repeated findings" section, so
 * repeating the enumeration inside the finding's own line would be noise. A
 * finding this round did not produce is returned untouched.
 */
export function undecorate(findings: Finding[], reduction: Reduction): Finding[] {
  return findings.map((f) => {
    const fp = "fp" in f && typeof f.fp === "string" ? f.fp : "";
    return reduction.byFp.get(fp) ?? f;
  });
}

/**
 * The applied reconcile plan with `toCreate` expanded to full member lists.
 *
 * `toReply` and `toResolve` are deliberately NOT expanded: each carries a GitHub
 * THREAD, and one thread may appear in exactly one bucket once (report/partition.ts
 * fails a plan that reuses a thread id). A replied-to cluster's members instead fall
 * through partition's trailing `findings` sweep into `open`, which is what they are.
 */
export function expandApplied(
  applied: Reconciliation<StampedFinding>,
  reduction: Reduction,
): Reconciliation<StampedFinding> {
  return { ...applied, toCreate: expandRepresentatives(applied.toCreate, reduction) };
}
