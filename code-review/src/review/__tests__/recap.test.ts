import { describe, it, expect } from "vitest";
import { renderRecap, renderRecapSection, renderHistorySection } from "@/review/recap.js";
import { diffState, attachFps, type ReviewState } from "@/state.js";

// A real prior state with one finding (A) and one history pass.
const prior: ReviewState = {
  schema: "toolu-review-state",
  version: 1,
  findings: attachFps([
    { path: "src/a.ts", line: 10, text: "finding A", category: "correctness" },
    { path: "src/c.ts", line: 3, text: "finding C", category: "perf" },
  ]),
  history: [
    {
      sha: "aaaaaaa",
      ts: 1700000000,
      verdict: "changes",
      counts: { new: 2, open: 0, resolved: 0, total: 2 },
    },
  ],
};

/** Current findings: A still open, B new; C gone → resolved (full review, in scope). */
function fullDiff() {
  return diffState({
    prior,
    current_findings: [
      { path: "src/a.ts", line: 10, text: "finding A", category: "correctness" },
      { path: "src/b.ts", line: 7, text: "finding B", category: "correctness" },
    ],
    scope: { in_scope_paths: ["src/a.ts", "src/b.ts", "src/c.ts"], full_review: true },
    head_sha: "deadbeefcafe",
    verdict: "changes",
    complete: true,
  });
}

describe("renderRecapSection", () => {
  it("leads with a since row, lists what was resolved, and folds still-open/new away", () => {
    const md = renderRecapSection(fullDiff(), {
      history: [],
      fullReview: true,
      sinceSha: "aaaaaaa1234",
    });
    expect(md).toBe(
      [
        "**Since `aaaaaaa`** &nbsp;✅ **1** resolved · 🔁 **1** still open · ⚠️ **1** new",
        "",
        "- ✅ `src/c.ts:3` — finding C",
        "",
        "<details><summary>Still open (1) · New (1)</summary>",
        "",
        "🔁 **Still open**",
        "",
        "- `src/a.ts:10` — finding A",
        "",
        "⚠️ **New**",
        "",
        "- `src/b.ts:7` — finding B",
        "",
        "</details>",
      ].join("\n"),
    );
  });

  it("compact mode keeps `path:line` refs and drops every finding text", () => {
    const md = renderRecapSection(fullDiff(), {
      history: [],
      fullReview: true,
      compact: true,
      sinceSha: "aaaaaaa",
    });
    expect(md).toContain("- ✅ `src/c.ts:3`\n");
    expect(md).toContain("- `src/a.ts:10`\n");
    expect(md).toContain("- `src/b.ts:7`\n");
    expect(md).not.toContain("finding");
  });

  it("replaces the resolved count with the scoped note on a scoped review", () => {
    const diff = diffState({
      prior,
      current_findings: [
        { path: "src/a.ts", line: 10, text: "finding A", category: "correctness" },
      ],
      scope: { in_scope_paths: ["src/a.ts"], full_review: false },
      head_sha: "0123456789",
      verdict: "changes",
      complete: true,
    });
    const md = renderRecapSection(diff, { history: [], fullReview: false, sinceSha: "aaaaaaa" });
    expect(md.split("\n")[0]).toBe(
      "**Since `aaaaaaa`** &nbsp;🔁 **1** still open · ⚠️ **0** new · <sub>scoped review — resolutions not recomputed</sub>",
    );
    expect(md).not.toContain("✅");
  });

  it("caps the resolved list at 8 refs and counts the rest", () => {
    const many: ReviewState = {
      ...prior,
      findings: attachFps(
        Array.from({ length: 10 }, (_, i) => ({
          path: `packages/api/src/__tests__/self-hosted-${i}.test.ts`,
          line: i + 7,
          text: `stale fixture ${i}`,
          category: "test quality",
        })),
      ),
    };
    const diff = diffState({
      prior: many,
      current_findings: [],
      scope: {
        in_scope_paths: many.findings.map((f) => String(f.path)),
        full_review: true,
      },
      head_sha: "5a5e23f00",
      verdict: "approved",
      complete: true,
    });
    const md = renderRecapSection(diff, { history: [], fullReview: true, compact: true });
    expect(md.split("\n")[0]).toBe(
      "**Since last review** &nbsp;✅ **10** resolved · 🔁 **0** still open · ⚠️ **0** new",
    );
    expect(md.split("\n").filter((l) => l.startsWith("- ✅ "))).toHaveLength(8);
    expect(md).toContain("_… 2 more_");
    // Nothing still open or new → no collapsed block at all.
    expect(md).not.toContain("<details>");
  });

  it("renders nothing without a prior review", () => {
    expect(renderRecapSection(fullDiff(), { history: [], fullReview: true, hasPrior: false })).toBe(
      "",
    );
  });
});

describe("renderHistorySection", () => {
  it("collapses a right-aligned pass table with verdict emoji", () => {
    const diff = fullDiff();
    expect(renderHistorySection(diff.next_state.history)).toBe(
      [
        "<details><summary><b>Review history</b> · 2 passes</summary>",
        "",
        "| Pass | Commit | Verdict | New | Open | Resolved |",
        "| :-- | :-- | :-- | --: | --: | --: |",
        "| 1 | `aaaaaaa` | ⚠️ changes | 2 | 0 | 0 |",
        "| 2 | `deadbee` | ⚠️ changes | 1 | 1 | 1 |",
        "",
        "</details>",
      ].join("\n"),
    );
  });

  it("says `1 pass` and marks approved and error rounds", () => {
    const one = renderHistorySection([
      {
        sha: "5564be9",
        ts: 1,
        verdict: "approved",
        counts: { new: 0, open: 0, resolved: 0, total: 0 },
      },
    ]);
    expect(one).toContain("<summary><b>Review history</b> · 1 pass</summary>");
    expect(one).toContain("| 1 | `5564be9` | ✅ approved | 0 | 0 | 0 |");
    const err = renderHistorySection([
      {
        sha: "abc1234",
        ts: 1,
        verdict: "error",
        counts: { new: 0, open: 0, resolved: 0, total: 0 },
      },
    ]);
    expect(err).toContain("| 🚫 error |");
  });

  it("renders nothing when there are no passes", () => {
    expect(renderHistorySection([])).toBe("");
  });
});

describe("renderRecap", () => {
  it("joins the recap and the history with one blank line", () => {
    const diff = fullDiff();
    const md = renderRecap(diff, { history: diff.next_state.history, fullReview: true });
    expect(md).toContain("**Since last review** &nbsp;✅ **1** resolved");
    expect(md).toContain("\n\n<details><summary><b>Review history</b> · 2 passes</summary>");
  });
});
