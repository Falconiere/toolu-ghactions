// gate.test.ts — real-data unit tests for the FAIL_ON merge-gate policy. Inputs
// are real CSV strings; core.warning is spied (a platform double, not mock data)
// to assert the dropped-token diagnostic without writing to the run log.
import { describe, it, expect, vi, afterEach } from "vitest";
import * as core from "@actions/core";
import { applyRoundCap, parseFailOn, shouldBlock } from "../gate.js";

/** parseFailOn result as a sorted array for order-independent comparison. */
function parsed(raw: string): string[] {
  return [...parseFailOn(raw)].sort();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseFailOn", () => {
  it("AC-1: 'none', empty, and whitespace → gate off (empty set), no warning", () => {
    const warn = vi.spyOn(core, "warning").mockImplementation(() => "");
    expect(parsed("none")).toEqual([]);
    expect(parsed("")).toEqual([]);
    expect(parsed("   ")).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("AC-2: blockable tokens, single and combined, whitespace-tolerant", () => {
    vi.spyOn(core, "warning").mockImplementation(() => "");
    expect(parsed("changes")).toEqual(["changes"]);
    expect(parsed("changes,error")).toEqual(["changes", "error"]);
    expect(parsed("error, changes")).toEqual(["changes", "error"]);
  });

  it("AC-3: case-insensitive", () => {
    vi.spyOn(core, "warning").mockImplementation(() => "");
    expect(parsed("CHANGES")).toEqual(["changes"]);
    expect(parsed("Changes,ERROR")).toEqual(["changes", "error"]);
  });

  it("AC-4: unrecognized tokens dropped with exactly one warning per call", () => {
    const warn = vi.spyOn(core, "warning").mockImplementation(() => "");
    expect(parsed("changes,bogus")).toEqual(["changes"]);
    expect(warn).toHaveBeenCalledTimes(1);

    warn.mockClear();
    expect(parsed("approved")).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);

    warn.mockClear();
    expect(parsed("skip")).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("AC-5: 'none' combined with a blockable token → just the blockable one, no warning", () => {
    const warn = vi.spyOn(core, "warning").mockImplementation(() => "");
    expect(parsed("none,changes")).toEqual(["changes"]);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("shouldBlock", () => {
  it("AC-6: blocks iff the resolved verdict is in the fail-on set", () => {
    vi.spyOn(core, "warning").mockImplementation(() => "");
    const onChanges = parseFailOn("changes");
    const onBoth = parseFailOn("changes,error");
    const off = parseFailOn("none");

    expect(shouldBlock("changes", onChanges)).toBe(true);
    expect(shouldBlock("error", onChanges)).toBe(false);
    expect(shouldBlock("error", onBoth)).toBe(true);
    expect(shouldBlock("approved", onChanges)).toBe(false);
    expect(shouldBlock("skip", onChanges)).toBe(false);
    expect(shouldBlock("changes", off)).toBe(false);
  });
});

describe("applyRoundCap", () => {
  const findings = [{ severity: "medium" }, { severity: "low" }];

  it("caps a changes verdict at the round limit when no blocker remains", () => {
    const d = applyRoundCap({ verdict: "changes", findings, priorRounds: 4, maxRounds: 5 });
    expect(d).toEqual({ verdict: "approved", capped: true });
  });

  it("caps past the limit too (round N+1 and later)", () => {
    const d = applyRoundCap({ verdict: "changes", findings, priorRounds: 9, maxRounds: 5 });
    expect(d.capped).toBe(true);
  });

  it("does not cap below the round limit", () => {
    const d = applyRoundCap({ verdict: "changes", findings, priorRounds: 3, maxRounds: 5 });
    expect(d).toEqual({ verdict: "changes", capped: false });
  });

  it("maxRounds 0 disables the cap entirely", () => {
    const d = applyRoundCap({ verdict: "changes", findings, priorRounds: 99, maxRounds: 0 });
    expect(d).toEqual({ verdict: "changes", capped: false });
  });

  it("a blocker finding keeps the changes verdict no matter the round", () => {
    const withBlocker = [...findings, { severity: "blocker" }];
    const d = applyRoundCap({
      verdict: "changes",
      findings: withBlocker,
      priorRounds: 9,
      maxRounds: 5,
    });
    expect(d).toEqual({ verdict: "changes", capped: false });
  });

  it("never touches non-changes verdicts", () => {
    for (const verdict of ["approved", "skip", "error"] as const) {
      const d = applyRoundCap({ verdict, findings, priorRounds: 9, maxRounds: 5 });
      expect(d).toEqual({ verdict, capped: false });
    }
  });
});
