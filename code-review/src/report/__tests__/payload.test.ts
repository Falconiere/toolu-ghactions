// payload.test.ts — proves buildPayload() honors the wire contract: category
// normalization (AC-35), no text/quoted_line/suggestion at any depth (AC-25),
// the run identity + its missing-runAttempt fallback, a deterministic
// durationMs, and a byte-for-byte fixture round-trip (fixtures/README.md).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { reviewWithModel } from "@/llm/reviewWithModel.js";
import { validateFindings } from "@/review/validate.js";
import { fingerprint } from "@/state.js";
import { partitionFindings } from "@/report/partition.js";
import type { DismissedFinding, PartitionedFindings, ReportedFinding } from "@/report/partition.js";
import { buildPayload } from "@/report/payload.js";
import type { BuildPayloadInput, ReviewRunPayload } from "@/report/payload.js";
import type { ReportCategory } from "@/report/categories.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(TEST_DIR, "fixtures", "review-run.payload.json");
const DEEPSEEK_SUCCESS_PATH = join(
  TEST_DIR,
  "..",
  "..",
  "llm",
  "__tests__",
  "fixtures",
  "deepseek-success.json",
);
const DEEPSEEK_SUCCESS: unknown = JSON.parse(readFileSync(DEEPSEEK_SUCCESS_PATH, "utf8"));

/** A fetch that always replays one recorded response — no network, no code mocks. */
function replayFetch(body: unknown): typeof fetch {
  return async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

/** Reproduces exactly what `fixtures/README.md` documents: parse the recorded
 *  DeepSeek completion (genuine, per deepseek.test.ts's header), validate +
 *  fingerprint its one finding, partition it as a first-round new finding, and
 *  build the payload `review-run.payload.json` was generated from. */
async function buildFixturePayload(): Promise<ReviewRunPayload> {
  const result = await reviewWithModel(
    {
      system: "You are a code reviewer.",
      user: "Review the following pull request diff. Respond ONLY with the required JSON verdict.",
      max_tokens: 4096,
      enforce_json_schema: true,
    },
    {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      apiKey: "sk-test",
      maxRetries: 0,
      fetch: replayFetch(DEEPSEEK_SUCCESS),
    },
  );
  const changedLinesByPath = new Map<string, number[]>([["src/math.ts", [1]]]);
  const anchored = validateFindings(result.findings, changedLinesByPath, "medium");
  const stamped = anchored.map((f) => ({ ...f, fp: fingerprint(f) }));

  const partitioned = partitionFindings({
    applied: { toCreate: stamped, toReply: [], toResolve: [] },
    findings: stamped,
    suppressed: [],
    priorThreads: [],
    prior: null,
  });
  if (!partitioned.ok) throw new Error(`partition violation: ${partitioned.reason}`);

  return buildPayload({
    repoId: "789012345",
    target: { owner: "acme", repo: "widgets-mobile", prNumber: 42, headSha: "unused" },
    reviewedSha: "3f2c1a9e7b8d4e5f6a1b2c3d4e5f6a7b8c9d0e1f",
    baseBranch: "main",
    authorLogin: "octocat",
    context: { runId: 18453927061, runAttempt: 1 },
    inputs: { provider: "deepseek", model: "deepseek-v4-flash" },
    verdict: result.verdict,
    capped: false,
    fullReview: true,
    startMs: 1782001200000,
    now: () => 1782001200000 + 42_318,
    prior: null,
    partitions: partitioned.partitions,
  });
}

const NINE_CATEGORIES: ReadonlySet<ReportCategory> = new Set<ReportCategory>([
  "correctness",
  "security",
  "performance",
  "test-coverage",
  "doc-accuracy",
  "assertions",
  "migration",
  "conventions",
  "other",
]);

const FORBIDDEN_KEYS = new Set(["text", "quoted_line", "suggestion"]);

/** Recursively collect every forbidden-key path present anywhere in `value`. */
function forbiddenKeyPaths(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => forbiddenKeyPaths(item, `${path}[${i}]`));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, v]) => [
      ...(FORBIDDEN_KEYS.has(key) ? [`${path}.${key}`] : []),
      ...forbiddenKeyPaths(v, `${path}.${key}`),
    ]);
  }
  return [];
}

