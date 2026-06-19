// github/comment.ts — find, create, or update the bot's sticky PR verdict
// comment via the GitHub Issues-comments API. Port of find-sticky-comment.sh +
// post-comment.sh.
//
// Dedup is LOGIN-AGNOSTIC: a custom GitHub App may author the comment, so we
// match on the hidden state marker in the body (consistent with state.ts), with
// a legacy-header fallback used only when no marker comment exists anywhere.
// findSticky pages through ALL comments, preferring a marker match globally so a
// stale comment on a later page can never win over a real marker.

/** Marker prefix the state module writes; matched as a substring (mirrors state.ts). */
const MARKER_PREFIX = "<!-- toolu-review-state:v1";
/** Legacy headers on pre-marker comments — the fallback when no marker exists. */
const LEGACY_HEADER_RE = /### Code Review|### PR Review in Progress/;
/** Hard page cap, guarding a misbehaving API (matches the bash). */
const MAX_PAGES = 20;
const PER_PAGE = 100;

/** One issue comment, with only the fields this module reads. `body` is optional to
 * match the Octokit REST response (a comment can have an empty/absent body). */
export interface IssueComment {
  id: number;
  body?: string;
  created_at: string;
  html_url: string;
}

/** The slice of an Octokit REST client this module uses. */
export interface CommentClient {
  rest: {
    issues: {
      listComments(params: {
        owner: string;
        repo: string;
        issue_number: number;
        per_page: number;
        page: number;
      }): Promise<{ data: IssueComment[] }>;
      createComment(params: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }): Promise<{ data: { html_url: string } }>;
      updateComment(params: {
        owner: string;
        repo: string;
        comment_id: number;
        body: string;
      }): Promise<{ data: { html_url: string } }>;
    };
  };
}

/** Repo + PR coordinates for the comment operations. */
export interface CommentTarget {
  owner: string;
  repo: string;
  prNumber: number;
}

/** A located sticky comment (its id and body), or null when none exists. */
export interface StickyComment {
  id: number;
  body: string;
}

/** True when a comment body carries the hidden state marker. */
function hasMarker(body: string): boolean {
  return body.includes(MARKER_PREFIX);
}

/**
 * Locate the latest sticky review comment on a PR, login-agnostic.
 *
 * Pages through every comment (capped at {@link MAX_PAGES}), preferring a state
 * marker globally; only when no marker comment exists anywhere does it fall back
 * to the latest legacy-header comment. Returns the latest match by `created_at`,
 * or null when none is found. Never throws on an empty/short page.
 */
export async function findSticky(
  octokit: CommentClient,
  target: CommentTarget,
): Promise<StickyComment | null> {
  const markerMatches: IssueComment[] = [];
  const legacyMatches: IssueComment[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data } = await octokit.rest.issues.listComments({
      owner: target.owner,
      repo: target.repo,
      issue_number: target.prNumber,
      per_page: PER_PAGE,
      page,
    });
    for (const c of data) {
      if (hasMarker(c.body ?? "")) markerMatches.push(c);
      else if (LEGACY_HEADER_RE.test(c.body ?? "")) legacyMatches.push(c);
    }
    // Stop at a short page (the last page) or the hard cap.
    if (data.length < PER_PAGE) break;
  }

  const selected = markerMatches.length > 0 ? markerMatches : legacyMatches;
  if (selected.length === 0) return null;

  // Latest by created_at (string ISO timestamps sort lexically == chronologically).
  const latest = selected.reduce((a, b) => (a.created_at <= b.created_at ? b : a));
  return { id: latest.id, body: latest.body ?? "" };
}

/**
 * Create or update the sticky comment, returning its `html_url`.
 *
 * When `stickyId` is given (the caller already located it), the comment is
 * updated in place — skipping the list round-trip. Otherwise a new comment is
 * created. Throws if the API response carries no `html_url` (the bash treated a
 * missing url as a hard failure / exit 1).
 *
 * @param octokit - the injected REST client.
 * @param target - repo + PR coordinates.
 * @param body - the markdown comment body.
 * @param stickyId - an already-located sticky comment id to update, if any.
 */
export async function upsertComment(
  octokit: CommentClient,
  target: CommentTarget,
  body: string,
  stickyId?: number,
): Promise<string> {
  let url: string;
  if (stickyId !== undefined) {
    const { data } = await octokit.rest.issues.updateComment({
      owner: target.owner,
      repo: target.repo,
      comment_id: stickyId,
      body,
    });
    url = data.html_url;
  } else {
    const { data } = await octokit.rest.issues.createComment({
      owner: target.owner,
      repo: target.repo,
      issue_number: target.prNumber,
      body,
    });
    url = data.html_url;
  }
  if (!url) throw new Error("post-comment: API response carried no html_url");
  return url;
}
