// shape.ts — line-prime a unified diff and extract per-file changed_lines.
// Port of shape-diff.sh. Prefixes each body line with its NEW-file absolute
// line number (`Lnnn: `) so the model cites real, anchorable line numbers;
// removed lines get `L---: `. Emits, per file, the set of new-file line numbers
// present in the diff (context + additions) — the lines an inline comment can
// anchor to. Line-for-line parity with the awk in shape-diff.sh.

/** Per-file anchorable line set: the new-file line numbers present in the diff. */
export interface ShapedFile {
  path: string;
  changed_lines: number[];
  /**
   * New-file line number → that line's content (the leading `+`/space marker
   * stripped). Lets the finding gate verify a finding's `quoted_line` against
   * the real post-change text, so a finding that quotes a removed (`L---:`) line
   * — flagging deleted code as if still present — is dropped.
   */
  line_text: Record<number, string>;
}

/** Line-primed diff text plus the per-file anchorable line sets. */
export interface ShapedDiff {
  diff: string;
  files: ShapedFile[];
}

const DIFF_GIT_PREFIX = "diff --git ";
const ADD_HEADER_PREFIX = "+++ ";
const DEL_HEADER_PREFIX = "--- ";
const HUNK_PREFIX = "@@ ";

/**
 * Line-prime a unified diff. Walks every line in order, tracking the current
 * file path (from `+++ ` headers) and the new-file line counter (reset from
 * each `@@ -a,b +c,d @@` to the number after `+`). Additions and context lines
 * are prefixed `Lnnn: ` and their line numbers recorded against the current
 * path; removed lines get `L---: `; headers and other lines pass through
 * unchanged. An empty input yields an empty diff and no files.
 */
export function shapeDiff(rawDiff: string): ShapedDiff {
  if (rawDiff === "") {
    return { diff: "", files: [] };
  }

  const out: string[] = [];
  // Pairs of (path, newLine) in encounter order — grouped/uniqued at the end,
  // mirroring jq's `group_by(.path) | map(... unique)`.
  const pairsByPath = new Map<string, Set<number>>();
  // New-file line number → content, per path (mirrors pairsByPath; feeds line_text).
  const textByPath = new Map<string, Map<number, string>>();
  // First-seen path order, so the emitted files[] order is stable and matches
  // jq group_by (which sorts by key — see note below).
  let path = "";
  let newLine = 0;

  // printf '%s\n' adds a trailing newline the awk then reads as a final empty
  // record; splitting on "\n" of the (newline-terminated) raw diff reproduces
  // the same line set without a spurious trailing blank in the output.
  const lines = rawDiff.split("\n");
  const hadTrailingNewline = rawDiff.endsWith("\n");
  if (hadTrailingNewline) lines.pop();

  for (const line of lines) {
    if (line.startsWith(DIFF_GIT_PREFIX)) {
      out.push(line);
    } else if (line.startsWith(ADD_HEADER_PREFIX)) {
      path = line.replace(/^\+\+\+ b\//, "").replace(/^\+\+\+ /, "");
      out.push(line);
    } else if (line.startsWith(DEL_HEADER_PREFIX)) {
      out.push(line);
    } else if (line.startsWith(HUNK_PREFIX)) {
      const m = line.match(/\+[0-9]+/);
      if (m) newLine = Number.parseInt(m[0].slice(1), 10);
      out.push(line);
    } else if (line.startsWith("+")) {
      out.push(`L${newLine}: ${line}`);
      record(pairsByPath, path, newLine);
      recordText(textByPath, path, newLine, line.slice(1));
      newLine++;
    } else if (line.startsWith("-")) {
      out.push(`L---: ${line}`);
    } else if (line.startsWith(" ")) {
      out.push(`L${newLine}: ${line}`);
      record(pairsByPath, path, newLine);
      recordText(textByPath, path, newLine, line.slice(1));
      newLine++;
    } else {
      // index/mode/rename headers, "\ No newline", blank lines
      out.push(line);
    }
  }

  // jq group_by(.path) sorts groups by path key; reproduce that ordering so the
  // emitted files[] matches the bash output exactly.
  const files: ShapedFile[] = [...pairsByPath.keys()].sort().map((p) => ({
    path: p,
    changed_lines: [...(pairsByPath.get(p) ?? new Set<number>())].sort((a, b) => a - b),
    line_text: Object.fromEntries(textByPath.get(p) ?? new Map<number, string>()),
  }));

  const diff = hadTrailingNewline ? `${out.join("\n")}\n` : out.join("\n");
  return { diff, files };
}

/** Record a (path, line) pair, deduping per path via a Set. */
function record(byPath: Map<string, Set<number>>, path: string, line: number): void {
  let set = byPath.get(path);
  if (!set) {
    set = new Set<number>();
    byPath.set(path, set);
  }
  set.add(line);
}

/** Record a new-file line's content (last write wins within a path). */
function recordText(
  byPath: Map<string, Map<number, string>>,
  path: string,
  line: number,
  text: string,
): void {
  let map = byPath.get(path);
  if (!map) {
    map = new Map<number, string>();
    byPath.set(path, map);
  }
  map.set(line, text);
}
