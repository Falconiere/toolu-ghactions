// main.test.ts — exercise the THIN entry main.ts end to end with REAL boundaries:
// the @actions/core inputs come from real INPUT_* env vars, the @actions/github
// context is hydrated from a real event-payload file, and core.setOutput writes
// to a real GITHUB_OUTPUT file we read back. No network: GitHub's REST API is a local
// HTTP server (GITHUB_API_URL), so a crashing PR run's label + comment writes are real.
//
// @actions/github.context is a module-level singleton built at import time, so
// each case sets the env, then dynamically imports a FRESH main module (node_modules
// are NOT re-evaluated by that: GITHUB_API_URL must be set before the first import).
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

let workdir: string;
const savedEnv = { ...process.env };

/**
 * A local GitHub REST API — the real Octokit talks HTTP to it, never to github.com:
 * PR #7 carries `labels`, listing its comments answers 403 (a crashing pipeline), and
 * every write succeeds. Records each request's method, path and auth header.
 */
const api: {
  labels: Set<string>;
  calls: { method: string; path: string; auth: string }[];
  url: string;
} = { labels: new Set(), calls: [], url: "" };
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
  req.on("end", () => {
    const method = req.method ?? "GET";
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    api.calls.push({ method, path, auth: req.headers.authorization ?? "" });
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const label = /\/issues\/7\/labels\/(.+)$/.exec(path)?.[1];
    if (method === "GET" && path.endsWith("/issues/7/comments")) {
      return send(403, { message: "Resource not accessible by integration" });
    }
    if (method === "DELETE" && label !== undefined) {
      api.labels.delete(decodeURIComponent(label));
      return send(200, []);
    }
    if (method === "POST" && path.endsWith("/issues/7/labels")) {
      const body: { labels: string[] } = JSON.parse(raw);
      for (const l of body.labels) api.labels.add(l);
      return send(200, []);
    }
    return send(201, { html_url: "https://github.com/test-org/test-repo/issues/7#c1" });
  });
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  api.url = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

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
  process.env["GITHUB_API_URL"] = api.url;
  api.labels.clear();
  api.calls.length = 0;
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
    // The required API key so readInputs resolves a provider.
    process.env["INPUT_API_KEY"] = "sk-test";
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

  it("AC-9: FAIL_ON=changes + non-trigger skip stays green (gate wired, does not over-fire)", async () => {
    // The merge gate is wired in main(); skip is never blockable, so even with
    // FAIL_ON=changes a non-trigger event must keep the job green. Hermetic: a
    // non-trigger push returns verdict=skip before any model/network call.
    process.env["INPUT_API_KEY"] = "sk-test";
    process.env["INPUT_TOKEN"] = "ghs_token";
    process.env["INPUT_FAIL_ON"] = "changes";
    process.env["GITHUB_SHA"] = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    setEvent("push", { ref: "refs/heads/feature" });

    await runMain();

    const outputs = readOutputs();
    expect(outputs["verdict"]).toBe("skip");
    expect(process.exitCode === undefined || process.exitCode === 0).toBe(true);
  });

  it("infra failure (unsupported PROVIDER) → verdict=error output and the job is failed", async () => {
    // readInputs() throws on an unsupported PROVIDER. This trips the last-resort
    // main().catch BEFORE any octokit/network call — proving the top-level guard sets
    // verdict=error and fails the job hermetically.
    process.env["INPUT_API_KEY"] = "sk-test";
    process.env["INPUT_PROVIDER"] = "openai";
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

/** Wait (bounded) for main()'s floating promise to fail the job. */
async function untilFailed(): Promise<void> {
  for (let i = 0; i < 200 && process.exitCode !== 1; i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("main — infra failure on a PR", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  async function prRun(): Promise<void> {
    process.env["INPUT_API_KEY"] = "sk-test";
    process.env["INPUT_TOKEN"] = "ghs_token";
    process.env["GITHUB_SHA"] = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const payload = { action: "synchronize", pull_request: { number: 7, base: { ref: "main" } } };
    setEvent("pull_request", payload);
    // vi.resetModules does not re-evaluate node_modules, so @actions/github's context
    // singleton keeps the FIRST test's event — point it at this one.
    const { context } = await import("@actions/github");
    context.eventName = "pull_request";
    context.payload = payload;
  }

  it("takes merge-approved away and still fails with the ORIGINAL error", async () => {
    await prRun();
    api.labels.add("merge-approved");
    // core.setFailed reports through a `::error::` workflow command on stdout.
    const stdout = vi.spyOn(process.stdout, "write");

    await runMain();
    await untilFailed();

    expect([...api.labels]).toEqual(["request-changes"]);
    expect(readOutputs()["verdict"]).toBe("error");
    expect(process.exitCode).toBe(1);
    const lines = stdout.mock.calls.map((c) => String(c[0]));
    expect(lines.find((l) => l.startsWith("::error::"))).toContain(
      "AI Code Review failed: could not read PR comments to locate the prior review",
    );
  });

  it("one App credential alone warns and falls back to the default token", async () => {
    await prRun();
    process.env["INPUT_APP_ID"] = "12345";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runMain();
    await untilFailed();

    expect(warn).toHaveBeenCalledWith(
      "[WARN] APP_ID and APP_PRIVATE_KEY must both be set; falling back to github-actions[bot]",
    );
    expect(api.calls[0]?.auth).toBe("token ghs_token");
  });
});
