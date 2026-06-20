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

  it("rejects a verdict missing a required top-level key (verdict)", () => {
    const missingVerdict = {
      review_plan: "",
      findings: [],
      other_checks: "",
      top_must_fix: [],
    };
    expect(Verdict.safeParse(missingVerdict).success).toBe(false);
  });

  // other_checks / top_must_fix are emitted AFTER findings, so a length-truncated
  // response often lacks them. They default so a repaired/partial object still
  // validates and the findings completed before the cut survive.
  it("defaults other_checks and top_must_fix when absent (truncation resilience)", () => {
    const truncatedAfterFindings = {
      review_plan: "plan",
      verdict: "changes",
      findings: [],
    };
    const parsed = Verdict.safeParse(truncatedAfterFindings);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.other_checks).toBe("");
      expect(parsed.data.top_must_fix).toEqual([]);
    }
  });

  // The provider does not enforce the schema's maxLength during JSON-mode decoding, so
  // a complete, valid review can come back with a >280-char plan. The .catch backstop
  // must TRUNCATE it to 280 rather than fail validation, which would otherwise throw
  // the entire (complete) review away as an abstention.
  it("truncates an over-length review_plan instead of rejecting the whole verdict", () => {
    const longPlan = "x".repeat(400);
    const verbose = {
      review_plan: longPlan,
      verdict: "changes",
      findings: [],
    };
    const parsed = Verdict.safeParse(verbose);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.review_plan).toHaveLength(280);
      expect(parsed.data.review_plan).toBe(longPlan.slice(0, 280));
    }
  });
});
