// pipeline/git.ts — the pipeline's tiny git boundary: run a git command with the
// `|| true` idiom, resolve the review head sha, and read a file's post-change
// content at a ref. Split out of pipeline.ts so the orchestrator stays lean.
import { execFileSync } from "node:child_process";

/** Run `git` and return trimmed stdout, or null on non-zero exit (the `|| true` idiom). */
export function gitOrNull(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 1024,
    }).trim();
  } catch (err) {
    // The null return IS the contract (absent ref/path is an expected outcome);
    // still log so a genuinely broken git invocation is diagnosable.
    process.stderr.write(
      `  Note: git ${args[0] ?? ""} returned non-zero (${err instanceof Error ? err.message.split("\n")[0] : String(err)})\n`,
    );
    return null;
  }
}

/** Resolve the head sha for state/anchoring: GITHUB_SHA for HEAD, else `git rev-parse`. */
export function resolveHeadSha(reviewHead: string, contextSha: string, cwd: string): string {
  if (reviewHead === "HEAD") return contextSha;
  return gitOrNull(["rev-parse", reviewHead], cwd) ?? contextSha;
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
    } catch (err) {
      process.stderr.write(
        `  Note: could not read ${path} at ${reviewHead} (${err instanceof Error ? err.message.split("\n")[0] : String(err)})\n`,
      );
      return null;
    }
  };
}
