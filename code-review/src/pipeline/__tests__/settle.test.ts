// settle.test.ts — `settleVerdict`'s two LAST decisions and the order they run in:
// the MAX_ROUNDS surrender (review/gate.ts `applyRoundCap`) and the coverage
// degrade (AC-13). Both can fire on the same round and they pull in opposite
// directions — the cap forces "approved", the degrade forbids it — so which one
// speaks last is the whole behaviour. Nothing pinned it before this file.
//
// Real collaborators throughout: the reduction comes from the real
// `reduceFindings` (carry-forward + clustering), the exceptions from the real
// `ledgerExceptions` over a real `buildRoundLedger` ledger, and the findings are
// stamped with the real `fingerprint()`.
import { describe, expect, it } from "vitest";
import { ledgerExceptions, settleVerdict } from "@/pipeline/settle.js";
import { reduceFindings } from "@/pipeline/reduce.js";
import { buildRoundLedger, type CoverageEntry } from "@/review/ledger.js";
import type { PublishInput, PublishTarget } from "@/pipeline/publish.js";
import type { GithubContext, PipelineOctokit } from "@/pipeline/types.js";
import type { StampedFinding } from "@/pipeline/reviewCall.js";
import type { ActionInputs } from "@/inputs.js";
import type { BlockableVerdict } from "@/review/gate.js";
import type { ReviewState, HistoryEntry, Finding as StoredFinding } from "@/state.js";
import { fingerprint } from "@/state.js";

/** ActionInputs with the review-memory knobs this suite drives, overridable. */
function inputsWith(over: Partial<ActionInputs> = {}): ActionInputs {
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
    touluApiKey: "",
    touluApiUrl: "https://api.toolu.sh",
    ...over,
  };
}

/** settleVerdict never touches GitHub; the client is present only to type the input. */
const OCTOKIT: PipelineOctokit = {
  rest: {
    issues: {
      listComments: async () => ({ data: [] }),
      createComment: async () => ({ data: { html_url: "https://example.test/c" } }),
      updateComment: async () => ({ data: { html_url: "https://example.test/c" } }),
      createLabel: async () => ({}),
      removeLabel: async () => ({}),
      addLabels: async () => ({}),
    },
    pulls: {
      createReview: async () => ({ data: { html_url: "https://example.test/r" } }),
      createReplyForReviewComment: async () => ({ data: { id: 1 } }),
    },
  },
  graphql: async () => ({}),
};

const CONTEXT: GithubContext = {
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

const TARGET: PublishTarget = { owner: "acme", repo: "widgets", prNumber: 7, headSha: "abc123" };

/** A stamped model finding with a real fingerprint. */
function stamp(path: string, severity: StampedFinding["severity"], text: string): StampedFinding {
  return {
    path,
    line: 12,
    severity,
    category: "correctness",
    text,
    fp: fingerprint({ path, category: "correctness", text }),
  };
}

/** `n` completed rounds of history — `priorRounds` for the round cap. */
function history(n: number): HistoryEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    sha: `sha${i}`,
    ts: 1_700_000_000 + i,
    verdict: "changes",
    counts: { new: 1, open: 1, resolved: 0, total: 1 },
  }));
}

/** A round ledger over `reviewed` ∪ `unreviewed` ∪ `carried` paths, built the real way. */
function ledgerOf(reviewed: string[], unreviewed: string[], carried: string[] = []) {
  const paths = [...reviewed, ...unreviewed, ...carried];
  return buildRoundLedger({
    changedFiles: paths,
    binaryFiles: [],
    droppedFiles: [],
    strata: Object.fromEntries(paths.map((p) => [p, "substantive" as const])),
    exemplars: new Set<string>(),
    coverage: new Map<string, CoverageEntry>([
      ...reviewed.map((p): [string, CoverageEntry] => [p, { status: "reviewed" }]),
      ...unreviewed.map((p): [string, CoverageEntry] => [p, { status: "unreviewed" }]),
    ]),
    carried,
  });
}

