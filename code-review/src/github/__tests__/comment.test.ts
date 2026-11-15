import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { findSticky, upsertComment, PER_PAGE } from "@/github/comment.js";
import type { CommentClient, IssueComment, CommentTarget } from "@/github/comment.js";

// REAL recorded comment-list payloads from ./fixtures/sticky — a marker
// comment among human + legacy comments, a legacy-only list, and a no-sticky
// list. The Octokit client is a recording fake that PAGINATES those payloads at
// the real page size, so a store can straddle a page boundary; create/update
// calls are asserted against the injected fake (no network).
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "sticky");

const TARGET: CommentTarget = { owner: "test-org", repo: "test-repo", prNumber: 42 };

/** The GitHub App logins appearing in the recordings. The REST API reports
 *  `user.type` on every comment; these recordings predate the author guard and
 *  omit it, so it is restored here (findSticky fails closed without it). */
const BOT_LOGINS = new Set(["toolu-code-review[bot]", "github-actions[bot]"]);

/** Load a recorded comments-list fixture, with its App authors typed as GitHub reports them. */
function comments(name: string): IssueComment[] {
  const recorded: IssueComment[] = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));
  return recorded.map((c) => {
    const login = c.user?.login ?? "";
    return BOT_LOGINS.has(login) ? { ...c, user: { login, type: "Bot" } } : c;
  });
}

/** One recorded comment by id — throws when the fixture does not carry it. */
function recordedComment(id: number, name = "comments-page"): IssueComment {
  const found = comments(name).find((c) => c.id === id);
  if (!found) throw new Error(`fixture ${name}: no comment ${id}`);
  return found;
}

/** The recorded marker comment (id 777) with NO `user` key at all — the shape of a
 *  comment GitHub returned without an author. */
function markerWithoutAuthor(): IssueComment {
  const marker = recordedComment(777);
  return {
    id: marker.id,
    body: marker.body,
    created_at: marker.created_at,
    html_url: marker.html_url,
  };
}

/** `count` ordinary human comments starting at `firstId` — padding that pushes
 *  whatever follows them onto the next page. */
function humanFiller(count: number, firstId: number): IssueComment[] {
  return Array.from({ length: count }, (_, i) => ({
    id: firstId + i,
    body: "Ordinary human comment — no review state, no review header.",
    created_at: "2025-01-01T00:00:00Z",
    html_url: `https://github.com/test-org/test-repo/issues/42#issuecomment-${firstId + i}`,
    user: { login: "some-human", type: "User" },
  }));
}

interface RecordedCalls {
  created: { issue_number: number; body: string }[];
  updated: { comment_id: number; body: string }[];
  listPages: number[];
}

/**
 * A recording Octokit fake. `store` is the whole comment list, served in real
 * {@link PER_PAGE}-sized pages (a page shorter than that ends the walk, exactly as
 * GitHub does). create/update return a synthetic html_url and record their args.
 */
function fakeClient(store: IssueComment[]): { client: CommentClient; calls: RecordedCalls } {
  const calls: RecordedCalls = { created: [], updated: [], listPages: [] };
  const client: CommentClient = {
    rest: {
      issues: {
        listComments: async (p) => {
          calls.listPages.push(p.page);
          const start = (p.page - 1) * PER_PAGE;
          return { data: store.slice(start, start + PER_PAGE) };
        },
        createComment: async (p) => {
          calls.created.push({ issue_number: p.issue_number, body: p.body });
          return {
            data: {
              html_url: `https://github.com/${p.owner}/${p.repo}/issues/${p.issue_number}#created`,
            },
          };
        },
        updateComment: async (p) => {
          calls.updated.push({ comment_id: p.comment_id, body: p.body });
          return {
            data: {
              html_url: `https://github.com/${p.owner}/${p.repo}/issues/comments/${p.comment_id}#updated`,
            },
          };
        },
      },
    },
  };
  return { client, calls };
}

