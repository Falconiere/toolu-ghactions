// budget.test.ts — the output-budget ladder and the provider's own cap (AC-7).
//
// Every case drives the REAL loop (reviewWithModel → streamVerdict → the shipped
// OpenRouter provider) through the fetch seam production uses: recorded review content
// re-served as chat-completion SSE frames (sse.ts), and REAL provider error bodies for the
// refusal cases. Nothing is mocked — the assertions are on what the wire saw (`max_tokens`
// per request, call counts) and on the ProviderResult that came back.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { APICallError } from "ai";
import { reviewWithModel } from "@/llm/reviewWithModel.js";
import { MAX_ESCALATIONS, MAX_TOKEN_CEILING, isProviderCap } from "@/llm/budget.js";
import type { Envelope } from "@/prompt.js";
import { replayCompletion } from "@/__tests__/integration/sse.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** A recorded OpenRouter chat-completions body. */
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));
}

/** The action's default output budget — the number the ladder has to climb from. */
const DEFAULT_MAX_TOKENS = 8192;

const ENVELOPE: Envelope = {
  system: "You are a code reviewer.",
  user: "Review the following pull request diff.",
  max_tokens: DEFAULT_MAX_TOKENS,
  enforce_json_schema: true,
};

/** DeepSeek's REAL 400 for an over-cap budget: the model refuses the request outright,
 *  naming max_tokens and the range it will accept. */
const MAX_TOKENS_400 = JSON.stringify({
  error: {
    message: "Invalid max_tokens value, the valid range of max_tokens is [1, 8192]",
    type: "invalid_request_error",
    param: "max_tokens",
    code: "invalid_request_error",
  },
});

/** A rate limit whose body happens to ECHO the offending request — including its
 *  max_tokens. Transient, and emphatically NOT a per-request cap. */
const RATE_LIMIT_429 = JSON.stringify({
  error: {
    message: 'Rate limit exceeded for request {"max_tokens":65536}. Retry in 20s.',
    type: "rate_limit_error",
    code: "rate_limit_exceeded",
  },
});

const JSON_HEADERS = { "content-type": "application/json" };

/** The `max_tokens` each outgoing request asked for, in call order. */
function budgetsOf(bodies: string[]): unknown[] {
  return bodies.map((raw) => {
    const parsed: { max_tokens?: number } = JSON.parse(raw);
    return parsed.max_tokens;
  });
}

/** A fetch that records every request body and answers by call index — the seam the real
 *  provider client uses, so the SDK's own request shaping is exercised. */
function scripted(answer: (call: number, init: RequestInit | undefined) => Response): {
  fetch: typeof fetch;
  bodies: string[];
} {
  const bodies: string[] = [];
  const impl: typeof fetch = async (_url, init) => {
    bodies.push(typeof init?.body === "string" ? init.body : "{}");
    return answer(bodies.length - 1, init);
  };
  return { fetch: impl, bodies };
}

describe("budget escalation (AC-7)", () => {
  it("doubles 8192 → 131072 in four escalations, then salvages with the budget exhausted", async () => {
    // Every call returns the SAME recorded truncation (two findings complete, the third
    // cut). maxAttempts is 1 ON PURPOSE: escalations are a separate counter, so a ladder
    // that spent hang attempts would have stopped after ONE call. Five calls at the
    // doubled budgets is the proof that it did not.
    const { fetch: fetchImpl, bodies } = scripted((_call, init) =>
      replayCompletion(fixture("truncated-findings"), init),
    );

    const result = await reviewWithModel(ENVELOPE, {
      model: "deepseek/deepseek-v4-flash",
      apiKey: "sk-test",
      fetch: fetchImpl,
      maxRetries: 0,
      maxAttempts: 1,
    });

    expect(budgetsOf(bodies)).toEqual([8192, 16384, 32768, 65536, MAX_TOKEN_CEILING]);
    expect(bodies).toHaveLength(MAX_ESCALATIONS + 1);
    // The prefix survives, and the wording names the only knob left: the budget cannot
    // grow past its ceiling, so the chunk has to get smaller.
    expect(result.verdict).toBe("changes");
    expect(result.partial).toBe(true);
    expect(result.finishReason).toBe("length");
    expect(result.findings.map((f) => f.path)).toEqual(["src/auth.ts", "src/db.ts"]);
    expect(result.budgetExhausted).toBe(true);
    expect(result.error).toContain("lower MAX_CHUNK_LINES");
    expect(result.error).toContain(String(MAX_TOKEN_CEILING));
    expect(result.error).not.toContain("Raise MAX_TOKENS");
  }, 20_000);
});

