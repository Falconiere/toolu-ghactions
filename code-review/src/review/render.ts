// review/render.ts — the markdown body builder for the verdict comment. Split
// out of verdict.ts (which owns the verdict→label mapping and the size-cap loop)
// so each file stays under 300 LOC. Pure string assembly: every section here is
// a line-for-line port of format-verdict.sh's render_body and its helpers.
import type { Finding } from "@/llm/schema.js";
import type { MechanicalFinding } from "@/mechanical/sarif.js";

/** Severity rank, blocker (worst) → nit (least). Used to order/shrink findings. */
export const SEVERITY_RANK: Record<Finding["severity"], number> = {
  blocker: 0,
  high: 1,
  medium: 2,
  low: 3,
  nit: 4,
};

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
  /** The model's review plan ("" → default note). */
  reviewPlan: string;
  /** The model's other-checks blurb ("" → default note). */
  otherChecks: string;
  /** The model's explicit top-must-fix list (empty → auto-generated). */
  topMustFix: string[];
  /** All findings (after validation). */
  findings: Finding[];
  /** Pre-rendered recap markdown ("" when absent). */
  recap: string;
  /** Pre-rendered history markdown ("" when absent). */
  history: string;
  /** Pre-encoded state marker, appended verbatim as the LAST line ("" → omit). */
  marker: string;
  /** Deterministic findings (gitleaks/opengrep) for the Mechanical-checks summary ([] → omit). */
  mechanical: MechanicalFinding[];
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
  main += "- [x] Read repository context and PR diff\n";
  main += "- [x] Review changed files\n";
  main += "- [x] Analyze correctness, security, performance\n";
  main += "- [x] Post findings\n";
  main += `- [x] Set verdict label (${body.verdictLabel})\n\n`;
  main += `**Verdict:** ${body.verdictBadge}   ${buildSeveritySummary(body.findings)}`;
  // Surface the real provider-error message (not just the generic badge) so a failed
  // review is diagnosable from the comment alone.
  if (body.errorDetail !== "") main += `\n\n> ⚠️ **Provider error:** ${body.errorDetail}`;
  parts.push(main);

  if (body.recap !== "") parts.push(`\n${body.recap}\n`);

  let section = "\n";
  section += "### Review Plan\n";
  section += `${body.reviewPlan !== "" ? body.reviewPlan : "_No review plan provided._"}\n\n`;
  section += `### Findings (${body.findings.length})\n\n`;
  section += `${findingsSection}\n\n`;
  section += buildMechanicalSection(body.mechanical, body.errorDetail !== "");
  section += "### Other checks\n";
  section += `${body.otherChecks !== "" ? body.otherChecks : "_No additional checks performed._"}\n\n`;
  section += "### Top-N must-fix\n";
  section += buildTopMustFixSection(body);
  parts.push(section);

  if (body.history !== "") parts.push(`\n${body.history}\n`);
  parts.push(`\n${body.verdictLabel}\n`);
  if (body.marker !== "") parts.push(`\n${body.marker}\n`);

  return parts.join("");
}

/**
 * The findings list — one line per finding, `path:line`: severity: text plus an
 * optional italic "(category · confidence)" suffix. "_No findings._" when empty.
 */
export function buildFindingsSection(findings: Finding[]): string {
  if (findings.length === 0) return "_No findings._";
  return findings.map(findingLine).join("\n");
}

/**
 * Findings shrunk to the highest-severity `keep`, with a trailing
 * "_… N more findings — see the [job log](url)_" note. Used by the size guard.
 */
export function buildTruncatedFindingsSection(
  findings: Finding[],
  keep: number,
  jobUrl: string,
): string {
  const ordered = [...findings].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );
  const shown = ordered.slice(0, keep);
  const lines = shown.map(findingLine);
  const extra = findings.length - keep;
  if (extra > 0) lines.push(`_… ${extra} more findings — see the [job log](${jobUrl})_`);
  return lines.join("\n");
}

/** One finding line: ``path:line`` [source]: severity: text (category · confidence). */
function findingLine(f: Finding): string {
  const loc = f.line !== undefined && f.line !== null ? `:${f.line}` : "";
  // Provenance tag for findings the model confirmed from a deterministic tool.
  const src = f.source !== undefined && f.source !== "llm" ? ` _[${f.source}]_` : "";
  const meta = [f.category, f.confidence].filter((x): x is string => x !== undefined && x !== "");
  const suffix = meta.length > 0 ? ` _(${meta.join(" · ")})_` : "";
  return `\`${f.path}${loc}\`${src}: ${f.severity}: ${f.text}${suffix}`;
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
 * The Top-N must-fix section. Uses the model's explicit list when non-empty;
 * otherwise auto-generates from blocker/high findings, falling back to the first
 * three findings, falling back to "_None._" — exactly as build_top_must_fix_section.
 */
function buildTopMustFixSection(body: ReviewBody): string {
  // Parity with coordinate-findings.sh `unique | .[0:3]`: drop duplicates and cap
  // at 3. Insertion order is kept (the model lists these worst-first, so priority
  // must survive — unlike jq's alphabetical `unique`, which would scramble it).
  const capped = dedupeCap(body.topMustFix, TOP_MUST_FIX_MAX);
  if (capped.length > 0) return capped.join("\n");

  const highSev = body.findings.filter((f) => f.severity === "blocker" || f.severity === "high");
  if (highSev.length > 0) return highSev.map(mustFixLine).join("\n");
  if (body.findings.length > 0) return body.findings.slice(0, 3).map(mustFixLine).join("\n");
  return "_None._";
}

/** Dedupe a string list keeping first occurrence (insertion order), then cap to `max`. */
function dedupeCap(items: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length === max) break;
  }
  return out;
}

/** Auto-generated must-fix line: **`path:line`** — text. */
function mustFixLine(f: Finding): string {
  const loc = f.line !== undefined && f.line !== null ? `:${f.line}` : "";
  return `**\`${f.path}${loc}\`** — ${f.text}`;
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
