import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { reviewWithModel } from "@/llm/reviewWithModel.js";
import type { Envelope } from "@/prompt.js";
import { replayCompletion } from "@/__tests__/integration/sse.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** The fields of the outgoing OpenRouter request body this test asserts on. */
interface CapturedBody {
  model?: string;
  reasoning?: { effort?: string };
  provider?: { require_parameters?: boolean };
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  /** A caller-supplied EXTRA_BODY field, for the openai-compatible transport only. */
  chat_template_kwargs?: { enable_thinking?: boolean };
}

/** A fetch that records the outgoing request body, then replays the success fixture
 *  (as SSE — the review call streams). */
function capturingFetch(captured: { body: CapturedBody | null }): typeof fetch {
  const success = JSON.parse(readFileSync(join(FIXTURES, "success.json"), "utf8"));
  return async (_url, init) => {
    captured.body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    return replayCompletion(success, init);
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
    // Review calls STREAM (llm/streamVerdict.ts) — that is what makes a response cut at
    // max_tokens salvageable instead of an unparseable throw.
    expect(body.stream).toBe(true);
  });
});

describe("outgoing request shape (custom openai-compatible endpoint)", () => {
  it("carries EXTRA_BODY onto the wire, and no OpenRouter-only extras with it", async () => {
    // EXTRA_BODY reaches the request ONLY through providers.ts's
    // defaultSettingsMiddleware({ settings: { providerMetadata: { "openai-compatible": … } } })
    // — which works because that literal string happens to equal config.provider.split(".")[0]
    // inside @ai-sdk/openai-compatible. The only other exercise of the path is
    // custom-endpoint-live.test.ts, and it is skipIf(!TOOLU_LIVE_BASE_URL || !TOOLU_LIVE_MODEL)
    // — permanently skipped in CI. custom-endpoint-inputs.test.ts asserts the resolved
    // provider id but never that the fields land in the body. So an SDK upgrade, or a rename
    // of `name:` in createOpenAICompatible, silently drops EXTRA_BODY with a green suite: a
    // Qwen3/oMLX user's enable_thinking:false stops being sent, the model burns max_tokens on
    // hidden reasoning, the caller sees empty content with finish_reason "length", and every
    // chunk abstains. This is the offline proof that cannot be skipped.
    const captured: { body: CapturedBody | null } = { body: null };

    await reviewWithModel(ENVELOPE, {
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:8000/v1",
      extraBody: { chat_template_kwargs: { enable_thinking: false } },
      model: "qwen3-32b",
      apiKey: "",
      fetch: capturingFetch(captured),
      maxRetries: 0,
      maxAttempts: 1,
    });

    const body = captured.body;
    if (body === null) throw new Error("capturingFetch never recorded a request body");

    // The caller's extra field arrives verbatim, at the TOP LEVEL of the request body.
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.model).toBe("qwen3-32b");
    // OpenRouter's routing/reasoning extras must never reach another server.
    expect(body.reasoning).toBeUndefined();
    expect(body.provider).toBeUndefined();
    // The rest of the review contract is unchanged on the compatible transport.
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(4096);
    expect(body.stream).toBe(true);
  });

  it("omits the field entirely when EXTRA_BODY is not set (control for the capture above)", async () => {
    // Without this control the assertion above could pass vacuously — e.g. if the capturing
    // fetch recorded something other than the real outgoing body. Same transport, same
    // endpoint, no extraBody: the field must be ABSENT, proving it arrives because of
    // EXTRA_BODY and not from the compatible provider's own defaults.
    const captured: { body: CapturedBody | null } = { body: null };

    await reviewWithModel(ENVELOPE, {
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:8000/v1",
      model: "qwen3-32b",
      apiKey: "",
      fetch: capturingFetch(captured),
      maxRetries: 0,
      maxAttempts: 1,
    });

    const body = captured.body;
    if (body === null) throw new Error("capturingFetch never recorded a request body");
    expect(body.chat_template_kwargs).toBeUndefined();
    expect(body.model).toBe("qwen3-32b");
  });
});
