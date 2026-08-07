// github/review.ts — post per-line PR review comments (with committable code
// suggestions) via the Pull Request Reviews API. Port of post-review.sh.
//
// Advisory + non-fatal: the review event is always COMMENT (never hard-blocks
// merge — the summary comment + the agent-merge label remain the authority), and
// ANY failure (no PR context, unset token, a wholesale API failure, etc.) is
// caught and reported, never thrown. Only findings anchored by a real `line`
// are posted; a multi-line span uses start_line..line.
//
// ANCHOR VALIDATION: GitHub resolves a comment's `line` against ITS OWN diff of
// the PR, which can differ from the diff we reviewed (rename detection, merge
// bases). Before posting we fetch the PR's file patches (pulls.listFiles) and
// validate each anchor against GitHub's actual RIGHT-side lines: a finding whose
// file has no patch, or whose line/span cannot be mapped onto GitHub's diff at
// all, is UNANCHORED. There is no file-level fallback — GitHub's Reviews
// GraphQL mutation rejects `subjectType`/a null `position` outright (see the
// real PR-72 422 response captured in `__tests__/fixtures/pr72-createreview-
// 422.txt`) — so an unanchored finding is simply never posted inline; the
// caller renders `InlineReviewResult.unanchored` into the sticky summary
// comment instead.
//
// BATCHING + 422 BISECTION (src/github/reviewBatch.ts): comments post in
// batches of at most MAX_COMMENTS_PER_REVIEW so one review's request body
// stays bounded. If a batch's `createReview` call still 422s, the batch is
// bisected and each half retried; a single comment that still 422s in
// isolation is reported in `dropped` instead of sinking its siblings.
import { fingerprint } from "@/state.js";
import { appendFpMarker } from "@/review/fpmarker.js";
import type { Finding } from "@/llm/schema.js";
import { MAX_COMMENTS_PER_REVIEW, postComments } from "@/github/reviewBatch.js";
import type { PendingComment } from "@/github/reviewBatch.js";

export { MAX_COMMENTS_PER_REVIEW };

/** One inline review comment in the Reviews-API request body: always
 *  line-anchored (`line`, optionally a `start_line..line` span). There is no
 *  file-level shape — see the header comment. */