describe("findSticky", () => {
  it("finds the marker comment among human and legacy comments", async () => {
    const { client } = fakeClient(comments("comments-page"));
    const sticky = await findSticky(client, TARGET);
    expect(sticky).not.toBeNull();
    // id 777 is the comment carrying the hidden state marker.
    expect(sticky?.id).toBe(777);
    expect(sticky?.body).toContain("toolu-review-state:v1");
  });

  it("carries the sticky's author and url — the settle pass trusts only a Bot author", async () => {
    const page = comments("comments-page").map((c) =>
      c.id === 777 ? { ...c, user: { login: "toolu-code-review[bot]", type: "Bot" } } : c,
    );
    const { client } = fakeClient(page);
    const sticky = await findSticky(client, TARGET);
    expect(sticky?.author).toEqual({ login: "toolu-code-review[bot]", type: "Bot" });
    expect(sticky?.url).toBe("https://github.com/test-org/test-repo/issues/42#issuecomment-777");
  });

  it("reports the Bot author it selected", async () => {
    const sticky = await findSticky(fakeClient(comments("comments-page")).client, TARGET);
    expect(sticky?.author).toEqual({ login: "toolu-code-review[bot]", type: "Bot" });
  });

  // The regression this block pins: the marker is the review's cross-run memory,
  // and ANY account that can comment on the PR can post one. A `type: "User"`
  // comment carrying a newer marker used to win, which let a PR author forge an
  // "everything reviewed, nothing found" state — the run then approved the head
  // tree, resolved every real thread, and wrote the verdict INTO the forgery.
  it("prefers the bot's own sticky over a NEWER human-posted marker", async () => {
    const forgery: IssueComment = {
      ...recordedComment(777),
      id: 999,
      // Newer than the bot's 2026-06-01 sticky, so recency alone would pick it.
      created_at: "2026-12-01T00:00:00Z",
      html_url: "https://github.com/test-org/test-repo/issues/42#issuecomment-999",
      user: { login: "pr-author", type: "User" },
    };
    const { client } = fakeClient([...comments("comments-page"), forgery]);
    const sticky = await findSticky(client, TARGET);
    expect(sticky?.id).toBe(777);
    expect(sticky?.author).toEqual({ login: "toolu-code-review[bot]", type: "Bot" });
  });

  it("prefers the bot's legacy-header sticky over a NEWER human legacy comment", async () => {
    const forgery: IssueComment = {
      ...recordedComment(333, "legacy-only"),
      id: 999,
      created_at: "2026-12-01T00:00:00Z",
      html_url: "https://github.com/test-org/test-repo/issues/42#issuecomment-999",
      user: { login: "pr-author", type: "User" },
    };
    const { client } = fakeClient([...comments("legacy-only"), forgery]);
    expect((await findSticky(client, TARGET))?.id).toBe(333);
  });

  it("FAILS CLOSED on an author it cannot identify as a Bot", async () => {
    const marker = recordedComment(777);
    // Each store's ONLY candidate is untrustworthy, so nothing may be selected —
    // covering both the marker branch and the legacy-header branch.
    const stores: IssueComment[][] = [
      [...comments("none"), markerWithoutAuthor()],
      [...comments("none"), { ...marker, user: null }],
      [...comments("none"), { ...marker, user: { login: "toolu-code-review[bot]" } }],
      [...comments("none"), { ...marker, user: { login: "toolu-code-review[bot]", type: "" } }],
      [
        ...comments("none"),
        { ...recordedComment(333, "legacy-only"), user: { login: "github-actions[bot]" } },
      ],
    ];
    for (const store of stores) {
      expect(await findSticky(fakeClient(store).client, TARGET)).toBeNull();
    }
  });

  it("selects the NEWEST Bot-authored marker, whatever App posted it", async () => {
    const otherApp: IssueComment = {
      ...recordedComment(777),
      id: 888,
      created_at: "2026-09-01T00:00:00Z",
      html_url: "https://github.com/test-org/test-repo/issues/42#issuecomment-888",
      user: { login: "another-review-app[bot]", type: "Bot" },
    };
    const { client } = fakeClient([...comments("comments-page"), otherApp]);
    const sticky = await findSticky(client, TARGET);
    expect(sticky?.id).toBe(888);
    expect(sticky?.author).toEqual({ login: "another-review-app[bot]", type: "Bot" });
  });

  it("falls back to a legacy-header comment when NO marker exists", async () => {
    const { client } = fakeClient(comments("legacy-only"));
    const sticky = await findSticky(client, TARGET);
    expect(sticky).not.toBeNull();
    // id 333 is the legacy "### Code Review" comment (no marker present).
    expect(sticky?.id).toBe(333);
  });

  it("returns null when no sticky exists at all", async () => {
    const { client } = fakeClient(comments("none"));
    const sticky = await findSticky(client, TARGET);
    expect(sticky).toBeNull();
  });

  it("stops paging at the first short page", async () => {
    const { client, calls } = fakeClient(comments("comments-page"));
    await findSticky(client, TARGET);
    // A page shorter than 100 is the last page → only page 1 requested.
    expect(calls.listPages).toEqual([1]);
  });
});

