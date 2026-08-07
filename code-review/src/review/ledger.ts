// review/ledger.ts — the per-path coverage ledger (spec §Coverage ledger): every
// changed path gets exactly one CoverageEntry, and renderLedger produces a
// size-safe markdown section (counts-per-status summary always; per-path rows
// only for the exception statuses, hard-capped) that joins fitToSizeLimit's
// shrink ladder (src/review/verdict.ts) ahead of findings.
import type { DroppedFile } from "@/git/diff.js";
import type { Stratum } from "@/git/distill.js";

/** Every possible per-path outcome a review round can record. */
export type CoverageStatus =
  | "reviewed"
  | "pattern"
  | "rename"
  | "formatting"
  | "vendored"
  | "generated"
  | "excluded"
  | "carried"
  | "unreviewed"
  | "pending";

/** One path's coverage outcome. `reason` carries e.g. `DroppedFile.reason` for
 *  "excluded" ("lockfile", "build-output", "large-file", "minified", "binary", …). */
export interface CoverageEntry {
  status: CoverageStatus;
  reason?: string;
}

/** Every changed path maps to exactly one entry (AC-8: changed_files ∪
 *  binary_files ∪ dropped_files, counts summing to total_files). */
export interface CoverageLedger {
  entries: Record<string, CoverageEntry>;
}

/** Hard cap on per-path exception rows rendered — the size-safety valve on an
 *  arbitrarily large PR (AC-8: a 1 000-path ledger must render under 2 KB). */
export const LEDGER_MAX_ROWS = 50;

/** Canonical status order for the summary line — deterministic regardless of how
 *  the ledger's entries map was built (insertion order is NOT relied on). */
const STATUS_ORDER: readonly CoverageStatus[] = [
  "reviewed",
  "pattern",
  "rename",
  "formatting",
  "vendored",
  "generated",
  "excluded",
  "carried",
  "unreviewed",
  "pending",
];

/** Statuses that ALWAYS get per-path rows once present, in any verbosity — the
 *  spec's "exceptions are always visible" intent: an attempted-and-failed or
 *  not-yet-attempted path must never hide behind a summary count alone. */
const ALWAYS_ROW_STATUSES: ReadonlySet<CoverageStatus> = new Set(["unreviewed", "pending"]);

/**
 * Build a ledger from `[path, entry]` pairs. Last write wins per path, so
 * accumulating from several sources (distill strata, dropped files, binary
 * files, review-phase outcomes) in a fixed, documented order is the caller's
 * responsibility — this just materializes the map.
 */
export function buildLedger(entries: Iterable<readonly [string, CoverageEntry]>): CoverageLedger {
  const out: Record<string, CoverageEntry> = {};
  for (const [path, entry] of entries) out[path] = entry;
  return { entries: out };
}

/** Everything one review round contributes to its ledger. Every path in
 *  `changedFiles ∪ binaryFiles ∪ droppedFiles ∪ carried` gets exactly one entry
 *  (AC-8), resolved by {@link buildRoundLedger}'s documented precedence. */
export interface RoundLedgerInput {
  /** This round's IN-SCOPE changed (text) paths — `DiffData.changed_files`. */
  changedFiles: readonly string[];
  /** `DiffData.binary_files` — a reason-less bucket, ledgered `excluded (binary)`. */
  binaryFiles: readonly string[];
  /** `DiffData.dropped_files` — ledgered `excluded` with their own reason. */
  droppedFiles: readonly DroppedFile[];
  /** Layer 0's classification, one stratum per in-scope path (git/distill.ts). */
  strata: Readonly<Record<string, Stratum>>;
  /** Pattern-group exemplars: collapsed members' stand-ins, actually reviewed. */
  exemplars: ReadonlySet<string>;
  /** Layer 2's per-path outcomes, as reported through `reviewChunked`'s `onCoverage`. */
  coverage: ReadonlyMap<string, CoverageEntry>;
  /** Changed paths OUTSIDE this round's tree scope: not re-reviewed, findings
   *  carried forward (spec §True incremental). */
  carried: readonly string[];
  /** Paths whose prior finding failed carry-forward's strict shape check — carried
   *  WITHOUT a finding (pipeline/carry.ts's `carriedWithoutFinding`). */
  carriedWithoutFinding?: readonly string[];
}

/**
 * Assemble one round's ledger from every source that knows something about a path.
 *
 * Precedence, highest first — the order is the contract:
 *  1. `dropped`/`binary` — excluded before diffing, so no later source saw them;
 *  2. `carried` (out of tree scope, or carried-without-finding) — this round never
 *     looked at the path, whatever a stale stratum might say;
 *  3. a non-`substantive` stratum on a path that is NOT a pattern exemplar —
 *     `pattern`/`rename`/`formatting`/`vendored`/`generated` files are deliberately
 *     absent from the review diff, so a coverage event naming them (the whole-diff
 *     fast path reports `DiffData.changed_files`, which distill keeps FULL) must not
 *     claim they were read;
 *  4. Layer 2's coverage outcome — `reviewed`/`unreviewed`/`pending`;
 *  5. nothing at all → `unreviewed (not-attempted)`, loud by design: a path no layer
 *     accounted for is exactly the silent coverage loss this ledger exists to catch.
 */
