import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { reviewWithModel } from "@/llm/openrouter.js";
import type { Envelope } from "@/prompt.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** The fields of the outgoing OpenRouter request body this test asserts on. */
interface CapturedBody {
  model?: string;
  reasoning?: { effort?: string };
  provider?: { require_parameters?: boolean };
  temperature?: number;
  max_tokens?: number;
}

/** A fetch that records the outgoing request body, then replays the success fixture. */
function capturingFetch(captured: { body: CapturedBody | null }): typeof fetch {
  const success = JSON.parse(readFileSync(join(FIXTURES, "success.json"), "utf8"));
  return async (_url, init) => {
    captured.body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    return new Response(JSON.stringify(success), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

const ENVELOPE: Envelope = {
  system: "You are a code reviewer.",
  user: "Review the following pull request diff.",
  max_tokens: 4096,
  enforce_json_schema: true,
};

describe("outgoing request shape (reasoning-off proof)", () => {
  it("carries reasoning.effort none, provider.require_parameters true, and the model id", async () => {
    const captured: { body: CapturedBody | null } = { body: null };

    await reviewWithModel(ENVELOPE, {
      model: "deepseek/deepseek-v4-flash",
      apiKey: "sk-test",
      fetch: capturingFetch(captured),
      maxRetries: 0,
    });

    const body = captured.body;
    if (body === null) throw new Error("capturingFetch never recorded a request body");

    // The bug fix: reasoning disabled so the model does not burn max_tokens.
    expect(body.reasoning?.effort).toBe("none");
    // The bash sets this when enforcing the schema.
    expect(body.provider?.require_parameters).toBe(true);
    // The selected model id reaches the wire.
    expect(body.model).toBe("deepseek/deepseek-v4-flash");
    // temperature 0: greedy decoding for the most reproducible review output achievable.
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(4096);
  });
});
