// kimi.test.ts — the native Kimi (Moonshot AI) provider path. Two vendor facts shape it:
// Kimi's current models 400 on any explicit sampling value ("invalid temperature: only 1
// is allowed for this model"), and they reason on every call with no switch, billing the
// reasoning against max_tokens. So the request carries NO temperature and NO thinking
// field, and an EMPTY length cut is retried at a doubled budget instead of abstaining.
// The replayed CONTENT is the real recorded completion in success.json — a Kimi-recorded
// fixture (the analog of deepseek-success.json) needs a Kimi key and is still to be
// captured; until then the parse of a vendor-specific response is unproven here, only
// the request the vendor receives and the loop's reaction to its overrun shape.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { reviewWithModel } from "@/llm/reviewWithModel.js";
import type { Envelope } from "@/prompt.js";
import { replayCompletion } from "@/__tests__/integration/sse.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const SUCCESS = JSON.parse(readFileSync(join(FIXTURES, "success.json"), "utf8"));
const THINKING_LENGTH = JSON.parse(
  readFileSync(join(FIXTURES, "deepseek-thinking-length.json"), "utf8"),
);

interface CapturedBody {
  model?: string;
  response_format?: { type?: string };
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  reasoning?: unknown;
  provider?: unknown;
  thinking?: unknown;
  reasoning_effort?: unknown;
}
interface Captured {
  url: string | null;
  body: CapturedBody | null;
}

/** Parse the outgoing chat-completions body, or null when the request carried none. */
function parseBody(init: RequestInit | undefined): CapturedBody | null {
  return typeof init?.body === "string" ? JSON.parse(init.body) : null;
}

/** A fetch that records the outgoing request URL + body, then replays the recorded
 *  completion as SSE chunk frames (the review call streams). */
function capturingFetch(captured: Captured): typeof fetch {
  const impl: typeof fetch = (input, init) => {
    captured.url = input instanceof Request ? input.url : String(input);
    captured.body = parseBody(init);
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

describe("native Kimi provider", () => {
  it("posts to api.moonshot.ai in JSON mode with no temperature, no thinking field, and none of the OpenRouter extras", async () => {
    const captured: Captured = { url: null, body: null };
    const result = await reviewWithModel(ENVELOPE, {
      provider: "kimi",
      model: "kimi-k2.7-code",
      apiKey: "sk-test",
      maxRetries: 0,
      fetch: capturingFetch(captured),
    });
    const { url, body } = captured;
    if (url === null || body === null) throw new Error("capturingFetch never recorded a request");
    expect(url).toBe("https://api.moonshot.ai/v1/chat/completions");
    expect(body.model).toBe("kimi-k2.7-code");
    // Kimi honours JSON mode on every current model.
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.max_tokens).toBe(4096);
    expect(body.stream).toBe(true);
    // The vendor's sampling gate: any explicit temperature is a 400, so none is sent and
    // the model's forced default applies. The review call still pins 0 (and ai@4 would
    // substitute 0 for an omitted value anyway); the model's middleware strips it.
    expect(body).not.toHaveProperty("temperature");
    // No reasoning switch either: `thinking:{type:"disabled"}` errors on kimi-k2.7-code
    // and is unknown to kimi-k3, and the SDK's reasoning_effort slot stays unset.
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("reasoning_effort");
    // The OpenRouter envelope must NOT ride on a native request.
    expect(body).not.toHaveProperty("reasoning");
    expect(body).not.toHaveProperty("provider");
    // The recorded completion round-trips through the stock openai-compatible client.
    const expected = JSON.parse(SUCCESS.choices[0].message.content);
    expect(result.verdict).toBe(expected.verdict);
    expect(result.findings).toHaveLength(expected.findings.length);
  });

  it("escalates an EMPTY length cut instead of abstaining — the model reasoned past the budget", async () => {
    // deepseek-thinking-length.json is a REAL recording of exactly the shape a reasoning
    // model returns when it burns the budget: finish_reason "length", content "", every
    // completion token spent on reasoning. On DeepSeek that shape is the bug the
    // thinking switch prevents, so the loop abstains after ONE call
    // (reviewWithModel.test.ts). Kimi has no switch, so the same shape is an honest
    // overrun: the loop retries at the doubled budget, and here the second call answers
    // with the recorded success completion.
    const budgets: (number | undefined)[] = [];
    const overrunThenSuccess: typeof fetch = (_input, init) => {
      budgets.push(parseBody(init)?.max_tokens);
      const reply = budgets.length === 1 ? THINKING_LENGTH : SUCCESS;
      return Promise.resolve(replayCompletion(reply, init));
    };

    const result = await reviewWithModel(ENVELOPE, {
      provider: "kimi",
      model: "kimi-k2.7-code",
      apiKey: "sk-test",
      maxRetries: 0,
      // Escalations are counted apart from hang attempts, so a single attempt suffices.
      maxAttempts: 1,
      fetch: overrunThenSuccess,
    });

    expect(budgets).toEqual([4096, 8192]);
    const expected = JSON.parse(SUCCESS.choices[0].message.content);
    expect(result.verdict).toBe(expected.verdict);
    expect(result.findings).toHaveLength(expected.findings.length);
    expect(result.partial).toBeUndefined();
  });
});
