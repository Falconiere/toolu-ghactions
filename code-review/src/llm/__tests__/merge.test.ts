import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { reviewWithModel } from "@/llm/reviewWithModel.js";
import type { ProviderResult } from "@/llm/reviewWithModel.js";
import { mergeResults } from "@/llm/merge.js";
import { MAX_TOKEN_CEILING } from "@/llm/budget.js";
import { reviewChunked } from "@/review/chunked.js";
import type { DiffData } from "@/git/diff.js";
import type { Envelope } from "@/prompt.js";
import { replayCompletion } from "@/__tests__/integration/sse.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** A fetch that replays one recorded OpenRouter body — no network, no code mocks. The
 *  review call streams, so the recorded content is re-served as SSE chunk frames. */
function replayFetch(name: string): typeof fetch {
  const body: unknown = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));
  return async (_url, init) => replayCompletion(body, init);
}

const ENVELOPE: Envelope = {
  system: "You are a code reviewer.",
  user: "Review the following pull request diff.",
  max_tokens: 4096,
  enforce_json_schema: true,
};

/** Build a REAL ProviderResult by replaying a recorded response through the model layer. */
async function resultFrom(fixture: string): Promise<ProviderResult> {
  return reviewWithModel(ENVELOPE, {
    model: "deepseek/deepseek-v4-flash",
    apiKey: "sk-test",
    fetch: replayFetch(fixture),
    maxRetries: 0,
  });
}

/** A REAL salvaged partial: the recorded truncation replayed at `maxTokens`. At the
 *  ceiling the budget cannot grow, so the loop salvages on the first call; below it the
 *  ladder escalates first and salvages once its four doublings are spent. */
async function truncatedAt(maxTokens: number): Promise<ProviderResult> {
  return reviewWithModel(
    { ...ENVELOPE, max_tokens: maxTokens },
    {
      model: "deepseek/deepseek-v4-flash",
      apiKey: "sk-test",
      fetch: replayFetch("truncated-findings"),
      maxRetries: 0,
      maxAttempts: 1,
    },
  );
}

/** The un-chunked fast path (chunked.ts): a within-budget diff is ONE call whose result is
 *  returned as-is — mergeResults never runs, so the wording has to be right at the source.
 *  Only `changed_files` is read on this path; the rest is an empty, well-formed DiffData. */
async function unchunked(result: ProviderResult): Promise<ProviderResult> {
  const diff: DiffData = {
    diff: "",
    files: [],
    changed_files: ["src/auth.ts"],
    binary_files: [],
    dropped_files: [],
    renames: [],
    total_lines: 0,
    total_files: 1,
    truncated: false,
    base_sha: "0000000",
  };
  return reviewChunked({
    diff,
    maxChunkLines: 0, // chunking disabled → the fast path
    maxChunks: 0,
    mechanical: [],
    brief: null,
    buildEnvelope: () => ENVELOPE,
    review: async () => result,
    onCoverage: () => {},
  });
}

