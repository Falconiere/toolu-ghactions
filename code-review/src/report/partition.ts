// report/partition.ts — turn one run's APPLIED reconcile plan into four disjoint,
// exhaustive report buckets keyed by fingerprint. Pure (no I/O, no GitHub calls,
// no mutation of its arguments): `reconcile()` itself is neither disjoint nor
// exhaustive (see the two edge cases documented on {@link partitionFindings}), so
// this module owns correctness itself rather than trusting reconcile()'s buckets
// to already be a partition.
//
// Never calls normalizeCategory() — `category` passes through RAW. Normalization
// only happens at the payload boundary (report/payload.ts), because `category` is
// folded into the finding's identity hash (state.ts's `fingerprint()`); running it
// here would have no effect on identity but would invite a future caller to read
// a normalized category off this module and assume it is safe for the wire.
import type { Reconciliation } from "@/review/reconcile.js";
import type { PriorThread } from "@/github/threads.js";
import type { StampedFinding } from "@/pipeline/reviewCall.js";
import type { ReviewState } from "@/state.js";
import type { Finding } from "@/llm/schema.js";
import {
  pickMetadata,
  enrichFromPrior,
  settlementOf,
  resolveSuppressed,
  matchingSettledThreads,
} from "./settlement.js";
import type { SuppressedAttribution } from "./settlement.js";

/** How a `dismissed` finding was settled. `"explicit"`/`"exhausted"` come from
 *  {@link import("@/review/dismissal.js").classifyDismissals} via `t.dismissal`;
 *  `"resolved"` is {@link import("@/review/reconcile.js").isSettled} being true
 *  with `dismissal` undefined — a human resolving the thread in the GitHub UI,
 *  or the bot's own accepted-resolution note. */
export type Settlement = "explicit" | "exhausted" | "resolved";

/** The action's finding severity enum, reused rather than re-declared. */
type Severity = NonNullable<Finding["severity"]>;
/** The action's finding provenance enum, reused rather than re-declared. */
type Source = NonNullable<Finding["source"]>;

/**
 * Finding metadata safe to leave the runner: identity, anchor, and light
 * classification only. Deliberately excludes `text`, `quoted_line`, `end_line`,
 * `confidence` and `suggestion` — the whole feature's guarantee is that finding
 * prose and code never cross the wire. `category` is the model's raw, un-normalized
 * string; `normalizeCategory()` is called only at the payload boundary (A5).
 */
export interface ReportedFinding {
  /** The finding's identity hash (state.ts `fingerprint()`) — the join key. */
  fp: string;
  path: string;
  /** 1-based line, or null when the underlying thread has gone outdated. */
  line: number | null;
  /** Absent on `fixed`/`dismissed` when the marker has rotated past this fp. */
  severity?: Severity;
  /** Absent on `fixed`/`dismissed` when the marker has rotated past this fp. Raw. */
  category?: string;
  /** Absent on `fixed`/`dismissed` when the marker has rotated past this fp. */
  source?: Source;
}

/** A `dismissed` finding, additionally carrying how it was settled. */
export interface DismissedFinding extends ReportedFinding {
  settlement: Settlement;
}

/** The four provably disjoint, exhaustive report buckets for one run. */
export interface PartitionedFindings {
  /** {@link Reconciliation.toCreate} — findings with no matching prior thread. */
  new: ReportedFinding[];
  /** Findings that persist and were not otherwise classified this run — see the
   *  module doc for why an unclassified finding falls here rather than to `new`
   *  or `fixed`: an understated fix rate is acceptable, an invented one is not. */
  open: ReportedFinding[];
  /** {@link Reconciliation.toResolve} threads GitHub accepted, carrying NO
   *  settlement — the bot's own re-review concluded the finding no longer applies. */
  fixed: ReportedFinding[];
  /** Settled findings: {@link Reconciliation.toResolve} threads carrying a
   *  settlement, plus every `suppressed` finding not absorbed into its own
   *  thread's `toResolve` row (see {@link resolveSuppressed}). */
  dismissed: DismissedFinding[];
}

/** Everything {@link partitionFindings} needs from one run. When the run was
 *  CLUSTERED, `applied` and `findings` must both already be expanded from cluster
 *  representatives to full members (report/expand.ts) — the exhaustiveness check
 *  below compares them by fp and cannot see a member that never arrived. */
