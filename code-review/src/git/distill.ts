// distill.ts — Layer 0 of the review pipeline (spec §Layer 0): deterministic,
// ZERO-TOKEN distillation of a fetched diff (git/diff.ts) into
//   (a) one stratum per changed path (every path classified exactly once),
//   (b) mechanical pattern groups (git/patterns.ts), and
//   (c) a SHRUNK `review_diff` carrying only the segments a model must read.
// Code, not the model, does all the collapsing — so prompt size is bounded by
// substantive change, not diff bytes.
//
// STRATA and what happens to each in `review_diff`:
//   substantive → kept verbatim (this is the fail-safe default: anything not
//                 PROVABLY mechanical is reviewed, so degradation spends tokens
//                 but never loses coverage);
//   pattern     → only the group's exemplar is kept; members are dropped.
//                 A finding on the exemplar is reported ONCE, on the exemplar —
//                 it does NOT fan out to members (spec §Layer 0). Members are
//                 ledgered `pattern`, distinguishable from "reviewed, clean";
//   rename      → dropped. Exact (R100) renames carry no hunks; the OLD side of
//                 every -M-detected rename likewise carries no content of its own.
//                 A NEAR-rename's new side stays substantive: under -M its segment
//                 already contains only the real edits, which is what gets reviewed;
//   formatting  → dropped (trailing-whitespace edits ONLY: in each run of changed
//                 lines, every removed line pairs in order with an added line equal
//                 after trimEnd(). Indentation, reordering and interior whitespace
//                 edits are substantive — see isWhitespaceOnly);
//   vendored /
//   generated   → dropped (linguist attributes).
//
// `review_diff` keeps the shaped `Lnnn: ` line-priming intact (whole segments are
// kept or dropped, never edited), so downstream chunking (git/chunk.ts) and line
// anchoring are unchanged. `total_lines`/`total_files`/`files` are recomputed over
// the KEPT segments, but `changed_files` deliberately stays the FULL list: the
// coverage ledger must still account for every changed path, and dropping paths
// there would make them invisible.
//
// Git usage: at most ONE subprocess (a batched `git check-attr` over the changed
// paths, the same pattern as git/diff.ts:396). Rename, formatting, and pattern
// classification are all derived from the diff text itself — no refs are
// re-resolved, so distillation cannot disagree with the diff it was handed.
import { execFileSync } from "node:child_process";
import { attrSourceArgs, countLines, type DiffData } from "./diff.js";
import { splitDiffByFile, type FileSegment } from "./chunk.js";
import { anyGlobMatches } from "./globs.js";
import { unquoteGitPath } from "./path.js";
import {
  detectPatternGroups,
  parseHunkBody,
  type HunkBody,
  type PatternGroup,
} from "./patterns.js";

export type { PatternGroup } from "./patterns.js";

/** How a changed path was classified; exactly one applies per path. */
export type Stratum =
  | "substantive"
  | "pattern"
  | "rename"
  | "formatting"
  | "vendored"
  | "generated";

/** One changed path's row in the manifest handed to Layer 1 (never diff text). */
export interface ManifestEntry {
  path: string;
  stratum: Stratum;
  additions: number;
  deletions: number;
}

/** Layer 0's output: classification + the shrunk diff the reviewers see. */
export interface Distillation {
  /** Every path in `diff.changed_files`, exactly once. */
  strata: Record<string, Stratum>;
  pattern_groups: PatternGroup[];
  /** Exemplars + substantive segments only; `changed_files` stays the full list. */
  review_diff: DiffData;
  manifest: ManifestEntry[];
  /** Changed paths matching `rulesPaths` — the base-ref rules this PR edits. */
  rules_changed: string[];
}

/** Strata whose segments carry nothing a reviewer needs to read. */
const DROPPED_STRATA: ReadonlySet<Stratum> = new Set<Stratum>([
  "rename",
  "formatting",
  "vendored",
  "generated",
]);

