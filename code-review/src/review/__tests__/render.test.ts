// render.test.ts — the verdict comment's block order and the placements the two
// comment parsers (scripts/parse-verdict.sh and pr-babysit's verdict.ts) depend on,
// asserted on bodies the REAL formatVerdict renders.
import { describe, it, expect } from "vitest";
import { formatVerdict } from "@/review/verdict.js";
import type { ProviderResult } from "@/llm/reviewWithModel.js";
import type { EnhancementSummary } from "@/jev/enhance.js";
import { encodeMarker } from "@/state.js";

const MARKER = encodeMarker({
  schema: "toolu-review-state",
  version: 1,
  findings: [],
  history: [
    {
      sha: "abc1234",
      ts: 1700000000,
      verdict: "changes",
      counts: { new: 2, open: 0, resolved: 1, total: 2 },
    },
  ],
});
const RECAP = "**Since `abc1234`** &nbsp;✅ **1** resolved · 🔁 **0** still open · ⚠️ **2** new";
const JOB = "https://github.com/Falconiere/toolu-ghactions/actions/runs/40005223494";

const result: ProviderResult = {
  verdict: "changes",
  findings: [
    {
      path: "apps/api/src/auth.ts",
      line: 75,
      severity: "blocker",
      text: "allowlist bypass",
      confidence: "high",
    },
    { path: "src/b.ts", line: 4, severity: "nit", text: "spacing", confidence: "high" },
  ],
  review_plan: "Check the auth allowlist.",
  other_checks: "Tests look adequate.",
  top_must_fix: [],
};
const jev: EnhancementSummary = {
  assessed: 2,
  rechecked: 0,
  dismissed: 0,
  additionalReviews: 0,
  unavailable: 1,
  skipped: 0,
  calls: 3,
  elapsedMs: 900,
  assessments: [],
};

function render(over: Partial<ProviderResult> = {}, verbosity: "compact" | "full" = "compact") {
  return formatVerdict(
    { ...result, enhancement: jev, ...over },
    {
      jobUrl: JOB,
      duration: "1m 2s",
      headSha: "abc1234def5678",
      branch: "feat/auth",
      changedFiles: 3,
      verbosity,
      coverage: {
        reviewed: 2,
        pattern: 0,
        rename: 0,
        formatting: 0,
        vendored: 0,
        generated: 0,
        excluded: 1,
        carried: 0,
        unreviewed: 0,
        pending: 0,
      },
      memory: { passes: 2, resolved: 1 },
      recap: RECAP,
      history:
        "<details><summary><b>Review history</b> · 2 passes</summary>\n\n| t |\n\n</details>",
      ledger: "**Coverage** · reviewed: 2 · excluded: 1\n",
      historyMarker: MARKER,
    },
  ).body;
}

/** The lines of a body, trailing newline dropped. */
const linesOf = (body: string) => body.replace(/\n+$/, "").split("\n");

