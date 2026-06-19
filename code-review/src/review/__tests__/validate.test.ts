import { describe, it, expect } from "vitest";
import { validateFindings } from "@/review/validate.js";
import type { Finding } from "@/llm/schema.js";

// Real diff coordinates: src/a.ts changed lines 10..14, src/b.ts changed lines 5,6.
const changed = new Map<string, number[]>([
  ["src/a.ts", [10, 11, 12, 13, 14]],
  ["src/b.ts", [5, 6]],
]);

describe("validateFindings", () => {
  it("drops a finding on a line not in changed_lines (anti-hallucination)", () => {
    const findings: Finding[] = [
      { path: "src/a.ts", line: 99, severity: "high", text: "phantom line", confidence: "high" },
      { path: "src/a.ts", line: 10, severity: "high", text: "real line", confidence: "high" },
    ];
    const kept = validateFindings(findings, changed, "high");
    expect(kept).toHaveLength(1);
    expect(kept[0]?.text).toBe("real line");
  });

  it("keeps blocker/high findings regardless of confidence", () => {
    const findings: Finding[] = [
      { path: "src/a.ts", line: 10, severity: "blocker", text: "blocker no conf" },
      { path: "src/a.ts", line: 11, severity: "high", text: "high low conf", confidence: "medium" },
    ];
    const kept = validateFindings(findings, changed, "high");
    expect(kept.map((f) => f.text)).toEqual(["blocker no conf", "high low conf"]);
  });

  it("drops a medium-confidence low-severity finding under minConfidence=high", () => {
    const findings: Finding[] = [
      {
        path: "src/a.ts",
        line: 10,
        severity: "low",
        text: "med conf low sev",
        confidence: "medium",
      },
    ];
    expect(validateFindings(findings, changed, "high")).toHaveLength(0);
    // ...but kept when the floor is lowered to medium.
    expect(validateFindings(findings, changed, "medium")).toHaveLength(1);
  });

  it("strips a suggestion whose span runs outside the diff, keeping the finding", () => {
    const findings: Finding[] = [
      // line 13 is in the diff, but end_line 15 is NOT → span not fully in diff.
      {
        path: "src/a.ts",
        line: 13,
        end_line: 15,
        severity: "high",
        text: "spans out of diff",
        confidence: "high",
        suggestion: "do not apply me",
      },
    ];
    const kept = validateFindings(findings, changed, "high");
    expect(kept).toHaveLength(1);
    expect(kept[0]?.suggestion).toBeUndefined();
    expect(kept[0]?.text).toBe("spans out of diff");
  });

  it("keeps a suggestion when high-confidence and the whole span is in the diff", () => {
    const findings: Finding[] = [
      {
        path: "src/a.ts",
        line: 10,
        end_line: 12,
        severity: "high",
        text: "in span",
        confidence: "high",
        suggestion: "safe patch",
      },
    ];
    const kept = validateFindings(findings, changed, "high");
    expect(kept[0]?.suggestion).toBe("safe patch");
  });

  it("dedups duplicate findings keeping the max severity", () => {
    const findings: Finding[] = [
      { path: "src/b.ts", line: 5, severity: "low", text: "Same Bug, here!!!", confidence: "high" },
      // Same path/line/normalized-text → duplicate; higher severity must win.
      { path: "src/b.ts", line: 5, severity: "blocker", text: "same bug here", confidence: "high" },
    ];
    const kept = validateFindings(findings, changed, "high");
    expect(kept).toHaveLength(1);
    expect(kept[0]?.severity).toBe("blocker");
  });
});
