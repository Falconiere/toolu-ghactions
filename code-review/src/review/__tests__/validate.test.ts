import { describe, it, expect, vi } from "vitest";
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
    const { findings: kept } = validateFindings(findings, changed, "high");
    expect(kept).toHaveLength(1);
    expect(kept[0]?.text).toBe("real line");
  });

  it("keeps blocker/high findings regardless of confidence", () => {
    const findings: Finding[] = [
      { path: "src/a.ts", line: 10, severity: "blocker", text: "blocker no conf" },
      { path: "src/a.ts", line: 11, severity: "high", text: "high low conf", confidence: "medium" },
    ];
    const { findings: kept } = validateFindings(findings, changed, "high");
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
    expect(validateFindings(findings, changed, "high").findings).toHaveLength(0);
    // ...but kept when the floor is lowered to medium.
    expect(validateFindings(findings, changed, "medium").findings).toHaveLength(1);
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
    const { findings: kept } = validateFindings(findings, changed, "high");
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
    const { findings: kept } = validateFindings(findings, changed, "high");
    expect(kept[0]?.suggestion).toBe("safe patch");
  });

  it("dedups duplicate findings keeping the max severity", () => {
    const findings: Finding[] = [
      { path: "src/b.ts", line: 5, severity: "low", text: "Same Bug, here!!!", confidence: "high" },
      // Same path/line/normalized-text → duplicate; higher severity must win.
      { path: "src/b.ts", line: 5, severity: "blocker", text: "same bug here", confidence: "high" },
    ];
    const { findings: kept } = validateFindings(findings, changed, "high");
    expect(kept).toHaveLength(1);
    expect(kept[0]?.severity).toBe("blocker");
  });

  // Quote-anchored gate: a finding's quoted_line must match the real new-file
  // text at the cited line. Models misread the diff and quote a removed (`L---:`)
  // line as if still present (the action.yml `default:` removal bug).
  const lineText = new Map<string, Map<number, string>>([
    [
      "src/a.ts",
      new Map([
        [10, "    description: 'DEPRECATED: No-op. Kept for backward compatibility.'"],
        [11, "    required: false"],
      ]),
    ],
  ]);

  it("drops an LLM finding whose quoted_line does not match the cited new-file line", () => {
    const findings: Finding[] = [
      {
        path: "src/a.ts",
        line: 10,
        severity: "medium",
        confidence: "high",
        // Quotes a line that the diff REMOVED — absent from the new file.
        quoted_line: "    default: 'conservative'",
        text: "MERGE_STRATEGY still has a default value defined.",
      },
    ];
    expect(validateFindings(findings, changed, "high", lineText).findings).toHaveLength(0);
  });

  it("keeps an LLM finding whose quoted_line matches the cited line (substring tolerated)", () => {
    const findings: Finding[] = [
      {
        path: "src/a.ts",
        line: 10,
        severity: "medium",
        confidence: "high",
        quoted_line: "description: 'DEPRECATED: No-op.",
        text: "Real issue on the actual new line.",
      },
    ];
    expect(validateFindings(findings, changed, "high", lineText).findings).toHaveLength(1);
  });

  it("skips the quote check when no line text is supplied (backward compatible)", () => {
    const findings: Finding[] = [
      {
        path: "src/a.ts",
        line: 10,
        severity: "medium",
        confidence: "high",
        quoted_line: "    default: 'conservative'",
        text: "No line text → cannot verify, keep.",
      },
    ];
    expect(validateFindings(findings, changed, "high").findings).toHaveLength(1);
  });

  it("drops an LLM finding that quotes non-empty text on a blank cited line", () => {
    const blank = new Map<string, Map<number, string>>([["src/a.ts", new Map([[12, "   "]])]]);
    const findings: Finding[] = [
      {
        path: "src/a.ts",
        line: 12,
        severity: "medium",
        confidence: "high",
        quoted_line: "const secret = 'oops'",
        text: "Hallucinated quote on an empty line.",
      },
    ];
    expect(validateFindings(findings, changed, "high", blank).findings).toHaveLength(0);
  });

  it("exempts mechanical-scanner findings from the quote check", () => {
    const findings: Finding[] = [
      {
        path: "src/a.ts",
        line: 10,
        severity: "high",
        confidence: "high",
        source: "gitleaks",
        quoted_line: "anything that does not match",
        text: "Secret detected.",
      },
    ];
    expect(validateFindings(findings, changed, "high", lineText).findings).toHaveLength(1);
  });

  // ── Self-negation (AC-2, rev-5 rule) ──────────────────────────────────────
  // The verbatim actacanvas PR #6 junk texts, plus a negation-first variant, must
  // be dropped; adversarial near-misses and concede-then-accuse findings survive.
  // Every case is anchored to src/a.ts:10 (a real changed line) and high
  // confidence/severity, so ONLY the self-negation filter can be what drops it.
  function junkFinding(text: string): Finding {
    return { path: "src/a.ts", line: 10, severity: "high", confidence: "high", text };
  }

  const DROP_TEXTS = [
    "The comment is accurate. No issue.",
    "No issue.",
    "This is acceptable. No violation.",
    "Not a real issue.",
    // Negation-first: the any-sentence rule must catch it even before the excuse.
    "No issue. The comment is accurate.",
  ];

  it.each(DROP_TEXTS)("drops the verbatim PR #6 junk finding: %j", (text) => {
    const { findings: kept, selfNegating } = validateFindings([junkFinding(text)], changed, "high");
    expect(kept).toHaveLength(0);
    expect(selfNegating).toBe(1);
  });

  it("keeps a real finding whose sentence merely CONTAINS a negation phrase, not IS one", () => {
    const findings: Finding[] = [
      junkFinding("The retry never fires, so the timeout does not work as intended."),
      junkFinding("Clamping to 0 here is not acceptable for negative counts."),
    ];
    const { findings: kept, selfNegating } = validateFindings(findings, changed, "high");
    expect(kept.map((f) => f.text)).toEqual(findings.map((f) => f.text));
    expect(selfNegating).toBe(0);
  });

  it("keeps a concede-then-accuse finding: 'fine'/'acceptable' only self-negate in FINAL position", () => {
    const findings: Finding[] = [
      junkFinding("This is fine. The real bug is the missing await on line 12."),
    ];
    const { findings: kept, selfNegating } = validateFindings(findings, changed, "high");
    expect(kept).toHaveLength(1);
    expect(selfNegating).toBe(0);
  });

  it("still drops when the negation-phrase sentence is not the first one", () => {
    // Any-sentence matching: the excuse can lead OR follow the negation.
    const { findings: kept, selfNegating } = validateFindings(
      [junkFinding("Looked at this closely. No violation.")],
      changed,
      "high",
    );
    expect(kept).toHaveLength(0);
    expect(selfNegating).toBe(1);
  });

  it("logs the drop count once, matching the pipeline's 'Dropped N …' convention", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    validateFindings([junkFinding("No issue."), junkFinding("No violation.")], changed, "high");
    expect(write).toHaveBeenCalledWith("  Dropped 2 self-negating finding(s)\n");
    write.mockRestore();
  });
});
