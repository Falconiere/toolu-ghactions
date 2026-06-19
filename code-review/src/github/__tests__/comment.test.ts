import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { findSticky, upsertComment } from "@/github/comment.js";
import type { CommentClient, IssueComment, CommentTarget } from "@/github/comment.js";

// REAL recorded comment-list payloads from ./fixtures/sticky — a marker
// comment among human + legacy comments, a legacy-only list, and a no-sticky
// list. The Octokit client is a recording fake fed those payloads; create/update
// calls are asserted against the injected fake (no network).
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "sticky");

const TARGET: CommentTarget = { owner: "test-org", repo: "test-repo", prNumber: 42 };

/** Load a recorded comments-list fixture. */
function comments(name: string): IssueComment[] {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));
}

interface RecordedCalls {
  created: { issue_number: number; body: string }[];
  updated: { comment_id: number; body: string }[];
  listPages: number[];
}

/**
 * A recording Octokit fake. `pages` is the recorded list response for page 1;
 * any later page returns [] (a short page → stop). create/update return a
 * synthetic html_url and record their args.
 */
function fakeClient(pages: IssueComment[]): { client: CommentClient; calls: RecordedCalls } {
  const calls: RecordedCalls = { created: [], updated: [], listPages: [] };
  const client: CommentClient = {
    rest: {
      issues: {
        listComments: async (p) => {
          calls.listPages.push(p.page);
          return { data: p.page === 1 ? pages : [] };
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
