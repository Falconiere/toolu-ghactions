// publish-report.test.ts — proves A6's reporting wiring end to end through the
// REAL publish(): gating on TOOLU_API_KEY/INLINE_COMMENTS (AC-23), every POST
// failure mode degrading to exactly one core.warning with runReview's normal
// result unchanged and core.setFailed never reached (AC-24), and post() firing
// strictly AFTER postInline's thread mutations (AC-26). No network: `fetch` is
// injected per PublishInput's A1 seam, and the GitHub client is an in-memory fake.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as core from "@actions/core";
import { publish } from "@/pipeline/publish.js";
import type { PublishInput, PublishTarget } from "@/pipeline/publish.js";
import type { GithubContext, PipelineOctokit } from "@/pipeline/types.js";
import type { ActionInputs } from "@/inputs.js";
import type { BlockableVerdict } from "@/review/gate.js";
import { thread } from "@/review/__tests__/reconcile-helpers.js";
import { POST_TIMEOUT_MS } from "@/report/post.js";

/** A fully-populated ActionInputs, overridable per test. */
function baseInputs(over: Partial<ActionInputs> = {}): ActionInputs {
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
    maxChunks: 20,
    requestTimeoutMs: 180000,
    token: "ghs_test",
    appId: "",
    appPrivateKey: "",
    triggerPhrase: "@toolu",
    minTriggerPermission: "write",
    botName: "Toolu — Code Review",
    botLogoUrl: "https://example.com/logo.png",
    reviewMemory: false,
    failOn: new Set<BlockableVerdict>(),
    verbosity: "compact",
    touluApiKey: "toolu_test_key",
    touluApiUrl: "https://api.toolu.sh",
    ...over,
  };
}

/** A minimal in-memory PipelineOctokit. `calls` records, in order, every
 *  externally-observable mutation so ordering (AC-26) is assertable against the
 *  injected `fetch`'s own push into the same array. */
function fakeOctokit(calls: string[]): PipelineOctokit {
  return {
    rest: {
      issues: {
        listComments: async () => ({ data: [] }),
        createComment: async () => ({ data: { html_url: "https://github.com/o/r/issues/1#c1" } }),
        updateComment: async () => ({ data: { html_url: "https://github.com/o/r/issues/1#c1" } }),
        createLabel: async () => ({}),
        removeLabel: async () => ({}),
        addLabels: async () => ({}),
      },
      pulls: {
        createReview: async () => {
          calls.push("review-create");
          return { data: { html_url: "https://github.com/o/r/pull/7#review" } };
        },
        createReplyForReviewComment: async () => {
          calls.push("thread-reply");
          return { data: { id: 9001 } };
        },
      },
    },
    graphql: async (query: string) => {
      if (query.includes("resolveReviewThread")) {
        calls.push("thread-resolve");
        return { resolveReviewThread: { thread: { isResolved: true } } };
      }
      return {};
    },
  };
}

/** A minimal, valid PublishInput. `stamped` is empty and `priorThreads` carries
 *  one live bot thread with no matching finding, so `reconcile()` always routes
 *  it to `toResolve` — giving every test a real, non-empty partition to report
 *  (one `fixed` finding) without needing an anchored inline-review comment. */
