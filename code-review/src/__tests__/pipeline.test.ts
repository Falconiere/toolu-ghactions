// pipeline.test.ts — END-TO-END pipeline wiring with REAL data, no network, no
// fabricated review output. A real temp git repo provides the diff, the REAL
// recorded OpenRouter fixtures drive the LLM via an injected fetch, and a
// recording fake Octokit captures every API call. The pull_request context is a
// real GitHub pull_request event payload shape.
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runReview } from "../pipeline.js";
import type { GithubContext, PipelineOctokit, ReviewDeps } from "../pipeline.js";
import type { ActionInputs } from "../inputs.js";
import { git, setupGitRepo, writeFile, removeRepo } from "../git/__tests__/helpers.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "llm", "__tests__", "fixtures");

/** A fetch that replays one recorded OpenRouter chat-completions response — no network. */
function replayFetch(name: string): typeof fetch {
  const body = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

/** Every Octokit call this run can make, recorded for assertions. */
interface Recorded {
  listComments: number;
  created: { issue_number: number; body: string }[];
  updated: { comment_id: number; body: string }[];
  createdLabels: string[];
  removedLabels: string[];
  addedLabels: string[][];
  reviews: { commit_id: string; comments: number; body: string }[];
}

/**
 * A recording fake Octokit. `existing` seeds the comment list (empty by default
 * → the bot CREATES, then re-finds, then UPDATES). create/update return a
 * synthetic html_url; the labels + reviews APIs record their args and succeed.
 */
function fakeOctokit(existing: { id: number; body: string }[] = []): {
  octokit: PipelineOctokit;
  rec: Recorded;
} {
  const rec: Recorded = {
    listComments: 0,
    created: [],
    updated: [],
    createdLabels: [],
    removedLabels: [],
    addedLabels: [],
    reviews: [],
  };
  // A mutable comment store so a created comment is found on the next list.
  const store = existing.map((c, i) => ({
    id: c.id,
    body: c.body,
    created_at: `2026-01-01T00:0${i}:00Z`,
    html_url: `https://github.com/o/r/issues/comments/${c.id}`,
  }));
  let nextId = 9000;

  const octokit = {
    rest: {
      issues: {
        listComments: async (p: { page: number }) => {
          rec.listComments++;
          return { data: p.page === 1 ? store : [] };
        },
        createComment: async (p: { owner: string; repo: string; issue_number: number; body: string }) => {
          rec.created.push({ issue_number: p.issue_number, body: p.body });
          const id = nextId++;
          const html_url = `https://github.com/${p.owner}/${p.repo}/issues/${p.issue_number}#c${id}`;
          store.push({ id, body: p.body, created_at: `2026-06-01T00:00:0${store.length}Z`, html_url });
          return { data: { html_url } };
        },
        updateComment: async (p: { comment_id: number; body: string }) => {
          rec.updated.push({ comment_id: p.comment_id, body: p.body });
          const c = store.find((s) => s.id === p.comment_id);
          if (c) c.body = p.body;
          return { data: { html_url: `https://github.com/o/r/issues/comments/${p.comment_id}#updated` } };
        },
        createLabel: async (p: { name: string }) => {
          rec.createdLabels.push(p.name);
          return {};
        },
        removeLabel: async (p: { name: string }) => {
          rec.removedLabels.push(p.name);
          return {};
        },
        addLabels: async (p: { labels: string[] }) => {
          rec.addedLabels.push(p.labels);
          return {};
        },
      },
      pulls: {
        createReview: async (p: { commit_id: string; comments: unknown[]; body: string }) => {
          rec.reviews.push({ commit_id: p.commit_id, comments: p.comments.length, body: p.body });
          return { data: { html_url: "https://github.com/o/r/pull/7#review" } };
        },
      },
    },
  } as unknown as PipelineOctokit;
  return { octokit, rec };
}

/** Default, fully-resolved inputs (what readInputs would yield for a basic run). */
function baseInputs(overrides: Partial<ActionInputs> = {}): ActionInputs {
  return {
    model: "deepseek/deepseek-v4-flash",
    apiKey: "sk-test",
    maxTokens: 4096,
    minConfidence: "high",
    enforceJsonSchema: true,
    inlineComments: true,
    manageLabels: true,
    baseBranch: "main",
    reviewPromptFile: "",
    codebaseOverview: "",
    checkProjectRules: false, // keep the env hermetic — no repo rules to gather.
    rulesGlob: "",
    rulesMaxBytes: 32768,
    maxFiles: 0,
    maxDiffLines: 0,
    token: "ghs_test",
    appId: "",
    appPrivateKey: "",
    triggerPhrase: "@toolu",
    minTriggerPermission: "write",
    botName: "Toolu — Code Review",
    botLogoUrl: "https://example.com/logo.png",
    reviewMemory: true,
    ...overrides,
  };
}

/**
 * Build a REAL temp git repo with a base `main` and a feature branch carrying a
 * one-file change, returning the repo dir and the head sha. fetchDiff resolves
 * the diff against local `main` (no origin), matching the git-layer tests.
 */
function featureRepoWithChange(): { dir: string; headSha: string } {
  const dir = setupGitRepo();
  git(dir, "checkout", "-b", "feature", "--quiet");
  // A real source change so the diff is non-empty and line-anchored.
  writeFile(dir, "src/util.ts", "export function add(a: number, b: number): number {\n  return a - b;\n}\n");
  git(dir, "add", "src/util.ts");
  git(dir, "commit", "-m", "add util", "--quiet");
  const headSha = git(dir, "rev-parse", "HEAD").trim();
  return { dir, headSha };
}

/** A real `pull_request` event context for PR #7. */
function prContext(headSha: string): GithubContext {
  return {
    eventName: "pull_request",
    payload: { pull_request: { number: 7, base: { ref: "main" } } },
    repo: { owner: "test-org", repo: "test-repo" },
    sha: headSha,
    serverUrl: "https://github.com",
    runId: 12345,
  };
}

const repos: string[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) removeRepo(r);
});

