// patterns.ts — mechanical-pattern detection for Layer 0 distillation (see
// git/distill.ts). Pure string work, no git and no I/O: given the per-file
// segments of a SHAPED diff (git/shape.ts primes every body line with `Lnnn: `),
// find sets of files whose hunk bodies are byte-identical once the per-file
// coordinates are normalized away — the "same one-line insertion in 140 files"
// shape that dominates large mechanical PRs.
//
// Normalization (the thing that makes two files' changes "the same change"):
//   - `Lnnn: ` / `L---: ` line-priming prefixes are stripped (they encode the
//     file's own line numbers, which differ between otherwise identical changes);
//   - a hunk header's coordinates are stripped (`@@ -1,2 +1,3 @@ fn f()` → `@@ fn f()`)
//     while its section heading is KEPT, so changes landing in differently-named
//     surroundings do NOT collapse together (the strict, coverage-safe direction);
//   - the `+` / `-` / ` ` markers and the line content are kept verbatim;
//   - file headers (`diff --git`, `index`, `---`, `+++`, mode/rename lines) are
//     excluded entirely — they carry blob shas and paths that always differ.
// The sha1 of the result is the group key (`hunk_hash`).
//
// Only groups of at least PATTERN_MIN_MEMBERS files collapse; anything smaller
// stays substantive and is reviewed file-by-file. Findings on a group are
// reported on the exemplar ONLY and never fan out to members (spec §Layer 0).
//
// The parsed body also carries each changed line TRIMMED (`removed`/`added`),
// which is what distill.ts's formatting check compares. Trimmed, NOT despaced:
// only leading/trailing whitespace may differ for a pair to read as formatting,
// so an interior whitespace edit — inside a string literal, say — stays
// substantive and is reviewed (spec §Layer 0's fail-safe direction).
import { createHash } from "node:crypto";

/** Minimum number of identical-hunk files before a set collapses to one exemplar. */
export const PATTERN_MIN_MEMBERS = 3;

/** A set of files whose normalized hunk bodies hash identically. */
export interface PatternGroup {
  /** Path whose hunks are reviewed; findings do NOT fan out to members. */
  exemplar: string;
  /** All paths in the group, including the exemplar, path-sorted. */
  members: string[];
  /** sha1 of the normalized hunk body shared by every member. */
  hunk_hash: string;
  /** Code-generated, e.g. "identical 1-line insertion in 140 files". */
  summary: string;
}

/** One file's slice of a shaped diff — structurally a git/chunk.ts FileSegment. */
export interface PatternInput {
  path: string;
  diff: string;
}

/** The parsed, normalized hunk body of one file's diff segment. */
export interface HunkBody {
  /** Normalized body text (see module doc); the input to {@link hunkHash}. */
  normalized: string;
  /** Count of `+` lines in the body (matches `git diff --numstat` additions). */
  additions: number;
  /** Count of `-` lines in the body (matches `git diff --numstat` deletions). */
  deletions: number;
  /** Removed lines' content, TRIMMED (see {@link trimEnds}), in order. */
  removed: string[];
  /** Added lines' content, TRIMMED (see {@link trimEnds}), in order. */
  added: string[];
  /** True when the body carries a `\ No newline at end of file` marker. */
  noNewlineMarker: boolean;
}

/** A shaped body line's priming prefix: `L42: ` for kept lines, `L---: ` for removed. */
const LINE_PREFIX = /^L(?:[0-9]+|---): /;
/** A hunk header's coordinates, stripped so identical changes at different offsets match. */
const HUNK_COORDS = /^@@ -[0-9]+(?:,[0-9]+)? \+[0-9]+(?:,[0-9]+)? @@/;

/**
 * Parse one file's shaped diff segment into its normalized hunk body. Returns
 * null when the segment carries no hunk at all (a pure rename, a mode-only
 * change) — such a segment has nothing to compare and never joins a group.
 */
