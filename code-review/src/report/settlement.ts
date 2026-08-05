// report/settlement.ts — match a finding or thread against reconcile.ts's real
// settled-matching logic and enrich its reportable metadata. Split out of
// partition.ts (which stayed under the file-size budget until this file's
// worth of logic was added) so each file keeps one responsibility: this one
// answers "which thread settled this, and what does it look like on the wire";
// partition.ts owns turning those answers into the four disjoint buckets.
import { isSettled, matchesSettled } from "@/review/reconcile.js";
import type { PriorThread } from "@/github/threads.js";
import type { StampedFinding } from "@/pipeline/reviewCall.js";
import type { ReviewState } from "@/state.js";
import type { ReportedFinding, Settlement } from "./partition.js";

/** Every settled thread that covers `f`, reusing reconcile.ts's real
 *  settled-matching logic (all three prongs) so this stays in lockstep with
 *  `dropSettled`'s own decision instead of drifting from it. Returns the full
 *  list — not just the first — so a caller can detect AMBIGUITY: two settled
 *  threads on the same path can both loosely match one finding, and picking
 *  either arbitrarily risks attributing to the wrong physical thread. */
export function matchingSettledThreads(
  f: StampedFinding,
  priorThreads: PriorThread[],
): PriorThread[] {
  return priorThreads.filter(isSettled).filter((t) => matchesSettled(f, t));
}

/** `t.dismissal` when set; otherwise `isSettled(t)` was true some other way
 *  (GitHub resolution or the bot's accepted-resolution note) — see {@link Settlement}. */
export function settlementOf(t: PriorThread): Settlement {
  return t.dismissal ?? "resolved";
}

function isSeverity(v: unknown): v is NonNullable<ReportedFinding["severity"]> {
  return v === "blocker" || v === "high" || v === "medium" || v === "low" || v === "nit";
}

function isSource(v: unknown): v is NonNullable<ReportedFinding["source"]> {
  return v === "llm" || v === "gitleaks" || v === "opengrep" || v === "eslint";
}

/** Full metadata straight off a current-run finding — no enrichment needed. */
export function pickMetadata(f: StampedFinding): ReportedFinding {
  return {
    fp: f.fp,
    path: f.path,
    line: f.line,
    severity: f.severity,
    category: f.category,
    source: f.source,
  };
}

/**
 * A `PriorThread` carries no severity/category/source, so recover them by
 * joining the thread's `fp` against `prior.findings`. Omitted (never guessed)
 * when the marker has rotated the fingerprint past this thread — a stale/absent
 * `prior` degrades to identity-only metadata rather than fabricating a value.
 */
export function enrichFromPrior(thread: PriorThread, prior: ReviewState | null): ReportedFinding {
  const match = prior?.findings.find((f) => f.fp === thread.fp);
  // Bind each field to a local before guarding it. `Finding` reaches these
  // through an index signature, so they arrive as `unknown`; narrowing a local
  // is what carries the guard's result into the returned value, instead of
  // re-reading the property in the true branch and trusting that the narrowing
  // followed the second access.
  const severity = match?.severity;
  const category = match?.category;
  const source = match?.source;
  return {
    fp: thread.fp,
    path: thread.path,
    line: thread.line,
    severity: isSeverity(severity) ? severity : undefined,
    category: typeof category === "string" ? category : undefined,
    source: isSource(source) ? source : undefined,
  };
}

/** A `suppressed` finding paired with the settled thread that explains it. */
export interface SuppressedAttribution {
  finding: StampedFinding;
  thread: PriorThread;
}

/**
 * Pair each `suppressed` finding with its settled thread, EXCLUDING one whose
 * thread ALSO settles via `toResolve` — the OLD fp wins there (see partition.ts's
 * `classifyToResolve`): it's what the human dismissed and what the platform's
 * row already exists under, so the reworded re-raise contributes nothing further.
 * Zero matches, or MORE THAN ONE (two settled threads ambiguously covering one
 * finding — picking either risks absorbing into the wrong thread and losing the
 * real one), is a violation, not a guess.
 */
export function resolveSuppressed(
  suppressed: StampedFinding[],
  priorThreads: PriorThread[],
  resolvedThreadIds: Set<string>,
): { attributions: SuppressedAttribution[] } | { violation: string } {
  const attributions: SuppressedAttribution[] = [];
  for (const finding of suppressed) {
    const [thread, second] = matchingSettledThreads(finding, priorThreads);
    if (!thread) {
      return {
        violation: `partitionFindings: no settled prior thread accounts for suppressed finding ${finding.fp}`,
      };
    }
    if (second) {
      return {
        violation: `partitionFindings: ambiguous settlement for suppressed finding ${finding.fp} — more than one settled prior thread matches it`,
      };
    }
    if (!resolvedThreadIds.has(thread.threadId)) attributions.push({ finding, thread });
  }
  return { attributions };
}
