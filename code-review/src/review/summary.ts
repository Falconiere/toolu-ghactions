// review/summary.ts — the presentational blocks of the verdict comment's summary,
// split out of review/render.ts (at its size budget) when the comment moved to the
// toolu PR-comment layout: a compact header meta line, the <kbd> verdict pill, the
// stat tiles, GitHub alerts and collapsed <details> sections.
//
// GitHub sanitizes comment HTML (no style/class/CSS), so every block here is built
// only from what its renderer keeps: <sub>, <kbd>, <table>/<td width>, <h3>,
// <details>/<summary> and `> [!KIND]` alerts.
import type { Finding } from "@/llm/schema.js";
import type { MechanicalFinding } from "@/mechanical/sarif.js";
import type { CoverageStatus } from "@/review/ledger.js";
import { enhancementNote, type EnhancementSummary } from "@/jev/enhance.js";

/** Severity order for the FINDINGS caption, worst first. */
const SEVERITY_ORDER: readonly Finding["severity"][] = ["blocker", "high", "medium", "low", "nit"];

/** Ledger statuses kept out of the review diff on purpose (noise filter, linguist
 *  attributes, Layer 0 distill) — the REVIEWED tile's "filtered" count. */
const FILTERED: readonly CoverageStatus[] = [
  "pattern",
  "rename",
  "formatting",
  "vendored",
  "generated",
  "excluded",
];

/**
 * The verdict line: `**Verdict:** <kbd>{badge}</kbd>` plus the severity summary.
 * The `**Verdict:**` prefix is a parser contract (pr-babysit reads the badge from
 * it; review/settledBody.ts rewrites the line by it), so this is the ONE builder
 * both the renderer and the settle patch use.
 */
export function verdictLine(badge: string, severity = ""): string {
  const tail = severity !== "" ? ` ${severity}` : "";
  return `**Verdict:** <kbd>${badge}</kbd>${tail}`;
}

/** The small meta line beside the bot name: duration, short head sha, job link. */
export function headerMeta(opts: { duration?: string; sha?: string; jobUrl: string }): string {
  const parts: string[] = [];
  if (opts.duration) parts.push(`finished in ${opts.duration}`);
  if (opts.sha) parts.push(`\`${opts.sha.slice(0, 7)}\``);
  parts.push(`[View job](${opts.jobUrl})`);
  return `<sub>${parts.join(" · ")}</sub>`;
}

/** A GitHub alert. Every line of `text` is quoted, so a multi-line error detail
 *  stays inside the one alert instead of spilling out as body text. */
export function alert(kind: "NOTE" | "WARNING" | "CAUTION", title: string, text: string): string {
  const lines = `**${title}:** ${text}`.split("\n").map((line) => `> ${line}`);
  return [`> [!${kind}]`, ...lines].join("\n");
}

/**
 * A collapsed section. The blank lines around the body are required for GitHub to
 * render markdown inside it. A closing tag in the body (model-authored plans can
 * quote one) is escaped so it cannot end the block early.
 */
export function details(summary: string, body: string): string {
  const safe = body.replace(/<\/details\s*>/gi, "&lt;/details&gt;");
  return `<details><summary>${summary}</summary>\n\n${safe}\n\n</details>`;
}

/** What the stat tiles count. */
export interface TileStats {
  /** This pass's findings (the comment's representatives). */
  findings: readonly Finding[];
  /** Ledger counts per status; absent → REVIEWED falls back to `changedFiles`. */
  coverage?: Readonly<Record<CoverageStatus, number>>;
  /** File count of the reviewed diff. */
  changedFiles: number;
  /** Review-memory tally over the stored (≤10) history; absent when memory is off. */
  memory?: { passes: number; resolved: number };
  /** Deterministic findings (gitleaks/opengrep). */
  mechanical: readonly MechanicalFinding[];
}

/**
 * The stat tiles: FINDINGS and REVIEWED always; RESOLVED with review memory; a
 * fourth tile for CARRIED paths, else SCANNERS when deterministic tools flagged
 * anything. One `<td>` per tile, equal widths.
 */
export function buildTiles(stats: TileStats): string {
  const tiles = [findingsTile(stats.findings)];
  if (stats.memory) tiles.push(resolvedTile(stats.memory));
  tiles.push(reviewedTile(stats.coverage, stats.changedFiles));
  const carried = stats.coverage?.carried ?? 0;
  if (carried > 0)
    tiles.push(tile("CARRIED", `${carried} <sub>FILES</sub>`, "from earlier passes"));
  else if (stats.mechanical.length > 0) tiles.push(scannersTile(stats.mechanical));

  const width = Math.floor(100 / tiles.length);
  const row = tiles.map((cell) => `<td width="${width}%">${cell}</td>`).join("\n");
  return `<table>\n<tr>\n${row}\n</tr>\n</table>`;
}

/** The Jev block: counters in the body, the headline counts in the summary. */
export function buildJevSection(s: EnhancementSummary): string {
  const bits = [`${s.assessed} assessed`];
  if (s.unavailable > 0) bits.push(`${s.unavailable} unavailable`);
  if (s.skipReason !== undefined) bits.push("skipped");
  return details(`<b>Jev second opinion</b> · ${bits.join(" · ")}`, enhancementNote(s));
}

/** One tile's inner HTML: small label, big value, small caption. */
function tile(label: string, value: string, caption: string): string {
  return `<sub>${label}</sub><h3>${value}</h3><sub>${caption}</sub>`;
}

function findingsTile(findings: readonly Finding[]): string {
  if (findings.length === 0) return tile("FINDINGS", "0", "on this pass");
  const counts = new Map<Finding["severity"], number>();
  for (const f of findings) counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1);
  const caption = SEVERITY_ORDER.filter((s) => counts.has(s))
    .map((s) => `${counts.get(s)} ${s}`)
    .join(" · ");
  return tile("FINDINGS", String(findings.length), caption);
}

function resolvedTile(memory: { passes: number; resolved: number }): string {
  const caption = memory.passes === 1 ? "first pass" : `across ${memory.passes} passes`;
  return tile("RESOLVED", String(memory.resolved), caption);
}

function reviewedTile(
  coverage: Readonly<Record<CoverageStatus, number>> | undefined,
  changedFiles: number,
): string {
  if (coverage === undefined) {
    return tile("REVIEWED", `${changedFiles} <sub>FILES</sub>`, "files in diff");
  }
  const value = `${coverage.reviewed} <sub>FILES</sub>`;
  const total = Object.values(coverage).reduce((sum, n) => sum + n, 0);
  if (total === 0) return tile("REVIEWED", value, "no changed files");
  const missing = coverage.unreviewed + coverage.pending;
  if (missing > 0) return tile("REVIEWED", value, `⚠️ ${missing} not reviewed`);
  const filtered = FILTERED.reduce((sum, status) => sum + coverage[status], 0);
  return tile("REVIEWED", value, filtered > 0 ? `${filtered} filtered` : "nothing filtered");
}

function scannersTile(mechanical: readonly MechanicalFinding[]): string {
  const byTool = new Map<string, number>();
  for (const f of mechanical) byTool.set(f.tool, (byTool.get(f.tool) ?? 0) + 1);
  const caption = [...byTool.entries()].map(([tool, n]) => `${n} ${tool}`).join(" · ");
  return tile("SCANNERS", String(mechanical.length), caption);
}
