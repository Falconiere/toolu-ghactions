// review/render.ts — the markdown body builder for the verdict comment. Split
// out of verdict.ts (which owns the verdict→label mapping and the size-cap loop)
// so each file stays under 300 LOC. Pure string assembly in the toolu PR-comment
// layout: header, checklist, verdict pill, stat tiles and the since-last-review row
// first, then Top-N and Findings, then — under `### Review details` — status lines
// and collapsed detail sections, with the label and state marker last. The
// presentational blocks live in review/summary.ts.
import type { Finding } from "@/llm/schema.js";
import type { MechanicalFinding } from "@/mechanical/sarif.js";
import type { FindingCluster } from "@/review/cluster.js";
import type { CoverageStatus } from "@/review/ledger.js";
import type { EnhancementSummary } from "@/jev/enhance.js";
import { SEVERITY_RANK } from "./findings.js";
import {
  buildClusterSection,
  buildDroppedSection,
  buildUnanchoredSection,
} from "@/review/sections.js";
import { alert, buildJevSection, buildTiles, details, verdictLine } from "@/review/summary.js";

// The findings list itself lives in review/findings.ts (this file is at its size
// budget); re-exported here so verdict.ts keeps one import site for the body.
export {
  buildFindingsSection,
  buildTruncatedFindingsSection,
  SEVERITY_RANK,
} from "@/review/findings.js";

/** Cap on the rendered top-must-fix list, matching coordinate-findings.sh `.[0:3]`. */
const TOP_MUST_FIX_MAX = 3;

/** The content the body renders, mirroring parse-response.sh's JSON object. */
export interface ReviewBody {
  /** Resolved verdict label markdown, e.g. "`merge-approved`". */
  verdictLabel: string;
  /** Deterministic optional-enhancement counts (the collapsed Jev section). */
  enhancement?: EnhancementSummary;
  /** Verdict badge text, e.g. "✅ Approved". */
  verdictBadge: string;
  /** Provider error detail shown under the verdict when the review errored ("" → omit). */
  errorDetail: string;
  /**
   * True ONLY when the LLM abstained — it delivered no review plan, no other-checks
   * blurb and no findings. NOT derivable from errorDetail: a recovered truncation /
   * partly-failed chunked review sets errorDetail while still delivering findings and a
   * real verdict. NOT derivable from the resolved verdict alone either: the
   * source-evidence gate and the coverage degrade force verdict "error" on a review the
   * provider answered in full. Rendering "LLM judgment unavailable" above the model's
   * own review plan, or over a findings list, is a lie either way.
   */
  llmErrored: boolean;
  /** The header meta line beside the bot name (review/summary.ts `headerMeta`). */
  header: string;
  /** Branch name shown in the Code Review heading. */
  branch: string;
  /** Job log URL used by the truncation note. */
  jobUrl: string;
  /** Branding name. */
  botName: string;
  /** Branding logo URL. */
  botLogoUrl: string;
  /** The model's review plan ("" → section omitted). */
  reviewPlan: string;
  /** The model's other-checks blurb ("" → section omitted). */
  otherChecks: string;
  /** All findings (after validation). */
  findings: Finding[];
  /** File count of the reviewed diff — shown in the compact checklist line. */
  changedFiles: number;
  /**
   * Compact mode: collapse the multi-line static checklist to a single checked line.
   * Findings, the Findings heading, and ≥1 `- [x]` box are preserved in BOTH modes so
   * the parse-verdict.sh contract (identification + completeness + findings) still holds.
   */
  compact: boolean;
  /** Pre-rendered recap markdown ("" when absent). */
  recap: string;
  /** Pre-rendered history markdown ("" when absent). */
  history: string;
  /** Pre-encoded state marker, appended verbatim as the LAST line ("" → omit). */
  marker: string;
  /** Deterministic findings (gitleaks/opengrep) for the Mechanical-checks summary ([] → omit). */
  mechanical: MechanicalFinding[];
  /** MAX_ROUNDS surrender note shown under the verdict line ("" → omit). */
  capNote: string;
  /** Pre-rendered coverage-ledger section (review/ledger.ts). Unlike recap/history
   *  it IS droppable: it joins the size ladder ahead of findings (verdict.ts). */
  ledger: string;
  /** Ledger counts per status for the REVIEWED/CARRIED tiles (absent → diff size). */
  coverage?: Record<CoverageStatus, number>;
  /** Review-memory tally for the RESOLVED tile (absent when memory is off). */
  memory?: { passes: number; resolved: number };
  /** Findings GitHub could not anchor inline — rendered in their own section. */
  unanchored: Finding[];
  /** Findings whose inline comment GitHub rejected (422) even posted alone. */
  dropped: Finding[];
  /** This round's clusters; the multi-member ones get an enumerated block. */
  clusters: FindingCluster[];
}

