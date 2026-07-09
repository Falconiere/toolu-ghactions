import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { reviewWithModel } from "@/llm/reviewWithModel.js";
import type { ProviderResult } from "@/llm/reviewWithModel.js";
import { mergeResults } from "@/llm/merge.js";
import type { Envelope } from "@/prompt.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** A fetch that replays one recorded OpenRouter body — no network, no code mocks. */
function replayFetch(name: string): typeof fetch {
  const body = readFileSync(join(FIXTURES, `${name}.json`), "utf8");
  return async () =>
    new Response(body, { status: 200, headers: { "content-type": "application/json" } });
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

describe("mergeResults", () => {
  it("returns a changes verdict when any chunk requests changes", async () => {
    const merged = mergeResults([await resultFrom("approved"), await resultFrom("findings")]);
    expect(merged.verdict).toBe("changes");
    expect(merged.error).toBeUndefined();
  });

  it("returns approved only when every non-error chunk approves", async () => {
    const merged = mergeResults([await resultFrom("approved"), await resultFrom("approved")]);
    expect(merged.verdict).toBe("approved");
  });

  it("concatenates findings in input (chunk) order", async () => {
    const findings = await resultFrom("findings"); // 1 finding
    const approved = await resultFrom("approved"); // 0 findings
    const merged = mergeResults([findings, approved, findings]);
    expect(merged.findings.length).toBe(findings.findings.length * 2);
    expect(merged.findings[0]).toEqual(findings.findings[0]);
  });

  it("unions and caps top_must_fix across chunks", async () => {
    const a = await resultFrom("approved"); // top_must_fix: 1 entry
    const b = await resultFrom("findings"); // top_must_fix: 1 different entry
    const merged = mergeResults([a, b, a]); // duplicate `a` must not double-count
    const expected = new Set([...(a.top_must_fix ?? []), ...(b.top_must_fix ?? [])]);
    expect(new Set(merged.top_must_fix)).toEqual(expected);
    expect((merged.top_must_fix ?? []).length).toBe(expected.size);
  });

  it("keeps successes and records the failure when a chunk errors (partial degrade)", async () => {
    const good = await resultFrom("findings");
    const bad = await resultFrom("empty-content"); // verdict:"error"
    expect(bad.verdict).toBe("error");

    const merged = mergeResults([good, bad]);
    // Surviving verdict, not abstained.
    expect(merged.verdict).toBe("changes");
    expect(merged.findings).toEqual(good.findings);
    expect(merged.error).toContain("1/2 chunks failed");
  });

  it("never emits a confident approval over unreviewed files: approved + error → error", async () => {
    const good = await resultFrom("approved");
    const bad = await resultFrom("empty-content"); // verdict:"error"

    const merged = mergeResults([good, bad]);
    // The surviving chunks approved, but a chunk's files went unreviewed — the merged
    // verdict must be inconclusive (error → "review incomplete", request-changes label).
    expect(merged.verdict).toBe("error");
    expect(merged.partial).toBe(true);
    expect(merged.error).toContain("1/2 chunks failed");
  });

  it("stays error only when every chunk errored", async () => {
    const merged = mergeResults([
      await resultFrom("empty-content"),
      await resultFrom("empty-content"),
    ]);
    expect(merged.verdict).toBe("error");
    expect(merged.error).toContain("2/2 chunks failed");
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

    const merged = mergeResults([chunk, chunk, chunk]);

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
    const merged = mergeResults([await resultFrom("verbose")]);
    expect(merged.review_plan?.endsWith("…")).toBe(false);
    expect(merged.other_checks?.endsWith("…")).toBe(false);
  });
});