export interface PartitionInput {
  /** postInline's return value — the reconcile plan narrowed to mutations GitHub
   *  actually accepted (a failed `resolveThread`/`replyToThread` call is absent). */
  applied: Reconciliation<StampedFinding>;
  /** This run's findings AFTER dropSettled — the exact array `reconcile()` (and
   *  `postInline`) were called with. Needed because reconcile()'s own buckets can
   *  silently drop a finding (reconcile.ts:169-174): `covered.add(idx)` fires
   *  before the `isResolved` early return, so a finding that only loosely matches
   *  an ALREADY-resolved thread is excluded from `toCreate` but never reaches
   *  `toReply` or `toResolve` either. The `open` fallback below is what recovers it. */
  findings: StampedFinding[];
  /** Findings `dropSettled` removed before `reconcile()` ran (an already-settled
   *  thread's finding re-raised this run) — from `SettledVerdict.suppressed`. */
  suppressed: StampedFinding[];
  /** The full prior-thread list passed to `dropSettled`/`reconcile()` this run —
   *  used only to attribute a settlement to each `suppressed` finding. */
  priorThreads: PriorThread[];
  /** Prior review state, for enriching a `PriorThread` (which carries no
   *  severity/category/source) by joining its `fp` against `prior.findings`. */
  prior: ReviewState | null;
}

/** The outcome of {@link partitionFindings}: either a verified partition, or a
 *  signal the caller can act on without throwing or reporting something
 *  incoherent — see the module doc for why this is a discriminated result rather
 *  than a thrown error. */
export type PartitionResult =
  | { ok: true; partitions: PartitionedFindings }
  | { ok: false; reason: string };

/** Claim `fp` for the current bucket unless an earlier-precedence step already
 *  did — the mechanism that makes disjointness hold by construction. */
function claim(claimed: Set<string>, fp: string): boolean {
  if (claimed.has(fp)) return false;
  claimed.add(fp);
  return true;
}

/** Rule 1 — a suppressed finding not absorbed by {@link resolveSuppressed} is
 *  `dismissed`, settlement attributed from the thread it was matched to. */
function classifySuppressed(
  attributions: SuppressedAttribution[],
  claimed: Set<string>,
): DismissedFinding[] {
  const dismissed: DismissedFinding[] = [];
  for (const { finding, thread } of attributions) {
    if (claim(claimed, finding.fp)) {
      dismissed.push({ ...pickMetadata(finding), settlement: settlementOf(thread) });
    }
  }
  return dismissed;
}

/** Rules 1b/2 — a `toResolve` thread carrying `dismissal` is `dismissed`; one
 *  with none is `fixed`. Both enriched from `prior.findings` (see {@link enrichFromPrior}). */
function classifyToResolve(
  toResolve: PriorThread[],
  prior: ReviewState | null,
  claimed: Set<string>,
): { dismissed: DismissedFinding[]; fixed: ReportedFinding[] } {
  const dismissed: DismissedFinding[] = [];
  const fixed: ReportedFinding[] = [];
  for (const t of toResolve) {
    if (t.dismissal !== undefined) {
      if (claim(claimed, t.fp))
        dismissed.push({ ...enrichFromPrior(t, prior), settlement: t.dismissal });
    } else if (claim(claimed, t.fp)) {
      fixed.push(enrichFromPrior(t, prior));
    }
  }
  return { dismissed, fixed };
}

/** Rules 3/4 — `toReply[].finding` and `toCreate` claim `open`/`new` first;
 *  LAST, any `findings` entry still unclaimed falls to `open` (never `new`),
 *  recovering reconcile.ts:169-174 without letting a genuinely new finding
 *  (which is also in `findings`) get swept in here ahead of `toCreate`. */
function classifyOpenAndNew(
  applied: Reconciliation<StampedFinding>,
  findings: StampedFinding[],
  claimed: Set<string>,
): { open: ReportedFinding[]; created: ReportedFinding[] } {
  const open: ReportedFinding[] = [];
  for (const action of applied.toReply) {
    if (claim(claimed, action.finding.fp)) open.push(pickMetadata(action.finding));
  }
  const created: ReportedFinding[] = [];
  for (const f of applied.toCreate) {
    if (claim(claimed, f.fp)) created.push(pickMetadata(f));
  }
  for (const f of findings) {
    if (claim(claimed, f.fp)) open.push(pickMetadata(f));
  }
  return { open, created };
}

/** Independently re-derives, from the RAW `suppressed`/`priorThreads` inputs —
 *  NOT `resolveSuppressed`'s already-decided attributions — how many settled
 *  threads match each suppressed finding. `resolveSuppressed` already refuses
 *  an ambiguous match itself, but a check built from its OUTPUT could never
 *  see a regression of that refusal; this recomputes from scratch instead, the
 *  same "verify, don't just trust" spirit as {@link isExhaustive}. Returns the
 *  offending fp, or null when every suppressed finding matches exactly one. */
