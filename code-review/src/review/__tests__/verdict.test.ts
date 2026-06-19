import { describe, it, expect } from "vitest";
import { formatVerdict } from "../verdict.js";
import type { ProviderResult } from "../../llm/openrouter.js";
import type { Finding } from "../../llm/schema.js";
import { encodeMarker, type ReviewState } from "../../state.js";

const MARKER = encodeMarker({
  schema: "toolu-review-state",
  version: 1,
  findings: [{ path: "src/a.ts", line: 10, text: "remembered", category: "c", fp: "x" }],
  history: [{ sha: "abc1234", ts: 1700000000, verdict: "changes", counts: { new: 1, open: 0, resolved: 0, total: 1 } }],
});

/** The last non-empty line of a body. */
function lastLine(body: string): string {
  const trimmed = body.replace(/\n+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("\n") + 1);
}

describe("formatVerdict", () => {
  it("maps approved → agent-merge-approved label and ✅ badge", () => {
    const result: ProviderResult = {
      verdict: "approved",
      findings: [],
      review_plan: "Looks good.",
      other_checks: "Ran the checklist.",
      top_must_fix: [],
    };
    const { body, label } = formatVerdict(result, {});
    expect(label).toBe("agent-merge-approved");
    expect(body).toContain("`agent-merge-approved`");
    expect(body).toContain("✅ Approved");
  });

  it("maps error → agent-request-changes label + provider-error badge", () => {
    const result: ProviderResult = { verdict: "error", findings: [], error: "boom" };
    const { body, label } = formatVerdict(result, {});
    // error is the do-not-approve fail-safe: request-changes label, error badge.
    expect(label).toBe("agent-request-changes");
    expect(body).toContain("🚫 Review incomplete — provider error");
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

  it("enforces the 65000-char cap, dropping lowest-severity findings first while recap + marker survive", () => {
    // 400 findings, padded so the full body blows past the 65000 ceiling.
    const pad = "x".repeat(200);
    const findings: Finding[] = [];
    for (let i = 0; i < 400; i++) {
      // Mostly nits/low, a handful of blockers — the worst must survive longest.
      const severity: Finding["severity"] = i < 3 ? "blocker" : i < 6 ? "high" : i % 2 === 0 ? "nit" : "low";
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
