// pipeline.ts — orchestrate one code-review run, replicating main.sh's flow with
// the ported TS modules. Every boundary (octokit, the GitHub event context, the
// LLM fetch, the repo cwd, the clock) is injected through `deps` so the pipeline
// runs end-to-end in tests with NO network and NO process.env reads.
//
// FLOW (main.sh order): resolve event → skip on non-trigger → fetch diff →
// skip/empty handling → read prior sticky (review memory) → post in-progress →
// gather rules → build prompt → review → validate → diff state → render recap →
// format verdict → post comment + label + inline review → return outputs.
// The phases live in pipeline/ (sticky, reviewCall, publish); this file wires them.
//
// ERROR ABSTAIN: a verdict:"error" ProviderResult is NOT an infra failure — we
// format it (request-changes label, "provider error" badge), post it, return
// normally. The job stays green; main.ts decides the exit code.
import { fetchDiff } from "./git/diff.js";
import type { DiffData } from "./git/diff.js";
import { resolveEvent } from "./github/event.js";
import type { EventResolution } from "./github/event.js";
import type { CommentTarget } from "./github/comment.js";
import { fetchReviewThreads } from "./github/threads.js";
import { setVerdictLabel } from "./github/label.js";
import type { LabelTarget } from "./github/label.js";
import { upsertComment } from "./github/comment.js";
import type { ReviewTarget } from "./github/review.js";
import { resolveHeadSha, sinceChangedLines } from "./pipeline/git.js";
import { locatePrior, postInProgress } from "./pipeline/sticky.js";
import type { PriorSticky } from "./pipeline/sticky.js";
import type { IncrementalScope } from "./review/incremental.js";
import { reviewAndValidate } from "./pipeline/reviewCall.js";
import { publish } from "./pipeline/publish.js";
import { skipBody, noopBody } from "./pipeline/bodies.js";
import type { GithubContext, PipelineOctokit, ReviewDeps, ReviewResult } from "./pipeline/types.js";

// Re-export the public pipeline types so callers keep importing from "./pipeline.js".
export type { GithubContext, PipelineOctokit, ReviewDeps, ReviewResult };

/** The combined comment/review/label coordinates one run targets. */
type RunTarget = CommentTarget & ReviewTarget & LabelTarget;

/**
 * Run the full review pipeline for one event, replaying main.sh end to end
 * against the injected boundaries. A non-trigger event or an empty/over-limit
 * diff returns a "skip" verdict (still posting the skip/approved comment, as the
 * bash does); a provider "error" verdict is posted and returned normally
 * (abstain). Only a genuine infra failure (diff resolution, comment-post) throws.
 */
export async function runReview(deps: ReviewDeps): Promise<ReviewResult> {
  const { inputs, octokit, context } = deps;
  const cwd = deps.cwd ?? process.cwd();
  const now = deps.now ?? Date.now;
  const startMs = now();

  const event = await resolveTrigger(deps);
  if (!event || event.pr_number === undefined) {
    return { verdict: "skip", findingsCount: 0, commentUrl: "" };
  }
  const target: RunTarget = {
    owner: context.repo.owner,
    repo: context.repo.repo,
    prNumber: event.pr_number,
    headSha: "", // filled after the diff resolves the review head sha.
  };
  const reviewHead = event.review_head ?? "HEAD";
  const baseBranch = event.base_ref && event.base_ref !== "" ? event.base_ref : inputs.baseBranch;

  const resolved = await resolveDiffOrSkip(deps, target, reviewHead, baseBranch, cwd);
  if ("done" in resolved) return resolved.done;
  const diff = resolved.diff;

  // Prior sticky (memory carrier) + in-progress post (marker rides along so a
  // cancel-in-progress mid-review keeps memory intact) + the bot's prior threads.
  const found = await locatePrior(octokit, target, inputs.reviewMemory);
  const stickyId = await postInProgress(octokit, target, context, found);
  const priorThreads = await fetchReviewThreads(octokit, target);
  target.headSha = resolveHeadSha(reviewHead, context.sha, cwd);
  // The sha the incremental series is stored on. Prefer the PR HEAD sha over
  // target.headSha: on pull_request events the latter is GITHUB_SHA — the
  // ephemeral test-merge commit, orphaned on every push — so a series stored on
  // it never resolves (or ancestor-checks) next run and the scope stays null.
  // The PR HEAD sha survives: it is reachable from the next merge commit, so
  // `merge-base --is-ancestor <prev head> HEAD` holds and the since-diff lands
  // on the same checkout tree the review diff numbers its lines against.
  // The fallback never stores a merge sha in practice: pull_request payloads
  // always carry `.pull_request.head.sha` (event.head_sha is only absent on
  // other events), and on issue_comment runs target.headSha is `git rev-parse
  // FETCH_HEAD` — the fetched PR head itself, the correct series anchor.
  const reviewedSha = event.head_sha ?? target.headSha;

  const scope = incrementalScope(deps, found, reviewHead, cwd);

  const reviewed = await reviewAndValidate({
    inputs,
    diff,
    event,
    priorThreads,
    reviewHead,
    cwd,
    sarifDir: deps.sarifDir,
    fetch: deps.fetch,
  });

  return publish({
    octokit,
    context,
    target,
    inputs,
    diff,
    priorThreads,
    scope,
    reviewedSha,
    reviewHead,
    baseBranch,
    result: reviewed.result,
    stamped: reviewed.stamped,
    mechanical: reviewed.mechanical,
    prior: found.prior,
    stickyId,
    fullReview: event.full_review,
    startMs,
    now,
  });
}

