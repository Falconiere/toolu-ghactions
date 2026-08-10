// selfNegating.test.ts — direct unit coverage for the no-defect sentence rule,
// on VERBATIM reviewer output. The end-to-end drops live in validate.test.ts;
// these pin the two edges reviews of this very PR surfaced: a finding concluding
// "no defect" (the pattern the original list missed — caught by the bot's own
// self-negating finding on this file), and the degenerate wrapper case.
import { describe, expect, it } from "vitest";
import { isSelfNegating } from "@/review/selfNegating.js";

describe("isSelfNegating — verbatim reviewer texts", () => {
  it("drops the bot's own self-negating finding on this module (ends 'no defect')", () => {
    // Verbatim from the PR #102 dogfood review of selfNegating.ts:90.
    expect(isSelfNegating("The logic is sound; no defect.")).toBe(false); // semicolon: one sentence, not a standalone conclusion
    expect(isSelfNegating("The logic is sound. No defect.")).toBe(true);
    expect(isSelfNegating("No defect.")).toBe(true);
    expect(isSelfNegating("No defects found.")).toBe(true);
  });

  it("keeps concede-then-accuse and does-not-work-as-intended findings", () => {
    expect(isSelfNegating("This is fine. The real bug is the missing await on line 12.")).toBe(
      false,
    );
    expect(isSelfNegating("The retry never fires, so the timeout does not work as intended.")).toBe(
      false,
    );
  });

  it("unwraps bold wrappers, including the degenerate empty body", () => {
    expect(isSelfNegating("**No issue.**")).toBe(true);
    expect(isSelfNegating("**X**")).toBe(false);
    expect(isSelfNegating("****")).toBe(false);
  });
});
