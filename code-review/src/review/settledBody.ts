// review/settledBody.ts — patch the sticky verdict comment after a settle pass
// (pipeline/dismissRecompute.ts) recomputed the verdict WITHOUT a model call. The body
// cannot be re-rendered — its review plan, other-checks text and coverage ledger are
// not stored — so the patch edits only the lines that carry the verdict:
//
//   - the `**Verdict:**` line (→ ✅ Approved when nothing remains standing);
//   - one `> ✅ **Settled:** …` note directly under it (inserted, or replaced when a
//     previous settle pass left one — so the patch is idempotent);
//   - the standalone label line and full-mode checklist label, when the verdict flips.
//
// Everything else, the state marker above all, is left byte-for-byte. A body whose
// layout is not recognised yields null and the caller writes nothing (fail closed).
import { labelAndBadge } from "./verdict.js";
import type { RecomputeOutcome } from "./recompute.js";

const VERDICT_LINE = /^\*\*Verdict:\*\* .*$/m;
// Anchored to the verdict line: a note is only ever the paragraph right below it, so a
// finding whose text happens to contain the same words is never touched.
const SETTLED_NOTE = /^(\*\*Verdict:\*\* .*)\n\n> ✅ \*\*Settled:\*\* [^\n]*/m;
const IN_PROGRESS = /^### PR Review in Progress$/m;

/**
 * Apply a settle outcome to a completed verdict body, or return null when the body is
 * not one (in-progress, skipped, foreign) or lacks a line an approval must rewrite.
 */
export function patchSettledBody(
  body: string,
  outcome: Extract<RecomputeOutcome, { kind: "approve" }>,
): string | null {
  if (IN_PROGRESS.test(body) || !VERDICT_LINE.test(body)) return null;
  let out = body.replace(SETTLED_NOTE, "$1");
  if (outcome.verdict === "approved") {
    const swapped = swapLabel(out);
    if (swapped === null) return null;
    out = swapped.replace(VERDICT_LINE, `**Verdict:** ${labelAndBadge("approved").badge}`);
  }
  return out.replace(VERDICT_LINE, (line) => `${line}\n\n${settledNote(outcome)}`);
}

/** The note naming what the settle pass did — and, for an advisory remainder, why the
 *  label reads merge-approved while the verdict still reads Changes requested. */
function settledNote(outcome: Extract<RecomputeOutcome, { kind: "approve" }>): string {
  const base =
    `> ✅ **Settled:** ${outcome.settled} of ${outcome.total} finding(s) settled on their ` +
    "threads since this review (dismissed, argued out, or resolved) — verdict recomputed " +
    "without a new model call.";
  if (outcome.verdict === "approved") return base;
  return `${base} The rest are below \`APPROVE_BELOW\`, so the label is \`merge-approved\`.`;
}

/** Swap the request-changes label for merge-approved: the standalone label line (the
 *  LAST one — a finding's text never sits alone on a line in backticks after it) and
 *  the full-mode checklist entry. A body a previous settle pass already swapped is
 *  returned as-is (idempotence); null when neither label line is present. */
function swapLabel(body: string): string | null {
  const from = `\`${labelAndBadge("changes").label}\``;
  const to = `\`${labelAndBadge("approved").label}\``;
  const lines = body.split("\n");
  const at = lines.lastIndexOf(from);
  if (at < 0) return lines.includes(to) ? body : null;
  lines[at] = to;
  return lines
    .join("\n")
    .replace(`- [x] Set verdict label (${from})`, `- [x] Set verdict label (${to})`);
}
