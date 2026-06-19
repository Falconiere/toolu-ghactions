import { describe, expect, it } from "vitest";
import { Verdict } from "@/llm/schema.js";

describe("Verdict schema", () => {
  it("parses a valid verdict with findings", () => {
    const valid = {
      review_plan: "Reviewed 1 file.",
      verdict: "changes",
      findings: [
        {
          path: "src/util.ts",
          line: 3,
          end_line: 5,
          severity: "high",
          category: "correctness",
          confidence: "high",
          quoted_line: "return a - b;",
          suggestion: "return a + b;",
          text: "add() subtracts.",
        },
      ],
      other_checks: "",
      top_must_fix: ["Fix add()"],
    };
    const parsed = Verdict.parse(valid);
    expect(parsed.verdict).toBe("changes");
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]?.severity).toBe("high");
  });

  it("parses a minimal valid verdict (only required finding fields)", () => {
    const minimal = {
      review_plan: "",
      verdict: "approved",
      findings: [{ path: "a.ts", line: 1, severity: "nit", text: "style" }],
      other_checks: "",
      top_must_fix: [],
    };
    expect(() => Verdict.parse(minimal)).not.toThrow();
  });

  it("rejects an invalid severity", () => {
    const badSeverity = {
      review_plan: "",
      verdict: "changes",
      findings: [{ path: "a.ts", line: 1, severity: "critical", text: "x" }],
      other_checks: "",
      top_must_fix: [],
    };
    expect(Verdict.safeParse(badSeverity).success).toBe(false);
  });

  it("rejects an invalid top-level verdict value", () => {
    const badVerdict = {
      review_plan: "",
      verdict: "error",
      findings: [],
      other_checks: "",
      top_must_fix: [],
    };
    expect(Verdict.safeParse(badVerdict).success).toBe(false);
  });

  it("rejects a finding missing a required field (text)", () => {
    const missingText = {
      review_plan: "",
      verdict: "changes",
      findings: [{ path: "a.ts", line: 1, severity: "low" }],
      other_checks: "",
      top_must_fix: [],
    };
    expect(Verdict.safeParse(missingText).success).toBe(false);
  });

  it("rejects a verdict missing a required top-level key", () => {
    const missingOtherChecks = {
      review_plan: "",
      verdict: "approved",
      findings: [],
      top_must_fix: [],
    };
    expect(Verdict.safeParse(missingOtherChecks).success).toBe(false);
  });
});
