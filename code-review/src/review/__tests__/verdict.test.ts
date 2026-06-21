import { describe, it, expect } from "vitest";
import { formatVerdict } from "@/review/verdict.js";
import type { ProviderResult } from "@/llm/reviewWithModel.js";
import type { Finding } from "@/llm/schema.js";
import type { MechanicalFinding } from "@/mechanical/sarif.js";
import { encodeMarker } from "@/state.js";

const MARKER = encodeMarker({
  schema: "toolu-review-state",
  version: 1,
  findings: [{ path: "src/a.ts", line: 10, text: "remembered", category: "c", fp: "x" }],
  history: [
    {
      sha: "abc1234",
      ts: 1700000000,
      verdict: "changes",
      counts: { new: 1, open: 0, resolved: 0, total: 1 },
    },
  ],
});

/** The last non-empty line of a body. */
function lastLine(body: string): string {
  const trimmed = body.replace(/\n+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("\n") + 1);
}

describe("formatVerdict", () => {
  it("maps approved → merge-approved label and ✅ badge", () => {
    const result: ProviderResult = {
      verdict: "approved",
      findings: [],
      review_plan: "Looks good.",
      other_checks: "Ran the checklist.",
      top_must_fix: [],
    };
    const { body, label } = formatVerdict(result, {});
    expect(label).toBe("merge-approved");
    expect(body).toContain("`merge-approved`");
    expect(body).toContain("✅ Approved");
  });

  it("maps error → request-changes label + provider-error badge", () => {
    const result: ProviderResult = {
      verdict: "error",
      findings: [],
      error: "boom",
      finishReason: "length",
    };
    const { body, label } = formatVerdict(result, {});
    // error is the do-not-approve fail-safe: request-changes label, error badge.
    expect(label).toBe("request-changes");
    expect(body).toContain("🚫 Review incomplete — provider error");
    // The real provider-error message + finish_reason are surfaced (not just the badge).
    expect(body).toContain("boom");
    expect(body).toContain("finish_reason: length");
  });

  it("puts the state marker as the last line of the body", () => {
    const result: ProviderResult = {
      verdict: "changes",
      findings: [{ path: "src/a.ts", line: 10, severity: "high", text: "bug", confidence: "high" }],
      review_plan: "",
      other_checks: "",
      top_must_fix: [],
    };
    const { body } = formatVerdict(result, {
      recap: "### Changes since last review\n\n⚠️ New (1)",
      history: "",
      historyMarker: MARKER,
    });
    expect(body).toContain("### Changes since last review");
    expect(lastLine(body)).toBe(MARKER);
  });

  it("dedupes top_must_fix and caps it at 3 (FIX 11 — coordinate-findings parity)", () => {
    // 10 items with duplicates: the rendered Top-N must-fix section keeps the first
    // 3 UNIQUE items in order, matching the bash `unique | .[0:3]` cap.
    const topMustFix = [
      "Fix the auth bypass in login.ts",
      "Fix the auth bypass in login.ts", // dup of #1
      "Close the SQL injection in query.ts",
      "Fix the auth bypass in login.ts", // dup of #1
      "Handle the null deref in parse.ts",
      "Close the SQL injection in query.ts", // dup of #3
      "A fifth distinct must-fix",
      "A sixth distinct must-fix",
      "A seventh distinct must-fix",
      "Handle the null deref in parse.ts", // dup of #5
    ];
    const result: ProviderResult = {
      verdict: "changes",
      findings: [],
      review_plan: "",
      other_checks: "",
      top_must_fix: topMustFix,
    };
    const { body } = formatVerdict(result, {});

    // Exactly the 3 first-seen unique items render; the 4th+ unique ones do not.
    expect(body).toContain("Fix the auth bypass in login.ts");
    expect(body).toContain("Close the SQL injection in query.ts");
    expect(body).toContain("Handle the null deref in parse.ts");
    expect(body).not.toContain("A fifth distinct must-fix");
    expect(body).not.toContain("A sixth distinct must-fix");

    // The Top-N section body has exactly 3 lines (no duplicate of #1).
    const section = body.split("### Top-N must-fix\n")[1] ?? "";
    const firstItem = "Fix the auth bypass in login.ts";
    const occurrences = section.split(firstItem).length - 1;
    expect(occurrences).toBe(1);
  });

  it("enforces the 65000-char cap, dropping lowest-severity findings first while recap + marker survive", () => {
    // 400 findings, padded so the full body blows past the 65000 ceiling.
    const pad = "x".repeat(200);
    const findings: Finding[] = [];
    for (let i = 0; i < 400; i++) {
      // Mostly nits/low, a handful of blockers — the worst must survive longest.
      const severity: Finding["severity"] =
        i < 3 ? "blocker" : i < 6 ? "high" : i % 2 === 0 ? "nit" : "low";
      findings.push({
        path: `src/file${i}.ts`,
        line: 10,
        severity,
        text: `finding ${i} ${pad}`,
        confidence: "high",
      });
    }
    const result: ProviderResult = {
      verdict: "changes",
      findings,
      review_plan: "plan",
      other_checks: "checks",
      top_must_fix: [],
    };
    const recap = "### Changes since last review\n\n⚠️ New (400)";
    const { body } = formatVerdict(result, { recap, history: "", historyMarker: MARKER });

    // Body fits under the cap.
    expect(body.length).toBeLessThanOrEqual(65000);
    // Recap and marker survived the shrink; marker is still the last line.
    expect(body).toContain("### Changes since last review");
    expect(body).toContain(MARKER);
    expect(lastLine(body)).toBe(MARKER);
    // Lowest-severity dropped first: blockers/highs kept, the overflow note present.
    expect(body).toContain("blocker:");
    expect(body).toMatch(/_… \d+ more findings/);
    // The truncated section is ordered worst-first, so a blocker line precedes any nit.
    const blockerIdx = body.indexOf(": blocker:");
    const nitIdx = body.indexOf(": nit:");
    if (nitIdx !== -1) expect(blockerIdx).toBeLessThan(nitIdx);
  });
});

describe("formatVerdict — mechanical findings + graceful degradation", () => {
  const secret: MechanicalFinding = {
    tool: "gitleaks",
    ruleId: "github-pat",
    path: "src/a.ts",
    line: 5,
    severity: "error",
    message: "secret detected",
  };

  it("renders a Mechanical-checks section with per-tool counts + provenance tag on confirmed findings", () => {
    const result: ProviderResult = {
      verdict: "changes",
      findings: [
        { path: "src/a.ts", line: 5, severity: "high", text: "leaked token", source: "gitleaks" },
      ],
      review_plan: "",
      other_checks: "",
      top_must_fix: [],
    };
    const { body } = formatVerdict(result, { mechanical: [secret] });
    expect(body).toContain("### Mechanical checks");
    expect(body).toContain("1 gitleaks");
    expect(body).toContain("_[gitleaks]_"); // provenance tag on the finding line
  });

  it("on LLM error WITH mechanical findings, degrades gracefully (section + 'LLM judgment unavailable')", () => {
    const result: ProviderResult = { verdict: "error", findings: [], error: "boom" };
    const { body, label } = formatVerdict(result, { mechanical: [secret] });
    expect(body).toContain("### Mechanical checks");
    expect(body).toContain("LLM judgment unavailable");
    expect(label).toBe("request-changes"); // error still fails-safe to do-not-merge
  });
});