/** A minimal ReportedFinding, overridable — mirrors partition.test.ts's builder. */
function reportedFinding(over: Partial<ReportedFinding> = {}): ReportedFinding {
  return {
    fp: "fp-1",
    path: "src/a.ts",
    line: 10,
    severity: "medium",
    category: "correctness",
    source: "llm",
    ...over,
  };
}

function dismissedFinding(over: Partial<DismissedFinding> = {}): DismissedFinding {
  return { ...reportedFinding(), settlement: "explicit", ...over };
}

function emptyPartitions(): PartitionedFindings {
  return { new: [], open: [], fixed: [], dismissed: [] };
}

/** A minimal, valid BuildPayloadInput, overridable per test. */
function baseInput(over: Partial<BuildPayloadInput> = {}): BuildPayloadInput {
  return {
    repoId: "42",
    target: { owner: "acme", repo: "widgets", prNumber: 7, headSha: "ignored-merge-sha" },
    reviewedSha: "headsha1234",
    baseBranch: "main",
    authorLogin: "octocat",
    context: { runId: 111, runAttempt: 2 },
    inputs: { provider: "openrouter", model: "anthropic/claude-sonnet-4-5" },
    verdict: "changes",
    capped: false,
    fullReview: true,
    startMs: 1000,
    now: () => 1500,
    prior: null,
    partitions: emptyPartitions(),
    ...over,
  };
}

describe("buildPayload — identity and shape", () => {
  it("reports schemaVersion, repo/pull identity, and the run id — pull.headSha from reviewedSha, never target.headSha", () => {
    const target = {
      owner: "acme",
      repo: "widgets",
      prNumber: 7,
      headSha: "MERGE_SHA_MUST_NOT_APPEAR",
    };
    const payload = buildPayload(
      baseInput({
        target,
        reviewedSha: "REAL_PR_HEAD_SHA",
        context: { runId: 987654321, runAttempt: 3 },
      }),
    );
    expect(payload.schemaVersion).toBe(1);
    expect(payload.repo.fullName).toBe("acme/widgets");
    expect(payload.pull.headSha).toBe("REAL_PR_HEAD_SHA");
    expect(payload.run.githubRunId).toBe("987654321");
    expect(payload.run.githubRunAttempt).toBe(3);
    expect(JSON.stringify(payload)).not.toContain("MERGE_SHA_MUST_NOT_APPEAR");
  });

  it("defaults githubRunAttempt to 1 when the A1 seam carries none (headSha?/headRef?'s convention)", () => {
    const payload = buildPayload(baseInput({ context: { runId: 1 } }));
    expect(payload.run.githubRunAttempt).toBe(1);
  });
});

describe("buildPayload — timing and round", () => {
  it("derives durationMs/startedAt from the injected clock, never wall time", () => {
    const payload = buildPayload(
      baseInput({ startMs: 5_000_000_000_000, now: () => 5_000_000_000_777 }),
    );
    expect(payload.run.durationMs).toBe(777);
    expect(payload.run.startedAt).toBe(5_000_000_000_000);
  });

  it.each([
    [null, 1],
    [{ len: 2 }, 3],
    [{ len: 10 }, 11], // saturates: state.ts's diffState() caps history at .slice(-10)
  ])("reportedRound is prior.history.length + 1, advisory only (%o -> %i)", (spec, expected) => {
    const prior =
      spec === null
        ? null
        : {
            schema: "toolu-review-state" as const,
            version: 1 as const,
            findings: [],
            history: Array.from({ length: spec.len }, (_, i) => ({
              sha: `s${i}`,
              ts: i,
              verdict: "changes",
              counts: { new: 0, open: 0, resolved: 0, total: 0 },
            })),
          };
    expect(buildPayload(baseInput({ prior })).run.reportedRound).toBe(expected);
  });
});

