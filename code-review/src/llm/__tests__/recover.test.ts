// recover.test.ts — direct unit coverage for the salvage primitives that the
// deadline/streamVerdict suites only exercise end-to-end through reviewWithModel:
// bestPrefix's tie rule, salvageResult's message/flag composition, and abstain's
// finishReason propagation. Finding shapes mirror the recorded review fixtures.
import { describe, expect, it } from "vitest";
import { NoObjectGeneratedError } from "ai";
import { abstain, bestPrefix, salvageResult, type Prefix } from "@/llm/recover.js";
import type { Finding } from "@/llm/schema.js";

const finding = (path: string): Finding => ({
  path,
  line: 12,
  severity: "medium",
  text: "The retry never fires, so the timeout does not work as intended.",
});

const one: Prefix = { findings: [finding("src/auth.ts")], review_plan: "Reviewing the diff." };
const two: Prefix = { findings: [finding("src/auth.ts"), finding("src/db.ts")] };

describe("bestPrefix — retained across attempts and escalations", () => {
  it("adopts the candidate when nothing is retained yet", () => {
    expect(bestPrefix(undefined, one)).toBe(one);
  });

  it("prefers more completed findings", () => {
    expect(bestPrefix(one, two)).toBe(two);
    expect(bestPrefix(two, one)).toBe(two);
  });

  it("keeps the already-retained prefix on a tie, so a retry never loses ground", () => {
    const rival: Prefix = { findings: [finding("src/other.ts")] };
    expect(bestPrefix(one, rival)).toBe(one);
  });
});

describe("salvageResult — the cut → ProviderResult composition", () => {
  it("length cut with headroom: changes + partial + finishReason, advice = raise MAX_TOKENS", () => {
    const r = salvageResult(one, { reason: "length", exhausted: false });
    expect(r.verdict).toBe("changes");
    expect(r.partial).toBe(true);
    expect(r.finishReason).toBe("length");
    expect(r.budgetExhausted).toBeUndefined();
    expect(r.error).toContain("Raise MAX_TOKENS");
  });

  it("length cut at the ceiling: budgetExhausted, advice = lower MAX_CHUNK_LINES", () => {
    const r = salvageResult(two, { reason: "length", exhausted: true });
    expect(r.budgetExhausted).toBe(true);
    expect(r.error).toContain("lower MAX_CHUNK_LINES");
    expect(r.error).not.toContain("Raise MAX_TOKENS");
  });

  it("deadline cut: no finishReason claimed, deadline-specific wording", () => {
    const r = salvageResult(one, { reason: "deadline" });
    expect(r.finishReason).toBeUndefined();
    expect(r.error).toContain("deadline");
    expect(r.verdict).toBe("changes");
  });
});

describe("abstain — the verdict:error terminal", () => {
  it("carries the SDK's finishReason and classifies our own abort as timeout", () => {
    const err = new NoObjectGeneratedError({
      message: "no object",
      text: "",
      finishReason: "length",
      response: { id: "gen-test", timestamp: new Date(0), modelId: "deepseek/deepseek-v4-flash" },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });
    const timedOut = abstain(err, true);
    expect(timedOut.verdict).toBe("error");
    expect(timedOut.failure).toBe("timeout");
    const schema = abstain(err, false);
    expect(schema.failure).toBe("schema");
    expect(schema.finishReason).toBe("length");
    const transport = abstain(new Error("socket hang up"), false);
    expect(transport.failure).toBe("transport");
    expect(transport.findings).toEqual([]);
  });
});
