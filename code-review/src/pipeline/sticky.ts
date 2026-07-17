// pipeline/sticky.ts — locate the prior sticky verdict comment (the review's
// cross-push memory carrier) and post the in-progress body over it WITHOUT
// losing that memory. Split out of pipeline.ts so the orchestrator stays lean.
//
// The prior RAW marker is carried into the in-progress body: a run cancelled
// mid-review (concurrency cancel-in-progress) otherwise leaves a marker-less
// sticky, and the next run silently starts memory-blank — history reset, recap
// lost, MAX_ROUNDS counter back to zero. That reset is exactly the observed
// "resolves a round then invents a fresh batch" non-convergence.
import { decodeMarker, extractMarker } from "@/state.js";
import type { ReviewState } from "@/state.js";
import { findSticky, upsertComment } from "@/github/comment.js";
import type { CommentTarget } from "@/github/comment.js";
import { inProgressBody } from "./bodies.js";
import type { GithubContext, PipelineOctokit } from "./types.js";

/** What locating the prior sticky yields: its id, decoded state, and raw marker. */
export interface PriorSticky {
  stickyId: number | undefined;
  /** Decoded prior state — null when memory is off or no usable marker exists. */
  prior: ReviewState | null;
  /** The RAW marker line, carried forward verbatim (survives cancelled runs). */
  priorMarker: string | null;
}

/**
 * Locate the prior sticky ALWAYS (independent of memory): its id drives the
 * upsert dedup, so a pre-existing sticky is updated in place, not duplicated
 * each run. DECODE its marker into `prior` only when memory is on; EXTRACT the
 * raw marker regardless, so a cancelled run never wipes state a future
 * memory-on run would read. Best-effort: any lookup failure yields empties.
 */
export async function locatePrior(
  octokit: PipelineOctokit,
  target: CommentTarget,
  reviewMemory: boolean,
): Promise<PriorSticky> {
  const sticky = await findSticky(octokit, target).catch((err: unknown) => {
    process.stderr.write(
      `  Warning: could not locate the sticky comment (${err instanceof Error ? err.message : String(err)})\n`,
    );
    return null;
  });
  if (!sticky) return { stickyId: undefined, prior: null, priorMarker: null };
  const prior = reviewMemory ? asReviewState(decodeMarker(sticky.body)) : null;
  return { stickyId: sticky.id, prior, priorMarker: extractMarker(sticky.body) };
}

/**
 * Post the in-progress body (prior marker riding along) and return the sticky id
 * so subsequent posts update in place. Re-locates the sticky after creating it (a
 * fresh create has no id otherwise), keeping the in-progress comment and the final
 * verdict comment together in ONE sticky. Best-effort: a failure must not abort
 * the review — the caller keeps whatever sticky id it already had.
 */
export async function postInProgress(
  octokit: PipelineOctokit,
  target: CommentTarget,
  context: GithubContext,
  found: PriorSticky,
): Promise<number | undefined> {
  try {
    await upsertComment(
      octokit,
      target,
      inProgressBody(context, found.priorMarker),
      found.stickyId,
    );
    if (found.stickyId !== undefined) return found.stickyId;
    const sticky = await findSticky(octokit, target).catch((err: unknown) => {
      process.stderr.write(
        `  Warning: could not re-locate the sticky after creating it (${err instanceof Error ? err.message : String(err)})\n`,
      );
      return null;
    });
    return sticky?.id;
  } catch {
    process.stderr.write("  Warning: could not post in-progress comment\n");
    return found.stickyId;
  }
}

/** Type guard: a decoded marker is a usable ReviewState (vs the empty `{}` fail-safe). */
function isReviewState(decoded: ReviewState | Record<string, never>): decoded is ReviewState {
  return "findings" in decoded;
}

/** Narrow a decoded marker to a usable ReviewState, or null when it was the empty `{}`. */
export function asReviewState(decoded: ReviewState | Record<string, never>): ReviewState | null {
  return isReviewState(decoded) ? decoded : null;
}