function basePublishInput(
  octokit: PipelineOctokit,
  over: Partial<PublishInput> = {},
): PublishInput {
  const target: PublishTarget = { owner: "acme", repo: "widgets", prNumber: 7, headSha: "abc123" };
  const context: GithubContext = {
    eventName: "pull_request",
    payload: null,
    repo: { owner: "acme", repo: "widgets" },
    sha: "abc123",
    serverUrl: "https://github.com",
    runId: 555,
    runAttempt: 1,
    repoId: 789012345,
    authorLogin: "octocat",
  };
  return {
    octokit,
    context,
    target,
    inputs: baseInputs(),
    diff: {
      diff: "",
      files: [],
      changed_files: [],
      binary_files: [],
      dropped_files: [],
      renames: [],
      total_lines: 0,
      total_files: 1,
      truncated: false,
      base_sha: "base123",
    },
    result: { verdict: "approved", findings: [] },
    stamped: [],
    priorThreads: [thread({ fp: "fp-dropped", threadId: "T_live" })],
    prior: null,
    stickyId: undefined,
    mechanical: [],
    scope: null,
    reviewedSha: "abc123",
    fullReview: true,
    reviewHead: "HEAD",
    baseBranch: "main",
    startMs: 1_700_000_000_000,
    now: () => 1_700_000_000_500,
    ...over,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("publish — reporting gate (AC-23)", () => {
  it("TOOLU_API_KEY empty: no request, no warning", async () => {
    const warn = vi.spyOn(core, "warning").mockImplementation(() => {});
    const failed = vi.spyOn(core, "setFailed").mockImplementation(() => {});
    let fetchCalled = false;
    const fetchStub: typeof fetch = async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    };
    const input = basePublishInput(fakeOctokit([]), {
      inputs: baseInputs({ touluApiKey: "" }),
      fetch: fetchStub,
    });

    const result = await publish(input);

    expect(result.verdict).toBe("approved");
    expect(fetchCalled).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  });

  it("TOOLU_API_KEY set + INLINE_COMMENTS false: no request, exactly one warning", async () => {
    const warn = vi.spyOn(core, "warning").mockImplementation(() => {});
    const failed = vi.spyOn(core, "setFailed").mockImplementation(() => {});
    let fetchCalled = false;
    const fetchStub: typeof fetch = async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    };
    const input = basePublishInput(fakeOctokit([]), {
      inputs: baseInputs({ inlineComments: false }),
      fetch: fetchStub,
    });

    const result = await publish(input);

    expect(result.verdict).toBe("approved");
    expect(fetchCalled).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("INLINE_COMMENTS");
    expect(failed).not.toHaveBeenCalled();
  });
});

describe("publish — every POST failure mode is silent (AC-24)", () => {
  it("a 500 response: normal result, one warning, setFailed never reached", async () => {
    const warn = vi.spyOn(core, "warning").mockImplementation(() => {});
    const failed = vi.spyOn(core, "setFailed").mockImplementation(() => {});
    const fetchStub: typeof fetch = async () => new Response("", { status: 500 });
    const input = basePublishInput(fakeOctokit([]), { fetch: fetchStub });

    const result = await publish(input);

    expect(result.verdict).toBe("approved");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("500");
    expect(failed).not.toHaveBeenCalled();
  });

  it("a thrown fetch error: normal result, one warning, setFailed never reached", async () => {
    const warn = vi.spyOn(core, "warning").mockImplementation(() => {});
    const failed = vi.spyOn(core, "setFailed").mockImplementation(() => {});
    const fetchStub: typeof fetch = async () => {
      throw new Error("getaddrinfo ENOTFOUND api.toolu.sh");
    };
    const input = basePublishInput(fakeOctokit([]), { fetch: fetchStub });

    const result = await publish(input);

    expect(result.verdict).toBe("approved");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("ENOTFOUND");
    expect(failed).not.toHaveBeenCalled();
  });

  it("never resolving past the timeout: aborts deterministically, normal result, one warning, no hang", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(core, "warning").mockImplementation(() => {});
    const failed = vi.spyOn(core, "setFailed").mockImplementation(() => {});
    // Real fetch behavior: the promise settles only when the AbortController fires.
    const hangingFetch: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("This operation was aborted."), { name: "AbortError" }));
        });
      });
    const input = basePublishInput(fakeOctokit([]), { fetch: hangingFetch });

    const pending = publish(input);
    // Drive post.ts's setTimeout deterministically instead of waiting real time.
    await vi.advanceTimersByTimeAsync(POST_TIMEOUT_MS + 100);
    const result = await pending;

    expect(result.verdict).toBe("approved");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/abort/i);
    expect(failed).not.toHaveBeenCalled();
  });
});

describe("publish — post() runs strictly after postInline (AC-26)", () => {
  it("orders the reporting POST after the thread-resolution mutation", async () => {
    vi.spyOn(core, "warning").mockImplementation(() => {});
    const calls: string[] = [];
    const octokit = fakeOctokit(calls);
    const fetchStub: typeof fetch = async () => {
      calls.push("report-post");
      return new Response("{}", { status: 200 });
    };
    const input = basePublishInput(octokit, { fetch: fetchStub });

    await publish(input);

    // The one live prior thread has no matching finding this run, so reconcile()
    // resolves it: a closing reply, then the resolve mutation, both via octokit —
    // and only THEN does report-run.ts's post() fire.
    expect(calls).toEqual(["thread-reply", "thread-resolve", "report-post"]);
  });
});
