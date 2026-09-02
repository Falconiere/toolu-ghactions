// minimax.test.ts — the native MiniMax provider path. Asserts the outgoing request
// shape: api.minimax.io, the model id, JSON mode, temperature 0 (accepted on the current
// endpoint), the thinking switch plus reasoning_split as top-level body fields, and none
// of the OpenRouter-only extras. The replayed CONTENT is the real recorded completion in
// success.json — a MiniMax-recorded fixture (the analog of deepseek-success.json) needs a
// MiniMax key and is still to be captured; until then the parse of a vendor-specific
// response is unproven here, only the request the vendor receives.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { reviewWithModel } from "@/llm/reviewWithModel.js";
import type { Envelope } from "@/prompt.js";
import { replayCompletion } from "@/__tests__/integration/sse.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const SUCCESS = JSON.parse(readFileSync(join(FIXTURES, "success.json"), "utf8"));

interface CapturedBody {
  model?: string;
  response_format?: { type?: string };
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  reasoning?: unknown;
  provider?: unknown;
  thinking?: unknown;
  reasoning_split?: unknown;
}
interface Captured {
  url: string | null;
  body: CapturedBody | null;
}

/** A fetch that records the outgoing request URL + body, then replays the recorded
 *  completion as SSE chunk frames (the review call streams). */
function capturingFetch(captured: Captured): typeof fetch {
  const impl: typeof fetch = (input, init) => {
    captured.url = input instanceof Request ? input.url : String(input);
    captured.body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    return Promise.resolve(replayCompletion(SUCCESS, init));
  };
  return impl;
}

const ENVELOPE: Envelope = {
  system: "You are a code reviewer.",
  user: "Review the following pull request diff. Respond ONLY with the required JSON verdict.",
  max_tokens: 4096,
  enforce_json_schema: true,
};

describe("native MiniMax provider", () => {
  it("posts to api.minimax.io with the thinking switch, reasoning_split, and none of the OpenRouter extras", async () => {
    const captured: Captured = { url: null, body: null };
    const result = await reviewWithModel(ENVELOPE, {
      provider: "minimax",
      model: "MiniMax-M3",
      apiKey: "sk-test",
      maxRetries: 0,
      fetch: capturingFetch(captured),
    });
    const { url, body } = captured;
    if (url === null || body === null) throw new Error("capturingFetch never recorded a request");
    expect(url).toBe("https://api.minimax.io/v1/chat/completions");
    expect(body.model).toBe("MiniMax-M3");
    // JSON mode. MiniMax ignores response_format on this endpoint, so the schema reaches
    // the model through the prompt instruction the SDK injects; the hint is still sent.
    expect(body.response_format).toEqual({ type: "json_object" });
    // The current M2.x/M3 endpoint accepts temperature on [0, 2] (the legacy API's (0, 1]
    // is gone), so greedy decoding is requested like everywhere else.
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(4096);
    expect(body.stream).toBe(true);
    // The OpenRouter envelope must NOT ride on a native request.
    expect(body).not.toHaveProperty("reasoning");
    expect(body).not.toHaveProperty("provider");
    // MiniMax-M3 thinks by default and honours this switch (the M2.x ids do not); either
    // way reasoning_split keeps any reasoning out of message.content, where MiniMax would
    // otherwise embed it in <think> tags ahead of the JSON.
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.reasoning_split).toBe(true);
    // The recorded completion round-trips through the stock openai-compatible client.
    const expected = JSON.parse(SUCCESS.choices[0].message.content);
    expect(result.verdict).toBe(expected.verdict);
    expect(result.findings).toHaveLength(expected.findings.length);
  });
});
