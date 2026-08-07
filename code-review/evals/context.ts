// evals/context.ts — build the `ActionInputs`/`GithubContext` a live eval run
// hands to `runReview()`. Split out of run.ts to keep that file under the
// house 300-line ceiling; this file has no gh/git/network of its own.
import type { ActionInputs } from "@/inputs.js";
import type { GithubContext } from "@/pipeline.js";
import type { EvalArgs } from "./args.js";
import type { FetchedPr } from "./fetch.js";

/** Inputs matching the action's own defaults (inputs.ts), overridden only by
 *  what the CLI/env actually supplies — no `process.env` reads beyond API_KEY
 *  (read by the caller, never here). */
export function buildInputs(args: EvalArgs, apiKey: string, baseBranch: string): ActionInputs {
  return {
    provider: args.provider,
    model: args.model,
    apiKey,
    maxTokens: 8192,
    minConfidence: "high",
    enforceJsonSchema: true,
    inlineComments: true,
    manageLabels: false,
    baseBranch,
    reviewPromptFile: "",
    codebaseOverview: "",
    checkProjectRules: true,
    rulesGlob: "",
    rulesRef: "base",
    excludeGlobs: [],
    rulesMaxBytes: 32768,
    maxFiles: 0,
    maxRounds: 0,
    maxDiffLines: 0,
    maxChunkLines: 1500,
    maxChunks: 0,
    maxWallMs: args.maxWallMs,
    requestTimeoutMs: 180000,
    token: "eval-harness-does-not-post",
    appId: "",
    appPrivateKey: "",
    triggerPhrase: "@toolu",
    minTriggerPermission: "write",
    botName: "Toolu — Code Review (eval)",
    botLogoUrl: "https://example.com/logo.png",
    reviewMemory: true,
    failOn: new Set(),
    verbosity: "compact",
    touluApiKey: "",
    touluApiUrl: "https://api.toolu.sh",
  };
}

/** A `pull_request` event context (auto-triggers a full review, no phrase
 *  needed — github/event.ts) built from the fetched PR's real fields. */
export function buildContext(
  pr: FetchedPr,
  owner: string,
  repo: string,
  headSha: string,
): GithubContext {
  return {
    eventName: "pull_request",
    payload: {
      pull_request: {
        number: pr.number,
        base: { ref: pr.baseRefName },
        head: { sha: headSha, ref: pr.headRefName },
        title: pr.title,
        body: pr.body,
      },
      repository: { id: 0 },
    },
    repo: { owner, repo },
    sha: headSha,
    headSha,
    serverUrl: "https://github.com",
    runId: 0,
    repoId: 0,
  };
}