/**
 * Render the full comment body for a given findings list (the size-cap loop
 * calls this with progressively shrunk findings). Everything but the ledger and
 * the findings is emitted unconditionally, so the size guard can only ever shrink
 * those two. Blocks are separated by one blank line; the marker, when present, is
 * always the last line.
 *
 * Four placements are parser contracts (scripts/parse-verdict.sh, pr-babysit):
 *  - the checklist precedes every model-influenced line — pr-babysit reads the FIRST
 *    `Set verdict label (…)` match, and a finding may quote one;
 *  - `### Top-N must-fix` sits directly above `### Findings`, whose heading ends
 *    pr-babysit's must_fix scan;
 *  - `### Review details` follows the findings sections whenever anything does, so
 *    both parsers' Findings scan (up to the next `### `) never reaches the
 *    model-authored plan or other-checks text below it;
 *  - the verdict label stands alone on its line, where both parsers read it.
 */
export function renderBody(body: ReviewBody, findingsSection: string): string {
  const blocks: string[] = [
    `<img src="${body.botLogoUrl}" width="20" align="left"> **${body.botName}** ${body.header}`,
    `### Code Review — \`${body.branch}\``,
    buildChecklist(body),
    verdictLine(body.verdictBadge, buildSeveritySummary(body.findings)),
  ];
  // Surface the real provider-error message (not just the badge) so a failed review
  // is diagnosable from the comment alone. Label honestly: "Provider error" only when
  // the LLM actually abstained; a recovered/partly-failed review that still produced
  // a verdict is a "Partial review", not an error.
  if (body.errorDetail !== "") {
    blocks.push(
      body.llmErrored
        ? alert("CAUTION", "Provider error", body.errorDetail)
        : alert("WARNING", "Partial review", body.errorDetail),
    );
  }
  // The MAX_ROUNDS surrender is a verdict override — say so right under the verdict
  // so an auto-approved round is never mistaken for a clean review.
  if (body.capNote !== "") blocks.push(alert("NOTE", "Round cap", body.capNote));
  blocks.push(
    buildTiles({
      findings: body.findings,
      coverage: body.coverage,
      changedFiles: body.changedFiles,
      memory: body.memory,
      mechanical: body.mechanical,
    }),
  );
  if (body.recap !== "") blocks.push(body.recap.trimEnd());

  // Top-N is derived from the same surviving findings the comment renders. Never
  // render independently generated model prose here: it may describe a claim the
  // evidence gate, scope filter, or settlement step already rejected.
  const topMustFix = buildTopMustFixSection(body.findings);
  if (topMustFix !== "") blocks.push(`### Top-N must-fix\n${topMustFix}`);
  // Findings is unconditional: parse-verdict.sh extracts findings from this exact block.
  blocks.push(`### Findings (${body.findings.length})\n\n${findingsSection}`);

  // A repeated finding is posted once, on its exemplar (where the files it stands for
  // are named); findings with no inline anchor, or that GitHub's Reviews API refused,
  // would otherwise vanish (spec §Publish hardening).
  const sections = [
    buildClusterSection(body.clusters),
    buildUnanchoredSection(body.unanchored),
    buildDroppedSection(body.dropped),
  ];
  for (const section of sections) if (section !== "") blocks.push(section.trimEnd());

  const trailing = [
    buildMechanicalSection(body.mechanical, body.llmErrored),
    // Per-file coverage: what was reviewed, carried, excluded, or NOT reviewed.
    body.ledger.trimEnd(),
    body.reviewPlan !== "" ? details("<b>Review plan</b>", body.reviewPlan) : "",
    body.otherChecks !== "" ? details("<b>Other checks</b>", body.otherChecks) : "",
    body.enhancement ? buildJevSection(body.enhancement) : "",
    body.history.trimEnd(),
  ].filter((block) => block !== "");
  if (trailing.length > 0) blocks.push("### Review details", ...trailing);

  blocks.push(body.verdictLabel);
  if (body.marker !== "") blocks.push(body.marker);
  return `${blocks.join("\n\n")}\n`;
}