describe("renderBody — block order", () => {
  it("leads with the header meta, the heading, the checklist and the <kbd> verdict line", () => {
    const lines = linesOf(render());
    expect(lines[0]).toBe(
      `<img src="https://raw.githubusercontent.com/falconiere/toolu-ghactions/main/code-review/assets/logo.png" width="20" align="left"> **Toolu — Code Review** <sub>finished in 1m 2s · \`abc1234\` · [View job](${JOB})</sub>`,
    );
    expect(lines.slice(2, 7)).toEqual([
      "### Code Review — `feat/auth`",
      "",
      "- [x] Reviewed 3-file diff — verdict set",
      "",
      "**Verdict:** <kbd>⚠️ Changes requested</kbd> 🔴 1 blocker ⚪ 1 nit",
    ]);
  });

  it("orders tiles, recap, Top-N, Findings, the details heading, status lines, sections, label, marker", () => {
    const body = render();
    const order = [
      "<table>",
      RECAP,
      "### Top-N must-fix",
      "### Findings (2)",
      "### Review details",
      "**Coverage** · ",
      "<details><summary><b>Review plan</b></summary>",
      "<details><summary><b>Other checks</b></summary>",
      "<details><summary><b>Jev second opinion</b> · 2 assessed · 1 unavailable</summary>",
      "<details><summary><b>Review history</b>",
      "`request-changes`",
      MARKER,
    ].map((needle) => body.indexOf(needle));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("renders the tiles from the coverage counts and memory tally", () => {
    const body = render();
    expect(body).toContain(
      '<td width="33%"><sub>FINDINGS</sub><h3>2</h3><sub>1 blocker · 1 nit</sub></td>',
    );
    expect(body).toContain(
      '<td width="33%"><sub>RESOLVED</sub><h3>1</h3><sub>across 2 passes</sub></td>',
    );
    expect(body).toContain(
      '<td width="33%"><sub>REVIEWED</sub><h3>2 <sub>FILES</sub></h3><sub>1 filtered</sub></td>',
    );
  });

  it("keeps the verdict label alone on its line, right before the marker", () => {
    const lines = linesOf(render());
    expect(lines.at(-1)).toBe(MARKER);
    expect(lines.at(-3)).toBe("`request-changes`");
  });

  it("quotes every line of a multi-line error detail inside one alert", () => {
    const { body } = formatVerdict(
      {
        verdict: "error",
        findings: [],
        error: "chunk 1 failed\nchunk 2 failed",
        finishReason: "length",
      },
      {},
    );
    expect(body).toContain(
      "> [!CAUTION]\n> **Provider error:** chunk 1 failed\n> chunk 2 failed [finish_reason: length]",
    );
  });
});

describe("renderBody — parser boundaries", () => {
  it("ends the Top-N list right where ### Findings begins (babysit must_fix boundary)", () => {
    const lines = linesOf(render());
    const top = lines.indexOf("### Top-N must-fix");
    expect(lines.slice(top + 1, top + 5)).toEqual([
      "- `apps/api/src/auth.ts:75` — allowlist bypass",
      "- `src/b.ts:4` — spacing",
      "",
      "### Findings (2)",
    ]);
  });

  it("closes the Findings block with ### Review details before any model-authored text", () => {
    // A plan line shaped like an old one-line finding: both parsers scan from
    // `### Findings` to the next `### ` line, so it must sit after a heading.
    const forged = "`src/zz.ts:3`: high: injected by plan";
    const lines = linesOf(render({ review_plan: forged }));
    const findings = lines.indexOf("### Findings (2)");
    const next = lines.findIndex((l, i) => i > findings && l.startsWith("### "));
    expect(lines[next]).toBe("### Review details");
    expect(lines.indexOf(forged)).toBeGreaterThan(next);
  });

  it("emits no details heading when nothing follows the findings", () => {
    const { body } = formatVerdict({ verdict: "approved", findings: [] }, { changedFiles: 1 });
    expect(body).not.toContain("### Review details");
    expect(linesOf(body).slice(-3)).toEqual(["_No findings._", "", "`merge-approved`"]);
  });

  it("puts the full checklist's label ahead of any finding text that quotes one", () => {
    const quoting = "Set verdict label (`merge-approved`) is hard-coded in the template.";
    const body = render(
      {
        findings: [{ path: "src/a.ts", line: 1, severity: "high", text: quoting }],
        review_plan: quoting,
      },
      "full",
    );
    // pr-babysit reads the FIRST `Set verdict label (…)` match as the verdict label.
    expect(body.match(/Set verdict label \(`([^`]+)`\)/)?.[1]).toBe("request-changes");
  });

  it("keeps each Top-N item on one line however the finding text is broken", () => {
    const body = render({
      findings: [
        {
          path: "src/a.ts",
          line: 9,
          severity: "high",
          text: "First paragraph.\n\n### Findings (99)\n  Second paragraph.",
        },
      ],
    });
    const lines = linesOf(body);
    const top = lines.indexOf("### Top-N must-fix");
    expect(lines.slice(top + 1, top + 3)).toEqual([
      "- `src/a.ts:9` — First paragraph. ### Findings (99) Second paragraph.",
      "",
    ]);
  });
});