/** Run the real settleVerdict over a real reduction + real ledger exceptions. */
function settle(opts: {
  findings: StampedFinding[];
  reviewed: string[];
  unreviewed: string[];
  maxRounds: number;
  priorRounds: number;
  reviewMemory?: boolean;
  /** The model's own verdict before settling (default "changes"). */
  resultVerdict?: "approved" | "changes";
  /** Paths this round did NOT re-review — their prior findings carry forward. */
  carried?: string[];
  /** Marker findings, loosely typed exactly as a decoded marker delivers them. */
  priorFindings?: StoredFinding[];
}) {
  const ledger = ledgerOf(opts.reviewed, opts.unreviewed, opts.carried ?? []);
  const prior: ReviewState = {
    schema: "toolu-review-state",
    version: 1,
    findings: opts.priorFindings ?? [],
    history: history(opts.priorRounds),
  };
  const reduction = reduceFindings({ modelFindings: opts.findings, prior, ledger });
  const input: PublishInput = {
    octokit: OCTOKIT,
    context: CONTEXT,
    target: TARGET,
    inputs: inputsWith({
      reviewMemory: opts.reviewMemory ?? true,
      maxRounds: opts.maxRounds,
    }),
    diff: {
      diff: "",
      files: [],
      changed_files: [...opts.reviewed, ...opts.unreviewed, ...(opts.carried ?? [])],
      binary_files: [],
      dropped_files: [],
      renames: [],
      total_lines: 0,
      total_files: opts.reviewed.length + opts.unreviewed.length + (opts.carried?.length ?? 0),
      truncated: false,
      base_sha: "base123",
    },
    result: { verdict: opts.resultVerdict ?? "changes", findings: opts.findings },
    stamped: opts.findings,
    priorThreads: [],
    prior,
    stickyId: undefined,
    mechanical: [],
    ledger,
    exceptionPaths: new Set<string>(),
    scope: null, // full review — the incremental filter is covered elsewhere
    reviewedSha: "abc123",
    fullReview: true,
    reviewHead: "HEAD",
    baseBranch: "main",
    startMs: 1_700_000_000_000,
    now: () => 1_700_000_000_500,
  };
  return settleVerdict(input, reduction, ledgerExceptions(ledger));
}

describe("settleVerdict — MAX_ROUNDS surrender vs the coverage degrade", () => {
  it("the coverage degrade runs LAST and overrides the round cap's approval (decided order)", () => {
    // Round 3 of MAX_ROUNDS=3 with only sub-blocker findings → applyRoundCap turns
    // "changes" into "approved". One path went unreviewed in the same round, so the
    // AC-13 degrade then turns that approval into "error".
    //
    // THIS IS THE DECIDED ORDER, not an accident of the code: the round cap exists
    // so a reviewer that regenerates findings forever cannot block a PR, while the
    // degrade exists so the action never claims a verdict over code it did not read.
    // The second is a statement about what was READ and the first about what was
    // FOUND, so the cap cannot license an approval the coverage does not support —
    // settle.ts calls degradeOnCoverage after the cap for exactly that reason.
    const settled = settle({
      findings: [stamp("src/a.ts", "medium", "prefer a named constant here")],
      reviewed: ["src/a.ts"],
      unreviewed: ["src/b.ts"],
      maxRounds: 3,
      priorRounds: 2,
    });

    expect(settled.verdict).toBe("error");
    expect(settled.validated.verdict).toBe("error");
    // The cap DID fire — it is reported (`run.capped`) and explained, it just does
    // not get the last word on the verdict.
    expect(settled.capped).toBe(true);
    expect(settled.capNote).toContain("Round cap reached (MAX_ROUNDS=3)");
    // The degrade's own explanation is synthesized because the result carried none.
    expect(settled.validated.error).toContain("1 file(s) were not reviewed this run");
    // The findings are still there — neither rule deletes them, they stay advisory.
    expect(settled.findings).toHaveLength(1);
  });

  it("the same round with COMPLETE coverage keeps the cap's approval", () => {
    // The control: identical inputs minus the unreviewed path.
    const settled = settle({
      findings: [stamp("src/a.ts", "medium", "prefer a named constant here")],
      reviewed: ["src/a.ts", "src/b.ts"],
      unreviewed: [],
      maxRounds: 3,
      priorRounds: 2,
    });

    expect(settled.capped).toBe(true);
    expect(settled.verdict).toBe("approved");
    expect(settled.validated.verdict).toBe("approved");
    expect(settled.validated.error).toBeUndefined();
    expect(settled.capNote).toContain("Round cap reached (MAX_ROUNDS=3)");
  });

  it("a blocker disables the cap, so incomplete coverage leaves the verdict at `changes`", () => {
    // The degrade only ever touches a would-be APPROVAL. With the cap disabled by
    // a blocker the verdict is still "changes", which is already do-not-merge, so
    // nothing degrades and no synthesized error is written over the run.
    const settled = settle({
      findings: [stamp("src/a.ts", "blocker", "this bypasses the auth check")],
      reviewed: ["src/a.ts"],
      unreviewed: ["src/b.ts"],
      maxRounds: 3,
      priorRounds: 2,
    });

    expect(settled.capped).toBe(false);
    expect(settled.verdict).toBe("changes");
    expect(settled.capNote).toBe("");
    expect(settled.validated.error).toBeUndefined();
  });

  it("before the cap round, incomplete coverage still leaves `changes` alone", () => {
    const settled = settle({
      findings: [stamp("src/a.ts", "medium", "prefer a named constant here")],
      reviewed: ["src/a.ts"],
      unreviewed: ["src/b.ts"],
      maxRounds: 5,
      priorRounds: 1, // this is round 2 of 5
    });

    expect(settled.capped).toBe(false);
    expect(settled.verdict).toBe("changes");
  });

  it("REVIEW_MEMORY off disables the cap entirely, so coverage alone decides", () => {
    // settle.ts passes `maxRounds: 0` when review memory is off — the cap cannot
    // fire, and a "changes" verdict is untouched by the degrade.
    const settled = settle({
      findings: [stamp("src/a.ts", "medium", "prefer a named constant here")],
      reviewed: ["src/a.ts"],
      unreviewed: ["src/b.ts"],
      maxRounds: 3,
      priorRounds: 2,
      reviewMemory: false,
    });

    expect(settled.capped).toBe(false);
    expect(settled.verdict).toBe("changes");
  });
});