/**
 * The verdict checklist, right under the Code Review heading. Full mode lists the
 * five static review phases; compact mode collapses them to a single checked line
 * naming the file count. BOTH keep ≥1 `- [x]` box and none unchecked — parse-verdict.sh derives review
 * completeness from the checkbox counts (state "complete" = ≥1 checked, none unchecked).
 */
function buildChecklist(body: ReviewBody): string {
  if (body.compact) {
    // "N-file diff", not "N changed files reviewed": on a scoped review
    // (full_review=false) the model is focus-directed but still receives the whole
    // diff, so the diff size is the only count this line can honestly claim.
    return `- [x] Reviewed ${body.changedFiles}-file diff — verdict set`;
  }
  return (
    "- [x] Read repository context and PR diff\n" +
    "- [x] Review changed files\n" +
    "- [x] Analyze correctness, security, performance\n" +
    "- [x] Post findings\n" +
    `- [x] Set verdict label (${body.verdictLabel})`
  );
}

/**
 * The Mechanical-checks status line — a per-tool count of the deterministic
 * findings (uploaded to the Code Scanning tab), plus, when the LLM errored, a
 * "judgment unavailable" alert so a provider failure still yields a useful review
 * (graceful degradation). Empty deterministic set → "" (omitted) unless the LLM
 * errored too.
 */
export function buildMechanicalSection(
  mechanical: MechanicalFinding[],
  llmErrored: boolean,
): string {
  if (mechanical.length === 0) {
    return llmErrored
      ? alert("WARNING", "LLM judgment unavailable", "no deterministic findings either.")
      : "";
  }
  const byTool = new Map<string, number>();
  for (const f of mechanical) byTool.set(f.tool, (byTool.get(f.tool) ?? 0) + 1);
  const counts = [...byTool.entries()].map(([tool, n]) => `${n} ${tool}`).join(", ");
  const line =
    `**Mechanical checks** · ${mechanical.length} deterministic finding(s) — ${counts}. ` +
    "See the **Code Scanning** tab for details.";
  if (!llmErrored) return line;
  return `${line}\n\n${alert("WARNING", "LLM judgment unavailable", "showing deterministic findings only.")}`;
}

/**
 * The Top-N must-fix section body — derived from the surviving findings, sorted by
 * severity and capped at three, each text flattened to one line. This summary cannot
 * resurrect an unvalidated claim.
 */
function buildTopMustFixSection(findings: Finding[]): string {
  return (
    [...findings]
      .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
      .slice(0, TOP_MUST_FIX_MAX)
      // One line per item: a multi-line text would spill into pr-babysit's must_fix scan
      // and could carry a `### ` line that ends the section early.
      .map((f) => `- \`${f.path}:${f.line}\` — ${f.text.trim().replace(/\s*\n\s*/g, " ")}`)
      .join("\n")
  );
}

/**
 * The severity summary line, e.g. "🔴 1 blocker 🟠 2 high". Counts each severity
 * present and joins with spaces; empty string when there are no findings, so the
 * verdict line ends at the badge.
 */
export function buildSeveritySummary(findings: Finding[]): string {
  const counts = { blocker: 0, high: 0, medium: 0, low: 0, nit: 0 };
  for (const f of findings) counts[f.severity]++;
  const parts: string[] = [];
  if (counts.blocker > 0) parts.push(`🔴 ${counts.blocker} blocker`);
  if (counts.high > 0) parts.push(`🟠 ${counts.high} high`);
  if (counts.medium > 0) parts.push(`🟡 ${counts.medium} medium`);
  if (counts.low > 0) parts.push(`🔵 ${counts.low} low`);
  if (counts.nit > 0) parts.push(`⚪ ${counts.nit} nit`);
  return parts.join(" ");
}
