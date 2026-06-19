// main.test.ts — exercise the THIN entry main.ts end to end with REAL boundaries:
// the @actions/core inputs come from real INPUT_* env vars, the @actions/github
// context is hydrated from a real event-payload file, and core.setOutput writes
// to a real GITHUB_OUTPUT file we read back. No network: the scenarios chosen
// (a non-trigger push, and a missing-token infra failure) never reach an API.
//
// @actions/github.context is a module-level singleton built at import time, so
// each case sets the env, then dynamically imports a FRESH main module.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let workdir: string;
const savedEnv = { ...process.env };

/** Read the parsed key=value pairs core.setOutput wrote to GITHUB_OUTPUT. */
function readOutputs(): Record<string, string> {
  const outputPath = process.env["GITHUB_OUTPUT"];
  if (outputPath === undefined) throw new Error("GITHUB_OUTPUT is not set");
  const raw = readFileSync(outputPath, "utf8");
  const out: Record<string, string> = {};
  // @actions/core writes "name<<delimiter\nvalue\ndelimiter\n" blocks.
  const re = /^([^<\n]+)<<(ghadelimiter_[^\n]+)\n([\s\S]*?)\n\2$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const [, name, , value] = m;
    if (name !== undefined && value !== undefined) out[name] = value;
  }
  return out;
}

/** Write the GitHub event payload to a file and point GITHUB_EVENT_PATH at it. */
function setEvent(eventName: string, payload: unknown): void {
  const eventPath = join(workdir, "event.json");
  writeFileSync(eventPath, JSON.stringify(payload));
  process.env["GITHUB_EVENT_NAME"] = eventName;
  process.env["GITHUB_EVENT_PATH"] = eventPath;
}

/** Import a FRESH main module so github.context re-hydrates from the current env. */
async function runMain(): Promise<void> {
  // Drop the cached module graph so @actions/github's context singleton (built at
  // import time) re-reads the env, and main.ts's side-effecting main() re-fires.
  vi.resetModules();
  await import("@/main.js");
  // main() is fired at import as a floating promise; let the microtasks drain.
  await new Promise((r) => setTimeout(r, 50));
}

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "main-test-"));
  // Reset to a clean env, then set the shared run context.
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("INPUT_") || k.startsWith("GITHUB_")) delete process.env[k];
  }
  process.env["GITHUB_REPOSITORY"] = "test-org/test-repo";
  process.env["GITHUB_SERVER_URL"] = "https://github.com";
  process.env["GITHUB_RUN_ID"] = "999";
  process.env["GITHUB_OUTPUT"] = join(workdir, "outputs.txt");
  writeFileSync(process.env["GITHUB_OUTPUT"], "");
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
  // Restore the original env wholesale.
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

describe("main — entry wiring", () => {
  it("non-trigger push event → sets verdict=skip output, does not fail the job", async () => {
    // A legacy single-provider key so readInputs resolves an effective provider.
    process.env["INPUT_OPENROUTER_API_KEY"] = "sk-test";
    process.env["INPUT_TOKEN"] = "ghs_token";
    process.env["GITHUB_SHA"] = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    setEvent("push", { ref: "refs/heads/feature" });

    await runMain();

    const outputs = readOutputs();
    expect(outputs["verdict"]).toBe("skip");
    expect(outputs["findings-count"]).toBe("0");
    // A skip is success: process.exitCode must not be set to a failure.
    expect(process.exitCode === undefined || process.exitCode === 0).toBe(true);
  });

  it("infra failure (malformed PROVIDERS) → verdict=error output and the job is failed", async () => {
    // readInputs() throws on a PROVIDERS value that is set but not a JSON array.
    // This trips the last-resort main().catch BEFORE any octokit/network call —
    // proving the top-level guard sets verdict=error and fails the job hermetically.
    process.env["INPUT_PROVIDERS"] = "not-a-json-array";
    process.env["INPUT_TOKEN"] = "ghs_token";
    process.env["GITHUB_SHA"] = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    setEvent("pull_request", { pull_request: { number: 7, base: { ref: "main" } } });

    await runMain();

    const outputs = readOutputs();
    expect(outputs["verdict"]).toBe("error");
    // A true infra failure fails the job.
    expect(process.exitCode).toBe(1);
    // Reset so a failing exit code does not leak into the rest of the suite.
    process.exitCode = 0;
  });
});
