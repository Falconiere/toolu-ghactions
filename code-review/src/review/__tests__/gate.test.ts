// gate.test.ts — real-data unit tests for the FAIL_ON merge-gate policy. Inputs
// are real CSV strings; core.warning is spied (a platform double, not mock data)
// to assert the dropped-token diagnostic without writing to the run log.
import { describe, it, expect, vi, afterEach } from "vitest";
import * as core from "@actions/core";
// @actions/core is native ESM (v3+), whose namespace is frozen, so `vi.spyOn(core, …)`
// below needs this spy-mode mock: every export stays the real implementation, wrapped
// in a spy that vi.spyOn can then redirect. Nothing about the logger is faked.
vi.mock(import("@actions/core"), { spy: true });
import {
  applyRoundCap,
  parseApproveBelow,
  parseFailOn,
  resolveLabelVerdict,
  shouldBlock,
} from "../gate.js";

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

  it("sees a blocker a `low` cluster exemplar would otherwise hide", () => {
    // The contract callers depend on: `findings` must be the cluster's FULL member
    // list, not its representative. Severity is deliberately not part of the cluster
    // key and the exemplar is picked by lowest fingerprint, so the exemplar is
    // routinely the LEAST severe member of its own cluster. pipeline/settle.ts
    // expands via reduce.ts's expandForSeverityGate before calling this.
    const members = applyRoundCap({
      verdict: "changes",
      findings: [{ severity: "low" }, { severity: "blocker" }, { severity: "low" }],
      priorRounds: 9,
      maxRounds: 5,
    });
    expect(members).toEqual({ verdict: "changes", capped: false });

    // The representative-only list this must never be handed again: it approves.
    const exemplarOnly = applyRoundCap({
      verdict: "changes",
      findings: [{ severity: "low" }],
      priorRounds: 9,
      maxRounds: 5,
    });
    expect(exemplarOnly).toEqual({ verdict: "approved", capped: true });
  });

  it("caps past round 10 — the round number is not derived from the capped history", () => {
    // state.ts persists a monotonic `rounds` counter because `history` is capped to
    // the last 10; a round number read off that array stops at 10 and MAX_ROUNDS=12
    // could never fire. The gate itself must stay correct well past 10.
    for (const priorRounds of [11, 12, 40]) {
      const d = applyRoundCap({ verdict: "changes", findings, priorRounds, maxRounds: 12 });
      expect(d).toEqual({ verdict: "approved", capped: true });
    }
  });
});

describe("parseApproveBelow", () => {
  it("AC-5: known severities and aliases normalize onto the five-level scale", () => {
    const warn = vi.spyOn(core, "warning").mockImplementation(() => "");
    expect(parseApproveBelow("high")).toBe("high");
    expect(parseApproveBelow("HIGH")).toBe("high");
    expect(parseApproveBelow("critical")).toBe("blocker");
    expect(parseApproveBelow("warning")).toBe("medium");
    expect(warn).not.toHaveBeenCalled();
  });

  it("AC-5: empty input defaults to 'nit' with no warning", () => {
    const warn = vi.spyOn(core, "warning").mockImplementation(() => "");
    expect(parseApproveBelow("")).toBe("nit");
    expect(parseApproveBelow("   ")).toBe("nit");
    expect(warn).not.toHaveBeenCalled();
  });

  it("AC-5: unrecognized input falls back to 'nit' with exactly one warning", () => {
    const warn = vi.spyOn(core, "warning").mockImplementation(() => "");
    expect(parseApproveBelow("bogus")).toBe("nit");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("resolveLabelVerdict", () => {
  it("AC-1: a 'changes' verdict with only findings strictly below the threshold becomes 'approved'", () => {
    const result = resolveLabelVerdict({
      verdict: "changes",
      findings: [{ severity: "medium" }, { severity: "low" }, { severity: "nit" }],
      approveBelow: "high",
    });
    expect(result).toBe("approved");
  });

  it("AC-2: a 'changes' verdict with a finding at or above the threshold stays 'changes'", () => {
    const result = resolveLabelVerdict({
      verdict: "changes",
      findings: [{ severity: "medium" }, { severity: "high" }],
      approveBelow: "high",
    });
    expect(result).toBe("changes");

    const withBlocker = resolveLabelVerdict({
      verdict: "changes",
      findings: [{ severity: "blocker" }],
      approveBelow: "high",
    });
    expect(withBlocker).toBe("changes");
  });

  it("AC-3: the default threshold ('nit') still blocks on a nit-only finding — unchanged behavior", () => {
    const result = resolveLabelVerdict({
      verdict: "changes",
      findings: [{ severity: "nit" }],
      approveBelow: "nit",
    });
    expect(result).toBe("changes");
  });

  it("AC-4: 'error', 'approved', and 'skip' verdicts pass through unchanged regardless of findings/threshold", () => {
    const findings = [{ severity: "nit" }];
    for (const verdict of ["error", "approved", "skip"] as const) {
      expect(resolveLabelVerdict({ verdict, findings, approveBelow: "blocker" })).toBe(verdict);
    }
  });

  it("a finding with an unranked/missing severity fails closed (treated as blocking)", () => {
    const result = resolveLabelVerdict({
      verdict: "changes",
      findings: [{ severity: "totally-unknown" }],
      approveBelow: "high",
    });
    expect(result).toBe("changes");
  });

  it("ranks every cluster MEMBER, so a `low` exemplar cannot hide a blocker", () => {
    // Same contract applyRoundCap has: callers must expand cluster representatives to
    // their member lists first. Under APPROVE_BELOW=medium a `low` exemplar ranks
    // below the threshold on its own — which is exactly how the chip flipped to
    // merge-approved while a blocker member of the same cluster survived.
    const exemplarOnly = resolveLabelVerdict({
      verdict: "changes",
      findings: [{ severity: "low" }],
      approveBelow: "medium",
    });
    expect(exemplarOnly).toBe("approved");

    const members = resolveLabelVerdict({
      verdict: "changes",
      findings: [{ severity: "low" }, { severity: "blocker" }, { severity: "low" }],
      approveBelow: "medium",
    });
    expect(members).toBe("changes");
  });
});
