// helpers.ts — build REAL temp git repos for the git-layer tests (no mocks).
// Mirrors the setup_git_repo helper in __tests__/fetch-diff.bats: a temp dir,
// `git init`, identity config, and an initial commit on `main`.
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  existsSync,
  readFileSync,
} from "node:fs";
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

/**
 * Whether this runner's filesystem accepts `name` as a filename — probed by
 * actually creating it in a throwaway temp dir. Used to skip (never silently
 * pass) the special-character path tests on a filesystem that refuses names
 * containing `"` or a tab, such as an exFAT/NTFS mount or macOS SMB.
 */
export function canCreateFile(name: string): boolean {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, name), "probe\n");
    return true;
  } catch {
    // The probe's ONLY question is "does this fs accept the name"; any failure
    // to create it is a no, and the caller skips the case with that reason.
    return false;
  } finally {
    removeRepo(dir);
  }
}

/** Field separator in the spawn log — never appears in an argv entry the tests generate. */
const ARG_SEP = "\x1f";

/** A live PATH shim: where its log is written, and how to undo the install. */
export interface GitShim {
  /** Path of the append-only log holding one line per intercepted invocation. */
  readonly logPath: string;
  /** Restore the previous PATH and delete the shim directory. Idempotent. */
  uninstall(): void;
}

/**
 * Prepend a `git` shim to PATH that appends each invocation's argv to a log and
 * then `exec`s the REAL git binary — so every git call underneath is genuine
 * (no mocks, no fabricated output) while the test can still count invocations
 * and assert on the exact argv the code built. Same technique as
 * `spawncount.test.ts`. Call {@link GitShim.uninstall} in an `afterEach`.
 */
export function installGitShim(): GitShim {
  // Resolve the real git BEFORE prepending, or the shim would exec itself.
  const realGit = execFileSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const shimDir = mkdtempSync(join(tmpdir(), "git-shim-helper-"));
  const logPath = join(shimDir, "spawn.log");
  writeFileSync(logPath, "");
  const script =
    `#!/usr/bin/env bash\n` +
    `printf '%s${ARG_SEP}' "$@" >> "${logPath}"\n` +
    `printf '\\n' >> "${logPath}"\n` +
    `exec "${realGit}" "$@"\n`;
  const shimPath = join(shimDir, "git");
  writeFileSync(shimPath, script);
  chmodSync(shimPath, 0o755);

  const previousPath = process.env.PATH ?? "";
  process.env.PATH = `${shimDir}:${previousPath}`;
  let installed = true;
  return {
    logPath,
    uninstall() {
      if (!installed) return;
      installed = false;
      process.env.PATH = previousPath;
      removeRepo(shimDir);
    },
  };
}

/** Wipe the shim's log so only invocations made AFTER the call are counted. */
export function resetSpawnLog(shim: GitShim): void {
  writeFileSync(shim.logPath, "");
}

/** The argv (without the trailing empty field the separator leaves) of each logged invocation. */
export function readSpawnLog(shim: GitShim): string[][] {
  if (!existsSync(shim.logPath)) return [];
  return readFileSync(shim.logPath, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.split(ARG_SEP).slice(0, -1));
}
