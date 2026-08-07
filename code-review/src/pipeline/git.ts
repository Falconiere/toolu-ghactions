// pipeline/git.ts — the pipeline's tiny git boundary: run a git command with the
// `|| true` idiom, resolve the review head sha, and read a file's post-change
// content at a ref. Split out of pipeline.ts so the orchestrator stays lean.
import { execFileSync } from "node:child_process";
import { fetchDiff } from "@/git/diff.js";
import { unquoteGitPath } from "@/git/path.js";

/**
 * Force RAW (unescaped) non-ASCII bytes in every path git prints, exactly as
 * git/diff.ts does. The two modules' outputs are COMPARED (scope.ts matches
 * `treeDiffPaths` against `diff.changed_files`), so they must agree on how a
 * path is spelled or a non-ASCII file reads as unchanged and is dropped from
 * the incremental review.
 */
const QUOTEPATH_OFF = ["-c", "core.quotepath=false"];

/** Run `git` and return stdout VERBATIM, or null on non-zero exit. Path output must
 *  not be trimmed: a path may legally begin or end with a space, and git does not
 *  quote one — trimming would silently rename it. */
function gitRawOrNull(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", [...QUOTEPATH_OFF, ...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 1024,
    });
  } catch {
    // Silent by contract: non-zero exit is an ANSWER here, not an error —
    // `merge-base --is-ancestor` says "no" via exit code, `rev-parse --verify`
    // probes for refs that are expected to be absent. Callers log at their own
    // decision points when the outcome is worth surfacing.
    return null;
  }
}

/** Run `git` and return trimmed stdout, or null on non-zero exit (the `|| true` idiom). */
export function gitOrNull(args: string[], cwd: string): string | null {
  return gitRawOrNull(args, cwd)?.trim() ?? null;
}

/**
 * The ROOT TREE sha of a ref (`git rev-parse <ref>^{tree}`), or null when the ref
 * does not resolve. Content-addressed, so an identical-content rebase yields the
 * same value — that is what makes the tree the incremental file-set base
 * (spec §True incremental), unlike the commit sha it hangs off.
 */
export function resolveTreeSha(ref: string, cwd: string): string | null {
  return gitOrNull(["rev-parse", `${ref}^{tree}`], cwd);
}

/** True when the object exists in the LOCAL object database (`git cat-file -e`).
 *  A force-push that garbage-collected the last reviewed tree answers false here,
 *  and the caller fails open to a full review. */
export function objectExists(object: string, cwd: string): boolean {
  return gitOrNull(["cat-file", "-e", `${object}^{tree}`], cwd) !== null;
}

/**
 * The paths differing between two TREE objects (`git diff-tree -r --name-only`),
 * or null when the command fails (the caller then fails open to a full review).
 *
 * NEWLINE-delimited, deliberately NOT `-z`, then C-unquoted (git/path.ts): the
 * result is compared for equality against `DiffData.changed_files`, which
 * git/diff.ts reads off a non-`-z` `git diff --name-only` and decodes the same
 * way. Both sides therefore hold the REAL path. Line splitting is safe because a
 * path containing a newline is always quoted, so it can never span two lines.
 */
export function treeDiffPaths(fromTree: string, toTree: string, cwd: string): string[] | null {
  const out = gitRawOrNull(["diff-tree", "-r", "--name-only", fromTree, toTree], cwd);
  if (out === null) return null;
  return out
    .split("\n")
    .filter((p) => p !== "")
    .map(unquoteGitPath);
}

/** Resolve the head sha for state/anchoring: GITHUB_SHA for HEAD, else `git rev-parse`. */
export function resolveHeadSha(reviewHead: string, contextSha: string, cwd: string): string {
  if (reviewHead === "HEAD") return contextSha;
  return gitOrNull(["rev-parse", reviewHead], cwd) ?? contextSha;
}

/**
 * Compute the incremental-review scope: the lines changed since the last
 * reviewed sha, per path. Returns null (→ full review, fail-open) when the sha
 * is missing, unresolvable, or not an ancestor of the review head (rebase /
 * force-push rewrote history). An EMPTY map is a real result: nothing changed
 * since the last review, so no genuinely new finding can exist.
 */
export function sinceChangedLines(opts: {
  reviewedSha: string | undefined;
  reviewHead: string;
  excludeGlobs: string[];
  cwd: string;
}): Map<string, Set<number>> | null {
  const { reviewedSha, reviewHead, excludeGlobs, cwd } = opts;
  if (reviewedSha === undefined || reviewedSha === "") return null;
  if (gitOrNull(["rev-parse", "--verify", `${reviewedSha}^{commit}`], cwd) === null) return null;
  if (gitOrNull(["merge-base", "--is-ancestor", reviewedSha, reviewHead], cwd) === null) {
    process.stderr.write(
      `  Note: last reviewed sha ${reviewedSha.slice(0, 7)} is not an ancestor of ${reviewHead} — full review\n`,
    );
    return null;
  }
  try {
    const diff = fetchDiff({
      baseBranch: reviewedSha,
      reviewHead,
      githubBaseRef: reviewedSha,
      excludeGlobs,
      maxFiles: 0,
      maxDiffLines: 0,
      cwd,
    });
    if (diff.error !== undefined) return null;
    return new Map(diff.files.map((f) => [f.path, new Set(f.changed_lines)]));
  } catch (err) {
    process.stderr.write(
      `  Note: could not compute the incremental scope (${err instanceof Error ? err.message.split("\n")[0] : String(err)}) — full review\n`,
    );
    return null;
  }
}

/**
 * Reader for full post-change file content at the review head — used for
 * oversized-chunk context. Read UNTRIMMED (gitOrNull's trim would alter file
 * bytes); null when the path does not exist at the ref (deleted files — normal).
 */
export function readFileAt(reviewHead: string, cwd: string): (path: string) => string | null {
  return (path: string) => {
    try {
      return execFileSync("git", ["show", `${reviewHead}:${path}`], {
        cwd,
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 1024,
      });
    } catch {
      // Silent: an absent path at the ref is the documented null contract
      // (deleted files — normal), and logging it would emit one line per
      // deleted file on every chunked review.
      return null;
    }
  };
}
