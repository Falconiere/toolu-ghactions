import { describe, expect, it } from "vitest";
import { Verdict, Finding, normalizeFinding, normalizeVerdict } from "@/llm/schema.js";

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

  // other_checks has the same soft cap as review_plan: the provider does not enforce
  // maxLength in JSON mode, so a valid review can carry a >600-char blurb. The .catch
  // must TRUNCATE it to 600 rather than reject the whole (complete) review.
  it("truncates an over-length other_checks instead of rejecting the whole verdict", () => {
    const longChecks = "y".repeat(900);
    const verbose = {
      review_plan: "plan",
      verdict: "approved",
      findings: [],
      other_checks: longChecks,
    };
    const parsed = Verdict.safeParse(verbose);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.other_checks).toHaveLength(600);
      expect(parsed.data.other_checks).toBe(longChecks.slice(0, 600));
    }
  });
});

describe("normalizeVerdict", () => {
  it("maps the aliases models reach for onto the two enum values", () => {
    expect(normalizeVerdict("approved")).toBe("approved");
    // Case is normalized away, so an all-caps enum value still maps — worth pinning
    // explicitly, since "APPROVED" is a valid verdict the strict schema would reject.
    expect(normalizeVerdict("APPROVED")).toBe("approved");
    expect(normalizeVerdict("Changes")).toBe("changes");
    expect(normalizeVerdict("LGTM")).toBe("approved");
    expect(normalizeVerdict("Approve")).toBe("approved");
    expect(normalizeVerdict("request_changes")).toBe("changes");
    expect(normalizeVerdict("Request-Changes")).toBe("changes");
    expect(normalizeVerdict("changes requested")).toBe("changes");
    expect(normalizeVerdict("reject")).toBe("changes");
  });

  it("returns null for anything it cannot map, rather than guessing a verdict", () => {
    // A guessed verdict is the one thing recovery must never do: "approved" invented
    // here would announce a clean review the model never gave.
    expect(normalizeVerdict("maybe")).toBeNull();
    expect(normalizeVerdict("")).toBeNull();
    expect(normalizeVerdict("!!!")).toBeNull();
    expect(normalizeVerdict(null)).toBeNull();
    expect(normalizeVerdict(undefined)).toBeNull();
    expect(normalizeVerdict(7)).toBeNull();
    expect(normalizeVerdict({ verdict: "approved" })).toBeNull();
  });
});

describe("normalizeFinding", () => {
  it("coerces a quoted line number and an alias severity into a valid Finding", () => {
    const parsed = Finding.safeParse(
      normalizeFinding({
        path: "src/a.ts",
        line: "42",
        end_line: "44",
        severity: "CRITICAL",
        text: "Token compared with ==.",
      }),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.line).toBe(42);
      expect(parsed.data.end_line).toBe(44);
      expect(parsed.data.severity).toBe("blocker");
    }
  });

  it("drops an unrecognized OPTIONAL enum value instead of failing the finding", () => {
    const parsed = Finding.safeParse(
      normalizeFinding({
        path: "src/a.ts",
        line: 1,
        severity: "medium",
        confidence: "low",
        source: "sonarqube",
        text: "Unbounded retry loop.",
      }),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.confidence).toBeUndefined();
      expect(parsed.data.source).toBeUndefined();
    }
  });

  it("leaves a finding invalid when it has no line or no rankable severity", () => {
    // Both are load-bearing — a finding with no line cannot be anchored to the diff, and
    // an unrankable severity cannot be gated on. Normalization must NOT invent either.
    expect(
      Finding.safeParse(normalizeFinding({ path: "src/a.ts", severity: "low", text: "x" })).success,
    ).toBe(false);
    expect(
      Finding.safeParse(
        normalizeFinding({ path: "src/a.ts", line: "not a number", severity: "low", text: "x" }),
      ).success,
    ).toBe(false);
    expect(
      Finding.safeParse(
        normalizeFinding({ path: "src/a.ts", line: 1, severity: "showstopper", text: "x" }),
      ).success,
    ).toBe(false);
  });

  it("preserves a finding that was already valid, byte for byte", () => {
    // The normalizer runs on EVERY recovered finding, so it must be a no-op on good input.
    const good = {
      path: "src/a.ts",
      line: 3,
      end_line: 5,
      severity: "high",
      category: "correctness",
      confidence: "high",
      quoted_line: "return a - b;",
      suggestion: "return a + b;",
      source: "llm",
      text: "add() subtracts.",
    };
    expect(normalizeFinding(good)).toEqual(good);
  });

  it("passes a non-object through unchanged, so Finding produces the rejection", () => {
    expect(normalizeFinding("nope")).toBe("nope");
    expect(normalizeFinding(null)).toBeNull();
    expect(normalizeFinding([1, 2])).toEqual([1, 2]);
  });
});
