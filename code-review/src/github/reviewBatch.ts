// github/reviewBatch.ts — batch + 422-bisect inline review comments so one
// PR-wide review's request body stays bounded (MAX_COMMENTS_PER_REVIEW) and
// one poison comment (an anchor GitHub's Reviews GraphQL mutation still
// rejects) can no longer zero out the whole run. Split out of review.ts to
// keep that file under the house 300-line ceiling (plan s11).
//
// A batch's `createReview` call 422ing bisects the batch and retries each
// half; a single comment that still 422s in isolation is reported `dropped`
// instead of thrown. Any OTHER error (permissions, network, ...) is NOT
// bisectable — it bubbles out of the batch and `postComments` folds it into
// the wholesale posted:false/reason outcome the caller already handles,
// exactly as a single unbatched call did before batching existed.
import { errorMessage } from "@/errors.js";
import type { Finding } from "@/llm/schema.js";
import type {
  InlineReviewResult,
  ReviewClient,
  ReviewComment,
  ReviewTarget,
} from "@/github/review.js";

/** The largest number of comments one `createReview` call carries. GitHub's
 *  Reviews GraphQL mutation aborts validation after ~50 field errors (see the
 *  real PR-72 fixture) well before any batch this size — 30 keeps a normal
 *  batch comfortably clear of that ceiling even when several anchors are bad. */
export const MAX_COMMENTS_PER_REVIEW = 30;

/** A built comment paired with the finding it came from, so a batch outcome
 *  can report exactly which findings posted, dropped, or never got that far. */
export interface PendingComment {
  finding: Finding;
  comment: ReviewComment;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** True for the 422 the Reviews API returns on a comment it cannot resolve —
 *  bisectable. Matches Octokit's `.status` when present (a real client) or the
 *  HTTP reason phrase in the message (thrown-Error fakes in tests). */
function isUnprocessable(err: unknown): boolean {
  if (isRecord(err) && err["status"] === 422) return true;
  const message = errorMessage(err, "");
  return message.includes("422") || message.includes("Unprocessable Entity");
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

/** The review body for one batch. Only the first of possibly several batches
 *  points at the summary comment for the verdict — repeating that phrase on
 *  every batch would just be noise once a PR needs more than one review. */
function batchBody(
  index: number,
  totalBatches: number,
  batchCount: number,
  totalCount: number,
): string {
  if (index === 0) {
    return totalBatches > 1
      ? `🤖 AI Code Review — ${totalCount} inline comment(s) across ${totalBatches} reviews. See the summary comment for the full verdict.`
      : `🤖 AI Code Review — ${batchCount} inline comment(s). See the summary comment for the full verdict.`;
  }
  return `🤖 AI Code Review — continued (review ${index + 1}/${totalBatches}, ${batchCount} more comment(s)).`;
}

interface BisectOutcome {
  posted: PendingComment[];
  dropped: Finding[];
  url?: string;
  lastError?: string;
}

/**
 * Post one batch; on a 422, bisect it and retry each half so a single poison
 * comment cannot sink its siblings. A non-422 error is rethrown so the caller
 * treats the whole batch as a wholesale failure.
 */
async function postBatch(
  octokit: ReviewClient,
  batch: PendingComment[],
  target: ReviewTarget,
  body: string,
): Promise<BisectOutcome> {
  try {
    const { data } = await octokit.rest.pulls.createReview({
      owner: target.owner,
      repo: target.repo,
      pull_number: target.prNumber,
      commit_id: target.headSha,
      event: "COMMENT",
      body,
      comments: batch.map((b) => b.comment),
    });
    return { posted: batch, dropped: [], url: data.html_url };
  } catch (err) {
    if (!isUnprocessable(err)) throw err;
    const lastError = errorMessage(err, "reviews API request failed");
    if (batch.length <= 1) {
      // Isolated to a single comment and it STILL 422s — that comment is poison;
      // report it dropped instead of failing (or further splitting) anything.
      return { posted: [], dropped: batch.map((b) => b.finding), lastError };
    }
    const mid = Math.ceil(batch.length / 2);
    const left = await postBatch(octokit, batch.slice(0, mid), target, body);
    const right = await postBatch(octokit, batch.slice(mid), target, body);
    return {
      posted: [...left.posted, ...right.posted],
      dropped: [...left.dropped, ...right.dropped],
      url: left.url ?? right.url,
      lastError: right.lastError ?? left.lastError,
    };
  }
}

/**
 * Post every anchorable comment across as many `createReview` batches as
 * needed (≤ MAX_COMMENTS_PER_REVIEW each), bisecting any batch that 422s.
 * `unanchored` passes through untouched — this function only ever decides
 * `posted`/`dropped` for comments that made it this far.
 */
export async function postComments(
  octokit: ReviewClient,
  postable: PendingComment[],
  target: ReviewTarget,
  unanchored: Finding[],
): Promise<InlineReviewResult> {
  const batches = chunk(postable, MAX_COMMENTS_PER_REVIEW);
  const dropped: Finding[] = [];
  let posted = 0;
  let url: string | undefined;
  let lastError: string | undefined;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    if (batch === undefined) continue;
    const body = batchBody(i, batches.length, batch.length, postable.length);
    try {
      const outcome = await postBatch(octokit, batch, target, body);
      posted += outcome.posted.length;
      dropped.push(...outcome.dropped);
      url ??= outcome.url;
      lastError = outcome.lastError ?? lastError;
    } catch (err) {
      // Non-422 (permissions, network, ...): this batch is a wholesale failure.
      lastError = errorMessage(err, "reviews API request failed");
    }
  }

  if (posted === 0) {
    return {
      posted: false,
      count: 0,
      batches: batches.length,
      unanchored,
      dropped,
      reason: lastError ?? "reviews API request failed",
    };
  }
  return { posted: true, count: posted, batches: batches.length, unanchored, dropped, url };
}
