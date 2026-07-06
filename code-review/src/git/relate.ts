// git/relate.ts — group per-file diff segments that must be reviewed TOGETHER,
// so the chunker never separates a module from the file that declares it.
//
// Motivating failure: a PR adds `tests/helpers/live_harness.rs` (which declares
// `#[path = "live_harness_api.rs"] mod api;`) and `tests/helpers/live_harness_api.rs`.
// Packed into different chunks, the model reviewing the child alone concluded the
// parent was deleted and every `use super::…` unresolved — 8 false findings. The
// two files form one compilation unit; they must ride in one chunk.
//
// Detection is Rust-only today (the language the failure hit); the grouping walk
// is language-agnostic, so new `moduleTargets` rules extend it. Edges found:
//   - `#[path = "P"] mod X;`  → P resolved against the declaring file's directory.
//   - `mod X;` / `pub mod X;` → dir/X.rs, dir/X/mod.rs, stem-dir/X.rs, stem-dir/X/mod.rs.
//   - `use super::…`          → the files that could OWN this module: dir/mod.rs,
//                               plus the parent dir's <dir>.rs (child → parent).
// Only edges whose target is ANOTHER SEGMENT IN THE PR union anything — a miss is
// simply no edge, never an error.
import type { FileSegment } from "./chunk.js";

/**
 * Partition segments into groups that must share a chunk. Each group's segments
 * stay in path-sorted order; groups are ordered by their first segment's path
 * (so directory siblings still pack adjacently). Segments with no edges form
 * singleton groups — the packing for an unrelated diff is unchanged.
 */
export function groupRelatedSegments(segments: FileSegment[]): FileSegment[][] {
  const indexByPath = new Map<string, number>();
  segments.forEach((seg, i) => {
    if (seg.path !== "") indexByPath.set(seg.path, i);
  });

  // Union-find over segment indices.
  const parent = segments.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root] ?? root;
    // Path compression.
    let cur = i;
    while (cur !== root) {
      const next = parent[cur] ?? root;
      parent[cur] = root;
      cur = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  segments.forEach((seg, i) => {
    for (const target of moduleTargets(seg)) {
      const j = indexByPath.get(target);
      if (j !== undefined) union(i, j);
    }
  });

  // Collect groups keyed by root, each sorted by path; order groups by first path.
  const byRoot = new Map<number, FileSegment[]>();
  segments.forEach((seg, i) => {
    const root = find(i);
    const group = byRoot.get(root);
    if (group) group.push(seg);
    else byRoot.set(root, [seg]);
  });
  const groups = [...byRoot.values()];
  for (const group of groups) {
    group.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
  groups.sort((a, b) => {
    const pa = a[0]?.path ?? "";
    const pb = b[0]?.path ?? "";
    return pa < pb ? -1 : pa > pb ? 1 : 0;
  });
  return groups;
}

/**
 * Candidate paths of segments this segment is module-coupled to. Scans the
 * segment's NEW-file lines only (added + context; removed `L---:` lines are the
 * old content and must not create edges).
 */
function moduleTargets(seg: FileSegment): string[] {
  if (!seg.path.endsWith(".rs")) return [];
  const dir = dirOf(seg.path);
  const stemDir = seg.path.replace(/\.rs$/, ""); // a/b/c.rs → a/b/c (children of a non-mod.rs file)
  const targets: string[] = [];

  // `#[path = "…"]` applies to the NEXT `mod` item; remember it between lines.
  let pendingPath: string | null = null;
  for (const code of newFileLines(seg.diff)) {
    // `#[path = "…"] mod x;` may share one line — strip the attribute, keep the rest.
    let rest = code;
    const pathAttr = rest.match(/^\s*#\[path\s*=\s*"([^"]+)"\s*\]\s*(.*)$/);
    if (pathAttr?.[1] !== undefined) {
      pendingPath = pathAttr[1];
      rest = pathAttr[2] ?? "";
    }
    const modDecl = rest.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/);
    if (modDecl?.[1] !== undefined) {
      const name = modDecl[1];
      if (pendingPath !== null) {
        targets.push(join(dir, pendingPath));
        pendingPath = null;
      } else {
        targets.push(join(dir, `${name}.rs`), join(dir, `${name}/mod.rs`));
        targets.push(join(stemDir, `${name}.rs`), join(stemDir, `${name}/mod.rs`));
      }
      continue;
    }
    // Reverse direction: a child using `use super::…` couples to the file that owns
    // its parent module — same-dir mod.rs, or the parent dir's <dir>.rs.
    if (/^\s*(?:pub\s+)?use\s+super::/.test(rest)) {
      targets.push(join(dir, "mod.rs"));
      if (dir !== "") targets.push(`${dir}.rs`);
    }
    // The attribute binds only to the next item; any other code line clears it.
    if (pathAttr === null && rest.trim() !== "" && !rest.trim().startsWith("//")) {
      pendingPath = null;
    }
  }
  return targets.map(normalizePath);
}

/** New-file code lines of a SHAPED diff segment: strip the `Lnnn: ` prefix and the
 *  leading `+`/space diff marker; skip removed (`L---:`) lines and headers. */
function newFileLines(shapedDiff: string): string[] {
  const out: string[] = [];
  for (const line of shapedDiff.split("\n")) {
    const m = line.match(/^L\d+: ([+ ])(.*)$/);
    if (m?.[2] !== undefined) out.push(m[2]);
  }
  return out;
}

/** The directory part of a repo-relative path ("" at the root). */
function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/** Join two repo-relative path parts (either may be ""). */
function join(dir: string, rest: string): string {
  return dir === "" ? rest : `${dir}/${rest}`;
}

/** Resolve `.` / `..` components in a repo-relative path (never escapes the root). */
function normalizePath(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}