/**
 * Classify a fetched diff and shrink it to the segments worth model attention.
 * Never throws: a failing `git check-attr` simply skips the vendored/generated
 * layer, and any path this module cannot classify falls through to `substantive`.
 */
export function distill(diff: DiffData, opts: { rulesPaths: string[]; cwd: string }): Distillation {
  const segments = splitDiffByFile(diff.diff);
  const bodies = new Map<string, HunkBody | null>();
  for (const segment of segments) bodies.set(segment.path, parseHunkBody(segment.diff));

  const strata = new Map<string, Stratum>();
  classifyRenames(diff, segments, bodies, strata);
  for (const [path, stratum] of linguistStrata(diff.changed_files, opts.cwd, diff.attr_source)) {
    if (!strata.has(path)) strata.set(path, stratum);
  }
  for (const segment of segments) {
    if (strata.has(segment.path)) continue;
    const body = bodies.get(segment.path);
    if (body !== undefined && body !== null && isWhitespaceOnly(body)) {
      strata.set(segment.path, "formatting");
    }
  }

  const pattern_groups = detectPatternGroups(segments.filter((s) => !strata.has(s.path)));
  for (const group of pattern_groups) {
    for (const member of group.members) strata.set(member, "pattern");
  }
  for (const path of diff.changed_files) {
    if (!strata.has(path)) strata.set(path, "substantive");
  }

  const exemplars = new Set(pattern_groups.map((g) => g.exemplar));
  const kept = segments.filter((s) => isKept(s, strata.get(s.path), exemplars));
  return {
    strata: Object.fromEntries(diff.changed_files.map((p) => [p, strata.get(p) ?? "substantive"])),
    pattern_groups,
    review_diff: shrinkDiff(diff, kept),
    manifest: diff.changed_files.map((path) => manifestEntry(path, strata, bodies)),
    rules_changed:
      opts.rulesPaths.length === 0
        ? []
        : diff.changed_files.filter((p) => anyGlobMatches(opts.rulesPaths, p)),
  };
}

/**
 * Mark rename strata from the diff text: the OLD side of every -M-detected
 * rename (it has no segment of its own), plus BOTH sides of an exact rename —
 * a segment carrying `rename from`/`rename to` headers and no hunk at all.
 */
function classifyRenames(
  diff: DiffData,
  segments: readonly FileSegment[],
  bodies: ReadonlyMap<string, HunkBody | null>,
  strata: Map<string, Stratum>,
): void {
  for (const rename of diff.renames) strata.set(rename.from, "rename");
  for (const segment of segments) {
    const body = bodies.get(segment.path);
    if (body !== undefined && body !== null) continue; // has hunks → real edits to review
    const from = segment.diff.match(/^rename from (.+)$/m)?.[1];
    if (from === undefined || segment.path === "") continue;
    strata.set(segment.path, "rename");
    strata.set(unquoteGitPath(from), "rename");
  }
}

/**
 * True when a file's hunks change nothing but TRAILING whitespace (a `\r` counts,
 * so a CRLF → LF conversion qualifies). Inside each contiguous run of `-`/`+`
 * lines (a context line or hunk header closes the run), the removed and added
 * lines must pair one-to-one, in order, and match after `trimEnd()`.
 *
 * Pairing per run, not across the file, keeps a reordering (`validate(x); use(x);`
 * → `use(x); validate(x);`) substantive. Leading whitespace is NOT ignored: in
 * Python or YAML a dedent moves a statement out of its block. Interior whitespace
 * is not ignored either (unlike `git diff -w`): an edit inside a string literal is
 * real. A `\ No newline at end of file` marker forces `false` too: an end-of-file
 * newline change is a real content change. Anything else falls through to
 * `substantive` — the fail-safe direction, spending tokens rather than coverage.
 */
