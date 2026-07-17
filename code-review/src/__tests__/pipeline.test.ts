// pipeline.test.ts — END-TO-END pipeline wiring with REAL data, no network, no
// fabricated review output. A real temp git repo provides the diff, the REAL
// recorded OpenRouter fixtures drive the LLM via an injected fetch, and a
// recording fake Octokit captures every API call. The pull_request context is a
// real GitHub pull_request event payload shape.
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runReview } from "@/pipeline.js";
import type { GithubContext, PipelineOctokit, ReviewDeps } from "@/pipeline.js";
import type { ActionInputs } from "@/inputs.js";
import { parseFailOn, shouldBlock, type BlockableVerdict } from "@/review/gate.js";
import {
  decodeMarker,
  encodeMarker,
  extractMarker,
  fingerprint,
  type ReviewState,
} from "@/state.js";
import { appendFpMarker } from "@/review/fpmarker.js";
import { git, setupGitRepo, writeFile, removeRepo } from "@/git/__tests__/helpers.js";

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "llm",
  "__tests__",
  "fixtures",
);

/** A fetch that replays one recorded OpenRouter chat-completions response — no network. */
function replayFetch(name: string): typeof fetch {
  const body = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));
  return async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

/** The captured outgoing request body the prompt-routing assertions read. */
interface CapturedRequestBody {
  messages?: { role: string; content: string }[];
}

/** A fetch that records the outgoing request body (the prompt), then replays a fixture. */
function capturingReplayFetch(
  name: string,
  captured: { body: CapturedRequestBody | null },
): typeof fetch {
  const body = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));
  return async (_url, init) => {
    captured.body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
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
  replies: { comment_id: number; body: string }[];
  resolved: string[];
}

/** A bot-authored review thread to seed into the fake graphql reviewThreads response. */
interface SeedThread {
  threadId: string;
  rootCommentId: number;
  fp: string;
  path: string;
  line: number | null;
  isResolved?: boolean;
  isOutdated?: boolean;
  botLogin?: string;
  replies?: { author: string; body: string }[];
}

/**
 * A recording fake Octokit. `existing` seeds the comment list (empty by default
 * → the bot CREATES, then re-finds, then UPDATES). create/update return a
 * synthetic html_url; the labels + reviews APIs record their args and succeed.
 */
