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

  it("does not render model top_must_fix prose when no validated findings survive", () => {
    // The recorded model summary is untrusted independently generated prose. It
    // must never resurrect a claim that validation already rejected.
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

    expect(body).not.toContain("### Top-N must-fix");
    expect(body).not.toContain("Fix the auth bypass in login.ts");
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
    expect(body).toContain("#### 🔴 Blocker · ");
    expect(body).toMatch(/_… \d+ more findings/);
    // The truncated section is ordered worst-first, so the blocker group heading
    // precedes any nit group heading.
    const blockerIdx = body.indexOf("#### 🔴 Blocker");
    const nitIdx = body.indexOf("#### ⚪ Nit");
    if (nitIdx !== -1) expect(blockerIdx).toBeLessThan(nitIdx);
  });
});

describe("formatVerdict — verbosity (compact vs full) + dedup", () => {
  const base: ProviderResult = {
    verdict: "changes",
    findings: [
      { path: "src/a.ts", line: 10, severity: "blocker", text: "auth bypass", confidence: "high" },
      { path: "src/b.ts", line: 4, severity: "nit", text: "spacing", confidence: "high" },
    ],
    review_plan: "Reviewed 2 files.",
    other_checks: "Tests look adequate.",
    top_must_fix: [],
  };

  it("compact (default): single-line checklist, keeps the parse-verdict contract", () => {
    const { body } = formatVerdict(base, { changedFiles: 3, historyMarker: MARKER });
    // Single compact checklist line replaces the 5-line static list.
    expect(body).toContain("- [x] Reviewed 3-file diff — verdict set");
    expect(body).not.toContain("- [x] Read repository context and PR diff");
    // parse-verdict.sh contract: ≥1 checked box, the ### Code Review heading, ### Findings block.
    expect(body).toMatch(/^[ \t]*- \[x\] /m);
    expect(body).toContain("### Code Review —");
    expect(body).toContain("### Findings (2)");
    // The state marker is still the last line under the compact shape.
    expect(lastLine(body)).toBe(MARKER);
  });

  it("compact names the diff size regardless of count", () => {
    const { body } = formatVerdict(base, { changedFiles: 1 });
    expect(body).toContain("- [x] Reviewed 1-file diff — verdict set");
  });

  it("full: restores the multi-line static checklist", () => {
    const { body } = formatVerdict(base, { verbosity: "full", changedFiles: 3 });
    expect(body).toContain("- [x] Read repository context and PR diff");
    expect(body).toContain("- [x] Set verdict label");
    expect(body).not.toContain("Reviewed 3-file diff");
  });

  it("omits empty Review Plan / Other checks sections without filler", () => {
    const bare: ProviderResult = {
      verdict: "changes",
      findings: [{ path: "src/a.ts", line: 1, severity: "high", text: "bug", confidence: "high" }],
      review_plan: "",
      other_checks: "",
      top_must_fix: [],
    };
    const { body } = formatVerdict(bare, {});
    expect(body).not.toContain("### Review Plan");
    expect(body).not.toContain("_No review plan provided._");
    expect(body).not.toContain("### Other checks");
    expect(body).not.toContain("_No additional checks performed._");
    expect(body).toContain("### Top-N must-fix");
  });

  it("derives Top-N from surviving findings instead of model prose", () => {
    const { body } = formatVerdict(base, {});
    expect(body).toContain("### Top-N must-fix");
    expect(body).toContain("`src/a.ts:10` — auth bypass");
    expect(body).toContain("`src/b.ts:4` — spacing");
  });

  it("severity-sorts the Findings list worst-first without mutating the input array", () => {
    const findings: Finding[] = [
      { path: "src/nit.ts", line: 1, severity: "nit", text: "n", confidence: "high" },
      { path: "src/blk.ts", line: 2, severity: "blocker", text: "b", confidence: "high" },
    ];
    const snapshot = [...findings];
    const { body } = formatVerdict({ ...base, findings }, {});
    // Blocker renders before the nit even though it was second in the input. Assert
    // on the extracted finding-line path sequence, not indexOf over the whole body,
    // so surrounding text (severity summary, headings) can't mask a bad sort.
    const orderedPaths = [...body.matchAll(/^\*\*\d+\.\*\* `(src\/[^`]+)`/gm)].map((m) => m[1]);
    expect(orderedPaths).toEqual(["src/blk.ts", "src/nit.ts"]);
    // The caller's array is untouched (reconcile/inline posting reuse it downstream).
    expect(findings).toEqual(snapshot);
  });

  it("ignores model Top-N prose in BOTH modes", () => {
    const withTop: ProviderResult = { ...base, top_must_fix: ["Fix the auth bypass now"] };
    for (const verbosity of ["compact", "full"] as const) {
      const { body } = formatVerdict(withTop, { verbosity, changedFiles: 2 });
      expect(body).toContain("### Top-N must-fix");
      expect(body).not.toContain("Fix the auth bypass now");
      expect(body).toContain("`src/a.ts:10` — auth bypass");
    }
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
    expect(body).toContain("**[gitleaks]**"); // provenance tag on the finding's meta line
  });

  it("on LLM error WITH mechanical findings, degrades gracefully (section + 'LLM judgment unavailable')", () => {
    const result: ProviderResult = { verdict: "error", findings: [], error: "boom" };
    const { body, label } = formatVerdict(result, { mechanical: [secret] });
    expect(body).toContain("### Mechanical checks");
    expect(body).toContain("LLM judgment unavailable");
    expect(body).toContain("**Provider error:**"); // a real abstain keeps the error label
    expect(label).toBe("request-changes"); // error still fails-safe to do-not-merge
  });

  it("on LLM error with NO mechanical findings, says judgment is unavailable", () => {
    const result: ProviderResult = { verdict: "error", findings: [], error: "boom" };
    const { body } = formatVerdict(result, {});
    expect(body).toContain("LLM judgment unavailable");
  });

  it("a recovered partial review WITH mechanical findings keeps the tool counts, no 'unavailable' note", () => {
    // The fourth cell of the llmErrored × mechanical matrix: LLM partially succeeded
    // AND deterministic findings exist. The Mechanical-checks section must render its
    // per-tool count line WITHOUT the "LLM judgment unavailable" suffix — judgment was
    // delivered — while the truncation still surfaces as the Partial-review callout.
    const result: ProviderResult = {
      verdict: "changes",
      findings: [{ path: "src/a.ts", line: 5, severity: "high", text: "bug" }],
      review_plan: "",
      other_checks: "",
      top_must_fix: [],
      partial: true,
      error: "output truncated at the token limit — recovered 1 finding(s).",
      finishReason: "length",
    };
    const { body } = formatVerdict(result, { mechanical: [secret] });
    expect(body).toContain("### Mechanical checks");
    expect(body).toContain("1 gitleaks");
    expect(body).not.toContain("LLM judgment unavailable");
    expect(body).toContain("**Partial review:**");
  });

  it("a recovered partial review is NOT 'LLM judgment unavailable' (toolu-conventions#3 regression)", () => {
    // Replays the real failure: a chunked review where 1/3 chunks truncated — merge.ts
    // sets `error` + `partial` but the verdict is "changes" WITH findings. The comment
    // rendered "LLM judgment unavailable — no deterministic findings either." directly
    // under 6 LLM findings, because llmErrored was derived from errorDetail != "".
    const result: ProviderResult = {
      verdict: "changes",
      findings: [
        { path: "docs/conventions.html", line: 1124, severity: "high", text: "broken link" },
      ],
      review_plan: "",
      other_checks: "",
      top_must_fix: [],
      partial: true,
      error:
        "1/3 chunks truncated at the output-token limit — recovered the findings " +
        "completed before the cut; later findings may be missing. Raise MAX_TOKENS to avoid.",
      finishReason: "length",
    };
    const { body, label } = formatVerdict(result, {});
    expect(body).not.toContain("LLM judgment unavailable");
    // The truncation is still surfaced — as a partial-review note, not a provider error.
    expect(body).toContain("**Partial review:**");
    expect(body).toContain("1/3 chunks truncated");
    expect(label).toBe("request-changes");
  });
});

describe("capNote (MAX_ROUNDS surrender note)", () => {
  it("renders the round-cap callout under the verdict when set", () => {
    const result: ProviderResult = { verdict: "approved", findings: [] };
    const { body } = formatVerdict(result, {
      capNote: "Round cap reached (MAX_ROUNDS=5): verdict auto-approved.",
    });
    expect(body).toContain("🔁 **Round cap:** Round cap reached (MAX_ROUNDS=5)");
  });

  it("omits the callout entirely when capNote is absent", () => {
    const result: ProviderResult = { verdict: "approved", findings: [] };
    const { body } = formatVerdict(result, {});
    expect(body).not.toContain("Round cap");
  });
});