function isWhitespaceOnly(body: HunkBody): boolean {
  if (body.noNewlineMarker || body.additions === 0) return false;
  let removed: string[] = [];
  let added: string[] = [];
  // The trailing "" closes the last run.
  for (const line of [...body.normalized.split("\n"), ""]) {
    if (line.startsWith("-")) removed.push(line.slice(1).trimEnd());
    else if (line.startsWith("+")) added.push(line.slice(1).trimEnd());
    else {
      if (removed.length !== added.length || removed.some((r, i) => r !== added[i])) return false;
      removed = [];
      added = [];
    }
  }
  return true;
}

/** Keep exemplars and substantive segments; drop members and non-reviewable strata. */
function isKept(
  segment: FileSegment,
  stratum: Stratum | undefined,
  exemplars: ReadonlySet<string>,
): boolean {
  if (exemplars.has(segment.path)) return true;
  if (stratum === undefined) return true; // unclassified → review it
  if (stratum === "pattern") return false; // non-exemplar member
  return !DROPPED_STRATA.has(stratum);
}

/** One manifest row: the path's stratum plus its numstat, read off the diff text. */
function manifestEntry(
  path: string,
  strata: ReadonlyMap<string, Stratum>,
  bodies: ReadonlyMap<string, HunkBody | null>,
): ManifestEntry {
  const body = bodies.get(path);
  return {
    path,
    stratum: strata.get(path) ?? "substantive",
    additions: body?.additions ?? 0,
    deletions: body?.deletions ?? 0,
  };
}

/**
 * Rebuild a DiffData over the kept segments. `changed_files`, `binary_files`,
 * `dropped_files`, `renames`, `base_sha`, and `truncated` are inherited verbatim
 * (the ledger and the prompt's manifest blocks still describe the WHOLE change);
 * the diff text, `files`, `total_lines`, and `total_files` describe the shrunk
 * set actually under review.
 */
function shrinkDiff(diff: DiffData, kept: readonly FileSegment[]): DiffData {
  const keptPaths = new Set(kept.map((s) => s.path));
  const text = kept.map((s) => s.diff).join("");
  return {
    ...diff,
    diff: text,
    files: diff.files.filter((f) => keptPaths.has(f.path)),
    total_lines: countLines(text),
    total_files: keptPaths.size,
  };
}

/**
 * Paths the repo marks `linguist-vendored` / `linguist-generated`, via ONE
 * batched `git check-attr` (same NUL-delimited idiom as git/diff.ts:396 — git
 * paths may contain newlines, NUL can never). Degrades to an empty map when
 * check-attr is unavailable: those files then read as substantive and are
 * reviewed, which is the safe direction.
 *
 * Note fetchDiff already drops `linguist-generated` files before diffing, so in
 * practice this catches the `linguist-vendored` files that DO reach the diff.
 * Attributes are read from `attrSource` (the PR base) when fetchDiff set one.
 */
function linguistStrata(
  paths: readonly string[],
  cwd: string,
  attrSource: string | undefined,
): Map<string, Stratum> {
  const out = new Map<string, Stratum>();
  if (paths.length === 0) return out;
  let res: string;
  try {
    res = execFileSync(
      "git",
      [
        ...attrSourceArgs(attrSource),
        "check-attr",
        "-z",
        "linguist-generated",
        "linguist-vendored",
        "--stdin",
      ],
      { cwd, input: paths.join("\0"), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
  } catch {
    return out;
  }
  // -z output is a flat NUL-separated stream of <path>\0<attr>\0<value> triples.
  const fields = res.split("\0");
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const path = fields[i];
    if (path === undefined || fields[i + 2] !== "set") continue;
    // linguist-generated wins over linguist-vendored when a path carries both.
    if (fields[i + 1] === "linguist-generated") out.set(path, "generated");
    else if (fields[i + 1] === "linguist-vendored" && !out.has(path)) out.set(path, "vendored");
  }
  return out;
}
