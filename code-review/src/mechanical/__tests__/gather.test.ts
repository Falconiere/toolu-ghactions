import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gatherMechanical } from "@/mechanical/gather.js";

// The fixtures dir holds the real gitleaks.sarif + opengrep.sarif recorded for sarif.test.ts;
// gatherMechanical treats it exactly like a real TOOLU_SARIF_DIR the composite steps write.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("gatherMechanical", () => {
  it("collects findings from every recognized SARIF in the dir, tagged by tool", () => {
    const findings = gatherMechanical(FIXTURES);
    expect(findings.length).toBe(3); // 2 gitleaks + 1 opengrep
    const tools = findings.map((f) => f.tool).sort();
    expect(tools).toEqual(["gitleaks", "gitleaks", "opengrep"]);
  });

  it("dedupes identical tool+rule+location across files", () => {
    const findings = gatherMechanical(FIXTURES);
    const keys = findings.map((f) => `${f.tool}|${f.ruleId}|${f.path}|${f.line}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("returns [] for undefined / absent dir (no scan ran → review still proceeds)", () => {
    expect(gatherMechanical(undefined)).toEqual([]);
    expect(gatherMechanical("")).toEqual([]);
    expect(gatherMechanical(join(FIXTURES, "nope"))).toEqual([]);
  });
});
