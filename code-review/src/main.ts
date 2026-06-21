// main.ts — entry point for the Toolu AI Code Review action. Thin wrapper:
// read inputs, mint the GitHub App token (when configured), build the deps
// bundle, run the pipeline, set outputs. All orchestration lives in pipeline.ts.
//
// TOP-LEVEL GUARD: a thrown infra error (diff resolution, comment-post, an
// unexpected crash) sets verdict=error, posts a best-effort error comment, and
// calls setFailed so the job goes red. A provider ABSTAIN is NOT an infra error
// — runReview returns verdict:"error" normally and the job stays green.
import * as core from "@actions/core";
import * as github from "@actions/github";
import { readInputs } from "./inputs.js";
import type { ActionInputs } from "./inputs.js";
import { runReview } from "./pipeline.js";
import type { GithubContext } from "./pipeline.js";
import { shouldBlock } from "./review/gate.js";
import { mintAppToken } from "./github/appToken.js";
import { createAppAuth } from "@octokit/auth-app";
import type { EventPayload } from "./github/event.js";

/** Build the GithubContext slice the pipeline reads from the @actions/github context. */
function buildContext(): GithubContext {
  const payload: EventPayload | null = github.context.payload ?? null;
  const head = payload?.pull_request?.head;
  return {
    eventName: github.context.eventName,
    payload,
    repo: github.context.repo,
    sha: github.context.sha,
    // The PR head sha/ref (when this is a pull_request event): the inline-review
    // commit_id must be a commit IN the PR, and the heading shows the source branch.
    ...(head?.sha ? { headSha: head.sha } : {}),
    ...(head?.ref ? { headRef: head.ref } : {}),
    serverUrl: github.context.serverUrl,
    runId: github.context.runId,
  };
}

/**
 * Resolve the Octokit token: mint a GitHub App installation token when APP_ID +
 * APP_PRIVATE_KEY are set (so the bot posts under the App identity), else the
 * default TOKEN. Mint failures fall back to the default token (never throws).
 */
async function resolveToken(inputs: ActionInputs): Promise<string> {
  if (inputs.appId === "" || inputs.appPrivateKey === "") return inputs.token;
  const repo = `${github.context.repo.owner}/${github.context.repo.repo}`;
  const minted = await mintAppToken(inputs.appId, inputs.appPrivateKey, repo, {
    // App-JWT-authed Octokit used only to resolve the installation. createAppAuth
    // is the authStrategy; the app credentials ride in `auth`.
    octokitFactory: ({ appId, privateKey }) =>
      github.getOctokit("", {
        authStrategy: createAppAuth,
        auth: { appId, privateKey },
      }),
  }).catch(() => null);
  if (minted) {
    core.info("Using GitHub App identity for PR comments");
    return minted;
  }
  return inputs.token;
}

/** Look up a commenter's repo permission via the collaborators API (fail-closed on throw). */
function permissionLookup(octokit: ReturnType<typeof github.getOctokit>) {
  return async (commenter: string): Promise<string> => {
    const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      username: commenter,
    });
    return data.permission;
  };
}

/** Look up a PR's base ref via the pulls API (best-effort; a throw → ""). */
function baseRefLookup(octokit: ReturnType<typeof github.getOctokit>) {
  return async (prNumber: number): Promise<string> => {
    const { data } = await octokit.rest.pulls.get({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      pull_number: prNumber,
    });
    return data.base.ref;
  };
}

/** Post a best-effort error comment when the pipeline crashes before posting one. */
async function postErrorComment(
  octokit: ReturnType<typeof github.getOctokit>,
  message: string,
): Promise<string> {
  const ctx = github.context;
  const url = `${ctx.serverUrl}/${ctx.repo.owner}/${ctx.repo.repo}/actions/runs/${ctx.runId}`;
  const prNumber = ctx.payload.pull_request?.number ?? ctx.payload.issue?.number;
  if (prNumber === undefined) return "";
  const body = `**AI Code Review failed** —— [View job](${url})

---
### Code Review — error

**Error:** ${message}

\`request-changes\`
`;
  const { data } = await octokit.rest.issues.createComment({
    owner: ctx.repo.owner,
    repo: ctx.repo.repo,
    issue_number: prNumber,
    body,
  });
  return data.html_url;
}

async function main(): Promise<void> {
  const inputs = readInputs();
  const token = await resolveToken(inputs);
  const octokit = github.getOctokit(token);

  try {
    const result = await runReview({
      inputs,
      octokit,
      context: buildContext(),
      lookupPermission: permissionLookup(octokit),
      lookupBaseRef: baseRefLookup(octokit),
      // The composite SAST steps write gitleaks/opengrep SARIF here; the pipeline reads it.
      ...(process.env["TOOLU_SARIF_DIR"] ? { sarifDir: process.env["TOOLU_SARIF_DIR"] } : {}),
    });

    core.setOutput("verdict", result.verdict);
    core.setOutput("findings-count", result.findingsCount);
    core.setOutput("comment-url", result.commentUrl);
    core.info(
      `Review complete: ${result.verdict} (${result.findingsCount} findings) — ${result.commentUrl}`,
    );
    // Verdict-driven merge gate: turn this check red when the verdict is in FAIL_ON
    // so branch protection can block the PR. The comment/label/outputs are already
    // posted above; only the exit code changes. Infra-thrown errors fail via catch.
    if (shouldBlock(result.verdict, inputs.failOn)) {
      core.setFailed(
        `Code review verdict '${result.verdict}' is in FAIL_ON — failing the job (the review was still posted). Set FAIL_ON: none to keep the review advisory.`,
      );
    }
  } catch (err) {
    // True infra failure: surface verdict=error, post a best-effort comment, fail the job.
    const message = err instanceof Error ? err.message : String(err);
    core.setOutput("verdict", "error");
    core.setOutput("findings-count", 0);
    const url = await postErrorComment(octokit, message).catch(() => "");
    if (url !== "") core.setOutput("comment-url", url);
    core.setFailed(`AI Code Review failed: ${message}`);
  }
}

main().catch((err: unknown) => {
  // Last-resort guard: readInputs / token mint threw before the try/catch above.
  core.setOutput("verdict", "error");
  core.setFailed(err instanceof Error ? (err.stack ?? err.message) : String(err));
});
