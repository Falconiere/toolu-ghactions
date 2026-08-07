// harness.ts — shared builders for the integration scenario suite (AC-15).
//
// Every scenario enters at `runReview` (src/pipeline.ts) with all four boundaries
// injected through `ReviewDeps`, so scope, prior state, packaging and coverage are
// PRODUCED BY THE PIPELINE and never hand-built:
//   - git      → a REAL scratch repo driven by the real `git` binary (helpers.ts);
//   - the LLM  → a scripted `fetch` that records every outgoing envelope and can
//                answer it with a verdict, a schema failure, or a transport failure;
//   - GitHub   → a recording Octokit fake whose comment store PERSISTS across
//                `runReview` calls, so round N+1 really reads round N's marker;
//   - toolu.sh → the same scripted `fetch`, routed by URL.
//
// Assertions in the scenarios read only REAL pipeline products: posted comment
// bodies, recorded API payloads, the decoded marker, the rendered ledger.
//
// The two boundary fakes live beside this file (both would push it past the house
// 300-line ceiling): `model.ts` (scripted provider + toolu.sh sink) and
// `github.ts` (recording Octokit). This file owns the scratch repos, the inputs and
// event contexts, and the readers for a finished run's products.
import { git, removeRepo, setupGitRepo, writeFile } from "@/git/__tests__/helpers.js";
import { fetchDiff } from "@/git/diff.js";
import { splitDiffByFile } from "@/git/chunk.js";
import { decodeMarker, extractMarker, type ReviewState } from "@/state.js";
import type { ReviewComment } from "@/github/review.js";
import type { GithubContext } from "@/pipeline.js";
import type { ActionInputs } from "@/inputs.js";
import type { BlockableVerdict } from "@/review/gate.js";
import type { Recorded } from "./github.js";

// ── Scratch repos ───────────────────────────────────────────────────────────

const repos: string[] = [];

/** Remove every scratch repo this file created. Call from `afterEach`. */
export function cleanupRepos(): void {
  for (const dir of repos.splice(0)) removeRepo(dir);
}

/** One scratch repo: its path and the feature branch's head sha. */
export interface Scratch {
  dir: string;
  headSha: string;
}

/**
 * A real repo with `base` committed on `main`, then `build` run on a `feature`
 * branch and committed. `build` gets the repo dir and may do ANY real git work
 * (write files, `git mv`, …) — the diff under review is whatever git reports.
 */
export function scratchRepo(
  build: (dir: string) => void,
  base: Record<string, string> = {},
): Scratch {
  const dir = setupGitRepo();
  repos.push(dir);
  for (const [path, content] of Object.entries(base)) writeFile(dir, path, content);
  if (Object.keys(base).length > 0) commitAll(dir, "base");
  git(dir, "checkout", "-b", "feature", "--quiet");
  build(dir);
  return { dir, headSha: commitAll(dir, "feature") };
}

/** Stage everything and commit; returns the new head sha. */
export function commitAll(dir: string, message: string): string {
  git(dir, "add", "-A");
  git(dir, "commit", "-m", message, "--quiet");
  return git(dir, "rev-parse", "HEAD").trim();
}

/** The head's root tree sha — what a complete round records as `reviewed_tree`. */
export function treeSha(dir: string): string {
  return git(dir, "rev-parse", "HEAD^{tree}").trim();
}

/**
 * The primed-diff line total of the REAL diff's segments under `prefix`. Scenarios
 * size `MAX_CHUNK_LINES` from this so a package boundary lands exactly where they
 * need it, instead of hard-coding git's own byte counts (which would silently drift).
 */
export function segmentLines(dir: string, prefix: string): number {
  const diff = fetchDiff({
    baseBranch: "main",
    githubBaseRef: "main",
    reviewHead: "HEAD",
    maxFiles: 0,
    maxDiffLines: 0,
    cwd: dir,
  });
  return splitDiffByFile(diff.diff)
    .filter((s) => s.path.startsWith(prefix))
    .reduce((n, s) => n + s.lines, 0);
}

// ── Inputs + event contexts ─────────────────────────────────────────────────

/** Fully-resolved inputs (what readInputs would yield), overridable per scenario. */
export function baseInputs(over: Partial<ActionInputs> = {}): ActionInputs {
  return {
    provider: "openrouter",
    model: "deepseek/deepseek-v4-flash",
    apiKey: "sk-test",
    maxTokens: 4096,
    minConfidence: "high",
    enforceJsonSchema: true,
    inlineComments: true,
    manageLabels: false,
    baseBranch: "main",
    reviewPromptFile: "",
    codebaseOverview: "",
    checkProjectRules: false,
    rulesGlob: "",
    rulesRef: "base",
    excludeGlobs: [],
    rulesMaxBytes: 32768,
    maxFiles: 0,
    maxRounds: 0,
    maxDiffLines: 0,
    maxChunkLines: 0,
    maxChunks: 0,
    maxWallMs: 0,
    requestTimeoutMs: 30000,
    token: "ghs_test",
    appId: "",
    appPrivateKey: "",
    triggerPhrase: "@toolu",
    minTriggerPermission: "write",
    botName: "Toolu — Code Review",
    botLogoUrl: "https://example.com/logo.png",
    reviewMemory: true,
    failOn: new Set<BlockableVerdict>(),
    verbosity: "compact",
    touluApiKey: "",
    touluApiUrl: "https://api.toolu.sh",
    ...over,
  };
}

/** A real `pull_request` event context for PR #7 (repoId set so reporting runs). */
export function prContext(headSha: string): GithubContext {
  return {
    eventName: "pull_request",
    payload: {
      pull_request: { number: 7, base: { ref: "main" }, head: { sha: headSha } },
      repository: { id: 4242 },
    },
    repo: { owner: "test-org", repo: "test-repo" },
    sha: headSha,
    headSha,
    serverUrl: "https://github.com",
    runId: 12345,
    repoId: 4242,
  };
}

/** An `@toolu …` issue_comment context (the `review`/`resume` re-triggers). */
export function commentContext(headSha: string, body: string): GithubContext {
  return {
    eventName: "issue_comment",
    payload: {
      issue: { number: 7, pull_request: {} },
      comment: { id: 42, body, user: { login: "human-dev", type: "User" } },
      repository: { id: 4242 },
    },
    repo: { owner: "test-org", repo: "test-repo" },
    sha: headSha,
    serverUrl: "https://github.com",
    runId: 12345,
    repoId: 4242,
  };
}

// ── Reading the run's products ──────────────────────────────────────────────

/** The chronologically last sticky-comment body this run posted: prefers the most
 *  recent update over the most recent create. Safe because `upsertComment` posts
 *  AT MOST once per `runReview` call and github/comment.ts's marker-based lookup
 *  rediscovers an existing sticky on every later round, so a create can never
 *  follow an update within one `Recorded` — see github/comment.ts's module doc. */
export function lastBody(rec: Recorded): string {
  return rec.updated.at(-1)?.body ?? rec.created.at(-1)?.body ?? "";
}

/** The decoded state marker of the last posted sticky comment. */
export function markerState(rec: Recorded): ReviewState | Record<string, never> {
  return decodeMarker(extractMarker(lastBody(rec)) ?? "");
}

/** Every inline comment posted this run, across all accepted batches. */
export function inlineComments(rec: Recorded): ReviewComment[] {
  return rec.reviews.flatMap((r) => r.comments);
}