export function parseHunkBody(segmentDiff: string): HunkBody | null {
  const normalized: string[] = [];
  const removed: string[] = [];
  const added: string[] = [];
  let started = false;
  let additions = 0;
  let deletions = 0;
  let noNewlineMarker = false;

  // Trailing newlines are stripped before splitting: fetchDiff strips them off the
  // WHOLE shaped diff, so the last file's segment would otherwise normalize
  // differently from every identical segment before it and never join their group.
  for (const raw of segmentDiff.replace(/\n+$/, "").split("\n")) {
    // Strip the priming prefix FIRST: everything below inspects real diff markers.
    const line = raw.replace(LINE_PREFIX, "");
    if (!started) {
      // File headers precede the first hunk; a body line can never start with
      // "@@" after prefix-stripping (it would carry a `+`/`-`/` ` marker).
      if (!line.startsWith("@@ ")) continue;
      started = true;
    }
    if (line.startsWith("@@")) {
      normalized.push(line.replace(HUNK_COORDS, "@@"));
      continue;
    }
    if (line.startsWith("\\")) {
      noNewlineMarker = true;
    } else if (line.startsWith("+")) {
      additions++;
      added.push(trimEnds(line.slice(1)));
    } else if (line.startsWith("-")) {
      deletions++;
      removed.push(trimEnds(line.slice(1)));
    }
    normalized.push(line);
  }

  if (!started) return null;
  return {
    normalized: normalized.join("\n"),
    additions,
    deletions,
    removed,
    added,
    noNewlineMarker,
  };
}

/** sha1 of a normalized hunk body — the pattern-group key. */
export function hunkHash(body: HunkBody): string {
  return createHash("sha1").update(body.normalized, "utf8").digest("hex");
}

/**
 * Group the given segments by normalized hunk body, keeping only groups of at
 * least {@link PATTERN_MIN_MEMBERS} files. Segments with no hunks, no changed
 * lines, or an empty path are ignored (they can never be a collapsible pattern).
 * Groups are returned exemplar-sorted, each with path-sorted members and the
 * lexicographically first member as the exemplar.
 */
export function detectPatternGroups(segments: readonly PatternInput[]): PatternGroup[] {
  const byHash = new Map<string, { paths: string[]; body: HunkBody }>();
  for (const segment of segments) {
    if (segment.path === "") continue;
    const body = parseHunkBody(segment.diff);
    if (body === null) continue;
    if (body.additions === 0 && body.deletions === 0) continue;
    const hash = hunkHash(body);
    const entry = byHash.get(hash);
    if (entry === undefined) byHash.set(hash, { paths: [segment.path], body });
    else entry.paths.push(segment.path);
  }

  const groups: PatternGroup[] = [];
  for (const [hunk_hash, entry] of byHash) {
    if (entry.paths.length < PATTERN_MIN_MEMBERS) continue;
    const members = [...entry.paths].sort();
    const exemplar = members[0];
    if (exemplar === undefined) continue;
    groups.push({ exemplar, members, hunk_hash, summary: summarize(entry.body, members.length) });
  }
  groups.sort((a, b) => (a.exemplar < b.exemplar ? -1 : a.exemplar > b.exemplar ? 1 : 0));
  return groups;
}

/** Code-generated group blurb, e.g. "identical 1-line insertion in 140 files". */
function summarize(body: HunkBody, memberCount: number): string {
  const changed = body.additions + body.deletions;
  const kind = body.deletions === 0 ? "insertion" : body.additions === 0 ? "deletion" : "change";
  return `identical ${changed}-line ${kind} in ${memberCount} files`;
}

/**
 * Strip only LEADING and TRAILING whitespace, leaving the interior byte-identical.
 *
 * Deliberately NOT `git diff -w`'s all-whitespace-removed comparison: collapsing
 * interior whitespace makes a real edit inside a string literal
 * (`"select * from  t"` → `"select *from t"`) compare equal to its own original,
 * so distill.ts would classify the file `formatting` and drop it from review
 * entirely. Trim-only keeps every indentation/trailing-whitespace reflow
 * classified as formatting while sending any interior change to `substantive`
 * — the fail-safe direction, which costs tokens but never coverage.
 */
function trimEnds(content: string): string {
  return content.replace(/^\s+/, "").replace(/\s+$/, "");
}