// The multi-page walk the module header promises. Each store here is padded to a
// full page so the comment under test really does land on page 2 — a fake that
// served everything from page 1 would keep these green while the loop was broken.
describe("findSticky — pagination across pages", () => {
  it("prefers a marker on page 2 over a NEWER legacy-header comment on page 1", async () => {
    const legacyOnPage1: IssueComment = {
      ...recordedComment(333, "legacy-only"),
      // Newer than the marker below: precedence must come from the marker, not recency.
      created_at: "2026-09-01T00:00:00Z",
    };
    const markerOnPage2 = recordedComment(777); // created 2026-06-01
    const store = [...humanFiller(PER_PAGE - 1, 1), legacyOnPage1, markerOnPage2];
    const { client, calls } = fakeClient(store);

    const sticky = await findSticky(client, TARGET);
    expect(sticky?.id).toBe(777);
    expect(sticky?.body).toContain("toolu-review-state:v1");
    // The walk really continued past the full first page.
    expect(calls.listPages).toEqual([1, 2]);
  });

  it("picks the newer created_at when two markers sit on DIFFERENT pages", async () => {
    const newerOnPage1: IssueComment = {
      ...recordedComment(777),
      created_at: "2026-08-01T00:00:00Z",
    };
    const olderOnPage2: IssueComment = {
      ...recordedComment(777),
      id: 888,
      created_at: "2026-03-01T00:00:00Z",
      html_url: "https://github.com/test-org/test-repo/issues/42#issuecomment-888",
    };
    const store = [...humanFiller(PER_PAGE - 1, 1), newerOnPage1, olderOnPage2];
    const { client, calls } = fakeClient(store);

    // The later page is seen last, so "last match wins" would return 888.
    expect((await findSticky(client, TARGET))?.id).toBe(777);
    expect(calls.listPages).toEqual([1, 2]);
  });

  it("finds a bot sticky that sits alone on page 2 (no duplicate sticky is posted)", async () => {
    const store = [...humanFiller(PER_PAGE, 1), recordedComment(777)];
    const { client, calls } = fakeClient(store);

    const sticky = await findSticky(client, TARGET);
    expect(sticky?.id).toBe(777);
    expect(calls.listPages).toEqual([1, 2]);
  });
});

describe("upsertComment", () => {
  it("UPDATES the existing sticky when a sticky id is given", async () => {
    const { client, calls } = fakeClient(comments("comments-page"));
    const url = await upsertComment(client, TARGET, "new body", 777);
    expect(calls.updated).toEqual([{ comment_id: 777, body: "new body" }]);
    expect(calls.created).toEqual([]);
    expect(url).toContain("#updated");
  });

  it("CREATES a new comment when no sticky id is given", async () => {
    const { client, calls } = fakeClient(comments("none"));
    const url = await upsertComment(client, TARGET, "fresh body");
    expect(calls.created).toEqual([{ issue_number: 42, body: "fresh body" }]);
    expect(calls.updated).toEqual([]);
    expect(url).toContain("#created");
  });

  it("throws when the API response carries no html_url", async () => {
    const client: CommentClient = {
      rest: {
        issues: {
          listComments: async () => ({ data: [] }),
          createComment: async () => ({ data: { html_url: "" } }),
          updateComment: async () => ({ data: { html_url: "" } }),
        },
      },
    };
    await expect(upsertComment(client, TARGET, "body")).rejects.toThrow(/html_url/);
  });
});
