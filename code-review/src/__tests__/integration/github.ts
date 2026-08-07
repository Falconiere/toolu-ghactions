// github.ts — the recording GitHub client the integration scenarios inject as
// `ReviewDeps.octokit`. It serves the exact shapes the pipeline's readers expect
// (github/threads.ts's zod-validated GraphQL reviewThreads page, the Reviews REST
// API, the issue-comments list) and records every mutation for assertions.
//
// Its comment store PERSISTS across `runReview` calls, so round N+1 really reads
// the state marker round N wrote — the scenarios never hand-build prior state.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { appendFpMarker } from "@/review/fpmarker.js";
import type { ReviewComment } from "@/github/review.js";
import type { PipelineOctokit } from "@/pipeline.js";

/** The REAL 422 body PR-72's `createReview` got back (github/__tests__/fixtures). */
export function pr72FixtureText(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(
    join(here, "..", "..", "github", "__tests__", "fixtures", "pr72-createreview-422.txt"),
    "utf8",
  );
}
// ── Recording GitHub client ─────────────────────────────────────────────────

/** A bot-authored review thread to serve from the graphql fake. */
export interface SeedThread {
  threadId: string;
  rootCommentId: number;
  fp: string;
  path: string;
  line: number | null;
  isResolved?: boolean;
  isOutdated?: boolean;
  botLogin?: string;
  replies?: { author: string; body: string }[];
  /** The root comment's body VERBATIM — a scenario passes the real body its previous
   *  round posted (which already carries its own fp marker). Omitted → a minimal
   *  body is synthesized and the marker for `fp` appended to it. */
  rootBody?: string;
}

/** Every GitHub call a run made, recorded for assertions. */
export interface Recorded {
  created: { body: string }[];
  updated: { comment_id: number; body: string }[];
  /** `createReview` calls GitHub ACCEPTED, with their full comment payloads. */
  reviews: { commit_id: string; body: string; comments: ReviewComment[] }[];
  /** Comment count of every `createReview` ATTEMPT, 422s included — the observable
   *  for batch bisection (attempts > accepted). */
  attempts: number[];
  replies: { comment_id: number; body: string }[];
  resolved: string[];
  addedLabels: string[][];
  removedLabels: string[];
}

/** How the GitHub fake behaves for one scenario. */
export interface OctokitOptions {
  /** Seed the comment list (a prior sticky). The store is mutable across rounds. */
  existing?: { id: number; body: string }[];
  /** Bot threads to serve. Mutable by reference — a scenario pushes the thread its
   *  previous round created, exactly as GitHub would show it on the next run. */
  threads?: SeedThread[];
  /** Path → GitHub's own patch. Present ⇒ `listFiles` exists and anchors are
   *  validated; a path mapped to `undefined` has no patch and is UNANCHORABLE. */
  patches?: Map<string, string | undefined>;
  /** A `createReview` batch containing a comment on this path 422s with the REAL
   *  PR-72 response text — until bisection isolates that comment alone. */
  poisonPath?: string;
}

/** A unified patch whose RIGHT side displays lines 1..`lines` — what GitHub
 *  returns for a small added file, and what anchor validation reads. */
export function patchCovering(lines: number): string {
  const rows = Array.from({ length: lines }, (_, i) => `+line ${i + 1}`);
  return `@@ -0,0 +1,${lines} @@\n${rows.join("\n")}`;
}

/** The recording GitHub fake. Its comment store PERSISTS across `runReview`
 *  calls, so a later round reads the marker an earlier one wrote. */
export function fakeOctokit(opts: OctokitOptions = {}): {
  octokit: PipelineOctokit;
  rec: Recorded;
} {
  const rec: Recorded = {
    created: [],
    updated: [],
    reviews: [],
    attempts: [],
    replies: [],
    resolved: [],
    addedLabels: [],
    removedLabels: [],
  };
  const store = (opts.existing ?? []).map((c, i) => ({
    id: c.id,
    body: c.body,
    created_at: `2026-01-01T00:0${i}:00Z`,
    html_url: `https://github.com/o/r/issues/comments/${c.id}`,
  }));
  const threads = opts.threads ?? [];
  const patches = opts.patches;
  let nextId = 9000;

  const octokit: PipelineOctokit = {
    rest: {
      issues: {
        listComments: async (p) => ({ data: p.page === 1 ? store : [] }),
        createComment: async (p) => {
          rec.created.push({ body: p.body });
          const id = nextId++;
          const html_url = `https://github.com/o/r/issues/${p.issue_number}#c${id}`;
          store.push({ id, body: p.body, created_at: "2026-06-01T00:00:00Z", html_url });
          return { data: { html_url } };
        },
        updateComment: async (p) => {
          rec.updated.push({ comment_id: p.comment_id, body: p.body });
          const c = store.find((s) => s.id === p.comment_id);
          if (c) c.body = p.body;
          return { data: { html_url: `https://github.com/o/r/c/${p.comment_id}` } };
        },
        createLabel: async (p) => {
          rec.addedLabels.push([p.name]);
          return {};
        },
        removeLabel: async (p) => {
          rec.removedLabels.push(p.name);
          return {};
        },
        addLabels: async (p) => {
          rec.addedLabels.push(p.labels);
          return {};
        },
      },
      pulls: {
        createReview: async (p) => {
          rec.attempts.push(p.comments.length);
          const poison = opts.poisonPath;
          if (poison !== undefined && p.comments.some((c) => c.path === poison)) {
            throw new Error(pr72FixtureText());
          }
          rec.reviews.push({ commit_id: p.commit_id, body: p.body, comments: p.comments });
          return { data: { html_url: "https://github.com/o/r/pull/7#review" } };
        },
        createReplyForReviewComment: async (p) => {
          rec.replies.push({ comment_id: p.comment_id, body: p.body });
          return { data: { id: 7000 + rec.replies.length } };
        },
        ...(patches === undefined
          ? {}
          : {
              listFiles: async () => ({
                data: [...patches].map(([filename, patch]) => ({
                  filename,
                  ...(patch === undefined ? {} : { patch }),
                })),
              }),
            }),
      },
    },
    graphql: async (query: string, variables?: Record<string, unknown>) => {
      if (query.includes("resolveReviewThread")) {
        rec.resolved.push(String(variables?.["threadId"]));
        return { resolveReviewThread: { thread: { isResolved: true } } };
      }
      return {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: threads.map((t) => ({
                id: t.threadId,
                isResolved: t.isResolved ?? false,
                isOutdated: t.isOutdated ?? false,
                path: t.path,
                line: t.line,
                comments: {
                  nodes: [
                    {
                      databaseId: t.rootCommentId,
                      body: t.rootBody ?? appendFpMarker(`**finding** at ${t.path}`, t.fp),
                      author: { login: t.botLogin ?? "toolu-bot" },
                    },
                    ...(t.replies ?? []).map((r, i) => ({
                      databaseId: t.rootCommentId + i + 1,
                      body: r.body,
                      author: { login: r.author },
                    })),
                  ],
                },
              })),
            },
          },
        },
      };
    },
  };
  return { octokit, rec };
}
