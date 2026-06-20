import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { fetchReviewThreads, resolveThread, replyToThread } from "@/github/threads.js";
import type { ThreadClient, ThreadTarget } from "@/github/threads.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** A recorded GraphQL `reviewThreads` response body (the unwrapped `data` object). */
function reviewThreadsFixture(): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, "review-threads.json"), "utf8"));
}

const TARGET: ThreadTarget = { owner: "o", repo: "r", prNumber: 7 };

/** A fake ThreadClient that records calls and replays a configured graphql response. */
function fakeClient(opts: {
  graphqlResponses?: unknown[];
  graphqlThrows?: boolean;
  replyThrows?: boolean;
}): {
  client: ThreadClient;
  calls: { graphql: { query: string; variables?: Record<string, unknown> }[]; replies: unknown[] };
} {
  const calls: {
    graphql: { query: string; variables?: Record<string, unknown> }[];
    replies: unknown[];
  } = { graphql: [], replies: [] };
  const responses = opts.graphqlResponses ?? [];
  let i = 0;
  const client: ThreadClient = {
    graphql: async (query: string, variables?: Record<string, unknown>) => {
      calls.graphql.push({ query, variables });
      if (opts.graphqlThrows) throw new Error("GraphQL boom");
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      return r ?? {};
    },
    rest: {
      pulls: {
        createReplyForReviewComment: async (params) => {
          calls.replies.push(params);
          if (opts.replyThrows) throw new Error("reply boom");
          return { data: { id: 9001 } };
        },
      },
    },
  };
  return { client, calls };
}

describe("fetchReviewThreads", () => {
  it("returns ONLY bot threads with a usable root (marker + databaseId)", async () => {
    const { client } = fakeClient({ graphqlResponses: [reviewThreadsFixture()] });
    const threads = await fetchReviewThreads(client, TARGET);

    // The human thread (no marker) and the no-databaseId thread are dropped.
    expect(threads).toHaveLength(1);
    const t = threads[0];
    expect(t?.threadId).toBe("PRRT_kwBOTthread1");
    expect(t?.rootCommentId).toBe(5001);
    expect(t?.fp).toBe("1111111111111111111111111111111111111111");
    expect(t?.path).toBe("src/auth.ts");
    expect(t?.line).toBe(42);
    expect(t?.isResolved).toBe(false);
    expect(t?.isOutdated).toBe(false);
    expect(t?.botLogin).toBe("toolu-bot");
  });

  it("parses the author replies (everything after the root comment)", async () => {
    const { client } = fakeClient({ graphqlResponses: [reviewThreadsFixture()] });
    const [t] = await fetchReviewThreads(client, TARGET);
    expect(t?.replies).toEqual([
      { author: "human-dev", body: "This is intentional — the value is already HMAC'd upstream." },
    ]);
  });

  it("follows pagination, accumulating bot threads across pages", async () => {
    const page1 = {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: true, endCursor: "CURSOR_1" },
            nodes: [
              {
                id: "T_page1",
                isResolved: false,
                isOutdated: false,
                path: "a.ts",
                line: 1,
                comments: {
                  nodes: [
                    {
                      databaseId: 11,
                      body: "p1\n<!-- toolu-fp:aaaa11 -->",
                      author: { login: "bot" },
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    };
    const page2 = {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "T_page2",
                isResolved: false,
                isOutdated: false,
                path: "b.ts",
                line: 2,
                comments: {
                  nodes: [
                    {
                      databaseId: 22,
                      body: "p2\n<!-- toolu-fp:bbbb22 -->",
                      author: { login: "bot" },
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    };
    const { client, calls } = fakeClient({ graphqlResponses: [page1, page2] });
    const threads = await fetchReviewThreads(client, TARGET);
    expect(threads.map((t) => t.threadId)).toEqual(["T_page1", "T_page2"]);
    // Second call carried the endCursor from page 1.
    expect(calls.graphql[1]?.variables?.["cursor"]).toBe("CURSOR_1");
  });

  it("returns [] (never throws) when graphql fails", async () => {
    const { client } = fakeClient({ graphqlThrows: true });
    await expect(fetchReviewThreads(client, TARGET)).resolves.toEqual([]);
  });

  it("returns [] for a malformed response shape", async () => {
    const { client } = fakeClient({ graphqlResponses: [{ unexpected: "shape" }] });
    await expect(fetchReviewThreads(client, TARGET)).resolves.toEqual([]);
  });
});

describe("resolveThread", () => {
  it("issues the resolve mutation with the thread id and returns true", async () => {
    const { client, calls } = fakeClient({
      graphqlResponses: [{ resolveReviewThread: { thread: { isResolved: true } } }],
    });
    const ok = await resolveThread(client, "T_resolve_me");
    expect(ok).toBe(true);
    expect(calls.graphql[0]?.query).toContain("resolveReviewThread");
    expect(calls.graphql[0]?.variables?.["threadId"]).toBe("T_resolve_me");
  });

  it("returns false (never throws) when the mutation fails", async () => {
    const { client } = fakeClient({ graphqlThrows: true });
    await expect(resolveThread(client, "T_x")).resolves.toBe(false);
  });
});

describe("replyToThread", () => {
  it("replies on the root comment and returns true", async () => {
    const { client, calls } = fakeClient({});
    const ok = await replyToThread(client, TARGET, 5001, "still flagging");
    expect(ok).toBe(true);
    expect(calls.replies[0]).toEqual({
      owner: "o",
      repo: "r",
      pull_number: 7,
      comment_id: 5001,
      body: "still flagging",
    });
  });

  it("returns false (never throws) when the reply call fails", async () => {
    const { client } = fakeClient({ replyThrows: true });
    await expect(replyToThread(client, TARGET, 1, "x")).resolves.toBe(false);
  });
});