describe("the provider's own max_tokens cap (AC-7)", () => {
  it("resolves a retained prefix as budget-exhausted, with NO extra call", async () => {
    // The first call truncates (prefix retained) and the escalation asks for a budget the
    // model refuses with a 400 naming max_tokens. Re-calling bigger would fail identically,
    // so the retained prefix IS the answer — and exactly two calls were spent.
    const { fetch: fetchImpl, bodies } = scripted((call, init) =>
      call === 0
        ? replayCompletion(fixture("truncated-findings"), init)
        : new Response(MAX_TOKENS_400, { status: 400, headers: JSON_HEADERS }),
    );

    const result = await reviewWithModel(ENVELOPE, {
      model: "deepseek/deepseek-v4-flash",
      apiKey: "sk-test",
      fetch: fetchImpl,
      maxRetries: 0,
      maxAttempts: 3,
    });

    expect(bodies).toHaveLength(2);
    expect(result.verdict).toBe("changes");
    expect(result.partial).toBe(true);
    expect(result.findings).toHaveLength(2);
    expect(result.budgetExhausted).toBe(true);
    expect(result.error).toContain("lower MAX_CHUNK_LINES");
  }, 20_000);

  it("abstains as transport on a FIRST-call 400 — never an empty partial", async () => {
    // MAX_TOKENS set above the model's real per-request cap: the very first call is
    // refused, so there is no prefix to resolve to. A "partial" with zero findings would
    // be a blocking review nobody can act on, so this abstains instead, and the failure
    // stays the honest transport classification.
    const { fetch: fetchImpl, bodies } = scripted(
      () => new Response(MAX_TOKENS_400, { status: 400, headers: JSON_HEADERS }),
    );

    const result = await reviewWithModel(ENVELOPE, {
      model: "deepseek/deepseek-v4-flash",
      apiKey: "sk-test",
      fetch: fetchImpl,
      maxRetries: 0,
      maxAttempts: 1,
    });

    expect(bodies).toHaveLength(1);
    expect(result.verdict).toBe("error");
    expect(result.findings).toEqual([]);
    expect(result.partial).toBeUndefined();
    expect(result.budgetExhausted).toBeUndefined();
    expect(result.failure).toBe("transport");
  }, 20_000);

  it("does NOT treat a 429 echoing max_tokens as a cap", async () => {
    // A rate limit that quotes the request body is still a rate limit. Treating it as a
    // cap would end the review early with a partial when a retry was the right answer,
    // so it stays a transport failure — the prefix is not laundered into a verdict.
    const { fetch: fetchImpl, bodies } = scripted((call, init) =>
      call === 0
        ? replayCompletion(fixture("truncated-findings"), init)
        : new Response(RATE_LIMIT_429, { status: 429, headers: JSON_HEADERS }),
    );

    const result = await reviewWithModel(ENVELOPE, {
      model: "deepseek/deepseek-v4-flash",
      apiKey: "sk-test",
      fetch: fetchImpl,
      maxRetries: 0,
      maxAttempts: 1,
    });

    expect(bodies).toHaveLength(2);
    expect(result.verdict).toBe("error");
    expect(result.partial).toBeUndefined();
    expect(result.budgetExhausted).toBeUndefined();
    expect(result.failure).toBe("transport");
  }, 20_000);

  it("keys the predicate on status AND text, over real APICallError instances", async () => {
    // The parenthesization is load-bearing: `400 && (message || body)`, never
    // `(400 && message) || body`. These are the SDK's own error class, built from the
    // same bodies the cases above put on the wire.
    const call = (status: number, responseBody: string, message: string): APICallError =>
      new APICallError({
        message,
        url: "https://openrouter.ai/api/v1/chat/completions",
        requestBodyValues: {},
        statusCode: status,
        responseBody,
      });

    expect(isProviderCap(call(400, MAX_TOKENS_400, "Bad Request"))).toBe(true);
    expect(isProviderCap(call(400, "{}", "Invalid max_tokens value"))).toBe(true);
    // Same text, transient status — not a cap.
    expect(isProviderCap(call(429, RATE_LIMIT_429, "Too Many Requests"))).toBe(false);
    expect(isProviderCap(call(500, MAX_TOKENS_400, "Internal Server Error"))).toBe(false);
    // Right status, unrelated complaint — not a cap either.
    expect(isProviderCap(call(400, '{"error":"bad temperature"}', "Bad Request"))).toBe(false);
    expect(isProviderCap(new Error("max_tokens"))).toBe(false);
  });
});
