// github/threads.ts — read and act on the bot's own inline PR review threads, so a
// re-review can react to what the author SAID rather than blindly re-posting the same
// findings every run. Three operations:
//   - fetchReviewThreads: GraphQL list of review threads (finding + author replies +
//     resolved/outdated state), normalised to {@link PriorThread}.
//   - resolveThread:      GraphQL resolveReviewThread — close a thread the bot is
//     dropping (it accepted the author's rebuttal).
//   - replyToThread:      REST reply on the root comment — the bot's counter-reasoning
//     posted IN the existing thread instead of opening a duplicate.
//
// All best-effort: the caller treats failures as non-fatal (the summary comment is
// always the authority). Only threads carrying the bot's hidden fingerprint marker
// (see fpmarker.ts) are returned — human review threads are not the bot's to manage.
import { z } from "zod";
import { extractFpMarker } from "@/review/fpmarker.js";

/** A bot-authored review thread observed on the PR, normalised for reconciliation. */
export interface PriorThread {
  /** GraphQL node id — the handle for resolveReviewThread. */
  threadId: string;
  /** REST databaseId of the thread's FIRST (root) comment — the handle for a reply. */
  rootCommentId: number;
  /** The finding fingerprint pulled from the root comment's hidden marker. */
  fp: string;
  /** File path the thread is anchored to. */
  path: string;
  /** 1-based line, or null when GitHub reports the thread as detached/outdated. */
  line: number | null;
  /** GitHub-side resolved flag (a resolved thread is not re-resolved or replied to). */
  isResolved: boolean;
  /** GitHub-side outdated flag (the anchored hunk was superseded by a later push). */
  isOutdated: boolean;
  /** The root comment body (the bot's original finding, marker included). */
  rootBody: string;
  /** Comments after the root, in order — the conversation (author + bot replies). */
  replies: ThreadComment[];
  /** Login of the root comment's author — i.e. the bot's own login on this PR. */
  botLogin: string;
}

/** One comment in a thread (root or reply). */
export interface ThreadComment {
  author: string;
  body: string;
}

/** Repo + PR coordinates a thread operation targets. */
export interface ThreadTarget {
  owner: string;
  repo: string;
  prNumber: number;
}

/** The Octokit slice these operations use: GraphQL (read + resolve) and one REST reply. */
export interface ThreadClient {
  graphql(query: string, variables?: Record<string, unknown>): Promise<unknown>;
  rest: {
    pulls: {
      createReplyForReviewComment(params: {
        owner: string;
        repo: string;
        pull_number: number;
        comment_id: number;
        body: string;
      }): Promise<{ data: { id: number } }>;
    };
  };
}

// --- GraphQL response shape for the reviewThreads query (only the fields we select).
// A graphql() result is untrusted external data, so it is zod-validated rather than cast:
// a malformed page is dropped (safeParse fail → break) instead of throwing or NPE'ing. ---
const GqlThreadSchema = z.object({
  id: z.string(),
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  path: z.string(),
  line: z.number().nullable(),
  comments: z.object({
    nodes: z.array(
      z.object({
        databaseId: z.number().nullable(),
        body: z.string(),
        author: z.object({ login: z.string() }).nullable(),
      }),
    ),
  }),
});
const GqlResponseSchema = z.object({
  repository: z
    .object({
      pullRequest: z
        .object({
          reviewThreads: z.object({
            pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
            nodes: z.array(GqlThreadSchema),
          }),
        })
        .nullable(),
    })
    .nullable(),
});
type GqlThread = z.infer<typeof GqlThreadSchema>;

const THREADS_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            isResolved
            isOutdated
            path
            line
            comments(first: 50) {
              nodes { databaseId body author { login } }
            }
          }
        }
      }
    }
  }
`;

const RESOLVE_MUTATION = `
  mutation($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread { isResolved }
    }
  }
`;

/**
 * Fetch the bot's own inline review threads (paginated), normalised to {@link PriorThread}.
 * A thread is kept only when its FIRST comment carries the bot's fingerprint marker AND a
 * usable root databaseId — i.e. it is a bot finding we can later reply to or resolve. Human
 * threads and malformed nodes are dropped. Never throws: any API error yields `[]` so a
 * re-review degrades to the old "post fresh" behaviour rather than failing the job.
 */
export async function fetchReviewThreads(
  client: ThreadClient,
  target: ThreadTarget,
): Promise<PriorThread[]> {
  const threads: PriorThread[] = [];
  let cursor: string | null = null;
  try {
    // Bound the pagination loop: 100 threads/page × 20 pages = 2000 threads, far beyond
    // any real PR, so a malformed endCursor can't spin forever.
    for (let page = 0; page < 20; page++) {
      const raw: unknown = await client.graphql(THREADS_QUERY, {
        owner: target.owner,
        repo: target.repo,
        number: target.prNumber,
        cursor,
      });
      const parsed = GqlResponseSchema.safeParse(raw);
      if (!parsed.success) break;
      const conn = parsed.data.repository?.pullRequest?.reviewThreads;
      if (!conn) break;
      for (const node of conn.nodes) {
        const parsed = normalizeThread(node);
        if (parsed) threads.push(parsed);
      }
      if (!conn.pageInfo.hasNextPage) break;
      cursor = conn.pageInfo.endCursor;
      if (cursor === null) break;
    }
  } catch {
    return [];
  }
  return threads;
}

/** Normalise one GraphQL thread node, or null when it is not a usable bot thread. */
function normalizeThread(node: GqlThread): PriorThread | null {
  const comments = node.comments.nodes;
  const root = comments[0];
  if (!root || root.databaseId == null) return null;
  const fp = extractFpMarker(root.body);
  if (fp === null) return null; // not the bot's finding → not ours to manage
  return {
    threadId: node.id,
    rootCommentId: root.databaseId,
    fp,
    path: node.path,
    line: node.line,
    isResolved: node.isResolved,
    isOutdated: node.isOutdated,
    rootBody: root.body,
    botLogin: root.author?.login ?? "",
    replies: comments.slice(1).map((c) => ({ author: c.author?.login ?? "", body: c.body })),
  };
}

/** Resolve a review thread (best-effort: returns false on any failure, never throws). */
export async function resolveThread(client: ThreadClient, threadId: string): Promise<boolean> {
  try {
    await client.graphql(RESOLVE_MUTATION, { threadId });
    return true;
  } catch {
    return false;
  }
}

/** Reply to a thread on its root comment (best-effort: returns false on failure, never throws). */
export async function replyToThread(
  client: ThreadClient,
  target: ThreadTarget,
  rootCommentId: number,
  body: string,
): Promise<boolean> {
  try {
    await client.rest.pulls.createReplyForReviewComment({
      owner: target.owner,
      repo: target.repo,
      pull_number: target.prNumber,
      comment_id: rootCommentId,
      body,
    });
    return true;
  } catch {
    return false;
  }
}
