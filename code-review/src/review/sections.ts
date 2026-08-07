// review/sections.ts — the verdict comment's size-proof sections, split out of
// review/render.ts (at its file-size budget): the findings GitHub could not anchor
// inline, the ones its Reviews API rejected outright, and the clustered repeats.
// The coverage-ledger section is rendered by review/ledger.ts itself and merely
// placed by render.ts.
//
// Every section here is HARD-CAPPED by construction: they exist because a huge PR
// produces huge lists, so none may grow with PR size. What is dropped is stated
// in the body, never silently.
import type { Finding } from "@/llm/schema.js";
import type { FindingCluster } from "@/review/cluster.js";

/** Cap on rendered per-finding rows in the two publish-failure sections — the
 *  rest are counted, not listed. */
const MAX_UNANCHORED_ROWS = 20;
/** Cap on rendered clusters, and on member paths listed inside one. */
const MAX_CLUSTERS = 10;
const MAX_MEMBERS_LISTED = 10;

/** `path:line` for a finding, or just `path` when it carries no line. */
function locationOf(f: { path: string; line?: number | null }): string {
  return f.line !== undefined && f.line !== null ? `${f.path}:${f.line}` : f.path;
}

/** The member paths a cluster stands for, capped at {@link MAX_MEMBERS_LISTED}
 *  with the remainder counted — never listed, so this cannot grow with PR size. */
function memberPaths(members: readonly { path: string }[]): string {
  const listed = members.slice(0, MAX_MEMBERS_LISTED).map((m) => `\`${m.path}\``);
  const hidden = members.length - listed.length;
  return hidden > 0 ? `${listed.join(", ")}, … ${hidden} more` : listed.join(", ");
}

/** "Same finding in N files: …" — which files this one finding stands for. */
function sameFindingLine(members: readonly { path: string }[]): string {
  return `Same finding in ${members.length} files: ${memberPaths(members)}`;
}

/** The settlement warning. Load-bearing, not decoration: `reconcile` settles the
 *  WHOLE cluster when a human resolves or dismisses the exemplar's thread. */
function dismissalLine(count: number): string {
  return `_Dismissing this thread dismisses the pattern (${count} files)._`;
}

/**
 * The two facts a cluster body must carry, as a standalone block: which files the
 * finding repeats in, and that settling this one thread settles all of them.
 *
 * Rendered in TWO places from this one builder (AC-4): the sticky comment's
 * "Repeated findings" section below, and — appended by pipeline/reduce.ts's
 * `decorateExemplars` — the EXEMPLAR'S OWN INLINE COMMENT, which is the body the
 * author actually reads before deciding to dismiss the thread. Appending it there
 * cannot rotate the thread's identity: the fingerprint is stamped upstream from the
 * raw finding text and github/review.ts prefers that stamped `fp`.
 */
export function clusterMemberNote(members: readonly { path: string }[]): string {
  return `${sameFindingLine(members)}\n\n${dismissalLine(members.length)}`;
}

/**
 * The "### Unanchored findings" section: findings whose file GitHub does not show
 * in its own PR diff (no `patch` — it omits them on huge diffs), so no inline
 * comment can exist for them (spec §Publish hardening). They are real findings and
 * must be readable somewhere; this is that somewhere. Empty list → "".
 */
export function buildUnanchoredSection(findings: Finding[]): string {
  if (findings.length === 0) return "";
  return (
    `### Unanchored findings (${findings.length})\n\n` +
    "GitHub does not show these files in its own diff of this PR, so they cannot carry an " +
    "inline comment. They are reported here instead.\n\n" +
    `${findingRows(findings)}\n\n`
  );
}

/**
 * The "### Findings GitHub rejected inline" section: findings whose comment the
 * Reviews API answered 422 to even after batch bisection isolated it ALONE
 * (`InlineReviewResult.dropped`, github/reviewBatch.ts). Unlike an unanchored
 * finding — where we know up front no anchor exists — this one looked postable and
 * GitHub refused it, so the reason is opaque and the finding would otherwise
 * disappear from the review entirely. Empty list → "".
 */
export function buildDroppedSection(findings: Finding[]): string {
  if (findings.length === 0) return "";
  return (
    `### Findings GitHub rejected inline (${findings.length})\n\n` +
    "GitHub's Reviews API rejected these comments (422) even posted one at a time, so they " +
    "could not be attached to their lines. They are reported here instead.\n\n" +
    `${findingRows(findings)}\n\n`
  );
}

/** One `- \`path:line\`: severity: text` row per finding, capped at
 *  {@link MAX_UNANCHORED_ROWS} with the remainder counted on a trailing line. */
function findingRows(findings: Finding[]): string {
  const shown = findings.slice(0, MAX_UNANCHORED_ROWS);
  const lines = shown.map((f) => `- \`${locationOf(f)}\`: ${f.severity}: ${f.text}`);
  const extra = findings.length - shown.length;
  if (extra > 0) lines.push(`_… ${extra} more_`);
  return lines.join("\n");
}

/**
 * The "### Repeated findings" section: one block per MULTI-member cluster
 * (review/cluster.ts) — the exemplar's line, the member paths it stands for, and
 * the settlement note. The note is load-bearing, not decoration: `reconcile`
 * settles the WHOLE cluster when a human resolves or dismisses the exemplar's
 * thread (spec §Layer 3), and the author must be told that before they click.
 * Singletons and an empty list → "".
 */
export function buildClusterSection(clusters: FindingCluster[]): string {
  const repeated = clusters.filter((c) => c.members.length > 1);
  if (repeated.length === 0) return "";
  const shown = repeated.slice(0, MAX_CLUSTERS);
  const blocks = shown.map(clusterBlock);
  const extra = repeated.length - shown.length;
  if (extra > 0) blocks.push(`_… ${extra} more repeated finding(s)_`);
  return (
    `### Repeated findings (${repeated.length})\n\n` +
    "Each of these is one finding repeated across several files. It is posted once, on its " +
    "exemplar; resolving or dismissing that thread settles the whole pattern.\n\n" +
    `${blocks.join("\n\n")}\n\n`
  );
}

/** One cluster's block: exemplar line, enumerated members, dismissal note — the
 *  same two facts {@link clusterMemberNote} carries, as nested list items. */
function clusterBlock(cluster: FindingCluster): string {
  const { exemplar, members } = cluster;
  const category = exemplar.category !== undefined ? ` _(${exemplar.category})_` : "";
  return (
    `- \`${locationOf(exemplar)}\`${category}: ${exemplar.severity}: ${exemplar.text}\n` +
    `  - ${sameFindingLine(members)}\n` +
    `  - ${dismissalLine(members.length)}`
  );
}
