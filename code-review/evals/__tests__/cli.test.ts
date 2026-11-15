// evals/__tests__/cli.test.ts — real subprocess tests for evals/run.ts's early
// exit paths: `--help` (no env/key/gh needed), a missing API_KEY, and `gh`
// missing/unauthenticated (a PATH shim intercepts the REAL `gh` binary — same
// technique as src/git/__tests__/spawncount.test.ts's git shim; no mock of our
// own modules). Run with `bun run test:evals`, which `bun run check` and CI
// both invoke.
import { describe, it, expect, afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const CODE_REVIEW_DIR = join(dirname(new URL(import.meta.url).pathname), "..", "..");

/** Resolve an absolute path to a real binary — BEFORE any PATH override, so
 *  the subprocess itself is always found regardless of what PATH we hand its
 *  child environment (mirrors spawncount.test.ts's `resolveRealGit`). */
function resolveBin(name: string): string {
  return execFileSync("bash", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
}

const BUN_BIN = resolveBin("bun");
const BASH_DIR = dirname(resolveBin("bash"));

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** What a failed `execFileSync` throws (Node's child_process contract) —
 *  narrowed without an `as` cast, same idiom as evals/fetch.ts's `NodeExecError`. */
interface ExecError extends Error {
  status?: number;
  stdout?: string;
  stderr?: string;
}

function isExecError(err: unknown): err is ExecError {
  return err instanceof Error;
}

/** Run `bun evals/run.ts <args>` as a real subprocess with a fully-controlled
 *  environment (never inherits this process's own PATH/API_KEY/etc). */
function runCli(args: readonly string[], env: Record<string, string>): RunResult {
  try {
    const stdout = execFileSync(BUN_BIN, [join(CODE_REVIEW_DIR, "evals", "run.ts"), ...args], {
      cwd: CODE_REVIEW_DIR,
      encoding: "utf8",
      env,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    if (!isExecError(err)) throw err;
    return { status: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

/** Every `it` here spawns a real bun subprocess that loads the whole app, so
 *  bun's 5s default is far too tight under CI load — one shared generous timeout. */
const SUBPROCESS_TIMEOUT_MS = 60_000;

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A PATH directory holding ONLY bun.
 *
 *  `dirname(BUN_BIN)` is not enough: a package manager that keeps every CLI in
 *  one bin dir (Homebrew puts `bun`, `gh` and the rest together) makes the "gh
 *  missing from PATH" case find the real `gh`, so the test then asserts on
 *  whatever the developer's own gh auth state happens to be. Symlink bun into a
 *  temp dir instead, and the absence of `gh` is a fact about the test, not about
 *  the machine running it. The subprocess is still launched by absolute path
 *  (BUN_BIN), so this dir only has to satisfy the `gh` lookup inside it. */
function bunOnlyPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "eval-bun-only-"));
  cleanupDirs.push(dir);
  symlinkSync(BUN_BIN, join(dir, "bun"));
  return dir;
}

describe("evals/run.ts --help", () => {
  it(
    "exits 0 and prints usage with NO env at all (no key, no gh, no network)",
    () => {
      const result = runCli(["--help"], { PATH: bunOnlyPath() });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Usage: bun evals/run.ts");
      expect(result.stdout).toContain("API_KEY");
    },
    SUBPROCESS_TIMEOUT_MS,
  );

  it(
    "-h behaves the same as --help",
    () => {
      const result = runCli(["-h"], { PATH: bunOnlyPath() });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Usage:");
    },
    SUBPROCESS_TIMEOUT_MS,
  );
});

describe("evals/run.ts — missing API_KEY", () => {
  it(
    "fails clearly before ever touching gh (PATH has no gh either)",
    () => {
      const result = runCli(["--pr", "acme/widgets#1"], { PATH: bunOnlyPath() });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("API_KEY is required");
    },
    SUBPROCESS_TIMEOUT_MS,
  );
});

describe("evals/run.ts — gh missing from PATH", () => {
  it(
    "fails with a clear install pointer, not a raw ENOENT",
    () => {
      const result = runCli(["--pr", "acme/widgets#1"], {
        PATH: bunOnlyPath(),
        API_KEY: "sk-test",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("gh CLI not found on PATH");
      expect(result.stderr).toContain("https://cli.github.com");
    },
    SUBPROCESS_TIMEOUT_MS,
  );
});

describe("evals/run.ts — gh not authenticated", () => {
  /** A fake `gh` that always fails the way the real CLI does when logged out. */
  function installFakeGh(): string {
    const dir = mkdtempSync(join(tmpdir(), "eval-gh-shim-"));
    cleanupDirs.push(dir);
    const script =
      "#!/usr/bin/env bash\n" +
      'echo "To get started with GitHub CLI, please run:  gh auth login" >&2\n' +
      "exit 1\n";
    const ghPath = join(dir, "gh");
    writeFileSync(ghPath, script);
    chmodSync(ghPath, 0o755);
    return dir;
  }

  it(
    "surfaces a clear not-authenticated message, not gh's raw stderr alone",
    () => {
      const ghDir = installFakeGh();
      const result = runCli(["--pr", "acme/widgets#1"], {
        PATH: `${ghDir}:${bunOnlyPath()}:${BASH_DIR}`,
        API_KEY: "sk-test",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("gh is not authenticated");
      expect(result.stderr).toContain("gh auth login");
    },
    SUBPROCESS_TIMEOUT_MS,
  );
});
