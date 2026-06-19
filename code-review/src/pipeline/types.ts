// pipeline/types.ts — the public types for the review pipeline: the injectable
// dependency bundle, the GitHub context slice, the Octokit union, and the result.
// Split out of pipeline.ts so that file stays under the 300-LOC budget. These are
// re-exported from pipeline.ts, so callers keep importing them from "./pipeline.js".
import type { EventPayload } from "@/github/event.js";
import type { CommentClient } from "@/github/comment.js";
import type { ReviewClient } from "@/github/review.js";
import type { LabelClient } from "@/github/label.js";
import type { ActionInputs } from "@/inputs.js";

/** The full Octokit slice the pipeline needs — the union of every module's client. */
export type PipelineOctokit = CommentClient & ReviewClient & LabelClient;

/** The slice of `@actions/github` context the pipeline reads (loose by design). */
export interface GithubContext {
  /** Event name, e.g. "pull_request" | "issue_comment". */
  eventName: string;
  /** Parsed event payload. */
  payload: EventPayload | null;
  /** { owner, repo } resolved from GITHUB_REPOSITORY. */
  repo: { owner: string; repo: string };
  /** The head commit SHA of the run (GITHUB_SHA). */
  sha: string;
  /**
   * The PR head commit SHA (`pull_request.head.sha`), when the event carries one.
   * The inline-review API needs a commit that is IN the PR — the merge SHA in
   * `sha` is rejected (422), so this is preferred for the inline-review commit_id.
   */
  headSha?: string;
  /**
   * The PR head branch name (`pull_request.head.ref`), when present. Used for the
   * verdict heading (the bash showed GITHUB_HEAD_REF, the PR source branch).
   */
  headRef?: string;
  /** Server URL for the "View job" link. */
  serverUrl: string;
  /** Numeric run id for the "View job" link. */
  runId: number;
}

/** The injectable dependency bundle for `runReview`. */
export interface ReviewDeps {
  /** Resolved, typed inputs (never re-read from env). */
  inputs: ActionInputs;
  /** The Octokit REST client (App-token authed in prod, a recording fake in tests). */
  octokit: PipelineOctokit;
  /** The GitHub event/repo context. */
  context: GithubContext;
  /** Custom fetch forwarded to the LLM call (tests replay a recorded response). */
  fetch?: typeof fetch;
  /** Repo working directory for git operations (default process.cwd()). */
  cwd?: string;
  /** Repo-permission lookup for an @mention re-trigger (fail-closed when absent). */
  lookupPermission?: (commenter: string) => Promise<string>;
  /** PR base-ref lookup for an @mention re-trigger (best-effort). */
  lookupBaseRef?: (prNumber: number) => Promise<string>;
  /** Clock for the state history timestamp + duration (default Date.now). */
  now?: () => number;
  /** Dir of deterministic-scanner SARIF (TOOLU_SARIF_DIR from the composite steps);
   * absent → no mechanical findings (the review runs LLM-only). */
  sarifDir?: string;
}

/** The pipeline's result — exactly the three action outputs main.ts forwards. */
export interface ReviewResult {
  verdict: "approved" | "changes" | "skip" | "error";
  findingsCount: number;
  commentUrl: string;
}
