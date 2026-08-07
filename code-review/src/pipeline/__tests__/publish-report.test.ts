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
import { fingerprint } from "@/state.js";
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
    maxWallMs: 0,
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
 *  injected `fetch`'s own push into the same array; `bodies`, when passed,
 *  collects each posted sticky-comment body. */
function fakeOctokit(calls: string[], bodies: string[] = []): PipelineOctokit {
  return {
    rest: {
      issues: {
        listComments: async () => ({ data: [] }),
        createComment: async (p) => {
          bodies.push(p.body);
          return { data: { html_url: "https://github.com/o/r/issues/1#c1" } };
        },
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
    // A complete-coverage round over one reviewed file: no `unreviewed`/`pending`
    // entry, so the ledger's degrade rule leaves the verdict alone (AC-13).
    ledger: { entries: { "src/a.ts": { status: "reviewed" } } },
    exceptionPaths: new Set<string>(),
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

describe("publish — cluster members are expanded on BOTH sides of the report partition", () => {
  it("reports every member of a clustered finding as `new`, with no partition failure", async () => {
    const warn = vi.spyOn(core, "warning").mockImplementation(() => {});
    const calls: string[] = [];
    const posted: unknown[] = [];
    const bodies: string[] = [];
    const octokit = fakeOctokit(calls, bodies);
    const fetchStub: typeof fetch = async (_url, init) => {
      calls.push("report-post");
      posted.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}"));
      return new Response("{}", { status: 200 });
    };

    // The same defect, same category and text, on three distinct paths: exactly
    // the shape review/cluster.ts collapses into ONE exemplar-led cluster.
    const text = "Unwrap on a Result that can be an Err in this handler.";
    const stamped = ["src/a.ts", "src/b.ts", "src/c.ts"].map((path) => ({
      path,
      line: 12,
      severity: "high" as const,
      category: "correctness",
      text,
      fp: fingerprint({ path, category: "correctness", text }),
    }));

    const input = basePublishInput(octokit, {
      stamped,
      // The live prior thread sits on an unrelated path, so it maps to no cluster
      // and still lands in `toResolve` (the `fixed` row every test here relies on).
      priorThreads: [
        thread({ fp: "fp-dropped", threadId: "T_live", path: "src/zzz.ts", line: 99 }),
      ],
      ledger: {
        entries: {
          "src/a.ts": { status: "reviewed" },
          "src/b.ts": { status: "reviewed" },
          "src/c.ts": { status: "reviewed" },
        },
      },
      fetch: fetchStub,
    });

    const result = await publish(input);

    // ONE inline comment for the cluster (its exemplar), not three.
    expect(calls).toEqual(["review-create", "thread-reply", "thread-resolve", "report-post"]);
    // partitionFindings() ran its exhaustiveness check over expanded member lists
    // on both sides; a representative-only `applied` would have returned
    // {ok:false} and reported nothing but a warning.
    expect(warn).not.toHaveBeenCalled();
    const body: { findings?: { new?: { fp: string }[] } } = JSON.parse(
      JSON.stringify(posted[0] ?? {}),
    );
    expect((body.findings?.new ?? []).map((f) => f.fp).sort()).toEqual(
      stamped.map((f) => f.fp).sort(),
    );
    // The action's own count is the member count, not the representative count.
    expect(result.findingsCount).toBe(3);
    // The sticky comment carries the cluster body: the members it stands for and
    // the settlement rule the author needs BEFORE resolving the exemplar's thread.
    const comment = bodies.at(-1) ?? "";
    expect(comment).toContain("### Repeated findings (1)");
    // Members are enumerated in review/cluster.ts's fp order (its determinism rule),
    // and the exemplar is the lowest fp — here src/b.ts.
    expect(comment).toContain("Same finding in 3 files: `src/b.ts`, `src/c.ts`, `src/a.ts`");
    expect(comment).toContain("_Dismissing this thread dismisses the pattern (3 files)._");
    // The findings list itself shows the cluster ONCE, not three times.
    expect(comment).toContain("### Findings (1)");
  });
});
