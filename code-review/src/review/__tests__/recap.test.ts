import { describe, it, expect } from "vitest";
import { renderRecap, renderHistorySection } from "@/review/recap.js";
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

describe("renderRecap", () => {
  it("renders new/open/resolved counts + history table from a real DiffResult", () => {
    // Current findings: A still open, B new; C gone → resolved (full review, in scope).
    const diff = diffState({
      prior,
      current_findings: [
        { path: "src/a.ts", line: 10, text: "finding A", category: "correctness" },
        { path: "src/b.ts", line: 7, text: "finding B", category: "correctness" },
      ],
      scope: { in_scope_paths: ["src/a.ts", "src/b.ts", "src/c.ts"], full_review: true },
      head_sha: "deadbeefcafe",
      verdict: "changes",
    });

    const md = renderRecap(diff, { history: diff.next_state.history, fullReview: true });

    // Recap counts header.
    expect(md).toContain("### Changes since last review");
    expect(md).toContain("✅ Resolved (1)");
    expect(md).toContain("🔁 Still open (1)");
    expect(md).toContain("⚠️ New (1)");
    // Bucket items carry `path:line` — text.
    expect(md).toContain("- `src/b.ts:7` — finding B");
    expect(md).toContain("- `src/a.ts:10` — finding A");
    expect(md).toContain("- `src/c.ts:3` — finding C");

    // History table — now 2 passes (prior + this one).
    expect(md).toContain("<details><summary>📜 Review history (2 passes)</summary>");
    expect(md).toContain("| Pass | Commit | Verdict | New | Open | Resolved |");
    expect(md).toContain("| 1 | `aaaaaaa` | changes | 2 | 0 | 0 |");
    expect(md).toContain("| 2 | `deadbee` | changes | 1 | 1 | 1 |");
    expect(md).toContain("</details>");
  });

  it("omits the Resolved bucket and notes scope on a scoped (non-full) review", () => {
    const diff = diffState({
      prior,
      current_findings: [
        { path: "src/a.ts", line: 10, text: "finding A", category: "correctness" },
      ],
      scope: { in_scope_paths: ["src/a.ts"], full_review: false },
      head_sha: "0123456789",
      verdict: "changes",
    });
    const md = renderRecap(diff, { history: diff.next_state.history, fullReview: false });
    expect(md).toContain("_scoped review — resolutions not recomputed_");
    expect(md).not.toContain("✅ Resolved");
  });

  it("renders nothing for history when there are no passes", () => {
    expect(renderHistorySection([])).toBe("");
  });
});
