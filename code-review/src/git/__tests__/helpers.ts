// helpers.ts — build REAL temp git repos for the git-layer tests (no mocks).
// Mirrors the setup_git_repo helper in __tests__/fetch-diff.bats: a temp dir,
// `git init`, identity config, and an initial commit on `main`.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

/** Run a git command in `cwd`, throwing on failure (tests want loud failures). */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** Create a fresh temp dir under the OS tmp root; caller removes it via removeRepo. */
export function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "diff-test-"));
}

/** Recursively remove a temp dir (safe on a missing path). */
export function removeRepo(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Init a temp repo on `main` with a deterministic identity and an initial
 * README commit, returning its path. Matches the bats setup_git_repo.
 */
export function setupGitRepo(): string {
  const dir = makeTmpDir();
  git(dir, "init", "--initial-branch=main", "--quiet");
  git(dir, "config", "user.email", "test@test.com");
  git(dir, "config", "user.name", "Test");
  writeFile(dir, "README.md", "initial\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-m", "initial commit", "--quiet");
  return dir;
}

/** Write a file under `dir` (creating parent directories as needed). */
export function writeFile(dir: string, relPath: string, content: string): void {
  const full = join(dir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}