describe("buildPayload — category normalization (the one call site)", () => {
  it("normalizes a recognized category, maps an unrecognized one to 'other', and defaults an absent source to 'llm'", () => {
    const payload = buildPayload(
      baseInput({
        partitions: {
          ...emptyPartitions(),
          new: [reportedFinding({ fp: "fp-tc", category: "TEST COVERAGE", source: undefined })],
          open: [reportedFinding({ fp: "fp-q", category: "quantum" })],
        },
      }),
    );
    expect(payload.findings.new[0]?.category).toBe("test-coverage");
    expect(payload.findings.new[0]?.source).toBe("llm");
    expect(payload.findings.open[0]?.category).toBe("other");
  });

  it("omits severity/category/source together when the marker rotated past the fp", () => {
    const payload = buildPayload(
      baseInput({
        partitions: {
          ...emptyPartitions(),
          fixed: [{ fp: "fp-rotated", path: "src/a.ts", line: 10 }],
        },
      }),
    );
    expect(payload.findings.fixed).toEqual([{ fp: "fp-rotated", path: "src/a.ts", line: 10 }]);
  });

  it("carries the settlement value on a dismissed finding alongside its normalized category", () => {
    const payload = buildPayload(
      baseInput({
        partitions: {
          ...emptyPartitions(),
          dismissed: [
            dismissedFinding({ fp: "fp-d", category: "SECURITY", settlement: "exhausted" }),
          ],
        },
      }),
    );
    expect(payload.findings.dismissed[0]).toMatchObject({
      category: "security",
      source: "llm",
      settlement: "exhausted",
    });
  });
});

describe("buildPayload — no text/quoted_line/suggestion at any depth (AC-25)", () => {
  it("never leaks them even if a partition entry carries them", () => {
    // ReportedFinding has no text/quoted_line/suggestion field, so this widens
    // past it deliberately: proves buildFinding() builds field by field and
    // never spreads the source object, not merely that the type disallows it.
    const leaky: ReportedFinding & { text: string; quoted_line: string; suggestion: string } = {
      ...reportedFinding({ fp: "fp-leaky" }),
      text: "full finding prose should never leave the runner",
      quoted_line: "some quoted source line",
      suggestion: "some suggested patch",
    };
    const payload = buildPayload(baseInput({ partitions: { ...emptyPartitions(), new: [leaky] } }));
    expect(forbiddenKeyPaths(payload)).toEqual([]);
  });
});

describe("buildPayload — driven from a real recorded completion (AC-25, AC-35)", () => {
  it("every emitted category is one of the nine members, identity is present, and no forbidden key leaks", async () => {
    const payload = await buildFixturePayload();
    const allFindings = [
      ...payload.findings.new,
      ...payload.findings.open,
      ...payload.findings.fixed,
      ...payload.findings.dismissed,
    ];
    expect(allFindings.length).toBeGreaterThan(0);
    for (const f of allFindings) {
      if (f.category !== undefined) expect(NINE_CATEGORIES.has(f.category)).toBe(true);
    }
    expect(typeof payload.run.githubRunId).toBe("string");
    expect(payload.run.githubRunId).not.toBe("");
    expect(typeof payload.run.githubRunAttempt).toBe("number");
    expect(forbiddenKeyPaths(payload)).toEqual([]);
  });
});

describe("buildPayload — fixture round-trip", () => {
  it("regenerating from the same recorded input reproduces review-run.payload.json byte-for-byte", async () => {
    const payload = await buildFixturePayload();
    const regenerated = `${JSON.stringify(payload, null, 2)}\n`;
    const onDisk = readFileSync(FIXTURE_PATH, "utf8");
    expect(regenerated).toBe(onDisk);
  });
});
