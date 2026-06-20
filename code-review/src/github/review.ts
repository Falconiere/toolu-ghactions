// github/review.ts — post per-line PR review comments (with committable code
// suggestions) via the Pull Request Reviews API. Port of post-review.sh.
//
// Advisory + non-fatal: the review event is always COMMENT (never hard-blocks
// merge — the summary comment + the agent-merge label remain the authority), and
// ANY failure (no PR context, unset token, an unanchorable-line 422, etc.) is
// caught and reported, never thrown. Only findings anchored by a real `line`
// are posted; a multi-line span uses start_line..line.
import { errorMessage } from "@/errors.js";
import { fingerprint } from "@/state.js";
import { appendFpMarker } from "@/review/fpmarker.js";
import type { Finding } from "@/llm/schema.js";

/** One inline review comment in the Reviews-API request body. */
export interface ReviewComment {
  path: string;
  body: string;
  side: "RIGHT";
  line: number;
  start_line?: number;
  start_side?: "RIGHT";
}

/** The slice of an Octokit REST client this module uses. */
export interface ReviewClient {
  rest: {
    pulls: {
      createReview(params: {
        owner: string;
        repo: string;
        pull_number: number;
        commit_id: string;
        event: "COMMENT";
        body: string;
        comments: ReviewComment[];
      }): Promise<{ data: { html_url: string } }>;
    };
  };
}

/** Repo + PR coordinates and the head commit the review anchors to. */
export interface ReviewTarget {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
}

/** Outcome of {@link postInlineReview} — non-fatal, so failures are reported, not thrown. */
export interface InlineReviewResult {
  /** Whether a review was posted. */
  posted: boolean;
  /** Number of inline comments posted (0 when skipped). */
  count: number;
  /** The created review's html_url when posted. */
  url?: string;
  /** Why nothing was posted (skip reason or caught error message). */
  reason?: string;
}

/**
 * Build the inline review comment for one finding. The body is
 * "**severity** _(category)_: text" plus a ```suggestion fenced block when the
 * finding carries one. A span wider than one line uses start_line..line; a
 * single line just sets `line`. Mirrors the jq object built in post-review.sh.
 */
function buildComment(f: Finding): ReviewComment {
  const severity = f.severity || "note";
  const category = f.category ? ` _(${f.category})_` : "";
  const suggestion =
    f.suggestion !== undefined && f.suggestion !== ""
      ? `\n\n\`\`\`suggestion\n${f.suggestion}\n\`\`\``
      : "";
  // Embed the finding fingerprint as a hidden marker so a later run recognises THIS
  // thread as its own (to dedup, reply in place, or resolve — see review/reconcile.ts).
  const body = appendFpMarker(
    `**${severity}**${category}: ${f.text ?? ""}${suggestion}`,
    fingerprint(f),
  );

  const end = f.end_line ?? f.line;
  if (end > f.line) {
    return {
      path: f.path,
      body,
      start_line: f.line,
      start_side: "RIGHT",
      line: end,
      side: "RIGHT",
    };
  }
  return { path: f.path, body, line: f.line, side: "RIGHT" };
}

/**
 * Post inline review comments for the in-diff findings, best-effort.
 *
 * Only findings with a real `line` are posted (they are expected to be
 * already anchored to the diff by the validate step). With no anchored
 * findings, nothing is posted. ANY error is caught and returned in `reason`;
 * this never throws — the summary comment already conveys the verdict.
 *
 * @param octokit - the injected REST client.
 * @param findings - validated findings (those with a `line` become comments).
 * @param target - repo, PR number, and the head sha to anchor the review to.
 */
export async function postInlineReview(
  octokit: ReviewClient,
  findings: Finding[],
  target: ReviewTarget,
): Promise<InlineReviewResult> {
  const comments = findings.filter((f) => f.line != null).map(buildComment);
  if (comments.length === 0) {
    return { posted: false, count: 0, reason: "no anchored findings" };
  }

  const summary = `🤖 AI Code Review — ${comments.length} inline comment(s). See the summary comment for the full verdict.`;
  try {
    const { data } = await octokit.rest.pulls.createReview({
      owner: target.owner,
      repo: target.repo,
      pull_number: target.prNumber,
      commit_id: target.headSha,
      event: "COMMENT",
      body: summary,
      comments,
    });
    return { posted: true, count: comments.length, url: data.html_url };
  } catch (err) {
    return { posted: false, count: 0, reason: errorMessage(err, "reviews API request failed") };
  }
}
