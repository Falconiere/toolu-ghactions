// evals/__tests__/scorecard.test.ts — pure scorecard-derivation and rendering
// tests, with synthetic data (no gh/git/network/key). Run directly with
// `bun test evals/__tests__` — NOT part of `bun run check`.
import { describe, it, expect } from "bun:test";
import type { PatternGroup } from "@/git/distill.js";
import type { ReviewState } from "@/state.js";
import {
  BODY_SIZE_LIMIT,
  strataCounts,
  biggestPatternGroup,
  parseCoverageSummary,
  computeFindingCounts,
  renderTable,
  renderJson,
  type Scorecard,
} from "../scorecard.js";

describe("strataCounts", () => {
  it("zero-fills every stratum and tallies the rest", () => {
    const counts = strataCounts({
      "a.ts": "substantive",
      "b.ts": "substantive",
      "c.ts": "rename",
      "d.ts": "pattern",
    });
    expect(counts).toEqual({
      substantive: 2,
      pattern: 1,
      rename: 1,
      formatting: 0,
      vendored: 0,
      generated: 0,
    });
  });
});

describe("biggestPatternGroup", () => {
  const groups: PatternGroup[] = [
    { exemplar: "a.ts", members: ["a.ts", "b.ts", "c.ts"], hunk_hash: "h1", summary: "s1" },
    {
      exemplar: "x.ts",
      members: ["x.ts", "y.ts", "z.ts", "w.ts"],
      hunk_hash: "h2",
      summary: "s2",
    },
  ];

  it("picks the group with the most members", () => {
    expect(biggestPatternGroup(groups)).toEqual({ exemplar: "x.ts", members: 4 });
  });

  it("returns null for no groups", () => {
    expect(biggestPatternGroup([])).toBeNull();
  });
});

describe("parseCoverageSummary", () => {
  it("parses the ### Coverage summary line", () => {
    const body =
      "Some preamble\n\n### Coverage\n\nreviewed: 3 · pattern: 2 · excluded: 1\n\nmore text";
    expect(parseCoverageSummary(body)).toEqual({ reviewed: 3, pattern: 2, excluded: 1 });
  });

  it("returns {} when the section is absent", () => {
    expect(parseCoverageSummary("no coverage section here")).toEqual({});
  });
});

describe("computeFindingCounts", () => {
  it("counts every finding as raw; clustered collapses exemplar+members", () => {
    const state: ReviewState = {
      schema: "toolu-review-state",
      version: 1,
      findings: [
        { fp: "fp1", path: "a.ts" },
        { fp: "fp2", path: "b.ts" },
        { fp: "fp3", path: "c.ts" },
        { fp: "fp4", path: "d.ts" },
      ],
      history: [],
      clusters: { fp1: "fp1", fp2: "fp1", fp3: "fp1" },
    };
    // fp1/fp2/fp3 form one cluster (exemplar fp1); fp4 is a singleton.
    expect(computeFindingCounts(state)).toEqual({ raw: 4, clustered: 2 });
  });

  it("treats an empty decoded marker as zero findings", () => {
    expect(computeFindingCounts({})).toEqual({ raw: 0, clustered: 0 });
  });

  it("every finding is its own cluster when there is no clusters map", () => {
    const state: ReviewState = {
      schema: "toolu-review-state",
      version: 1,
      findings: [
        { fp: "fp1", path: "a.ts" },
        { fp: "fp2", path: "b.ts" },
      ],
      history: [],
    };
    expect(computeFindingCounts(state)).toEqual({ raw: 2, clustered: 2 });
  });
});

function sampleScorecard(overrides: Partial<Scorecard> = {}): Scorecard {
  return {
    pr: { owner: "acme", repo: "widgets", number: 42 },
    provider: "openrouter",
    model: "deepseek/deepseek-v4-pro",
    changedFiles: 5,
    strata: { substantive: 5, pattern: 0, rename: 0, formatting: 0, vendored: 0, generated: 0 },
    patternGroups: { count: 0, biggestExemplar: null, biggestMembers: 0 },
    packages: 1,
    modelCalls: { cartographer: 1, packageLayer: 1, total: 2 },
    findings: { raw: 2, clustered: 2 },
    coverage: { reviewed: 5 },
    markerBytes: { body: 1200, limit: BODY_SIZE_LIMIT },
    wallMs: 4321,
    verdict: "changes",
    notes: [],
    ...overrides,
  };
}

describe("renderTable", () => {
  it("includes every AC-16 field", () => {
    const text = renderTable(sampleScorecard());
    expect(text).toContain("acme/widgets#42");
    expect(text).toContain("Changed files");
    expect(text).toContain("Strata");
    expect(text).toContain("Pattern groups");
    expect(text).toContain("Packages (Layer 2)");
    expect(text).toContain("Model calls");
    expect(text).toContain("Findings");
    expect(text).toContain("Coverage");
    expect(text).toContain("Marker bytes");
    expect(text).toContain("65000");
    expect(text).toContain("Wall time");
    expect(text).toContain("Verdict");
  });

  it("appends a Notes section only when notes are present", () => {
    expect(renderTable(sampleScorecard())).not.toContain("Notes:");
    const withNotes = renderTable(sampleScorecard({ notes: ["a caveat"] }));
    expect(withNotes).toContain("Notes:");
    expect(withNotes).toContain("a caveat");
  });
});

describe("renderJson", () => {
  it("round-trips through JSON.parse", () => {
    const sc = sampleScorecard();
    const parsed: unknown = JSON.parse(renderJson(sc));
    expect(parsed).toEqual(sc);
  });
});