describe("mergeResults", () => {
  it("returns a changes verdict when any chunk requests changes", async () => {
    const merged = mergeResults([[await resultFrom("approved")], [await resultFrom("findings")]]);
    expect(merged.verdict).toBe("changes");
    expect(merged.error).toBeUndefined();
  });

  it("returns approved only when every non-error chunk approves", async () => {
    const merged = mergeResults([[await resultFrom("approved")], [await resultFrom("approved")]]);
    expect(merged.verdict).toBe("approved");
  });

  it("concatenates findings in input (chunk) order", async () => {
    const findings = await resultFrom("findings"); // 1 finding
    const approved = await resultFrom("approved"); // 0 findings
    const merged = mergeResults([[findings], [approved], [findings]]);
    expect(merged.findings.length).toBe(findings.findings.length * 2);
    expect(merged.findings[0]).toEqual(findings.findings[0]);
  });

  it("unions and caps top_must_fix across chunks", async () => {
    const a = await resultFrom("approved"); // top_must_fix: 1 entry
    const b = await resultFrom("findings"); // top_must_fix: 1 different entry
    const merged = mergeResults([[a], [b], [a]]); // duplicate `a` must not double-count
    const expected = new Set([...(a.top_must_fix ?? []), ...(b.top_must_fix ?? [])]);
    expect(new Set(merged.top_must_fix)).toEqual(expected);
    expect((merged.top_must_fix ?? []).length).toBe(expected.size);
  });

  it("keeps successes and records the failure when a chunk errors (partial degrade)", async () => {
    const good = await resultFrom("findings");
    const bad = await resultFrom("empty-content"); // verdict:"error"
    expect(bad.verdict).toBe("error");

    const merged = mergeResults([[good], [bad]]);
    // Surviving verdict, not abstained.
    expect(merged.verdict).toBe("changes");
    expect(merged.findings).toEqual(good.findings);
    expect(merged.error).toContain("1/2 chunks failed");
  });

  it("never emits a confident approval over unreviewed files: approved + error → error", async () => {
    const good = await resultFrom("approved");
    const bad = await resultFrom("empty-content"); // verdict:"error"

    const merged = mergeResults([[good], [bad]]);
    // The surviving chunks approved, but a chunk's files went unreviewed — the merged
    // verdict must be inconclusive (error → "review incomplete", request-changes label).
    expect(merged.verdict).toBe("error");
    expect(merged.partial).toBe(true);
    expect(merged.error).toContain("1/2 chunks failed");
  });

  it("stays error only when every chunk errored", async () => {
    const merged = mergeResults([
      [await resultFrom("empty-content")],
      [await resultFrom("empty-content")],
    ]);
    expect(merged.verdict).toBe("error");
    expect(merged.error).toContain("2/2 chunks failed");
  });

  // Leaf-results contract (spec §Layer 2): a chunk that bisected on a schema failure
  // hands its LEAF results to the merge, never the failed parent.
  it("does not count a chunk fully covered by its bisection leaves as failed", async () => {
    const whole = await resultFrom("approved");
    const leafA = await resultFrom("approved");
    const leafB = await resultFrom("approved");

    // Chunk 2 needed two calls to cover it — every file was still reviewed.
    const merged = mergeResults([[whole], [leafA, leafB]]);

    expect(merged.verdict).toBe("approved");
    expect(merged.error).toBeUndefined();
    expect(merged.partial).toBeUndefined();
  });

  it("counts a chunk with a failed leaf as ONE failed chunk (its leaf's files went unreviewed)", async () => {
    const whole = await resultFrom("approved");
    const leafOk = await resultFrom("findings");
    const leafBad = await resultFrom("empty-content"); // verdict:"error"

    const merged = mergeResults([[whole], [leafOk, leafBad]]);

    // The good leaf's findings survive; the chunk still counts as failed once (not
    // twice, and not zero times) — 1 of the 2 chunks, not 1 of the 3 results.
    expect(merged.findings).toEqual(leafOk.findings);
    expect(merged.verdict).toBe("changes");
    expect(merged.partial).toBe(true);
    expect(merged.error).toContain("1/2 chunks failed");
  });

  it("skips chunks nothing covered (wall-clock pending) instead of counting them", async () => {
    const merged = mergeResults([[await resultFrom("approved")], []]);
    expect(merged.verdict).toBe("approved");
    expect(merged.error).toBeUndefined();
  });

  it("returns a defensive error result for an empty input", () => {
    const merged = mergeResults([]);
    expect(merged.verdict).toBe("error");
    expect(merged.findings).toEqual([]);
    expect(merged.error).toBeTruthy();
  });

  it("caps the merged review_plan (280) and other_checks (1000) with a … marker", async () => {
    // Each chunk's fields are already within the per-chunk schema caps, but joining one
    // per chunk with blank-line separators overruns the merged caps — the exact chunked
    // verbosity this bounds. Three copies push both fields past their ceilings.
    const chunk = await resultFrom("verbose");
    expect((chunk.review_plan ?? "").length).toBeLessThanOrEqual(280);
    expect((chunk.other_checks ?? "").length).toBeLessThanOrEqual(600);

    const merged = mergeResults([[chunk], [chunk], [chunk]]);

    // review_plan clipped to 280 chars + the marker; the first 280 are verbatim.
    expect(merged.review_plan).toHaveLength(281);
    expect(merged.review_plan?.endsWith("…")).toBe(true);
    const joinedPlan = [chunk.review_plan, chunk.review_plan, chunk.review_plan].join("\n\n");
    expect(merged.review_plan).toBe(`${joinedPlan.slice(0, 280)}…`);

    // other_checks clipped to 1000 chars + the marker.
    expect(merged.other_checks).toHaveLength(1001);
    expect(merged.other_checks?.endsWith("…")).toBe(true);
  });

  it("leaves within-budget merged narrative fields unclipped (no spurious marker)", async () => {
    // A single chunk under both caps must pass through untouched — no … appended.
    const merged = mergeResults([[await resultFrom("verbose")]]);
    expect(merged.review_plan?.endsWith("…")).toBe(false);
    expect(merged.other_checks?.endsWith("…")).toBe(false);
  });
});

