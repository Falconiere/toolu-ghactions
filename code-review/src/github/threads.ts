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
// The two mutations are best-effort (the summary comment is always the authority); the
// read fails loudly on its first page (see fetchReviewThreads). Only threads the bot
// rooted, carrying its hidden fingerprint marker (see fpmarker.ts), are returned —
// human review threads are not the bot's to manage.
import { z } from "zod";
import { errorMessage } from "@/errors.js";
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
  /** Login that resolved the thread (GraphQL `resolvedBy`; an App reads `name[bot]`),
   *  "" when unresolved or the API does not say. Whether that resolution SETTLES the
   *  finding is decided by classifyDismissals (`dismissal: "resolved"`), never here. */
  resolvedBy: string;
  /** GitHub-side outdated flag (the anchored hunk was superseded by a later push). */
  isOutdated: boolean;
  /**
   * How the thread was SETTLED — set by
   * {@link import("@/review/dismissal.js").classifyDismissals}, never by the
   * GraphQL read. `"explicit"` = an authorized `<TRIGGER_PHRASE> dismiss` reply;
   * `"resolved"` = resolved on GitHub by a human who clears MIN_TRIGGER_PERMISSION;
   * `"exhausted"` = the bot already argued the point and the author answered
   * again. Undefined when nothing settled it — including a thread resolved by the
   * bot itself, by a login below the floor, or by an unknown resolver.
   */
  dismissal?: "explicit" | "resolved" | "exhausted";
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

/**
 * The bot's durable acknowledgement that a finding no longer applies. Publishing
 * the reply and resolving its thread are separate best-effort API calls, so the
 * reply can land while the mutation fails. On a later run the thread is still open:
 * it resolves again if its finding is still gone (without repeating this note), and is
 * the finding's open thread if the finding is back. The note itself never settles.
 */
export const ACCEPTED_RESOLUTION_NOTE =
  "Re-reviewed — this no longer applies (addressed, or point taken). Resolving.";

/**
 * True only for the action's exact acknowledgement posted by the same identity
 * that opened the thread. Requiring both author equality and exact body equality
 * prevents another commenter from settling a finding by copying the sentence.
 */
export function hasAcceptedResolutionNote(thread: PriorThread): boolean {
  if (thread.botLogin === "") return false;
  return thread.replies.some(
    (reply) => reply.author === thread.botLogin && reply.body.trim() === ACCEPTED_RESOLUTION_NOTE,
  );
}

/** A login without GitHub's `[bot]` suffix. REST and `resolvedBy` spell an App's
 *  login `name[bot]`; GraphQL comment authors spell the same identity `name`. */
export function bare(login: string): string {
  return login.replace(/\[bot\]$/, "");
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
// a malformed page is a read failure (see fetchReviewThreads), never an NPE. ---
const GqlThreadSchema = z.object({
  id: z.string(),
  isResolved: z.boolean(),
  resolvedBy: z.object({ login: z.string() }).nullable().optional(),
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
type GqlConnection = NonNullable<
  NonNullable<z.infer<typeof GqlResponseSchema>["repository"]>["pullRequest"]
>["reviewThreads"];

const THREADS_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            isResolved
            resolvedBy { login }
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
 * A thread is kept only when its FIRST comment carries the fingerprint marker, a usable root
 * databaseId, AND was posted by `botLogin` — the sticky comment's author (compared {@link
 * bare}). Anyone can post an inline comment carrying the marker, so the marker alone proves
 * nothing. An empty `botLogin` (no bot-authored sticky yet) reads nothing.
 *
 * A failure on the FIRST page (a throw, a malformed body, no pull request) THROWS: "no
 * threads" would make the review re-post every finding as a duplicate and resurrect every
 * settled one. A failure MID-PAGINATION (e.g. a 403 secondary rate limit on page 2) keeps
 * the pages already fetched — strictly more information than starting over.
 */
export async function fetchReviewThreads(
  client: ThreadClient,
  target: ThreadTarget,
  botLogin: string,
): Promise<PriorThread[]> {
  const bot = bare(botLogin);
  if (bot === "") return [];
  const threads: PriorThread[] = [];
  let cursor: string | null = null;
  // Bound the pagination loop: 100 threads/page × 20 pages = 2000 threads, far beyond
  // any real PR, so a malformed endCursor can't spin forever.
  for (let page = 0; page < 20; page++) {
    let conn: GqlConnection;
    try {
      conn = await readPage(client, target, cursor);
    } catch (err) {
      if (page === 0) {
        throw new Error(`could not read review threads: ${errorMessage(err)}`, { cause: err });
      }
      return threads;
    }
    for (const node of conn.nodes) {
      const thread = normalizeThread(node);
      if (thread && bare(thread.botLogin) === bot) threads.push(thread);
    }
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    if (cursor === null) break;
  }
  return threads;
}

/** One validated reviewThreads page; throws on a malformed body or a missing PR. */
async function readPage(
  client: ThreadClient,
  target: ThreadTarget,
  cursor: string | null,
): Promise<GqlConnection> {
  const raw: unknown = await client.graphql(THREADS_QUERY, {
    owner: target.owner,
    repo: target.repo,
    number: target.prNumber,
    cursor,
  });
  const parsed = GqlResponseSchema.safeParse(raw);
  if (!parsed.success) throw new Error("malformed reviewThreads response");
  const conn = parsed.data.repository?.pullRequest?.reviewThreads;
  if (!conn) throw new Error("pull request not found");
  return conn;
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
    resolvedBy: node.resolvedBy?.login ?? "",
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