function ambiguouslySettledFp(
  suppressed: StampedFinding[],
  priorThreads: PriorThread[],
): string | null {
  for (const finding of suppressed) {
    if (matchingSettledThreads(finding, priorThreads).length !== 1) return finding.fp;
  }
  return null;
}

/** The claimed set must equal `findings ∪ non-absorbed-suppressed ∪ toResolve`
 *  (by fp) exactly — catches an inconsistent `applied`/`findings` pairing
 *  supplied by the caller, on top of the per-step disjointness `claim` already
 *  guarantees. An absorbed attribution (see {@link resolveSuppressed}) is
 *  excluded: its event is `toResolve`'s row, under a different fp. */
function isExhaustive(
  claimed: Set<string>,
  findings: StampedFinding[],
  attributions: SuppressedAttribution[],
  toResolve: PriorThread[],
): boolean {
  const expected = new Set<string>([
    ...findings.map((f) => f.fp),
    ...attributions.map((a) => a.finding.fp),
    ...toResolve.map((t) => t.fp),
  ]);
  return claimed.size === expected.size && [...expected].every((fp) => claimed.has(fp));
}

/** No `PriorThread` may produce a row in more than one bucket — an fp-set
 *  check alone cannot see this (two DIFFERENT fps can trace to one thread).
 *  Independently re-verifies what {@link resolveSuppressed}'s exclusion
 *  already prevents, the same "verify, don't just trust" spirit as
 *  {@link isExhaustive}. Returns the reused `threadId`, or null when clean. */
function reusedThreadId(
  attributions: SuppressedAttribution[],
  applied: Reconciliation<StampedFinding>,
): string | null {
  const used = [
    ...attributions.map((a) => a.thread.threadId),
    ...applied.toResolve.map((t) => t.threadId),
    ...applied.toReply.map((r) => r.thread.threadId),
  ];
  const seen = new Set<string>();
  for (const id of used) {
    if (seen.has(id)) return id;
    seen.add(id);
  }
  return null;
}

/**
 * Derive the four disjoint, exhaustive report buckets from the APPLIED reconcile
 * plan. Precedence (first match wins): `dismissed` → `fixed` → `open`
 * (`toReply[].finding`) → `new` (`toCreate`), then any still-unclaimed `findings`
 * entry falls to `open` — resolving reconcile.ts:189-196's one-fp-in-two-buckets
 * case to one, recovering reconcile.ts:169-174, and absorbing a suppressed
 * finding into its own thread's `toResolve` row when that thread also settles
 * this run (see {@link resolveSuppressed} — `fp` alone can't tell that apart).
 * A settlement lookup finding nothing, a failed exhaustiveness check, or a
 * thread reused across buckets all return `{ ok: false, reason }` rather than
 * throwing or reporting something incoherent.
 */
export function partitionFindings(input: PartitionInput): PartitionResult {
  const { applied, findings, suppressed, priorThreads, prior } = input;
  const claimed = new Set<string>();
  const resolvedThreadIds = new Set(applied.toResolve.map((t) => t.threadId));

  const resolved = resolveSuppressed(suppressed, priorThreads, resolvedThreadIds);
  if ("violation" in resolved) return { ok: false, reason: resolved.violation };

  const dismissedFromSuppressed = classifySuppressed(resolved.attributions, claimed);
  const fromResolve = classifyToResolve(applied.toResolve, prior, claimed);
  const { open, created } = classifyOpenAndNew(applied, findings, claimed);

  const ambiguousFp = ambiguouslySettledFp(suppressed, priorThreads);
  if (ambiguousFp) {
    return {
      ok: false,
      reason: `partitionFindings: ambiguous settlement for suppressed finding ${ambiguousFp} — more than one settled prior thread matches it`,
    };
  }
  if (!isExhaustive(claimed, findings, resolved.attributions, applied.toResolve)) {
    return {
      ok: false,
      reason:
        "partitionFindings: classified set does not match the expected finding set (exhaustiveness check failed)",
    };
  }
  const reused = reusedThreadId(resolved.attributions, applied);
  if (reused) {
    return {
      ok: false,
      reason: `partitionFindings: thread ${reused} would be reported in more than one bucket`,
    };
  }

  return {
    ok: true,
    partitions: {
      new: created,
      open,
      fixed: fromResolve.fixed,
      dismissed: [...dismissedFromSuppressed, ...fromResolve.dismissed],
    },
  };
}
