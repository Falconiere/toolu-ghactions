// github/review.ts — post per-line PR review comments (with committable code
// suggestions) via the Pull Request Reviews API. Port of post-review.sh.
//
// Advisory + non-fatal: the review event is always COMMENT (never hard-blocks
// merge — the summary comment + the agent-merge label remain the authority), and
// ANY failure (no PR context, unset token, an unanchorable-line 422, etc.) is
// caught and reported, never thrown. Only findings anchored by a real `line`
// are posted; a multi-line span uses start_line..line.
//
// ANCHOR VALIDATION: GitHub resolves a comment's `line` against ITS OWN diff of
// the PR, which can differ from the diff we reviewed (rename detection, merge
// bases). One comment whose line GitHub cannot resolve 422s the WHOLE review —
// every other comment is lost. So before posting we fetch the PR's file patches
// (pulls.listFiles) and validate each anchor against GitHub's actual RIGHT-side
// lines: an unanchorable finding DEGRADES to a file-level comment
// (subject_type "file") instead of sinking the batch, and a finding on a path
// GitHub doesn't show at all is dropped (the summary comment still carries it).
// A residual 422 retries ONCE with every comment converted to file-level.
import { errorMessage } from "@/errors.js";
import { fingerprint } from "@/state.js";
import { appendFpMarker } from "@/review/fpmarker.js";
import type { Finding } from "@/llm/schema.js";

/** One inline review comment in the Reviews-API request body: either line-anchored
 *  (`line` set, optionally a `start_line..line` span) or file-level
 *  (`subject_type: "file"`, no line fields). */
export interface ReviewComment {
  path: string;
  body: string;
  side?: "RIGHT";
  line?: number;
  start_line?: number;
  start_side?: "RIGHT";
  subject_type?: "file";
}

/** One file of the PR diff as GitHub reports it (`pulls.listFiles`). `patch` is
 *  absent for binary or very large files — nothing is line-anchorable there. */
export interface PrDiffFile {
  filename: string;
  patch?: string;
}

/** The slice of an Octokit REST client this module uses. `listFiles` is optional:
 *  a client without it (older fakes) skips anchor validation and posts as before. */
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
      listFiles?(params: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page: number;
        page: number;
      }): Promise<{ data: PrDiffFile[] }>;
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
  /** How many findings degraded to file-level comments (unanchorable in GitHub's diff). */
  degraded?: number;
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

/** Strip a comment's line anchors, keeping it as a file-level comment. The
 *  ```suggestion block (committable only against concrete lines) is removed too —
 *  GitHub rejects a suggestion without a line anchor. */
function toFileLevel(c: ReviewComment): ReviewComment {
  return {
    path: c.path,
    body: c.body.replace(/```suggestion[\s\S]*?```\n?/g, "").trim(),
    subject_type: "file",
  };
}

/**
 * GitHub's OWN anchorable RIGHT-side lines per path: every new-file line each
 * patch displays (context + additions), parsed from `pulls.listFiles`. Returns
 * null when the client has no `listFiles` or the fetch fails — the caller then
 * posts unvalidated (best-effort), relying on the file-level retry.
 */
async function fetchAnchorableLines(
  octokit: ReviewClient,
  target: ReviewTarget,
): Promise<Map<string, Set<number>> | null> {
  const pulls = octokit.rest.pulls;
  const listFiles = pulls.listFiles?.bind(pulls);
  if (listFiles === undefined) return null;
  const byPath = new Map<string, Set<number>>();
  try {
    // GitHub caps a PR's listed files at 3000 → at most 30 pages of 100.
    for (let page = 1; page <= 30; page++) {
      const { data } = await listFiles({
        owner: target.owner,
        repo: target.repo,
        pull_number: target.prNumber,
        per_page: 100,
        page,
      });
      for (const file of data) {
        byPath.set(file.filename, patchRightLines(file.patch));
      }
      if (data.length < 100) break;
    }
    return byPath;
  } catch {
    return null;
  }
}

