// process-exit.test.ts — regression for the "stuck on the loading gif, job green"
// bug (comemory PR #41 / run 27856347580).
//
// SYMPTOM: the action posts the in-progress comment, runs ~one REQUEST_TIMEOUT_MS,
// then the Node process exits 0 with NO further output — the verdict comment is
// never posted, "Review complete" never logs, and the job still goes GREEN.
//
// ROOT CAUSE: reviewWithModel's retry backoff timer was `.unref()`'d. When a
// per-attempt timeout aborts the in-flight LLM request the fetch socket is
// destroyed, so during the backoff that timer is the ONLY pending handle. An
// unref'd timer does not keep the event loop alive, so Node sees an empty loop
// and exits 0 mid-retry — the loop never resumes and the pipeline never finalizes.
//
// WHY A SUBPROCESS: the sibling in-process test ("retries a hung attempt and
// succeeds on the next") passes EVEN WITH the bug, because Vitest's own runner
// keeps the event loop alive, masking the premature exit. The bug only manifests
// in a bare Node process — exactly what the GitHub Action runs — so this test
// bundles reviewWithModel with esbuild (no mocks of our code) and runs it under a
// real `node` child. Real fetch seam, real openrouter.ts, real process lifecycle.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", ".."); // code-review/ — holds tsconfig + node_modules
const FIXTURE = join(HERE, "fixtures", "success.json");

// A bare-process harness: attempt 1 hangs (a REF'd timer mimics the live request
// socket holding the loop open) until OUR per-attempt AbortController fires, which
// rejects with an AbortError exactly as the real fetch does; attempt 2 replays the
// recorded success body. If the retry runs to completion the harness prints
// "RESULT:changes"; if the process exits early during the backoff it prints NOTHING.
const HARNESS = `
import { readFileSync } from "node:fs";
import { reviewWithModel } from "@/llm/openrouter.js";

void (async () => {
  const success = JSON.parse(readFileSync(process.argv[2], "utf8"));
  let calls = 0;
  const flakyFetch: typeof fetch = (_url, init) => {
    calls++;
    if (calls === 1) {
      return new Promise<Response>((_resolve, reject) => {
        // Ref'd timer = the in-flight request socket that keeps the loop alive until
        // the per-attempt deadline aborts it (just like a real pending fetch).
        const live = setTimeout(() => {}, 60_000);
        const onAbort = () => {
          clearTimeout(live);
          reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
        };
        // Guard the abort race: if the signal already fired before the listener is
        // attached, reject immediately instead of hanging forever.
        if (init?.signal?.aborted) onAbort();
        else init?.signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    return Promise.resolve(
      new Response(JSON.stringify(success), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };

  const result = await reviewWithModel(
    { system: "s", user: "u", max_tokens: 4096, enforce_json_schema: true },
    {
      model: "deepseek/deepseek-v4-flash",
      apiKey: "sk-test",
      fetch: flakyFetch,
      maxRetries: 0,
      timeoutMs: 50,
      maxAttempts: 3,
    },
  );
  process.stdout.write("RESULT:" + result.verdict + ":calls=" + calls + "\\n");
})();
`;

let outDir: string;
let bundle: string;

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), "cr-process-exit-"));
  bundle = join(outDir, "harness.cjs");
  await build({
    stdin: { contents: HARNESS, resolveDir: ROOT, loader: "ts", sourcefile: "harness.ts" },
    outfile: bundle,
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    tsconfig: join(ROOT, "tsconfig.json"), // resolves the @/* path alias
  });
}, 60_000);

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

it("completes the retry in a bare process — the aborted-attempt backoff must keep the event loop alive", () => {
  const stdout = execFileSync("node", [bundle, FIXTURE], { encoding: "utf8", timeout: 30_000 });
  // The success verdict from attempt 2 came through: the process stayed alive across
  // the backoff and the retry ran. Assert the EXACT last output line (not a loose
  // substring) so incidental stdout can't yield a false positive. With the unref'd-
  // backoff bug the process exits 0 during the backoff and stdout is empty.
  const lastLine = stdout.trim().split("\n").at(-1);
  expect(lastLine).toBe("RESULT:changes:calls=2");
}, 30_000);
