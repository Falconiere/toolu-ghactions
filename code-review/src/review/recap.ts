// review/recap.ts — render the "changes since last review" recap and the
// collapsed review-history table. Port of render-recap.sh (both subcommands),
// driven directly from a state.ts DiffResult instead of env JSON.
//
// Pure rendering — it never calls diffState itself. The markdown shape matches
// the bash exactly: bucket lines "<emoji label> (N)" with capped `path:line —
// text` lists, a "_… N more_" overflow note, and the <details> history table.
import type { DiffResult, Finding, HistoryEntry } from "@/state.js";

/** How many items to inline per recap bucket before collapsing the overflow. */
const RECAP_LIST_CAP = 8;

/** Options for {@link renderRecap}: history + the full-review flag. */
export interface RecapOptions {
  /** The history entries to table (already capped to ≤10 by diffState). */
  history: HistoryEntry[];
  /**
   * Whether this was a full review. When false the Resolved bucket is omitted
   * and a "_scoped review — resolutions not recomputed_" note is shown instead,
   * matching render-recap.sh's FULL_REVIEW="false" branch.
   */
  fullReview: boolean;
  /**
   * Whether a PRIOR review existed. The recap section is rendered only when a
   * prior review was found (render-recap.sh emits nothing when REVIEW_RECAP_JSON
   * is absent). Defaults to true.
   */
  hasPrior?: boolean;
}

/**
 * Render the recap section + the collapsed history table for the sticky comment.
 * Returns the concatenated markdown (recap first, then history), each section
 * separated by a blank line. Either section is empty when it has nothing to show
 * (no prior review → no recap; no history entries → no table).
 */
export function renderRecap(diff: DiffResult, opts: RecapOptions): string {
  const sections: string[] = [];
  const recap = renderRecapSection(diff, opts);
  if (recap !== "") sections.push(recap);
  const history = renderHistorySection(opts.history);
  if (history !== "") sections.push(history);
  return sections.join("\n");
}

/**
 * The "### Changes since last review" section. Empty string when no prior review
 * existed (hasPrior false). On a full review the Resolved bucket is shown;
 * otherwise the scoped-review note replaces it. Always renders Still-open + New.
 */
export function renderRecapSection(diff: DiffResult, opts: RecapOptions): string {
  if (opts.hasPrior === false) return "";

  const lines: string[] = [];
  lines.push("### Changes since last review");
  lines.push("");
  if (opts.fullReview) {
    lines.push(renderBucket("✅ Resolved", diff.counts.resolved, diff.resolved));
    lines.push("");
  } else {
    lines.push("_scoped review — resolutions not recomputed_");
    lines.push("");
  }
  lines.push(renderBucket("🔁 Still open", diff.counts.open, diff.open));
  lines.push("");
  lines.push(renderBucket("⚠️ New", diff.counts.new, diff.new));
  lines.push("");
  return lines.join("\n");
}

/**
 * The collapsed "<details>📜 Review history" table. Empty string when there are
 * no history entries. Newest last; the Pass number is the 1-based row index.
 */
export function renderHistorySection(history: HistoryEntry[]): string {
  if (history.length === 0) return "";

  const lines: string[] = [];
  lines.push(`<details><summary>📜 Review history (${history.length} passes)</summary>`);
  lines.push("");
  lines.push("| Pass | Commit | Verdict | New | Open | Resolved |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  history.forEach((e, i) => {
    const c = e.counts ?? { new: 0, open: 0, resolved: 0, total: 0 };
    lines.push(
      `| ${i + 1} | \`${e.sha || "?"}\` | ${e.verdict || "?"} | ${c.new ?? 0} | ${c.open ?? 0} | ${c.resolved ?? 0} |`,
    );
  });
  lines.push("");
  lines.push("</details>");
  return lines.join("\n");
}

/**
 * Render one bucket: a labelled count line plus a capped `path:line — text` list.
 * Mirrors render-recap.sh's render_bucket: nothing but the label when count is 0,
 * at most RECAP_LIST_CAP items inlined, then a "_… N more_" note for the rest.
 */
function renderBucket(label: string, count: number, items: Finding[]): string {
  const lines: string[] = [`${label} (${count})`];
  if (count === 0) return lines.join("\n");

  for (const f of items.slice(0, RECAP_LIST_CAP)) {
    const loc = f.line !== undefined && f.line !== null ? `:${f.line}` : "";
    lines.push(`- \`${f.path ?? ""}${loc}\` — ${f.text ?? ""}`);
  }
  const extra = count - RECAP_LIST_CAP;
  if (extra > 0) lines.push(`_… ${extra} more_`);
  return lines.join("\n");
}
