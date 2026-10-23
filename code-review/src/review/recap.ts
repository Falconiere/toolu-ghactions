// review/recap.ts — render the "changes since last review" recap and the
// collapsed review-history table. Port of render-recap.sh (both subcommands),
// driven directly from a state.ts DiffResult instead of env JSON.
//
// Pure rendering — it never calls diffState itself. The recap is a one-line row of
// counts, the resolved refs, and the still-open/new lists folded into <details>;
// every list is capped with a "_… N more_" overflow note. History is a collapsed,
// right-aligned table.
import type { DiffResult, Finding, HistoryEntry } from "@/state.js";
import { details } from "@/review/summary.js";

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
  /**
   * Compact mode (VERBOSITY input): bucket items render as `path:line` refs ONLY,
   * dropping the ` — text` tail. The full finding text already lives once in the
   * ### Findings block, so repeating it per bucket (a 4th copy on re-runs) is noise.
   * Defaults to false (full text).
   */
  compact?: boolean;
  /** The prior review's head sha, shown in the since row (7 chars); absent → "last review". */
  sinceSha?: string;
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
  return sections.join("\n\n");
}

/**
 * The since-last-review block. Empty string when no prior review existed (hasPrior
 * false). A one-line row of counts leads; on a full review the resolved refs follow
 * it (what got fixed is the news), while still-open and new — whose findings the
 * Findings section already lists — fold into one collapsed block. A scoped review
 * cannot recompute resolutions, so its row says so instead of counting them.
 */
export function renderRecapSection(diff: DiffResult, opts: RecapOptions): string {
  if (opts.hasPrior === false) return "";

  const compact = opts.compact === true;
  const since = opts.sinceSha
    ? `**Since \`${opts.sinceSha.slice(0, 7)}\`**`
    : "**Since last review**";
  const open = `🔁 **${diff.counts.open}** still open`;
  const fresh = `⚠️ **${diff.counts.new}** new`;
  const row = opts.fullReview
    ? `${since} &nbsp;✅ **${diff.counts.resolved}** resolved · ${open} · ${fresh}`
    : `${since} &nbsp;${open} · ${fresh} · <sub>scoped review — resolutions not recomputed</sub>`;

  const blocks = [row];
  if (opts.fullReview && diff.counts.resolved > 0) {
    blocks.push(renderItems(diff.counts.resolved, diff.resolved, compact, "✅ "));
  }
  const folded: string[] = [];
  const titles: string[] = [];
  if (diff.counts.open > 0) {
    titles.push(`Still open (${diff.counts.open})`);
    folded.push("🔁 **Still open**", renderItems(diff.counts.open, diff.open, compact, ""));
  }
  if (diff.counts.new > 0) {
    titles.push(`New (${diff.counts.new})`);
    folded.push("⚠️ **New**", renderItems(diff.counts.new, diff.new, compact, ""));
  }
  if (folded.length > 0) blocks.push(details(titles.join(" · "), folded.join("\n\n")));
  return blocks.join("\n\n");
}

/** Verdict decoration in the history table — the same vocabulary as the badges. */
const VERDICT_MARK: Record<string, string> = { approved: "✅ ", changes: "⚠️ ", error: "🚫 " };

/**
 * The collapsed "Review history" table. Empty string when there are no history
 * entries. Newest last; the Pass number is the 1-based row index.
 */
export function renderHistorySection(history: HistoryEntry[]): string {
  if (history.length === 0) return "";

  const passes = history.length === 1 ? "1 pass" : `${history.length} passes`;
  const rows = history.map((e, i) => {
    const c = e.counts ?? { new: 0, open: 0, resolved: 0, total: 0 };
    const verdict = e.verdict ? `${VERDICT_MARK[e.verdict] ?? ""}${e.verdict}` : "?";
    return `| ${i + 1} | \`${e.sha || "?"}\` | ${verdict} | ${c.new ?? 0} | ${c.open ?? 0} | ${c.resolved ?? 0} |`;
  });
  const table = [
    "| Pass | Commit | Verdict | New | Open | Resolved |",
    "| :-- | :-- | :-- | --: | --: | --: |",
    ...rows,
  ].join("\n");
  return details(`<b>Review history</b> · ${passes}`, table);
}

/**
 * One bucket's items: at most RECAP_LIST_CAP inlined, then a "_… N more_" note for
 * the rest. In full mode each item is `path:line — text`; in compact mode it is the
 * `path:line` ref only. `mark` prefixes every item (the resolved list's ✅).
 */
function renderItems(count: number, items: Finding[], compact: boolean, mark: string): string {
  const lines = items.slice(0, RECAP_LIST_CAP).map((f) => {
    const loc = f.line !== undefined && f.line !== null ? `:${f.line}` : "";
    const ref = `\`${f.path ?? ""}${loc}\``;
    return compact ? `- ${mark}${ref}` : `- ${mark}${ref} — ${f.text ?? ""}`;
  });
  const extra = count - RECAP_LIST_CAP;
  if (extra > 0) lines.push(`_… ${extra} more_`);
  return lines.join("\n");
}
