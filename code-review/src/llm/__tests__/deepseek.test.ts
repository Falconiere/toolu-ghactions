// deepseek.test.ts — the native DeepSeek provider path. Asserts the outgoing request
// shape (AC-1: api.deepseek.com, json_object, none of the OpenRouter-only extras) and
// the end-to-end parse of a REAL recorded DeepSeek response into a ProviderResult
// (AC-7). The fixture deepseek-success.json is a genuine api.deepseek.com completion,
// recorded via a one-off live call — no hand-faked data.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { reviewWithModel } from "@/llm/reviewWithModel.js";
import type { Envelope } from "@/prompt.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const DEEPSEEK_SUCCESS = JSON.parse(readFileSync(join(FIXTURES, "deepseek-success.json"), "utf8"));

interface CapturedBody {
  model?: string;
  response_format?: { type?: string };
  temperature?: number;
  max_tokens?: number;
  reasoning?: unknown;
  provider?: unknown;
}
interface Captured {
  url: string | null;
  body: CapturedBody | null;
}

/** A fetch that records the outgoing request URL + body, then replays the recorded
 *  native DeepSeek response fixture. */
function capturingFetch(captured: Captured): typeof fetch {
  const impl: typeof fetch = (input, init) => {
    captured.url = input instanceof Request ? input.url : String(input);
    captured.body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    return Promise.resolve(
      new Response(JSON.stringify(DEEPSEEK_SUCCESS), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return impl;
}

const ENVELOPE: Envelope = {
  system: "You are a code reviewer.",
  user: "Review the following pull request diff. Respond ONLY with the required JSON verdict.",
  max_tokens: 4096,
  enforce_json_schema: true,
};

describe("native DeepSeek provider", () => {
  it("AC-1: posts to api.deepseek.com with json_object and none of the OpenRouter extras", async () => {
    const captured: Captured = { url: null, body: null };
    await reviewWithModel(ENVELOPE, {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      apiKey: "sk-test",
      maxRetries: 0,
      fetch: capturingFetch(captured),
    });
    const { url, body } = captured;
    if (url === null || body === null) throw new Error("capturingFetch never recorded a request");
    expect(url).toContain("api.deepseek.com");
    expect(url).toContain("/chat/completions");
    expect(body.model).toBe("deepseek-v4-flash");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(4096);
    // The OpenRouter-only extras must NOT ride on the native DeepSeek request — the
    // native API rejects them and deepseek-v4-flash is non-thinking by default.
    expect(body).not.toHaveProperty("reasoning");
    expect(body).not.toHaveProperty("provider");
  });

  it("AC-7: parses the real recorded DeepSeek response into a ProviderResult", async () => {
    const captured: Captured = { url: null, body: null };
    const result = await reviewWithModel(ENVELOPE, {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      apiKey: "sk-test",
      maxRetries: 0,
      fetch: capturingFetch(captured),
    });
    // The fixture's verdict/findings are the ground truth the parse must reproduce.
    const expected = JSON.parse(DEEPSEEK_SUCCESS.choices[0].message.content);
    expect(result.verdict).not.toBe("error");
    expect(result.verdict).toBe(expected.verdict);
    expect(result.findings).toHaveLength(expected.findings.length);
  });
});
