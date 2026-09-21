// review/render.ts — the markdown body builder for the verdict comment. Split
// out of verdict.ts (which owns the verdict→label mapping and the size-cap loop)
// so each file stays under 300 LOC. Pure string assembly: every section here is
// a line-for-line port of format-verdict.sh's render_body and its helpers.
import type { Finding } from "@/llm/schema.js";
import type { MechanicalFinding } from "@/mechanical/sarif.js";
import type { FindingCluster } from "@/review/cluster.js";
import { SEVERITY_RANK } from "./findings.js";
import {
  buildClusterSection,
  buildDroppedSection,
  buildUnanchoredSection,
} from "@/review/sections.js";

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
  /** The header line ("**AI Code Review finished …** —— [View job](url)"). */
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
  /** Findings GitHub could not anchor inline — rendered in their own section. */
  unanchored: Finding[];
  /** Findings whose inline comment GitHub rejected (422) even posted alone. */
  dropped: Finding[];
  /** This round's clusters; the multi-member ones get an enumerated block. */
  clusters: FindingCluster[];
}

/**
 * Render the full comment body for a given findings list (the size-cap loop
 * calls this with progressively shrunk findings). The recap, history, and marker
 * are emitted unconditionally so the size guard can only ever shrink findings,
 * never the memory blocks. The marker, when present, is always the last line.
 */
export function renderBody(body: ReviewBody, findingsSection: string): string {
  const parts: string[] = [];
  parts.push(`<img src="${body.botLogoUrl}" width="20" align="left"> **${body.botName}**\n`);

  let main = `${body.header}\n\n`;
  main += "---\n";
  main += `### Code Review — \`${body.branch}\`\n\n`;
  main += buildChecklist(body);
  main += `**Verdict:** ${body.verdictBadge}   ${buildSeveritySummary(body.findings)}`;
  // Surface the real provider-error message (not just the generic badge) so a failed
  // review is diagnosable from the comment alone. Label honestly: "Provider error"
  // only when the LLM actually abstained; a recovered/partly-failed review that still
  // produced a verdict is a "Partial review", not an error.
  if (body.errorDetail !== "") {
    const label = body.llmErrored ? "Provider error" : "Partial review";
    main += `\n\n> ⚠️ **${label}:** ${body.errorDetail}`;
  }
  // The MAX_ROUNDS surrender is a verdict override — say so right under the verdict
  // so an auto-approved round is never mistaken for a clean review.
  if (body.capNote !== "") main += `\n\n> 🔁 **Round cap:** ${body.capNote}`;
  parts.push(main);

  if (body.recap !== "") parts.push(`\n${body.recap}\n`);

  let section = "\n";
  // Review Plan / Other checks render ONLY when the model supplied text — the old
  // "_No … provided._" filler was pure noise on the common empty case.
  if (body.reviewPlan !== "") section += `### Review Plan\n${body.reviewPlan}\n\n`;
  // Findings is unconditional: parse-verdict.sh extracts findings from this exact block.
  section += `### Findings (${body.findings.length})\n\n`;
  section += `${findingsSection}\n\n`;
  // A repeated finding is posted once, on its exemplar — this is where the files it
  // stands for are named, and where the "dismissing it dismisses the pattern" rule
  // is stated (spec §Layer 3).
  section += buildClusterSection(body.clusters);
  // Findings with no possible inline anchor would otherwise vanish entirely.
  section += buildUnanchoredSection(body.unanchored);
  // …and so would the ones GitHub's Reviews API refused outright (spec §Publish
  // hardening: bisection "posts the survivors, and reports the dropped ones").
  section += buildDroppedSection(body.dropped);
  section += buildMechanicalSection(body.mechanical, body.llmErrored);
  // Per-file coverage: what was reviewed, carried, excluded, or NOT reviewed.
  if (body.ledger !== "") section += `${body.ledger}\n`;
  if (body.otherChecks !== "") section += `### Other checks\n${body.otherChecks}\n\n`;
  // Top-N is derived from the same surviving findings the comment renders. Never
  // render independently generated model prose here: it may describe a claim the
  // evidence gate, scope filter, or settlement step already rejected.
  const topMustFix = buildTopMustFixSection(body.findings);
  if (topMustFix !== "") section += `### Top-N must-fix\n${topMustFix}`;
  parts.push(section);

  if (body.history !== "") parts.push(`\n${body.history}\n`);
  parts.push(`\n${body.verdictLabel}\n`);
  if (body.marker !== "") parts.push(`\n${body.marker}\n`);

  return parts.join("");
}

/**
 * The verdict checklist under the Code Review heading. Full mode lists the five static
 * review phases; compact mode collapses them to a single checked line naming the file
 * count. BOTH keep ≥1 `- [x]` box and none unchecked — parse-verdict.sh derives review
 * completeness from the checkbox counts (state "complete" = ≥1 checked, none unchecked).
 */
function buildChecklist(body: ReviewBody): string {
  if (body.compact) {
    // "N-file diff", not "N changed files reviewed": on a scoped review
    // (full_review=false) the model is focus-directed but still receives the whole
    // diff, so the diff size is the only count this line can honestly claim.
    const n = body.changedFiles;
    return `- [x] Reviewed ${n}-file diff — verdict set\n\n`;
  }
  return (
    "- [x] Read repository context and PR diff\n" +
    "- [x] Review changed files\n" +
    "- [x] Analyze correctness, security, performance\n" +
    "- [x] Post findings\n" +
    `- [x] Set verdict label (${body.verdictLabel})\n\n`
  );
}

/**
 * The "### Mechanical checks" section — a per-tool count of the deterministic
 * findings (uploaded to the Code Scanning tab), plus, when the LLM errored, a
 * "judgment unavailable" note so a provider failure still yields a useful review
 * (graceful degradation). Empty deterministic set → "" (section omitted).
 */
export function buildMechanicalSection(
  mechanical: MechanicalFinding[],
  llmErrored: boolean,
): string {
  if (mechanical.length === 0) {
    return llmErrored
      ? "> ⚠️ **LLM judgment unavailable** — no deterministic findings either.\n\n"
      : "";
  }
  const byTool = new Map<string, number>();
  for (const f of mechanical) byTool.set(f.tool, (byTool.get(f.tool) ?? 0) + 1);
  const counts = [...byTool.entries()].map(([tool, n]) => `${n} ${tool}`).join(", ");
  let out = "### Mechanical checks\n\n";
  out += `${mechanical.length} deterministic finding(s) — ${counts}. See the **Code Scanning** tab for details.\n`;
  if (llmErrored) {
    out += "\n> ⚠️ **LLM judgment unavailable** — showing deterministic findings only.\n";
  }
  return `${out}\n`;
}

/**
 * The Top-N must-fix section body — derived from the surviving findings, sorted by
 * severity and capped at three. This summary cannot resurrect an unvalidated claim.
 */
function buildTopMustFixSection(findings: Finding[]): string {
  return [...findings]
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
    .slice(0, TOP_MUST_FIX_MAX)
    .map((finding) => `- \`${finding.path}:${finding.line}\` — ${finding.text}`)
    .join("\n");
}

/**
 * The severity summary line, e.g. "🔴 1 blocker 🟠 2 high". Counts each severity
 * present and joins with spaces; empty string when there are no findings (the
 * bash emits nothing when no parts), so the Verdict line just trails a space.
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