// The PR #6 failure this fixes: the banner told the reader to raise a MAX_TOKENS that was
// already at its ceiling, because merge.ts RECOMPOSED the sentence instead of reusing the
// one composed where the budget state was known. The merged banner now contributes only a
// neutral count prefix, so whatever the chunk actually suffered rides through verbatim —
// and the un-chunked path, which never reaches merge at all, says the same thing because
// the per-chunk message was right to begin with.
describe("truncation wording is single-sourced (AC-6)", () => {
  it("renders the ceiling advice for an exhausted budget, merged AND un-chunked", async () => {
    const partial = await truncatedAt(MAX_TOKEN_CEILING);
    expect(partial.budgetExhausted).toBe(true);
    expect(partial.error).toContain("lower MAX_CHUNK_LINES");

    const merged = mergeResults([[partial], [await resultFrom("approved")]]);
    expect(merged.error).toBe(`1/2 chunks were cut short — ${partial.error ?? ""}`);
    expect(merged.error).toContain("lower MAX_CHUNK_LINES");
    expect(merged.error).not.toContain("Raise MAX_TOKENS");
    expect(merged.budgetExhausted).toBe(true);
    expect(merged.partial).toBe(true);
    expect(merged.finishReason).toBe("length");

    // Same words on the path that bypasses the merge entirely.
    const whole = await unchunked(partial);
    expect(whole.error).toBe(partial.error);
    expect(whole.error).toContain("lower MAX_CHUNK_LINES");
  }, 20_000);

  it("renders the raise-MAX_TOKENS advice while headroom remains, merged AND un-chunked", async () => {
    // 4096 doubles four times to 65536 — under the ceiling, so a bigger MAX_TOKENS is
    // still the reader's move and the ceiling is named so they know how far it goes.
    const partial = await truncatedAt(4096);
    expect(partial.budgetExhausted).toBeUndefined();

    const merged = mergeResults([[partial], [await resultFrom("approved")]]);
    expect(merged.error).toBe(`1/2 chunks were cut short — ${partial.error ?? ""}`);
    expect(merged.error).toContain("Raise MAX_TOKENS");
    expect(merged.error).toContain(String(MAX_TOKEN_CEILING));
    expect(merged.error).not.toContain("lower MAX_CHUNK_LINES");
    expect(merged.budgetExhausted).toBeUndefined();

    const whole = await unchunked(partial);
    expect(whole.error).toBe(partial.error);
    expect(whole.error).toContain("Raise MAX_TOKENS");
  }, 20_000);

  it("keeps the dropped-findings recovery wording distinct from any truncation wording", async () => {
    // A complete response with off-schema findings loses data too, but nothing about it is
    // a budget problem — advising a budget change there is advice that cannot help.
    const dropped = await resultFrom("deepseek-schema-mismatch");
    expect(dropped.partial).toBe(true);
    expect(dropped.error).toContain("did not match the required shape");
    expect(dropped.error).not.toContain("MAX_TOKENS");
    expect(dropped.error).not.toContain("MAX_CHUNK_LINES");
    expect(dropped.error).not.toContain("truncated");
    expect(dropped.budgetExhausted).toBeUndefined();

    // And it reaches the reader intact through the merged banner.
    const merged = mergeResults([[dropped], [await resultFrom("approved")]]);
    expect(merged.error).toBe(`1/2 chunks were cut short — ${dropped.error ?? ""}`);
    expect(merged.error).not.toContain("MAX_TOKENS");
  }, 20_000);
});