/** The new-file line numbers a unified patch displays (context + added lines). */
function patchRightLines(patch: string | undefined): Set<number> {
  const lines = new Set<number>();
  if (patch === undefined || patch === "") return lines;
  let newLine = 0;
  for (const row of patch.split("\n")) {
    const hunk = row.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk?.[1] !== undefined) {
      newLine = Number.parseInt(hunk[1], 10);
      continue;
    }
    if (row.startsWith("+") || row.startsWith(" ") || row === "") {
      lines.add(newLine);
      newLine++;
    }
    // "-" (removed) and "\ No newline…" advance nothing on the new side.
  }
  return lines;
}

/**
 * Validate one comment's anchors against GitHub's diff lines for its path.
 * Span → single-line → file-level, degrading only as far as needed; null means
 * the path isn't in GitHub's diff at all (drop the comment entirely).
 */
function validateAnchor(
  c: ReviewComment,
  anchorable: Map<string, Set<number>>,
): { comment: ReviewComment; degraded: boolean } | null {
  const lines = anchorable.get(c.path);
  if (lines === undefined) return null;
  if (c.line !== undefined && lines.has(c.line)) {
    // A span additionally needs its start anchored; collapse to the end line if not.
    if (c.start_line !== undefined && !lines.has(c.start_line)) {
      const { start_line: _s, start_side: _ss, ...single } = c;
      return { comment: single, degraded: false };
    }
    return { comment: c, degraded: false };
  }
  // The end anchor is off GitHub's diff; the start might still be on it.
  if (c.start_line !== undefined && lines.has(c.start_line)) {
    const { start_line: _s, start_side: _ss, ...rest } = c;
    return { comment: { ...rest, line: c.start_line }, degraded: false };
  }
  return { comment: toFileLevel(c), degraded: true };
}

/**
 * Post inline review comments for the in-diff findings, best-effort.
 *
 * Only findings with a real `line` are posted (they are expected to be
 * already anchored to the diff by the validate step). Anchors are then
 * re-validated against GitHub's OWN diff (see the header comment): unanchorable
 * findings degrade to file-level comments, findings on paths GitHub doesn't
 * show are dropped, and a residual 422 retries once with everything file-level
 * — one bad anchor never sinks the batch. With no postable comments, nothing
 * is posted. ANY error is caught and returned in `reason`; this never throws —
 * the summary comment already conveys the verdict.
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
  const built = findings.filter((f) => f.line != null).map(buildComment);
  if (built.length === 0) {
    return { posted: false, count: 0, reason: "no anchored findings" };
  }

  // Validate anchors against GitHub's diff when we can fetch it.
  const anchorable = await fetchAnchorableLines(octokit, target);
  let comments = built;
  let degraded = 0;
  if (anchorable !== null) {
    comments = [];
    for (const c of built) {
      const v = validateAnchor(c, anchorable);
      if (v === null) continue; // path not in GitHub's diff — summary still has it.
      if (v.degraded) degraded++;
      comments.push(v.comment);
    }
    if (comments.length === 0) {
      return { posted: false, count: 0, reason: "no anchored findings" };
    }
  }

  const post = async (batch: ReviewComment[]): Promise<InlineReviewResult> => {
    const summary = `🤖 AI Code Review — ${batch.length} inline comment(s). See the summary comment for the full verdict.`;
    const { data } = await octokit.rest.pulls.createReview({
      owner: target.owner,
      repo: target.repo,
      pull_number: target.prNumber,
      commit_id: target.headSha,
      event: "COMMENT",
      body: summary,
      comments: batch,
    });
    return { posted: true, count: batch.length, degraded, url: data.html_url };
  };

  try {
    return await post(comments);
  } catch (err) {
    // Last-resort degrade: some anchor GitHub still couldn't resolve. Convert every
    // comment to file-level (always resolvable for an in-diff path) and retry once,
    // so the batch posts instead of vanishing.
    const anyAnchored = comments.some((c) => c.line !== undefined);
    if (anyAnchored) {
      const fileLevel = comments.map(toFileLevel);
      degraded = fileLevel.length;
      try {
        return await post(fileLevel);
      } catch (retryErr) {
        return {
          posted: false,
          count: 0,
          reason: errorMessage(retryErr, "reviews API request failed"),
        };
      }
    }
    return { posted: false, count: 0, reason: errorMessage(err, "reviews API request failed") };
  }
}
