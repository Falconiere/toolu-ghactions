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
import type { CommentTarget, StickyComment } from "@/github/comment.js";
import { errorMessage } from "@/errors.js";
import { inProgressBody } from "./bodies.js";
import type { GithubContext, PipelineOctokit } from "./types.js";

/** What locating the prior sticky yields: its id, decoded state, and raw marker. */
export interface PriorSticky {
  stickyId: number | undefined;
  /** Decoded prior state — null when memory is off or no usable marker exists. */
  prior: ReviewState | null;
  /** The RAW marker line, carried forward verbatim (survives cancelled runs). */
  priorMarker: string | null;
  /** The sticky's author login (always a Bot — see findSticky): the identity whose
   *  review threads are the bot's own. "" when no sticky exists yet. */
  botLogin: string;
}

/**
 * Locate the prior sticky ALWAYS (independent of memory): its id drives the
 * upsert dedup, so a pre-existing sticky is updated in place, not duplicated
 * each run. DECODE its marker into `prior` only when memory is on; EXTRACT the
 * raw marker regardless, so a cancelled run never wipes state a future
 * memory-on run would read. `findSticky` only ever returns a BOT-authored
 * comment, so a marker hand-posted by any other commenter can never become this
 * run's prior state.
 *
 * A FAILED lookup is an infra error, NOT "no sticky yet" — the two are
 * indistinguishable downstream, and guessing "no sticky" makes postInProgress
 * CREATE a second comment (both then carry markers, so later runs pick between
 * them by created_at) while `prior: null` resets the round's memory: history,
 * recap and the MAX_ROUNDS counter. Throw instead; main.ts turns it into
 * verdict=error, a best-effort error comment and a red job.
 */
export async function locatePrior(
  octokit: PipelineOctokit,
  target: CommentTarget,
  reviewMemory: boolean,
): Promise<PriorSticky> {
  let sticky: StickyComment | null;
  try {
    sticky = await findSticky(octokit, target);
  } catch (err) {
    throw new Error(`could not read PR comments to locate the prior review: ${errorMessage(err)}`);
  }
  if (sticky === null) {
    return { stickyId: undefined, prior: null, priorMarker: null, botLogin: "" };
  }
  const prior = reviewMemory ? asReviewState(decodeMarker(sticky.body)) : null;
  return {
    stickyId: sticky.id,
    prior,
    priorMarker: extractMarker(sticky.body),
    botLogin: sticky.author?.login ?? "",
  };
}

/**
 * Post the in-progress body (prior marker riding along) and return the sticky id
 * so subsequent posts update in place, with its author. Re-locates the sticky after
 * creating it (a fresh create has no id otherwise), keeping the in-progress comment
 * and the final verdict comment together in ONE sticky — and learning, at no extra
 * cost, the identity the first run's threads must be rooted by. Best-effort: a failure
 * must not abort the review — the caller keeps whatever sticky it already had.
 */
export async function postInProgress(
  octokit: PipelineOctokit,
  target: CommentTarget,
  context: GithubContext,
  found: PriorSticky,
): Promise<Pick<PriorSticky, "stickyId" | "botLogin">> {
  const known = { stickyId: found.stickyId, botLogin: found.botLogin };
  try {
    await upsertComment(
      octokit,
      target,
      inProgressBody(context, found.priorMarker),
      found.stickyId,
    );
    if (found.stickyId !== undefined) return known;
    const sticky = await findSticky(octokit, target).catch((err: unknown) => {
      process.stderr.write(
        `  Warning: could not re-locate the sticky after creating it (${err instanceof Error ? err.message : String(err)})\n`,
      );
      return null;
    });
    return { stickyId: sticky?.id, botLogin: sticky?.author?.login ?? "" };
  } catch {
    process.stderr.write("  Warning: could not post in-progress comment\n");
    return known;
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