export interface ReviewComment {
  path: string;
  body: string;
  side?: "RIGHT";
  line?: number;
  start_line?: number;
  start_side?: "RIGHT";
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

/**
 * A finding that may already carry the state fingerprint the pipeline stamped on it
 * (`pipeline/reviewCall.ts`'s `StampedFinding`). {@link buildComment} PREFERS that
 * stamped value over recomputing one: the body is DECORATED before posting (a
 * cluster exemplar's enumerates its members — `pipeline/reduce.ts`), and a fp
 * recomputed from the decorated text would rotate the thread's identity, so the
 * next run could neither dedup, reply in place, nor resolve it.
 */
export type PostableFinding = Finding & { fp?: string };

/** Repo + PR coordinates and the head commit the review anchors to. */
export interface ReviewTarget {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
}

/** Outcome of {@link postInlineReview} — non-fatal, so failures are reported, not thrown. */
export interface InlineReviewResult {
  /** Whether at least one comment was posted. */
  posted: boolean;
  /** Number of inline comments actually posted (0 when skipped/failed). */
  count: number;
  /** Number of `createReview` batches issued (MAX_COMMENTS_PER_REVIEW each), 0 when skipped. */
  batches: number;
  /** Findings that could not be anchored to GitHub's own diff — never posted
   *  inline; the caller renders these into the sticky summary comment. */
  unanchored: Finding[];
  /** Findings whose comment still 422d after batch bisection isolated it alone. */
  dropped: Finding[];
  /** The first created review's html_url when at least one batch posted. */
  url?: string;
  /**
   * Why nothing was posted at all (skip reason or a wholesale caught error) —
   * or, when `posted` is true, a PARTIAL-failure marker: some comments posted
   * for real (see `count`/`url`) but a non-bisectable error (permissions,
   * network, ...) also hit another batch or bisected half, whose findings are
   * in neither `dropped` nor counted as posted (github/reviewBatch.ts never
   * discards an already-posted sibling to report that failure). Never set
   * merely because a poison comment landed in `dropped` — that is already
   * fully accounted for there.
   */
  reason?: string;
}

/**
 * Build the inline review comment for one finding. The body is
 * "**severity** _(category)_: text" plus a ```suggestion fenced block when the
 * finding carries one. A span wider than one line uses start_line..line; a
 * single line just sets `line`. Mirrors the jq object built in post-review.sh.
 */
function buildComment(f: PostableFinding): ReviewComment {
  const severity = f.severity || "note";
  const category = f.category ? ` _(${f.category})_` : "";
  const suggestion =
    f.suggestion !== undefined && f.suggestion !== ""
      ? `\n\n\`\`\`suggestion\n${f.suggestion}\n\`\`\``
      : "";
  // Embed the finding fingerprint as a hidden marker so a later run recognises THIS
  // thread as its own (to dedup, reply in place, or resolve — see review/reconcile.ts).
  // The STAMPED fp wins: it was computed from the raw finding, before any body
  // decoration, so decorating cannot rotate the thread identity (see PostableFinding).
  const body = appendFpMarker(
    `**${severity}**${category}: ${f.text ?? ""}${suggestion}`,
    f.fp ?? fingerprint(f),
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
 * GitHub's OWN anchorable RIGHT-side lines per path: every new-file line each
 * patch displays (context + additions), parsed from `pulls.listFiles`. Returns
 * null when the client has no `listFiles` or the fetch fails — the caller then
 * posts unvalidated (best-effort).
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
 * Span → single-line, collapsing only as far as needed. Returns null when the
 * comment cannot be anchored at all — the path isn't in GitHub's diff, or
 * neither end of the span maps onto it — so the caller reports it unanchored
 * instead of posting (there is no file-level fallback, see the header comment).
 */
function validateAnchor(
  c: ReviewComment,
  anchorable: Map<string, Set<number>>,
): ReviewComment | null {
  const lines = anchorable.get(c.path);
  if (lines === undefined) return null;
  if (c.line !== undefined && lines.has(c.line)) {
    // A span additionally needs its start anchored; collapse to the end line if not.
    if (c.start_line !== undefined && !lines.has(c.start_line)) {
      const { start_line: _s, start_side: _ss, ...single } = c;
      return single;
    }
    return c;
  }
  // The end anchor is off GitHub's diff; the start might still be on it.
  if (c.start_line !== undefined && lines.has(c.start_line)) {
    const { start_line: _s, start_side: _ss, ...rest } = c;
    return { ...rest, line: c.start_line };
  }
  return null;
}

/**
 * Post inline review comments for the in-diff findings, best-effort.
 *
 * Only findings with a real `line` are candidates; the rest are unanchored by
 * construction. Anchors are then re-validated against GitHub's OWN diff (see
 * the header comment): unanchorable findings never post — they come back in
 * `unanchored` for the caller to render into the sticky summary comment.
 * Posting itself batches and 422-bisects (`src/github/reviewBatch.ts`), so one
 * poison comment can no longer sink the whole run. ANY error is caught and
 * returned in `reason`; this never throws.
 *
 * @param octokit - the injected REST client.
 * @param findings - candidate findings (those with a `line` become comments).
 * @param target - repo, PR number, and the head sha to anchor the review to.
 */
export async function postInlineReview(
  octokit: ReviewClient,
  findings: PostableFinding[],
  target: ReviewTarget,
): Promise<InlineReviewResult> {
  const anchoredByLine = findings.filter((f) => f.line != null);
  const withoutLine = findings.filter((f) => f.line == null);
  if (anchoredByLine.length === 0) {
    return {
      posted: false,
      count: 0,
      batches: 0,
      unanchored: findings,
      dropped: [],
      reason: "no anchored findings",
    };
  }
  const built: PendingComment[] = anchoredByLine.map((f) => ({
    finding: f,
    comment: buildComment(f),
  }));

  // Validate anchors against GitHub's diff when we can fetch it.
  const anchorable = await fetchAnchorableLines(octokit, target);
  let postable = built;
  const unanchored: Finding[] = [...withoutLine];
  if (anchorable !== null) {
    postable = [];
    for (const b of built) {
      const comment = validateAnchor(b.comment, anchorable);
      if (comment === null) {
        unanchored.push(b.finding);
        continue;
      }
      postable.push({ finding: b.finding, comment });
    }
    if (postable.length === 0) {
      return {
        posted: false,
        count: 0,
        batches: 0,
        unanchored,
        dropped: [],
        reason: "no anchored findings",
      };
    }
  }

  return postComments(octokit, postable, target, unanchored);
}
