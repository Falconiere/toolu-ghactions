// git/chunk.ts — split a shaped diff into per-file segments and pack whole files
// into line-bounded chunks for the chunked review path. Pure string + array work
// (no git, no I/O): a giant diff that overwhelms the LLM is broken into chunks each
// ≤ a line budget, reviewed independently, then merged (see llm/merge.ts).
//
// The shaped diff is the concatenation of per-file `diff --git …` blocks (see
// git/diff.ts shapeDiff). We split at those boundaries with a zero-width lookahead
// so joining the segments reproduces the input EXACTLY — the single-chunk path is
// byte-identical to the un-chunked prompt, keeping existing fixtures stable.
import { countLines } from "./diff.js";

/** One file's slice of the shaped diff. */
export interface FileSegment {
  /** File path, from `+++ b/<path>` (or `--- a/<path>` for a deletion); "" if absent. */
  path: string;
  /** The `diff --git …` block for exactly this file, including its trailing newline. */
  diff: string;
  /** Primed-diff line count of {@link diff} (countLines semantics). */
  lines: number;
}

/** Result of {@link packChunks}: chunks to review + files dropped by the cap. */
export interface PackResult {
  /** Each chunk's segments, in path-sorted order; concat their `.diff` for the prompt. */
  chunks: FileSegment[][];
  /** Files beyond maxChunks (empty when maxChunks ≤ 0 = unlimited). */
  dropped: FileSegment[];
}

/**
 * Split a shaped diff into per-file segments at `diff --git ` boundaries.
 *
 * Invariant: `splitDiffByFile(d).map(s => s.diff).join("") === d` (round-trip), so
 * the single-chunk path reproduces the original prompt byte-for-byte. Any text
 * before the first `diff --git ` (there is none in real git output) is dropped.
 */
export function splitDiffByFile(shapedDiff: string): FileSegment[] {
  if (shapedDiff === "") return [];
  // Zero-width split before each `diff --git ` at line start: every piece keeps its
  // own trailing newline, so concatenation is lossless.
  const pieces = shapedDiff.split(/(?=^diff --git )/m).filter((p) => p.startsWith("diff --git "));
  return pieces.map((diff) => ({ path: parsePath(diff), diff, lines: countLines(diff) }));
}

/**
 * Greedily pack whole-file segments into chunks of ≤ maxLines primed lines.
 *
 * Files are sorted by path first so directory siblings share a chunk (minimizing
 * findings that span a chunk boundary). A file whose own diff exceeds maxLines
 * becomes its own oversized chunk — a file is never split across chunks. When
 * maxChunks > 0, segments that would form chunks beyond the limit spill into
 * `dropped` (the cost/runtime cap); maxChunks ≤ 0 means unlimited.
 */
export function packChunks(
  segments: FileSegment[],
  maxLines: number,
  maxChunks: number,
): PackResult {
  const sorted = [...segments].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const chunks: FileSegment[][] = [];
  let current: FileSegment[] = [];
  let currentLines = 0;
  for (const seg of sorted) {
    // Start a new chunk when adding this file would exceed the budget and the
    // current chunk already holds something (a single over-budget file rides alone).
    if (current.length > 0 && currentLines + seg.lines > maxLines) {
      chunks.push(current);
      current = [];
      currentLines = 0;
    }
    current.push(seg);
    currentLines += seg.lines;
  }
  if (current.length > 0) chunks.push(current);

  if (maxChunks > 0 && chunks.length > maxChunks) {
    return { chunks: chunks.slice(0, maxChunks), dropped: chunks.slice(maxChunks).flat() };
  }
  return { chunks, dropped: [] };
}

/**
 * Parse the file path from one file's diff block. Prefers `+++ b/<path>` (the new
 * path); falls back to `--- a/<path>` when `+++` is `/dev/null` (a deletion).
 * Returns "" when neither header is present (a mode-only change) — the segment
 * still rides in a chunk, it just carries no mechanical-finding key.
 */
function parsePath(segment: string): string {
  const plus = headerPath(segment, /^\+\+\+ (.+)$/m);
  if (plus !== undefined && plus !== "/dev/null") return stripSide(plus);
  const minus = headerPath(segment, /^--- (.+)$/m);
  if (minus !== undefined && minus !== "/dev/null") return stripSide(minus);
  return "";
}

/** A `---`/`+++` header path, with git's trailing tab (added for spaced names) removed. */
function headerPath(segment: string, re: RegExp): string | undefined {
  const raw = segment.match(re)?.[1];
  return raw === undefined ? undefined : (raw.split("\t")[0] ?? raw);
}

/**
 * Normalize one side's path so it KEY-MATCHES a SARIF finding's path: decode git's
 * C-quoting (a `"…"` wrapper with octal `\nnn` / `\t` / `\"` / `\\` escapes, emitted
 * for non-ASCII bytes), then drop the `a/` or `b/` side prefix. So `"b/caf\303\251.ts"`
 * → `café.ts` — without this the mechanical findings on such a file would orphan onto
 * chunk[0] and be triaged against the wrong code.
 */
function stripSide(raw: string): string {
  const v = unquoteCPath(raw);
  return v.startsWith("a/") || v.startsWith("b/") ? v.slice(2) : v;
}

/** git's C-quote named escapes → byte value. */
const NAMED_ESCAPE: Record<string, number> = {
  '"': 0x22,
  "\\": 0x5c,
  t: 0x09,
  n: 0x0a,
  r: 0x0d,
  b: 0x08,
  f: 0x0c,
  a: 0x07,
  v: 0x0b,
};

/** Decode a git C-quoted path (`"…"` with octal/named escapes) to its UTF-8 form. */
function unquoteCPath(path: string): string {
  if (!(path.length >= 2 && path.startsWith('"') && path.endsWith('"'))) return path;
  const inner = path.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    const code = inner.charCodeAt(i);
    if (code !== 0x5c) {
      bytes.push(code);
      continue;
    }
    const next = inner[i + 1];
    if (next === undefined) break;
    if (next >= "0" && next <= "7") {
      bytes.push(parseInt(inner.slice(i + 1, i + 4), 8));
      i += 3;
      continue;
    }
    bytes.push(NAMED_ESCAPE[next] ?? next.charCodeAt(0));
    i += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}
