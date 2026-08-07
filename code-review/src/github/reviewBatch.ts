// github/reviewBatch.ts — batch + 422-bisect inline review comments so one
// PR-wide review's request body stays bounded (MAX_COMMENTS_PER_REVIEW) and
// one poison comment (an anchor GitHub's Reviews GraphQL mutation still
// rejects) can no longer zero out the whole run. Split out of review.ts to
// keep that file under the house 300-line ceiling (plan s11).
//
// A batch's `createReview` call 422ing bisects the batch and retries each
// half; a single comment that still 422s in isolation is reported `dropped`
// instead of thrown. Any OTHER error (permissions, network, ...) is NOT
// bisectable — `postBatch` NEVER throws it: it is captured as that node's
// `lastError` and contributes no posted/dropped comments there, but is folded
// into the outcome by RETURNING, not throwing. A single unbatched call (or a
// batch that fails before any bisection) still ends up posted:false/reason —
// same outward result as before batching existed — but a batch that bisected
// keeps a sibling half's real, already-posted comments even when the other
// half then hits a non-422: an uncaught throw there would otherwise unwind
// past the sibling's success, and the caller would report posted:false while
// GitHub already carries those comments — the next round would repost them
// as duplicates (see the regression test for the exact scenario).
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

/** `typeof [] === "object"`, so arrays are excluded explicitly — an array thrown
 *  as an error must fall through to the message check, never be probed for a
 *  `.status` field it cannot meaningfully carry. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  /**
   * Set ONLY by a non-bisectable (non-422) failure node — never by a 422 that
   * bisection isolated down to a poison drop, which is already fully reported
   * via `dropped`. Kept separate from `lastError` (which both kinds set, and
   * which alone still drives the `posted:false` wholesale `reason`) so
   * `postComments` can surface a partial-failure marker on a `posted:true`
   * result without also re-surfacing an already-`dropped` finding's own error
   * as if something were unaccounted for.
   */
  failed?: string;
}

/**
 * Post one batch; on a 422, bisect it and retry each half so a single poison
 * comment cannot sink its siblings. This NEVER throws: a non-bisectable error
 * (permissions, network, ...) is captured as `lastError` and returned with
 * empty `posted`/`dropped` for this node instead of being rethrown — letting a
 * throw unwind past an already-resolved SIBLING half (awaited first, in the
 * bisection branch below) would erase its real, already-posted comments from
 * the result even though GitHub still carries them.
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
    const lastError = errorMessage(err, "reviews API request failed");
    if (!isUnprocessable(err)) {
      // Not bisectable — this node's whole batch failed, but that must never
      // erase a sibling branch's already-posted comments, so this RETURNS
      // (never throws); the caller folds it into the merged outcome below.
      // `failed` (unlike a 422's `lastError`) has no `dropped` entry standing in
      // for it, so postComments treats it as a partial-failure marker instead.
      return { posted: [], dropped: [], lastError, failed: lastError };
    }
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
      failed: right.failed ?? left.failed,
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
  let failed: string | undefined;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    if (batch === undefined) continue;
    const body = batchBody(i, batches.length, batch.length, postable.length);
    // postBatch() never throws (see its doc) — a non-422/non-bisectable failure
    // comes back as a zero-posted outcome carrying `lastError`/`failed`, so a
    // batch that fails after an earlier one succeeded cannot erase that
    // earlier success.
    const outcome = await postBatch(octokit, batch, target, body);
    posted += outcome.posted.length;
    dropped.push(...outcome.dropped);
    url ??= outcome.url;
    lastError = outcome.lastError ?? lastError;
    failed = outcome.failed ?? failed;
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
  return {
    posted: true,
    count: posted,
    batches: batches.length,
    unanchored,
    dropped,
    url,
    // Some comments posted for real, but a non-bisectable (non-422) failure
    // ALSO hit another batch/half — `reason` doubles as that partial-failure
    // marker here (see InlineReviewResult's doc). A pure 422 that bisection
    // isolated down to a `dropped` entry deliberately does NOT set this: that
    // finding is already fully accounted for, so re-surfacing its error as
    // `reason` would read as "something is unaccounted for" when nothing is.
    ...(failed !== undefined ? { reason: failed } : {}),
  };
}