/** Register a repo for cleanup and return it. */
function track<T extends { dir: string }>(repo: T): T {
  repos.push(repo.dir);
  return repo;
}

describe("runReview — end to end", () => {
  it("pull_request → reviews, upserts a comment, sets the verdict label, populates outputs", async () => {
    const { dir, headSha } = track(featureRepoWithChange());
    const { octokit, rec } = fakeOctokit();

    const deps: ReviewDeps = {
      inputs: baseInputs(),
      octokit,
      context: prContext(headSha),
      fetch: replayFetch("success"),
      cwd: dir,
      now: () => 1_700_000_000_000,
    };

    const result = await runReview(deps);

    // The recorded success fixture's verdict is "changes" (no structured findings).
    expect(result.verdict).toBe("changes");
    expect(result.findingsCount).toBe(0);
    expect(result.commentUrl).toBeTruthy();

    // A comment was upserted: created (in-progress), then updated (verdict).
    expect(rec.created.length + rec.updated.length).toBeGreaterThanOrEqual(1);
    // The verdict label chip was set to request-changes (and the opposite removed).
    expect(rec.addedLabels).toContainEqual(["agent-request-changes"]);
    expect(rec.removedLabels).toContain("agent-merge-approved");
    // The final verdict comment body carries the verdict label token + state marker.
    const lastBody = rec.updated.at(-1)?.body ?? rec.created.at(-1)?.body ?? "";
    expect(lastBody).toContain("agent-request-changes");
    expect(lastBody).toContain("toolu-review-state:v1");
  });

  it("re-uses the existing sticky: in-progress + verdict update the SAME comment, no second create", async () => {
    const { dir, headSha } = track(featureRepoWithChange());
    // A prior sticky comment carrying a marker → memory reads it, and all posts update it.
    const priorMarker = "<!-- toolu-review-state:v1 H4sIAAAAAAAAA6tWyk0tLk5MT1WyUkrJTM8sUVKoBgBM2H3iEgAAAA== -->";
    const { octokit, rec } = fakeOctokit([{ id: 555, body: `### Code Review — old\n\n${priorMarker}` }]);

    const result = await runReview({
      inputs: baseInputs(),
      octokit,
      context: prContext(headSha),
      fetch: replayFetch("success"),
      cwd: dir,
      now: () => 1_700_000_000_000,
    });

    expect(result.verdict).toBe("changes");
    // No new comment created: every post updated the located sticky (id 555).
    expect(rec.created).toEqual([]);
    expect(rec.updated.every((u) => u.comment_id === 555)).toBe(true);
    expect(rec.updated.length).toBeGreaterThanOrEqual(2);
  });

  it("non-trigger event → verdict skip, NO review (no comment, no label, no LLM)", async () => {
    const { octokit, rec } = fakeOctokit();
    let fetchCalled = false;
    const guardFetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const result = await runReview({
      inputs: baseInputs(),
      octokit,
      // A `push` event is not a trigger → resolveEvent returns run:false.
      context: {
        eventName: "push",
        payload: {},
        repo: { owner: "test-org", repo: "test-repo" },
        sha: "deadbeef",
        serverUrl: "https://github.com",
        runId: 1,
      },
      fetch: guardFetch,
    });

    expect(result.verdict).toBe("skip");
    expect(result.findingsCount).toBe(0);
    expect(result.commentUrl).toBe("");
    expect(fetchCalled).toBe(false);
    expect(rec.created).toEqual([]);
    expect(rec.updated).toEqual([]);
    expect(rec.addedLabels).toEqual([]);
  });

  it("LLM error (empty content) → verdict error, comment still posted, label set, job NOT failed", async () => {
    const { dir, headSha } = track(featureRepoWithChange());
    const { octokit, rec } = fakeOctokit();

    // runReview must RETURN normally (abstain) — never throw — on a provider error.
    const result = await runReview({
      inputs: baseInputs(),
      octokit,
      context: prContext(headSha),
      fetch: replayFetch("empty-content"),
      cwd: dir,
      now: () => 1_700_000_000_000,
    });

    expect(result.verdict).toBe("error");
    expect(result.findingsCount).toBe(0);
    expect(result.commentUrl).toBeTruthy();
    // The comment is still posted and the error maps to the request-changes label.
    expect(rec.created.length + rec.updated.length).toBeGreaterThanOrEqual(1);
    expect(rec.addedLabels).toContainEqual(["agent-request-changes"]);
    const lastBody = rec.updated.at(-1)?.body ?? rec.created.at(-1)?.body ?? "";
    expect(lastBody).toContain("provider error");
  });

  it("empty diff (no changes vs base) → verdict skip with the approved no-op comment", async () => {
    // A feature branch with NO commits past main → zero changed files.
    const dir = setupGitRepo();
    repos.push(dir);
    git(dir, "checkout", "-b", "feature", "--quiet");
    const headSha = git(dir, "rev-parse", "HEAD").trim();
    const { octokit, rec } = fakeOctokit();

    const result = await runReview({
      inputs: baseInputs(),
      octokit,
      context: prContext(headSha),
      fetch: replayFetch("success"),
      cwd: dir,
    });

    expect(result.verdict).toBe("skip");
    expect(result.commentUrl).toBeTruthy();
    // The no-op approved comment + the approved label.
    const body = rec.created.at(-1)?.body ?? "";
    expect(body).toContain("No file changes to review");
    expect(rec.addedLabels).toContainEqual(["agent-merge-approved"]);
  });
});
