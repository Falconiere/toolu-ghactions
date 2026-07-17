// pipeline/git.ts — the pipeline's tiny git boundary: run a git command with the
// `|| true` idiom, resolve the review head sha, and read a file's post-change
// content at a ref. Split out of pipeline.ts so the orchestrator stays lean.
import { execFileSync } from "node:child_process";
import { fetchDiff } from "@/git/diff.js";

/** Run `git` and return trimmed stdout, or null on non-zero exit (the `|| true` idiom). */
export function gitOrNull(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 1024,
    }).trim();
  } catch {
    // Silent by contract: non-zero exit is an ANSWER here, not an error —
    // `merge-base --is-ancestor` says "no" via exit code, `rev-parse --verify`
    // probes for refs that are expected to be absent. Callers log at their own
    // decision points when the outcome is worth surfacing.
    return null;
  }
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
