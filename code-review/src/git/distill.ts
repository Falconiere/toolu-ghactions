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
//   formatting  → dropped (indentation / trailing-whitespace reflow ONLY: every
//                 changed line's TRIMMED text is byte-identical to its pair's.
//                 An interior whitespace edit is substantive — see isWhitespaceOnly);
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
import { countLines, type DiffData } from "./diff.js";
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
  const segments = splitDiffByFile(diff.diff).map(withRenameTarget);
  const bodies = new Map<string, HunkBody | null>();
  for (const segment of segments) bodies.set(segment.path, parseHunkBody(segment.diff));

  const strata = new Map<string, Stratum>();
  classifyRenames(diff, segments, bodies, strata);
  for (const [path, stratum] of linguistStrata(diff.changed_files, opts.cwd)) {
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
 * An EXACT rename's segment carries no `---`/`+++` headers at all, so
 * splitDiffByFile leaves its path empty; recover it from the `rename to` header
 * so the segment is keyed by a real path like every other. The header is
 * C-unquoted (git/path.ts), so a path git had to quote keys the same way it does
 * in `changed_files`. Segments that already have a path are returned untouched.
 */
function withRenameTarget(segment: FileSegment): FileSegment {
  if (segment.path !== "") return segment;
  const to = segment.diff.match(/^rename to (.+)$/m)?.[1];
  return to === undefined ? segment : { ...segment, path: unquoteGitPath(to) };
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
 * True when a file's hunks change nothing but LEADING/TRAILING whitespace —
 * indentation and trailing-space reflows — computed from the diff we already hold.
 * Every removed line must pair, in order, with an added line whose TRIMMED text is
 * byte-identical (git/patterns.ts's `trimEnds`).
 *
 * Deliberately STRICTER than `git diff -w`, which ignores interior whitespace too:
 * under that comparison an edit inside a string literal (`"select * from  t"` →
 * `"select *from t"`) reads as whitespace-only and the file is dropped from review
 * unseen. Anything but a pure end-trim change therefore falls through to
 * `substantive` — the fail-safe direction, spending tokens rather than coverage.
 * A `\ No newline at end of file` marker forces `false` for the same reason: an
 * end-of-file newline change is a real content change.
 */
function isWhitespaceOnly(body: HunkBody): boolean {
  if (body.noNewlineMarker) return false;
  if (body.added.length === 0 || body.added.length !== body.removed.length) return false;
  return body.added.every((line, i) => line === body.removed[i]);
}

/** Keep exemplars and substantive segments; drop members and non-reviewable strata. */
function isKept(
  segment: FileSegment,
  stratum: Stratum | undefined,
  exemplars: ReadonlySet<string>,
): boolean {
  if (exemplars.has(segment.path)) return true;
  if (stratum === undefined) return true; // unclassifiable (e.g. mode-only) → review it
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
 */
function linguistStrata(paths: readonly string[], cwd: string): Map<string, Stratum> {
  const out = new Map<string, Stratum>();
  if (paths.length === 0) return out;
  let res: string;
  try {
    res = execFileSync(
      "git",
      ["check-attr", "-z", "linguist-generated", "linguist-vendored", "--stdin"],
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