describe("settleVerdict — the coverage degrade on its own", () => {
  it("degrades a clean approval over unreviewed files to error, counting every one", () => {
    const settled = settle({
      findings: [],
      reviewed: ["src/a.ts"],
      unreviewed: ["src/b.ts", "src/c.ts"],
      maxRounds: 0,
      priorRounds: 0,
      resultVerdict: "approved",
    });

    expect(settled.verdict).toBe("error");
    expect(settled.validated.verdict).toBe("error");
    expect(settled.validated.error).toContain("2 file(s) were not reviewed this run");
    expect(settled.capped).toBe(false);
  });

  it("leaves a findings-free `changes` alone — the degrade only ever touches an approval", () => {
    // Nothing was suppressed or dropped, so the flip-to-approved rule does not fire
    // either; the verdict stays the do-not-merge one it already was.
    const settled = settle({
      findings: [],
      reviewed: ["src/a.ts"],
      unreviewed: ["src/b.ts"],
      maxRounds: 0,
      priorRounds: 0,
    });
    expect(settled.verdict).toBe("changes");
    expect(settled.validated.error).toBeUndefined();
  });

  it("a carried finding holds the prior round's `changes`, and validated.verdict agrees", () => {
    // The rule that has no paired write left in settle.ts: every verdict rule moves
    // the local only and `validated.verdict` is synced once before the return, so
    // this pins that the ProviderResult the comment renders from cannot say
    // "approved" while the returned verdict says "changes".
    const priorFindings: StoredFinding[] = JSON.parse(
      '[{"path":"src/carried.ts","line":4,"severity":"high","category":"correctness",' +
        '"text":"the handle is never closed","fp":"fp-carried"}]',
    );
    const settled = settle({
      findings: [],
      reviewed: ["src/a.ts"],
      unreviewed: [],
      carried: ["src/carried.ts"],
      priorFindings,
      maxRounds: 0,
      priorRounds: 1, // one completed round, and history() records it as "changes"
      resultVerdict: "approved",
    });

    expect(settled.verdict).toBe("changes");
    expect(settled.validated.verdict).toBe("changes");
    // Coverage is COMPLETE (carried is not unreviewed/pending), so no degrade fired.
    expect(settled.validated.error).toBeUndefined();
    expect(settled.findings.map((f) => f.fp)).toEqual(["fp-carried"]);
  });

  it("never overwrites a provider's own error message with the synthesized one", () => {
    const ledger = ledgerOf(["src/a.ts"], ["src/b.ts"]);
    const prior: ReviewState = {
      schema: "toolu-review-state",
      version: 1,
      findings: [],
      history: [],
    };
    const reduction = reduceFindings({ modelFindings: [], prior, ledger });
    const input: PublishInput = {
      octokit: OCTOKIT,
      context: CONTEXT,
      target: TARGET,
      inputs: inputsWith({ reviewMemory: true, maxRounds: 0 }),
      diff: {
        diff: "",
        files: [],
        changed_files: ["src/a.ts", "src/b.ts"],
        binary_files: [],
        dropped_files: [],
        renames: [],
        total_lines: 0,
        total_files: 2,
        truncated: false,
        base_sha: "base123",
      },
      result: { verdict: "approved", findings: [], error: "1/2 chunks failed — upstream refused" },
      stamped: [],
      priorThreads: [],
      prior,
      stickyId: undefined,
      mechanical: [],
      ledger,
      exceptionPaths: new Set<string>(),
      scope: null,
      reviewedSha: "abc123",
      fullReview: true,
      reviewHead: "HEAD",
      baseBranch: "main",
      startMs: 1_700_000_000_000,
      now: () => 1_700_000_000_500,
    };

    const settled = settleVerdict(input, reduction, ledgerExceptions(ledger));
    expect(settled.verdict).toBe("error");
    expect(settled.validated.error).toBe("1/2 chunks failed — upstream refused");
  });
});
