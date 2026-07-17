// review/incremental.ts — the incremental-review scope filter: on a re-review,
// genuinely NEW findings may only come from lines that changed since the last
// reviewed sha. Everything else the model produces is either adjudication of an
// existing discussion (kept — matched to a prior thread or prior finding) or an
// invention about code that was already reviewed and cleared (dropped). This is
// what makes the review CONVERGE naturally: when a push changes nothing (or only
// fixes what was flagged), no fresh findings can appear, so once the open
// threads settle the verdict reaches approved — no surrender cap needed.
//
// Pure (no I/O). The scope map is computed by the pipeline (pipeline/git.ts);
// a null scope (first round, full re-review, rebase/force-push, unreachable
// sha) disables filtering entirely — fail-open to a full review, never to a
// silent drop.
import type { Finding } from "@/state.js";
import type { PriorThread } from "@/github/threads.js";
import { coveredByThread, NEARBY_LINE_RADIUS } from "./reconcile.js";
import type { ReconcileFinding } from "./reconcile.js";

/** Lines changed since the last reviewed sha, per path. An EMPTY map is a real
 *  scope (nothing changed since) — only `null` means "no scope, review fully". */
export type IncrementalScope = Map<string, Set<number>>;

/** True when a prior-state finding (from the marker) covers this one: same
 *  fingerprint, or same path within the nearby line radius. Works with inline
 *  comments off, where prior threads don't exist but marker findings do. */
function coveredByPriorFinding(f: ReconcileFinding, prior: Finding[]): boolean {
  return prior.some((p) => {
    if (p.fp !== undefined && p.fp === f.fp) return true;
    if (p.path !== f.path) return false;
    return typeof p.line === "number" && Math.abs(f.line - p.line) <= NEARBY_LINE_RADIUS;
  });
}

/**
 * Split this run's findings into kept / dropped under the incremental scope.
 * Kept: anchored to a line changed since the last review, OR covered by a prior
 * thread (strict or nearby), OR covered by a prior-state finding. Dropped:
 * everything else — a finding about already-reviewed, since-unchanged code.
 * A null scope keeps everything (full review).
 */
export function dropOutOfScope<F extends ReconcileFinding>(
  findings: F[],
  scope: IncrementalScope | null,
  priorThreads: PriorThread[],
  priorFindings: Finding[],
): { kept: F[]; dropped: F[] } {
  if (scope === null) return { kept: findings, dropped: [] };
  const kept: F[] = [];
  const dropped: F[] = [];
  for (const f of findings) {
    // f.line is always a real int here: the finding schema (llm/schema.ts)
    // requires `line: z.number().int()`, so no file-level/lineless finding can
    // reach this filter — only PRIOR-state findings have an optional line.
    const inScope = scope.get(f.path)?.has(f.line) === true;
    const carried = coveredByThread(f, priorThreads) || coveredByPriorFinding(f, priorFindings);
    (inScope || carried ? kept : dropped).push(f);
  }
  return { kept, dropped };
}
