// pipeline/scope.ts — the TREE-based incremental scope (spec §True incremental +
// resumable): which changed paths this round actually re-reviews, and the diff
// narrowed to them.
//
// The marker's `reviewed_tree` is the root tree sha of the last head whose review
// reached COMPLETE coverage. On a new push the file set to re-review is
// `git diff-tree -r --name-only <reviewed_tree> <head tree>` ∪ the exception lists
// (`unreviewed_paths` ∪ `pending_paths` — attempted-and-failed / never attempted).
// Everything else is CARRIED: not re-reviewed, its prior findings re-injected
// (pipeline/carry.ts) so no thread is falsely resolved.
//
// FAIL-OPEN EVERYWHERE: no marker, no `reviewed_tree`, a tree that was
// garbage-collected by a force-push, an unresolvable head, or a failing
// `diff-tree` all return `null` — review the whole diff. A missed narrowing costs
// tokens; a wrong narrowing costs coverage.
//
// `reviewed_sha` is untouched by any of this: it keeps driving the LINE-level
// `IncrementalScope` (pipeline/git.ts's `sinceChangedLines`) exactly as before.
// The tree picks the FILE set, the sha picks the lines within it.
import { countLines, type DiffData } from "@/git/diff.js";
import { splitDiffByFile } from "@/git/chunk.js";
import type { ReviewState } from "@/state.js";
import { objectExists, resolveTreeSha, treeDiffPaths } from "./git.js";

/** How this run picks its file set. `full` — a full re-review (`@toolu review`,
 *  memory off, or a non-PR event): no narrowing at all. `incremental` — a
 *  pull_request push: narrow to the tree diff ∪ exceptions. `resume` — the
 *  `@toolu resume` phrase: the exception paths ONLY. */
export type ScopeMode = "full" | "incremental" | "resume";

/** The resolved file scope for one round. */
export interface TreeScope {
  /** Changed paths to review this round. */
  inScope: ReadonlySet<string>;
  /** The prior round's exception paths (`unreviewed_paths` ∪ `pending_paths`).
   *  Always in scope, and passed to `dropOutOfScope` so a resume run's findings
   *  survive the LINE-level filter too (review/incremental.ts). */
  exceptions: ReadonlySet<string>;
}

/** The prior round's exception paths, deduped. */
export function exceptionPaths(prior: ReviewState | null): Set<string> {
  return new Set([...(prior?.unreviewed_paths ?? []), ...(prior?.pending_paths ?? [])]);
}

/**
 * Resolve this round's file scope, or null to review everything (fail-open).
 *
 * `resume` with NO exception paths deliberately falls back to null — a full
 * review. There is nothing to resume, and reviewing the PR as `@toolu review`
 * would is the answer that is never wrong; a no-op reply would leave the author
 * with a stale sticky comment and no way to tell a completed run from a broken one.
 */
export function resolveTreeScope(opts: {
  prior: ReviewState | null;
  mode: ScopeMode;
  reviewHead: string;
  cwd: string;
}): TreeScope | null {
  const { prior, mode, reviewHead, cwd } = opts;
  if (mode === "full") return null;
  const exceptions = exceptionPaths(prior);

  if (mode === "resume") {
    if (exceptions.size === 0) {
      process.stderr.write("  Note: nothing left to resume (no exception paths) — full review\n");
      return null;
    }
    return { inScope: exceptions, exceptions };
  }

  const reviewedTree = prior?.reviewed_tree;
  if (reviewedTree === undefined || reviewedTree === "") return null;
  if (!objectExists(reviewedTree, cwd)) {
    process.stderr.write(
      `  Note: last reviewed tree ${reviewedTree.slice(0, 7)} is not in this clone — full review\n`,
    );
    return null;
  }
  const headTree = resolveTreeSha(reviewHead, cwd);
  if (headTree === null) return null;
  const changed = treeDiffPaths(reviewedTree, headTree, cwd);
  if (changed === null) return null;
  return { inScope: new Set([...changed, ...exceptions]), exceptions };
}

/**
 * Narrow a fetched diff to the in-scope paths, returning the carried (dropped)
 * changed paths alongside. Whole segments are kept or dropped, never edited, so
 * the shaped `Lnnn: ` line priming and every downstream line anchor survive.
 * `binary_files`/`dropped_files` are inherited verbatim: they are excluded from
 * review regardless of scope and the ledger must still account for them.
 */
export function filterDiffToScope(
  diff: DiffData,
  inScope: ReadonlySet<string>,
): { diff: DiffData; carried: string[] } {
  const carried = diff.changed_files.filter((p) => !inScope.has(p));
  if (carried.length === 0) return { diff, carried };

  const kept = splitDiffByFile(diff.diff).filter((s) => inScope.has(s.path));
  const text = kept.map((s) => s.diff).join("");
  const keptPaths = diff.changed_files.filter((p) => inScope.has(p));
  return {
    diff: {
      ...diff,
      diff: text,
      files: diff.files.filter((f) => inScope.has(f.path)),
      changed_files: keptPaths,
      total_lines: countLines(text),
      total_files: keptPaths.length,
    },
    carried,
  };
}