function fakeOctokit(
  existing: { id: number; body: string }[] = [],
  seedThreads: SeedThread[] = [],
): {
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
    replies: [],
    resolved: [],
  };
  // A mutable comment store so a created comment is found on the next list.
  const store = existing.map((c, i) => ({
    id: c.id,
    body: c.body,
    created_at: `2026-01-01T00:0${i}:00Z`,
    html_url: `https://github.com/o/r/issues/comments/${c.id}`,
  }));
  let nextId = 9000;

  const octokit: PipelineOctokit = {
    rest: {
      issues: {
        listComments: async (p) => {
          rec.listComments++;
          return { data: p.page === 1 ? store : [] };
        },
        createComment: async (p) => {
          rec.created.push({ issue_number: p.issue_number, body: p.body });
          const id = nextId++;
          const html_url = `https://github.com/${p.owner}/${p.repo}/issues/${p.issue_number}#c${id}`;
          store.push({
            id,
            body: p.body,
            created_at: `2026-06-01T00:00:0${store.length}Z`,
            html_url,
          });
          return { data: { html_url } };
        },
        updateComment: async (p) => {
          rec.updated.push({ comment_id: p.comment_id, body: p.body });
          const c = store.find((s) => s.id === p.comment_id);
          if (c) c.body = p.body;
          return {
            data: { html_url: `https://github.com/o/r/issues/comments/${p.comment_id}#updated` },
          };
        },
        createLabel: async (p) => {
          rec.createdLabels.push(p.name);
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
          rec.reviews.push({ commit_id: p.commit_id, comments: p.comments.length, body: p.body });
          return { data: { html_url: "https://github.com/o/r/pull/7#review" } };
        },
        createReplyForReviewComment: async (p) => {
          rec.replies.push({ comment_id: p.comment_id, body: p.body });
          return { data: { id: 7000 + rec.replies.length } };
        },
      },
    },
    // GraphQL: serves the seeded reviewThreads page on a read query and records
    // resolveReviewThread mutations. One page (no pagination) is enough for tests.
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
              nodes: seedThreads.map((t) => ({
                id: t.threadId,
                isResolved: t.isResolved ?? false,
                isOutdated: t.isOutdated ?? false,
                path: t.path,
                line: t.line,
                comments: {
                  nodes: [
                    {
                      databaseId: t.rootCommentId,
                      body: appendFpMarker(`**finding** at ${t.path}`, t.fp),
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

/** Default, fully-resolved inputs (what readInputs would yield for a basic run). */
function baseInputs(overrides: Partial<ActionInputs> = {}): ActionInputs {
  return {
    provider: "openrouter",
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
    rulesRef: "base",
    excludeGlobs: [],
    rulesMaxBytes: 32768,
    maxFiles: 0,
    maxRounds: 0,
    maxDiffLines: 0,
    maxChunkLines: 0, // never chunk: existing tests exercise the single-call fast path
    maxChunks: 20,
    requestTimeoutMs: 180000,
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
  writeFile(
    dir,
    "src/util.ts",
    "export function add(a: number, b: number): number {\n  return a - b;\n}\n",
  );
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
    expect(rec.addedLabels).toContainEqual(["request-changes"]);
    expect(rec.removedLabels).toContain("merge-approved");
    // The final verdict comment body carries the verdict label token + state marker.
    const lastBody = rec.updated.at(-1)?.body ?? rec.created.at(-1)?.body ?? "";
    expect(lastBody).toContain("request-changes");
    expect(lastBody).toContain("toolu-review-state:v1");
  });

  it("re-uses the existing sticky: in-progress + verdict update the SAME comment, no second create", async () => {
    const { dir, headSha } = track(featureRepoWithChange());
    // A prior sticky comment carrying a marker → memory reads it, and all posts update it.
    const priorMarker =
      "<!-- toolu-review-state:v1 H4sIAAAAAAAAA6tWyk0tLk5MT1WyUkrJTM8sUVKoBgBM2H3iEgAAAA== -->";
    const { octokit, rec } = fakeOctokit([
      { id: 555, body: `### Code Review — old\n\n${priorMarker}` },
    ]);

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
    const guardFetch: typeof fetch = async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    };

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
    expect(rec.addedLabels).toContainEqual(["request-changes"]);
    const lastBody = rec.updated.at(-1)?.body ?? rec.created.at(-1)?.body ?? "";
    expect(lastBody).toContain("provider error");
  });

  it("graceful degradation: LLM error WITH mechanical findings → comment keeps the deterministic findings + 'LLM judgment unavailable', job NOT failed", async () => {
    const { dir, headSha } = track(featureRepoWithChange());
    const { octokit, rec } = fakeOctokit();
    // Real recorded gitleaks + opengrep SARIF — exactly what the composite steps write to TOOLU_SARIF_DIR.
    const sarifDir = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "mechanical",
      "__tests__",
      "fixtures",
    );

    const result = await runReview({
      inputs: baseInputs(),
      octokit,
      context: prContext(headSha),
      fetch: replayFetch("empty-content"), // provider error → LLM abstains
      cwd: dir,
      sarifDir,
      now: () => 1_700_000_000_000,
    });

    // The LLM failed, but the review is NOT empty: deterministic findings survive.
    expect(result.verdict).toBe("error");
    const lastBody = rec.updated.at(-1)?.body ?? rec.created.at(-1)?.body ?? "";
    expect(lastBody).toContain("### Mechanical checks");
    expect(lastBody).toContain("LLM judgment unavailable");
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
    expect(rec.addedLabels).toContainEqual(["merge-approved"]);
  });

  // FIX 1: in node24 the action's CWD is the consumer repo, so the checklist must
  // resolve via $GITHUB_ACTION_PATH (the action's own files). It is the FIRST
  // candidate, so when set to a dir with a sentinel checklist, that wins — proven
  // by the sentinel text reaching the system prompt on the wire.
  it("resolves the review checklist from GITHUB_ACTION_PATH (it wins over the repo-relative paths)", async () => {
    const { dir, headSha } = track(featureRepoWithChange());
    const { octokit } = fakeOctokit();

    // A temp action dir whose prompts/review-checklist.txt carries a sentinel that
    // does NOT appear in the shipped checklist, so its presence proves the source.
    const actionPath = mkdtempSync(join(tmpdir(), "action-path-"));
    repos.push(actionPath);
    const sentinel = "SENTINEL-GITHUB-ACTION-PATH-CHECKLIST-7f3a";
    mkdirSync(join(actionPath, "prompts"), { recursive: true });
    writeFileSync(
      join(actionPath, "prompts", "review-checklist.txt"),
      `${sentinel}\nReview the diff.\n`,
    );

    const saved = process.env["GITHUB_ACTION_PATH"];
    process.env["GITHUB_ACTION_PATH"] = actionPath;
    const captured: { body: CapturedRequestBody | null } = { body: null };
    try {
      const result = await runReview({
        inputs: baseInputs(),
        octokit,
        context: prContext(headSha),
        fetch: capturingReplayFetch("success", captured),
        cwd: dir,
        now: () => 1_700_000_000_000,
      });
      expect(result.verdict).toBe("changes");
    } finally {
      if (saved === undefined) delete process.env["GITHUB_ACTION_PATH"];
      else process.env["GITHUB_ACTION_PATH"] = saved;
    }

    // The system prompt sent to the model is the checklist read from GITHUB_ACTION_PATH.
    const system = captured.body?.messages?.find((m) => m.role === "system");
    expect(system?.content).toContain(sentinel);
  });

  // FIX 2: a decoded marker that is a non-null object MISSING the history key
  // (asReviewState only checks "findings") must not throw on `.history.length`.
  it("handles a prior marker with findings but NO history key without throwing", async () => {
    const { dir, headSha } = track(featureRepoWithChange());
    // A real marker for a state object that has `findings` but NO `history` key —
    // asReviewState narrows it to a ReviewState (it has "findings"), then the
    // memory step reads prior.history.length, which must optional-chain safely.
    const partial: ReviewState = JSON.parse(
      '{"schema":"toolu-review-state","version":1,"findings":[{"path":"src/util.ts","text":"old","category":"c","fp":"deadbeef"}]}',
    );
    const marker = encodeMarker(partial);
    const { octokit, rec } = fakeOctokit([{ id: 777, body: `### Code Review — old\n\n${marker}` }]);

    // Must NOT throw (the bug was a TypeError on prior.history.length).
    const result = await runReview({
      inputs: baseInputs({ reviewMemory: true }),
      octokit,
      context: prContext(headSha),
      fetch: replayFetch("success"),
      cwd: dir,
      now: () => 1_700_000_000_000,
    });

    expect(result.verdict).toBe("changes");
    // It reused the located sticky (memory still works) and posted a marker.
    expect(rec.updated.every((u) => u.comment_id === 777)).toBe(true);
    const lastBody = rec.updated.at(-1)?.body ?? "";
    expect(lastBody).toContain("toolu-review-state:v1");
  });

  // FIX 3: the inline-review commit_id must be the PR HEAD sha (a commit IN the
  // PR), not the merge/context sha — else the Reviews API 422s and comments vanish.
  it("anchors the inline review to the PR head sha from the event, not the merge sha", async () => {
    const { dir, headSha } = track(featureRepoWithChange());
    const { octokit, rec } = fakeOctokit();
    const prHeadSha = "feedface00000000000000000000000000000000";

    // The merge/context sha differs from the PR head sha the event carries.
    const ctx: GithubContext = {
      ...prContext(headSha),
      sha: "0000000000000000000000000000000000000000",
      headSha: prHeadSha,
      headRef: "feature-branch",
    };

    const result = await runReview({
      inputs: baseInputs(),
      octokit,
      context: ctx,
      // The findings fixture carries one finding anchored to src/util.ts:2 (a real
      // changed line), so an inline review IS posted.
      fetch: replayFetch("findings"),
      cwd: dir,
      now: () => 1_700_000_000_000,
    });

    expect(result.verdict).toBe("changes");
    expect(result.findingsCount).toBe(1);
    // An inline review was posted, anchored to the PR HEAD sha (not the merge sha).
    expect(rec.reviews.length).toBe(1);
    expect(rec.reviews[0]?.commit_id).toBe(prHeadSha);
    expect(rec.reviews[0]?.commit_id).not.toBe(ctx.sha);
    // FIX 10: the verdict heading shows the PR source branch from the event.
    const lastBody = rec.updated.at(-1)?.body ?? rec.created.at(-1)?.body ?? "";
    expect(lastBody).toContain("feature-branch");
  });

  // FIX 7: with memory OFF, a pre-existing sticky must still be REUSED (its id
  // drives upsert dedup) — otherwise every run posts a brand-new comment.
  it("reviewMemory=false still updates an existing sticky (no duplicate comment)", async () => {
    const { dir, headSha } = track(featureRepoWithChange());
    const priorMarker =
      "<!-- toolu-review-state:v1 H4sIAAAAAAAAA6tWyk0tLk5MT1WyUkrJTM8sUVKoBgBM2H3iEgAAAA== -->";
    const { octokit, rec } = fakeOctokit([
      { id: 888, body: `### Code Review — old\n\n${priorMarker}` },
    ]);

    const result = await runReview({
      inputs: baseInputs({ reviewMemory: false }),
      octokit,
      context: prContext(headSha),
      fetch: replayFetch("success"),
      cwd: dir,
      now: () => 1_700_000_000_000,
    });

    expect(result.verdict).toBe("changes");
    // No new comment: the located sticky (id 888) is updated in place.
    expect(rec.created).toEqual([]);
    expect(rec.updated.length).toBeGreaterThanOrEqual(1);
    expect(rec.updated.every((u) => u.comment_id === 888)).toBe(true);
    // Memory off → no recap/history rendered, and no state marker written.
    const lastBody = rec.updated.at(-1)?.body ?? "";
    expect(lastBody).not.toContain("toolu-review-state:v1");
  });
});

/**
 * A fetch that picks a recorded fixture per call by matching the OUTGOING request
 * body (the chunk's prompt carries its file paths) — so each chunk gets a distinct
 * recorded response. No network, no code mocks.
 */
function routingFetch(routes: Array<[match: string, fixture: string]>): typeof fetch {
  return async (_url, init) => {
    const raw = typeof init?.body === "string" ? init.body : "";
    const hit = routes.find(([m]) => raw.includes(m));
    const fixture = hit ? hit[1] : "approved";
    const body = JSON.parse(readFileSync(join(FIXTURES, `${fixture}.json`), "utf8"));
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

/**
 * Two real files that split into two chunks under a small budget: src/util.ts
 * (the add/subtract bug at line 2 — matches the `findings` fixture) plus a big
 * padding file that lands in its own chunk.
 */
function twoChunkRepo(): { dir: string; headSha: string } {
  const dir = setupGitRepo();
  git(dir, "checkout", "-b", "feature", "--quiet");
  writeFile(
    dir,
    "src/util.ts",
    "export function add(a: number, b: number): number {\n  return a - b;\n}\n",
  );
  const pad = Array.from({ length: 40 }, (_, n) => `export const pad_${n} = ${n}`).join("\n");
  writeFile(dir, "zzz/pad.ts", `${pad}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "two files", "--quiet");
  return { dir, headSha: git(dir, "rev-parse", "HEAD").trim() };
}

describe("runReview — chunked large diff", () => {
  it("chunks the diff, reviews each chunk, and merges findings + verdict", async () => {
    const { dir, headSha } = track(twoChunkRepo());
    const { octokit } = fakeOctokit();

    const result = await runReview({
      inputs: baseInputs({
        maxChunkLines: 15,
        maxChunks: 20,
        manageLabels: false,
        inlineComments: false,
      }),
      octokit,
      context: prContext(headSha),
      // util.ts chunk → a finding (changes); pad.ts chunk → clean (approved).
      fetch: routingFetch([
        ["src/util.ts", "findings"],
        ["zzz/pad.ts", "approved"],
      ]),
      cwd: dir,
      now: () => 1_700_000_000_000,
    });

    // Any chunk requesting changes wins; the util.ts:2 finding survives validation.
    expect(result.verdict).toBe("changes");
    expect(result.findingsCount).toBe(1);
  });

  it("degrades gracefully when one chunk errors: keeps the survivor, notes the failure", async () => {
    const { dir, headSha } = track(twoChunkRepo());
    const { octokit, rec } = fakeOctokit();

    const result = await runReview({
      inputs: baseInputs({
        maxChunkLines: 15,
        maxChunks: 20,
        manageLabels: false,
        inlineComments: false,
      }),
      octokit,
      context: prContext(headSha),
      // util.ts chunk succeeds with a finding; pad.ts chunk abstains (empty content).
      fetch: routingFetch([
        ["src/util.ts", "findings"],
        ["zzz/pad.ts", "empty-content"],
      ]),
      cwd: dir,
      now: () => 1_700_000_000_000,
    });

    // The whole review is NOT abstained: the surviving chunk's finding + verdict stand.
    expect(result.verdict).toBe("changes");
    expect(result.findingsCount).toBe(1);
    // …and the partial failure is surfaced in the posted comment.
    const lastBody = rec.updated.at(-1)?.body ?? rec.created.at(-1)?.body ?? "";
    expect(lastBody).toContain("chunks failed");
  });
});

describe("runReview — thread-aware inline reconciliation", () => {
  /** Read a finding's identity fields from a recorded fixture, to compute its real fp. */
  function fixtureFinding(
    name: string,
    idx: number,
  ): { path: string; category?: string; text: string } {
    const raw: { choices: { message: { content: string } }[] } = JSON.parse(
      readFileSync(join(FIXTURES, `${name}.json`), "utf8"),
    );
    const content: { findings: { path: string; category?: string; text: string }[] } = JSON.parse(
      raw.choices[0]?.message.content ?? "{}",
    );
    const f = content.findings[idx];
    if (!f) throw new Error(`fixture ${name} has no finding #${idx}`);
    return { path: f.path, category: f.category, text: f.text };
  }

  it("dedups a finding the author replied to and answers IN the thread (no new review)", async () => {
    const { dir, headSha } = track(featureRepoWithChange());
    const f0 = fixtureFinding("findings", 0); // src/util.ts:2
    const seed: SeedThread = {
      threadId: "T_keep",
      rootCommentId: 8001,
      fp: fingerprint(f0),
      path: f0.path,
      line: 2,
      replies: [{ author: "human-dev", body: "Intentional — callers expect a delta." }],
    };
    const { octokit, rec } = fakeOctokit([], [seed]);

    const result = await runReview({
      inputs: baseInputs(),
      octokit,
      context: prContext(headSha),
      fetch: replayFetch("findings"),
      cwd: dir,
      now: () => 1_700_000_000_000,
    });

    expect(result.findingsCount).toBe(1);
    // The finding maps to the existing thread → NOT re-posted as a fresh inline review.
    expect(rec.reviews.length).toBe(0);
    // The author had the last word → the bot answers in that thread.
    expect(rec.replies.length).toBe(1);
    expect(rec.replies[0]?.comment_id).toBe(8001);
    expect(rec.replies[0]?.body).toContain("Still flagging");
    // Nothing was resolved (the finding persists).
    expect(rec.resolved).toEqual([]);
  });

  it("resolves a dropped finding's thread (with a note) and posts only the genuinely new finding", async () => {
    const { dir, headSha } = track(featureRepoWithChange());
    const keep = fixtureFinding("findings-two", 0); // src/util.ts:2 — persists, has a reply
    const seedKeep: SeedThread = {
      threadId: "T_keep",
      rootCommentId: 8001,
      fp: fingerprint(keep),
      path: keep.path,
      line: 2,
      replies: [{ author: "human-dev", body: "Working as intended." }],
    };
    // A prior thread whose finding the model no longer emits → should be resolved.
    const seedDrop: SeedThread = {
      threadId: "T_drop",
      rootCommentId: 9001,
      fp: "0000000000000000000000000000000000000000",
      path: "src/removed.ts",
      line: 5,
    };
    const { octokit, rec } = fakeOctokit([], [seedKeep, seedDrop]);

    const result = await runReview({
      inputs: baseInputs(),
      octokit,
      context: prContext(headSha),
      fetch: replayFetch("findings-two"),
      cwd: dir,
      now: () => 1_700_000_000_000,
    });

    expect(result.findingsCount).toBe(2);
    // Only the NEW finding (src/util.ts:1) is posted — NOT the full set of 2 (dedup works).
    expect(rec.reviews.length).toBe(1);
    expect(rec.reviews[0]?.comments).toBe(1);
    // The dropped finding's thread is resolved.
    expect(rec.resolved).toEqual(["T_drop"]);
    // Two replies: the "still flagging" answer + the "no longer applies" resolution note.
    expect(rec.replies.length).toBe(2);
    const bodies = rec.replies.map((r) => r.body).join("\n");
    expect(bodies).toContain("Still flagging");
    expect(bodies).toContain("no longer applies");
  });

  it("a RESOLVED thread reaches the model prompt as a DISMISSED finding (do-not-reword)", async () => {
    const { dir, headSha } = track(featureRepoWithChange());
    const f0 = fixtureFinding("findings", 0);
    const seed: SeedThread = {
      threadId: "T_done",
      rootCommentId: 8005,
      fp: fingerprint(f0),
      path: f0.path,
      line: 2,
      isResolved: true,
    };
    const { octokit } = fakeOctokit([], [seed]);
    const captured: { body: CapturedRequestBody | null } = { body: null };

    const result = await runReview({
      inputs: baseInputs(),
      octokit,
      context: prContext(headSha),
      fetch: capturingReplayFetch("findings", captured),
      cwd: dir,
      now: () => 1_700_000_000_000,
    });
    expect(result.verdict).toBe("approved"); // suppression still handles the count

    // The prompt sent on the wire carries the dismissed block with the thread's
    // finding text and the do-not-reword instruction.
    const user = captured.body?.messages?.find((m) => m.role === "user");
    expect(user?.content).toContain(
      "## Dismissed findings (author resolved these threads — SETTLED)",
    );
    // The seeded thread's root body is `**finding** at <path>` (see fakeOctokit);
    // cleanFindingBody + sanitizeInstruction keep that text, so its presence
    // proves the THREAD's finding text reached the dismissed block.
    expect(user?.content).toContain(`finding** at ${f0.path}`);
    expect(user?.content).toContain("not verbatim, not reworded");
    // And it is NOT presented as an open accept-or-argue thread.
    expect(user?.content).not.toContain("## Prior review threads");
  });

  it("with NO prior threads, posts every finding (matches the old behaviour)", async () => {
    const { dir, headSha } = track(featureRepoWithChange());
    const { octokit, rec } = fakeOctokit([], []);

    const result = await runReview({
      inputs: baseInputs(),
      octokit,
      context: prContext(headSha),
      fetch: replayFetch("findings-two"),
      cwd: dir,
      now: () => 1_700_000_000_000,
    });

    expect(result.findingsCount).toBe(2);
    expect(rec.reviews.length).toBe(1);
    expect(rec.reviews[0]?.comments).toBe(2);
    expect(rec.replies).toEqual([]);
    expect(rec.resolved).toEqual([]);
  });

  it("a RESOLVED thread suppresses its finding everywhere: verdict, comment, count, inline", async () => {
    const { dir, headSha } = track(featureRepoWithChange());
    const f0 = fixtureFinding("findings", 0); // src/util.ts:2 — the fixture's only finding
    const seed: SeedThread = {
      threadId: "T_done",
      rootCommentId: 8001,
      fp: fingerprint(f0),
      path: f0.path,
      line: 2,
      isResolved: true, // a human closed the conversation
    };
    const { octokit, rec } = fakeOctokit([], [seed]);

    const result = await runReview({
      inputs: baseInputs(),
      octokit,
      context: prContext(headSha),
      fetch: replayFetch("findings"),
      cwd: dir,
      now: () => 1_700_000_000_000,
    });

    // The only finding was human-resolved → dropped from the count AND the model's
    // "changes" verdict is downgraded: nothing concrete is left to request changes for.
    expect(result.findingsCount).toBe(0);
    expect(result.verdict).toBe("approved");
    expect(rec.addedLabels).toContainEqual(["merge-approved"]);
    // Not re-posted inline, not replied to, and the resolved thread is never re-acted on.
    expect(rec.reviews).toEqual([]);
    expect(rec.replies).toEqual([]);
    expect(rec.resolved).toEqual([]);
    // The verdict comment no longer carries the suppressed finding's text.
    const lastBody = rec.updated.at(-1)?.body ?? rec.created.at(-1)?.body ?? "";
    expect(lastBody).not.toContain("performs subtraction");
  });

  it("an UNRESOLVED matching thread still counts toward the verdict (only posting is deduped)", async () => {
    const { dir, headSha } = track(featureRepoWithChange());
    const f0 = fixtureFinding("findings", 0);
    const seed: SeedThread = {
      threadId: "T_open",
      rootCommentId: 8002,
      fp: fingerprint(f0),
      path: f0.path,
      line: 2,
      isResolved: false,
    };
    const { octokit, rec } = fakeOctokit([], [seed]);

    const result = await runReview({
      inputs: baseInputs(),
      octokit,
      context: prContext(headSha),
      fetch: replayFetch("findings"),
      cwd: dir,
      now: () => 1_700_000_000_000,
    });

    expect(result.findingsCount).toBe(1);
    expect(result.verdict).toBe("changes");
    expect(rec.reviews).toEqual([]); // deduped inline (existing thread covers it)
  });

  it("suppression works with inline comments OFF (threads from earlier runs still count)", async () => {
    const { dir, headSha } = track(featureRepoWithChange());
    const f0 = fixtureFinding("findings", 0);
    const seed: SeedThread = {
      threadId: "T_done",
      rootCommentId: 8003,
      fp: fingerprint(f0),
      path: f0.path,
      line: 2,
      isResolved: true,
    };
    const { octokit, rec } = fakeOctokit([], [seed]);

    const result = await runReview({
      inputs: baseInputs({ inlineComments: false }),
      octokit,
      context: prContext(headSha),
      fetch: replayFetch("findings"),
      cwd: dir,
      now: () => 1_700_000_000_000,
    });

    expect(result.findingsCount).toBe(0);
    expect(result.verdict).toBe("approved");
    expect(rec.reviews).toEqual([]);
  });
});

// FAIL_ON merge gate composed with a REAL pipeline verdict (recorded fixtures, no
// network) — proves shouldBlock fires on a genuinely-produced verdict. The gate
// itself is wired in main.ts; here we assert the decision against the real verdict.
describe("FAIL_ON merge gate (real pipeline verdict + shouldBlock)", () => {
  it("AC-7: a real 'changes' verdict blocks under FAIL_ON=changes, not under none", async () => {
    const { dir, headSha } = track(featureRepoWithChange());
    const { octokit } = fakeOctokit();

    const result = await runReview({
      inputs: baseInputs(),
      octokit,
      context: prContext(headSha),
      fetch: replayFetch("success"),
      cwd: dir,
      now: () => 1_700_000_000_000,
    });

    expect(result.verdict).toBe("changes");
    expect(shouldBlock(result.verdict, parseFailOn("changes"))).toBe(true);
    expect(shouldBlock(result.verdict, parseFailOn("none"))).toBe(false);
  });

  it("AC-8: a real normal-return 'error' verdict blocks only when FAIL_ON includes error", async () => {
    const { dir, headSha } = track(featureRepoWithChange());
    const { octokit } = fakeOctokit();

    const result = await runReview({
      inputs: baseInputs(),
      octokit,
      context: prContext(headSha),
      fetch: replayFetch("empty-content"),
      cwd: dir,
      now: () => 1_700_000_000_000,
    });

    expect(result.verdict).toBe("error");
    expect(shouldBlock(result.verdict, parseFailOn("changes,error"))).toBe(true);
    expect(shouldBlock(result.verdict, parseFailOn("changes"))).toBe(false);
  });
});

describe("runReview — marker survives a cancelled run (cancel-in-progress safety)", () => {
  it("the in-progress upsert body CARRIES the prior state marker", async () => {
    // A rapid second push cancels the in-flight run via concurrency
    // cancel-in-progress AFTER the sticky was overwritten with the in-progress
    // body and BEFORE the final verdict restored the marker. If the in-progress
    // body drops the marker, that cancellation wipes review memory: history
    // reset, recap lost, MAX_ROUNDS counter back to zero (observed in prod as
    // "resolves a round then invents a fresh batch"). The FIRST update posted
    // must therefore already carry the prior marker.
    const { dir, headSha } = track(featureRepoWithChange());
    const priorState: ReviewState = {
      schema: "toolu-review-state",
      version: 1,
      findings: [{ path: "src/util.ts", line: 2, text: "prior finding", fp: "abc" }],
      history: [
        {
          sha: "1234567",
          ts: 1_700_000_000,
          verdict: "changes",
          counts: { new: 1, open: 0, resolved: 0, total: 1 },
        },
      ],
    };
    const priorMarker = encodeMarker(priorState);
    const { octokit, rec } = fakeOctokit([
      { id: 777, body: `### Code Review — old\n\n${priorMarker}` },
    ]);

    await runReview({
      inputs: baseInputs(),
      octokit,
      context: prContext(headSha),
      fetch: replayFetch("success"),
      cwd: dir,
      now: () => 1_700_000_000_000,
    });

    // First update = the in-progress body. It must carry the prior marker VERBATIM.
    const first = rec.updated[0];
    expect(first?.comment_id).toBe(777);
    expect(first?.body).toContain("PR Review in Progress");
    expect(first?.body).toContain(priorMarker);

    // And the final verdict body carries a (fresh) marker as always.
    expect(rec.updated.at(-1)?.body).toContain("toolu-review-state:v1");
  });

  it("reviewMemory=false still carries the marker through the in-progress body", async () => {
    // Memory off must not DESTROY state a future memory-on run would read.
    const { dir, headSha } = track(featureRepoWithChange());
    const priorMarker = encodeMarker({
      schema: "toolu-review-state",
      version: 1,
      findings: [],
      history: [],
    });
    const { octokit, rec } = fakeOctokit([
      { id: 888, body: `### Code Review — old\n\n${priorMarker}` },
    ]);

    await runReview({
      inputs: baseInputs({ reviewMemory: false }),
      octokit,
      context: prContext(headSha),
      fetch: replayFetch("success"),
      cwd: dir,
      now: () => 1_700_000_000_000,
    });

    expect(rec.updated[0]?.body).toContain(priorMarker);
  });

  it("a FIRST run (no prior sticky, null marker) posts an in-progress body with no marker and no 'null'", async () => {
    // priorMarker is null on round one — the body must not render a literal
    // "null" or an empty marker line.
    const { dir, headSha } = track(featureRepoWithChange());
    const { octokit, rec } = fakeOctokit();

    await runReview({
      inputs: baseInputs(),
      octokit,
      context: prContext(headSha),
      fetch: replayFetch("success"),
      cwd: dir,
      now: () => 1_700_000_000_000,
    });

    const first = rec.created[0];
    expect(first?.body).toContain("PR Review in Progress");
    expect(first?.body).not.toContain("null");
    expect(first?.body).not.toContain("toolu-review-state:v1");
  });
});

describe("runReview — incremental scope (natural convergence)", () => {
  it("nothing changed since the last reviewed sha → a freshly invented finding cannot flip the verdict", async () => {
    // Round N+1 with reviewed_sha == current head: the since-diff is EMPTY, so a
    // generative model re-inventing findings about already-reviewed code has no
    // scope to put them in. The verdict converges to approved with no surrender
    // cap involved — the bot "stops when there are no issues on the changed files".
    const { dir, headSha } = track(featureRepoWithChange());
    const priorMarker = encodeMarker({
      schema: "toolu-review-state",
      version: 1,
      findings: [],
      history: [
        {
          sha: headSha.slice(0, 7),
          ts: 1_700_000_000,
          verdict: "changes",
          counts: { new: 1, open: 0, resolved: 0, total: 1 },
        },
      ],
      reviewed_sha: headSha,
    });
    const { octokit, rec } = fakeOctokit([
      { id: 900, body: `### Code Review — old\n\n${priorMarker}` },
    ]);

    // The findings fixture flags src/util.ts:2 — a line in the PR diff, but NOT
    // changed since the last reviewed sha (nothing is).
    const result = await runReview({
      inputs: baseInputs(),
      octokit,
      context: prContext(headSha),
      fetch: replayFetch("findings"),
      cwd: dir,
      now: () => 1_700_000_000_000,
    });

    expect(result.verdict).toBe("approved");
    expect(result.findingsCount).toBe(0);
    expect(rec.addedLabels).toContainEqual(["merge-approved"]);
    // No inline review posted for the dropped finding.
    expect(rec.reviews).toEqual([]);
    // The comment says out-of-scope findings were not re-raised.
    expect(rec.updated.at(-1)?.body).toContain("Incremental review");
  });

  it("the same finding on a FIRST review (no reviewed_sha) still requests changes", async () => {
    // Control: without a prior reviewed_sha the scope is null → full review, and
    // the fixture's finding blocks as before. The filter only ever narrows
    // RE-reviews; it can never weaken round one.
    const { dir, headSha } = track(featureRepoWithChange());
    const { octokit, rec } = fakeOctokit();

    const result = await runReview({
      inputs: baseInputs(),
      octokit,
      context: prContext(headSha),
      fetch: replayFetch("findings"),
      cwd: dir,
      now: () => 1_700_000_000_000,
    });

    expect(result.verdict).toBe("changes");
    expect(result.findingsCount).toBe(1);
    expect(rec.addedLabels).toContainEqual(["request-changes"]);
  });

  it("the NEXT round's marker records this round's reviewed sha", async () => {
    const { dir, headSha } = track(featureRepoWithChange());
    const { octokit, rec } = fakeOctokit();

    await runReview({
      inputs: baseInputs(),
      octokit,
      context: prContext(headSha),
      fetch: replayFetch("findings"),
      cwd: dir,
      now: () => 1_700_000_000_000,
    });

    const lastBody = rec.updated.at(-1)?.body ?? rec.created.at(-1)?.body ?? "";
    const marker = extractMarker(lastBody);
    expect(marker).not.toBeNull();
    const state = decodeMarker(marker ?? "");
    expect("reviewed_sha" in state && state.reviewed_sha).toBe(headSha);
  });

  it("records the PAYLOAD's PR head sha, not GITHUB_SHA (the test-merge commit)", async () => {
    // On pull_request events GITHUB_SHA is the ephemeral test-merge commit,
    // orphaned on every push — a series stored on it never resolves (or
    // ancestor-checks) on the next run, silently disabling the incremental
    // scope. The marker must converge on `.pull_request.head.sha`.
    const { dir, headSha } = track(featureRepoWithChange());
    const { octokit, rec } = fakeOctokit();
    const ctx = prContext("1111111111111111111111111111111111111111");
    ctx.payload = {
      pull_request: { number: 7, base: { ref: "main" }, head: { sha: headSha } },
    };

    await runReview({
      inputs: baseInputs(),
      octokit,
      context: ctx,
      fetch: replayFetch("findings"),
      cwd: dir,
      now: () => 1_700_000_000_000,
    });

    const lastBody = rec.updated.at(-1)?.body ?? rec.created.at(-1)?.body ?? "";
    const marker = extractMarker(lastBody);
    expect(marker).not.toBeNull();
    const state = decodeMarker(marker ?? "");
    expect("reviewed_sha" in state && state.reviewed_sha).toBe(headSha);
  });
});