export function buildRoundLedger(input: RoundLedgerInput): CoverageLedger {
  const carried = new Set([...input.carried, ...(input.carriedWithoutFinding ?? [])]);
  // Set, not `changedFiles.includes` — the membership test below runs once per
  // carried path, and a linear scan per probe is O(carried × changedFiles) on the
  // very PRs (thousands of paths) this ledger exists to account for.
  const changed = new Set(input.changedFiles);
  const entries: Array<readonly [string, CoverageEntry]> = [];

  for (const path of input.changedFiles) {
    entries.push([path, changedFileEntry(path, carried, input)]);
  }
  for (const path of carried) {
    if (!changed.has(path)) entries.push([path, { status: "carried" }]);
  }
  for (const path of input.binaryFiles) entries.push([path, binaryFileEntry()]);
  for (const dropped of input.droppedFiles) entries.push([dropped.path, droppedFileEntry(dropped)]);
  return buildLedger(entries);
}

/** Rules 2-5 of {@link buildRoundLedger}'s precedence for one in-scope path. */
function changedFileEntry(
  path: string,
  carried: ReadonlySet<string>,
  input: RoundLedgerInput,
): CoverageEntry {
  if (carried.has(path)) return { status: "carried" };
  const stratum = input.strata[path];
  if (stratum !== undefined && stratum !== "substantive" && !input.exemplars.has(path)) {
    return { status: stratum };
  }
  return input.coverage.get(path) ?? { status: "unreviewed", reason: "not-attempted" };
}

/** Map a dropped file (`DiffData.dropped_files`) to its ledger entry: excluded,
 *  the drop reason carried alongside verbatim. */
export function droppedFileEntry(dropped: DroppedFile): CoverageEntry {
  return { status: "excluded", reason: dropped.reason };
}

/** Map a binary file (`DiffData.binary_files` — a separate, reason-less bucket,
 *  `src/git/diff.ts:221-224`) to its ledger entry: excluded, synthesized reason. */
export function binaryFileEntry(): CoverageEntry {
  return { status: "excluded", reason: "binary" };
}

/**
 * Render the ledger as a markdown section.
 *
 * Always: a single counts-per-status summary line, non-zero statuses only, in
 * {@link STATUS_ORDER}. Per-path rows render ONLY for `unreviewed`/`pending`
 * (always, in both verbosities — an exception must stay visible) and, in
 * `"full"` verbosity only, `excluded` too (its `reason` shown per row). Rows are
 * sorted by path for determinism and hard-capped at {@link LEDGER_MAX_ROWS} with
 * a trailing "… N more" line. No rows at all (clean ledger, or a compact ledger
 * with no unreviewed/pending) renders as the summary line alone.
 */
export function renderLedger(ledger: CoverageLedger, verbosity: "compact" | "full"): string {
  const paths = Object.keys(ledger.entries).sort();
  const summary = renderSummary(ledger.entries, paths);

  const rowStatuses: ReadonlySet<CoverageStatus> =
    verbosity === "full" ? new Set([...ALWAYS_ROW_STATUSES, "excluded"]) : ALWAYS_ROW_STATUSES;
  const rowPaths = paths.filter((p) => {
    const status = ledger.entries[p]?.status;
    return status !== undefined && rowStatuses.has(status);
  });

  if (rowPaths.length === 0) return `### Coverage\n\n${summary}\n`;

  const shown = rowPaths.slice(0, LEDGER_MAX_ROWS);
  const lines = shown.map((p) => renderRow(p, ledger.entries[p]));
  const overflow = rowPaths.length - shown.length;
  if (overflow > 0) lines.push(`… ${overflow} more`);

  return `### Coverage\n\n${summary}\n\n${lines.join("\n")}\n`;
}

/**
 * The ledger section reduced to its counts-per-status summary — the RUNG BELOW
 * {@link renderLedger} on `fitToSizeLimit`'s shrink ladder (src/review/verdict.ts):
 * an over-size body drops the per-path exception rows before it drops the section,
 * and drops the section before it starts shrinking findings.
 */
export function renderLedgerSummary(ledger: CoverageLedger): string {
  const paths = Object.keys(ledger.entries).sort();
  return `### Coverage\n\n${renderSummary(ledger.entries, paths)}\n`;
}

/** Every path carrying `status`, sorted — the marker's exception lists
 *  (`unreviewed_paths`/`pending_paths`) and the verdict degrade read this. */
export function pathsWithStatus(ledger: CoverageLedger, status: CoverageStatus): string[] {
  return Object.keys(ledger.entries)
    .filter((p) => ledger.entries[p]?.status === status)
    .sort();
}

/** The counts-per-status summary line: only non-zero statuses, canonical order. */
function renderSummary(entries: Record<string, CoverageEntry>, paths: string[]): string {
  const counts: Record<CoverageStatus, number> = {
    reviewed: 0,
    pattern: 0,
    rename: 0,
    formatting: 0,
    vendored: 0,
    generated: 0,
    excluded: 0,
    carried: 0,
    unreviewed: 0,
    pending: 0,
  };
  for (const p of paths) {
    const status = entries[p]?.status;
    if (status !== undefined) counts[status] += 1;
  }
  const parts = STATUS_ORDER.filter((s) => counts[s] > 0).map((s) => `${s}: ${counts[s]}`);
  return parts.length > 0 ? parts.join(" · ") : "_no changed files_";
}

/** One exception row: `- \`path\`: status` with `(reason)` appended when present. */
function renderRow(path: string, entry: CoverageEntry | undefined): string {
  const status = entry?.status ?? "unreviewed";
  const reason = entry?.reason;
  const reasonSuffix = reason !== undefined && reason !== "" ? ` (${reason})` : "";
  return `- \`${path}\`: ${status}${reasonSuffix}`;
}