/**
 * The incremental scope for this run: lines changed since the last reviewed sha.
 * Applies only to pull_request pushes — a manual `@toolu review` re-trigger
 * (issue_comment) is the explicit full-re-review escape hatch. Null → full
 * review (first round, manual re-trigger, memory off, or the last reviewed sha
 * is gone/rewritten) — genuinely NEW findings may otherwise only come from this
 * scope (see review/incremental.ts).
 */
function incrementalScope(
  deps: ReviewDeps,
  found: PriorSticky,
  reviewHead: string,
  cwd: string,
): IncrementalScope | null {
  if (!deps.inputs.reviewMemory || deps.context.eventName !== "pull_request") return null;
  return sinceChangedLines({
    reviewedSha: found.prior?.reviewed_sha,
    reviewHead,
    excludeGlobs: deps.inputs.excludeGlobs,
    cwd,
  });
}

/** Resolve the triggering event; null (with a [SKIP] log) when it should not review. */
async function resolveTrigger(deps: ReviewDeps): Promise<EventResolution | null> {
  const { inputs, context } = deps;
  const event = await resolveEvent(
    { eventName: context.eventName, payload: context.payload },
    {
      triggerPhrase: inputs.triggerPhrase,
      minTriggerPermission: inputs.minTriggerPermission,
      ...(deps.lookupPermission ? { lookupPermission: deps.lookupPermission } : {}),
      ...(deps.lookupBaseRef ? { lookupBaseRef: deps.lookupBaseRef } : {}),
    },
  );
  if (!event.run) {
    process.stderr.write(`[SKIP] Not triggering a review: ${event.reason ?? "not-triggered"}\n`);
    return null;
  }
  if (event.pr_number === undefined) {
    process.stderr.write("[SKIP] No PR number resolved from the event\n");
    return null;
  }
  return event;
}

/**
 * Fetch the diff (throws DiffResolutionError on an unresolvable base) and handle
 * the two non-review outcomes, posting the matching comment: a MAX_FILES/fetch
 * skip signal, or a diff with no file changes (approved no-op). Returns either
 * `{ done }` (a skip result to return as-is) or `{ diff }` (proceed to review).
 */
async function resolveDiffOrSkip(
  deps: ReviewDeps,
  target: RunTarget,
  reviewHead: string,
  baseBranch: string,
  cwd: string,
): Promise<{ done: ReviewResult } | { diff: DiffData }> {
  const { inputs, octokit, context } = deps;
  const diff = fetchDiff({
    baseBranch,
    maxFiles: inputs.maxFiles,
    maxDiffLines: inputs.maxDiffLines,
    excludeGlobs: inputs.excludeGlobs,
    reviewHead,
    githubBaseRef: baseBranch,
    cwd,
  });
  if (diff.error !== undefined) {
    process.stderr.write(`[SKIP] ${diff.error}\n`);
    const url = await upsertComment(octokit, target, skipBody(context, diff.error), undefined);
    return { done: { verdict: "skip", findingsCount: 0, commentUrl: url } };
  }
  if (diff.total_files === 0) {
    process.stderr.write("[SKIP] No file changes to review\n");
    const url = await upsertComment(octokit, target, noopBody(context), undefined);
    await setVerdictLabel(octokit, "approved", target, { manageLabels: inputs.manageLabels });
    return { done: { verdict: "skip", findingsCount: 0, commentUrl: url } };
  }
  return { diff };
}
