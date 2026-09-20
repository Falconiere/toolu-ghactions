// review/findings.ts — the layout of the `### Findings` section, split out of
// review/render.ts (at its file-size budget) when the flat list was replaced by
// severity-grouped blocks.
//
// Why blocks: a GitHub comment renders consecutive lines as one run of body text,
// so N findings on N adjacent lines arrived as an undifferentiated wall — a reader
// could not tell a wrapped line from the next finding. Each finding is now its own
// paragraph under a severity sub-heading: a bold numbered location line, a small
// `<sub>` meta line, then the text. The numbering is continuous across groups so a
// finding can be referred to by number.
//
// The shape is a CONTRACT: scripts/parse-verdict.sh parses these blocks back into
// JSON for the babysit loop (it still accepts the old one-line shape for comments
// written by earlier versions).
import type { Finding } from "@/llm/schema.js";

/**
 * What this renderer actually receives. {@link Finding} marks `line` required,
 * but a finding can reach the comment without one — `github/review.ts` filters
 * exactly that case (`f.line == null`) before posting inline, and `review/recap.ts`
 * guards for it too. Typing the reality here keeps the guard below honest and lets
 * a test build the case without deleting a required property behind the compiler's
 * back. A plain `Finding[]` is assignable to it.
 */
export type RenderableFinding = Omit<Finding, "line"> & { line?: number | null };

/** Severity rank, blocker (worst) → nit (least). Used to order/shrink findings. */
export const SEVERITY_RANK: Record<Finding["severity"], number> = {
  blocker: 0,
  high: 1,
  medium: 2,
  low: 3,
  nit: 4,
};

/** Sub-heading decoration per severity — same emoji vocabulary as the verdict's
 *  severity summary, so the two lines read as one scale. */
const SEVERITY_HEADING: Record<Finding["severity"], string> = {
  blocker: "🔴 Blocker",
  high: "🟠 High",
  medium: "🟡 Medium",
  low: "🔵 Low",
  nit: "⚪ Nit",
};

/**
 * The findings section: one `#### <emoji> <Severity> · N` group per severity
 * present, worst-first, each holding one block per finding. "_No findings._"
 * when empty.
 */
export function buildFindingsSection(findings: readonly RenderableFinding[]): string {
  if (findings.length === 0) return "_No findings._";
  return renderGroups(severitySorted(findings));
}

/**
 * The same section shrunk to the highest-severity `keep`, with a trailing
 * "_… N more findings — see the [job log](url)_" note. Used by the size guard,
 * which halves `keep` down to 0 — at which point only the note is left.
 */
export function buildTruncatedFindingsSection(
  findings: readonly RenderableFinding[],
  keep: number,
  jobUrl: string,
): string {
  const shown = severitySorted(findings).slice(0, keep);
  const extra = findings.length - shown.length;
  const groups = shown.length > 0 ? renderGroups(shown) : "";
  if (extra <= 0) return groups;
  const note = `_… ${extra} more findings — see the [job log](${jobUrl})_`;
  return groups === "" ? note : `${groups}\n\n${note}`;
}

/** Worst-severity-first COPY of `findings`: the caller's array is the SAME one the
 *  pipeline later maps for reconcile and inline posting, so sorting it in place
 *  would reorder those. The sort is stable, so equal severities keep input order. */
function severitySorted(findings: readonly RenderableFinding[]): RenderableFinding[] {
  return [...findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/**
 * The severity groups, blank-line separated. Group order is not a second list to
 * keep in sync: `ordered` is already severity-sorted, so a group simply opens at
 * the first finding of a new severity.
 */
function renderGroups(ordered: readonly RenderableFinding[]): string {
  const counts = new Map<Finding["severity"], number>();
  for (const f of ordered) counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1);

  const blocks: string[] = [];
  let index = 0;
  let group: Finding["severity"] | null = null;
  for (const f of ordered) {
    if (f.severity !== group) {
      group = f.severity;
      blocks.push(`#### ${SEVERITY_HEADING[group]} · ${counts.get(group) ?? 0}`);
    }
    blocks.push(findingBlock(f, ++index));
  }
  return blocks.join("\n\n");
}

/** One finding: `**N.** \`path\` **L12**`, an optional `<sub>` meta line, then
 *  the text as its own paragraph. */
function findingBlock(f: RenderableFinding, index: number): string {
  const line = f.line !== undefined && f.line !== null ? ` **L${f.line}**` : "";
  return `**${index}.** \`${f.path}\`${line}${metaLine(f)}\n\n${blockText(f.text)}`;
}

/**
 * The finding text as ONE block. A blank line is what closes a block for
 * scripts/parse-verdict.sh, so a text the model wrote in several paragraphs would
 * be silently truncated at its first blank line — everything after it dropped from
 * the parsed finding. Collapsing those to single newlines keeps the whole text in
 * the block; GitHub still renders a single newline as a line break, so the
 * paragraph split survives visually.
 */
function blockText(text: string): string {
  return text.trim().replace(/(\r?\n[ \t]*){2,}/g, "\n");
}

/** The small grey line under the location: provenance (only when a deterministic
 *  tool confirmed it), category, confidence. All optional → "" drops the line. */
function metaLine(f: RenderableFinding): string {
  const bits: string[] = [];
  if (f.source !== undefined && f.source !== "llm") bits.push(`**[${f.source}]**`);
  if (f.category !== undefined && f.category !== "") bits.push(f.category);
  // "high" alone next to a "high" severity reads as a repeat of the severity —
  // spell out what the word measures.
  if (f.confidence !== undefined) bits.push(`${f.confidence} confidence`);
  return bits.length > 0 ? `\n<sub>${bits.join(" · ")}</sub>` : "";
}
