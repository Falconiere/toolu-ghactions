import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { reviewWithModel } from "@/llm/openrouter.js";
import type { Envelope } from "@/prompt.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** Load a recorded OpenRouter chat-completions response body. */
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));
}

/** A fetch that always replays one recorded response — no network, no code mocks. */
function replayFetch(body: unknown): typeof fetch {
  return async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

const ENVELOPE: Envelope = {
  system: "You are a code reviewer.",
  user: "Review the following pull request diff.",
  max_tokens: 4096,
  enforce_json_schema: true,
};

describe("reviewWithModel", () => {
  it("maps a recorded success response to a changes verdict with the review plan", async () => {
    const result = await reviewWithModel(ENVELOPE, {
      model: "deepseek/deepseek-v4-flash",
      apiKey: "sk-test",
      fetch: replayFetch(fixture("success")),
      maxRetries: 0,
    });

    expect(result.verdict).toBe("changes");
    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.findings)).toBe(true);
    expect(result.review_plan).toContain("Review Plan");
  });

  it("abstains (verdict error) on empty content, carrying finishReason length", async () => {
    const result = await reviewWithModel(ENVELOPE, {
      model: "deepseek/deepseek-v4-flash",
      apiKey: "sk-test",
      fetch: replayFetch(fixture("empty-content")),
      maxRetries: 0,
    });

    // Fail-safe: never a throw, never a null verdict.
    expect(result.verdict).toBe("error");
    expect(result.findings).toEqual([]);
    expect(typeof result.error).toBe("string");
    expect(result.error).toBeTruthy();
    expect(result.finishReason).toBe("length");
  });

  it("aborts a hung provider on the timeout and abstains (verdict error, no hang)", async () => {
    // FIX 5: a fetch that never resolves on its own — it only settles when the
    // AbortController fires (real fetch rejects with an AbortError on signal abort).
    // A short timeoutMs proves the deadline cuts the hang instead of stalling to
    // the 6h runner ceiling. No mocks: this is exactly how the real fetch behaves.
    const hangingFetch: typeof fetch = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
          });
        }
      });

    const start = Date.now();
    const result = await reviewWithModel(ENVELOPE, {
      model: "deepseek/deepseek-v4-flash",
      apiKey: "sk-test",
      fetch: hangingFetch,
      maxRetries: 0,
      timeoutMs: 50,
    });
    const elapsed = Date.now() - start;

    expect(result.verdict).toBe("error");
    expect(result.findings).toEqual([]);
    expect(result.error).toBeTruthy();
    // It returned promptly via the deadline — nowhere near a hang.
    expect(elapsed).toBeLessThan(5_000);
  });

  it("abstains on a non-JSON / error HTTP response instead of throwing", async () => {
    const errorFetch: typeof fetch = async () =>
      new Response("upstream exploded", {
        status: 500,
        headers: { "content-type": "text/plain" },
      });

    const result = await reviewWithModel(ENVELOPE, {
      model: "deepseek/deepseek-v4-flash",
      apiKey: "sk-test",
      fetch: errorFetch,
      maxRetries: 0,
    });

    expect(result.verdict).toBe("error");
    expect(result.findings).toEqual([]);
    expect(result.error).toBeTruthy();
  });
});
