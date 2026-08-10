// streamVerdict.test.ts — the streaming transport's contract (AC-4, AC-5).
//
// Every case replays REAL recorded review content (src/llm/__tests__/fixtures) through
// the REAL provider stack: resolveModel → @openrouter/ai-sdk-provider → streamObject.
// Only the framing is synthesized — the recorded completion is re-chunked into the
// chat-completion SSE deltas the wire would have produced for it (sse.ts). Nothing is
// mocked: the fetch seam is the same one production uses.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { APICallError, NoObjectGeneratedError } from "ai";
import { MockLanguageModelV1 } from "ai/test";
import { z } from "zod";
import { streamVerdict, type StreamVerdictResult } from "@/llm/streamVerdict.js";
import { resolveModel } from "@/llm/providers.js";
import { reviewWithModel } from "@/llm/reviewWithModel.js";
import type { Envelope } from "@/prompt.js";
import { contentFrames, replayCompletion, sseResponse } from "@/__tests__/integration/sse.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

const Recorded = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).nonempty(),
});

/** The recorded completion body, and the content string inside it. */
function fixture(name: string): { body: unknown; content: string } {
  const body: unknown = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));
  return { body, content: Recorded.parse(body).choices[0].message.content };
}

/** Run one streamed review against `fetch`, with a caller-owned abort signal. */
function stream(
  fetchImpl: typeof fetch,
  signal = new AbortController().signal,
): Promise<StreamVerdictResult> {
  return streamVerdict({
    model: resolveModel({
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
      apiKey: "sk-test",
      fetch: fetchImpl,
    }),
    system: "You are a code reviewer.",
    prompt: "Review the following pull request diff.",
    maxTokens: 4096,
    maxRetries: 0,
    abortSignal: signal,
  });
}

/** A fetch replaying one recorded body in whatever shape the request asked for. */
function replay(name: string): typeof fetch {
  const { body } = fixture(name);
  return async (_url, init) => replayCompletion(body, init);
}

/** A body that delivers `frames` and then NEVER closes, dying only when the caller's
 *  deadline fires — exactly how a real response body behaves on abort. */
function stallingBody(frames: unknown[], signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(f)}\n\n`));
      const die = (): void => {
        controller.error(new DOMException("This operation was aborted", "AbortError"));
      };
      if (signal.aborted) die();
      else signal.addEventListener("abort", die, { once: true });
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const ENVELOPE: Envelope = {
  system: "You are a code reviewer.",
  user: "Review the following pull request diff.",
  max_tokens: 4096,
  enforce_json_schema: true,
};

describe("streamVerdict — the happy path (AC-4)", () => {
  it("reproduces the recorded review exactly when the content arrives as SSE deltas", async () => {
    const { content } = fixture("findings-two");
    const result = await stream(replay("findings-two"));

    // The recorded content, re-chunked into ~80-char deltas and reassembled by the SDK,
    // must yield the same object generateObject produced from the single JSON body.
    expect(result.outcome).toBe("complete");
    if (result.outcome !== "complete") throw new Error("expected a complete stream");
    expect(result.finishReason).toBe("stop");
    const recorded: unknown = JSON.parse(content);
    expect(result.object).toEqual(recorded);
  });
});

describe("streamVerdict — a cut stream (AC-5)", () => {
  it("returns the findings completed before a finish_reason length cut", async () => {
    // truncated-findings.json is a real completion cut mid-third-finding: two findings
    // closed before the cut, the third stops inside its severity string.
    const result = await stream(replay("truncated-findings"));

    expect(result.outcome).toBe("truncated");
    if (result.outcome !== "truncated") throw new Error("expected a truncated stream");
    expect(result.finishReason).toBe("length");
    expect(result.findings.map((f) => f.path)).toEqual(["src/auth.ts", "src/db.ts"]);
    // The plan is emitted before the findings, so it survives the cut.
    expect(result.review_plan).toContain("Reviewing the diff");
  });

  it("throws NoObjectGeneratedError when the cut landed before the first finding closed", async () => {
    // deepseek-truncated-before-findings.json stops at exactly `"findings":[`. The SDK's
    // partial parser CLOSES that to `[]`, which validates — so `object` resolves with an
    // empty review. That `[]` means unknown, not clean: it must abstain, never return a
    // zero-finding blocking verdict. The raw text rides along so the caller's budget
    // escalation still recognizes a real truncation.
    const { content } = fixture("deepseek-truncated-before-findings");
    const err: unknown = await stream(replay("deepseek-truncated-before-findings")).then(
      () => null,
      (e: unknown) => e,
    );

    expect(NoObjectGeneratedError.isInstance(err)).toBe(true);
    if (!NoObjectGeneratedError.isInstance(err)) throw new Error("expected the SDK error class");
    expect(err.finishReason).toBe("length");
    expect(err.text).toBe(content);
  });

  it("salvages the streamed prefix when the caller's deadline cuts the body", async () => {
    // The deadline case: every finding of a real recorded review reaches us, then the
    // per-attempt AbortController fires before the finish frame. The prefix is worth
    // keeping — abstaining here would throw away findings we actually received.
    const { content } = fixture("findings-two");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    const result = await stream(
      async () => stallingBody(contentFrames(content, "stop").slice(0, -1), controller.signal),
      controller.signal,
    );
    clearTimeout(timer);

    expect(result.outcome).toBe("aborted-with-prefix");
    if (result.outcome !== "aborted-with-prefix") throw new Error("expected an aborted stream");
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]?.path).toBe("src/util.ts");
  }, 10_000);

  it("re-throws a BARREN abort so the caller's hang retry still fires", async () => {
    // Nothing arrived before the deadline, so there is no prefix to salvage: the abort
    // must surface as a throw, which is what reviewWithModel's retry branch keys off.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 50);
    const err: unknown = await stream(
      async () => stallingBody([], controller.signal),
      controller.signal,
    ).then(
      () => null,
      (e: unknown) => e,
    );
    clearTimeout(timer);

    expect(err).toBeInstanceOf(Error);
    expect(NoObjectGeneratedError.isInstance(err)).toBe(false);
  }, 10_000);
});

describe("streamVerdict — transport failures (AC-5)", () => {
  it("re-throws the provider's APICallError verbatim, identity intact", async () => {
    // A real gateway 5xx: the SDK raises APICallError and enqueues it as an error part
    // (the `object` promise never settles). Identity is load-bearing — classifyFailure
    // reads the error CLASS to tell transport from schema, and bisect.ts branches on it.
    const err: unknown = await stream(
      async () => new Response("upstream exploded", { status: 500 }),
    ).then(
      () => null,
      (e: unknown) => e,
    );

    expect(APICallError.isInstance(err)).toBe(true);
    if (!APICallError.isInstance(err)) throw new Error("expected an APICallError");
    expect(err.statusCode).toBe(500);
  });

  it("re-throws an error frame that arrives mid-stream", async () => {
    // The provider can also fail AFTER the headers: an `{error:…}` frame in the middle of
    // an otherwise healthy stream. Nothing was completed, so there is nothing to salvage.
    const { content } = fixture("findings-two");
    const frames: unknown[] = [
      ...contentFrames(content, "stop").slice(0, 2),
      { error: { code: 503, message: "upstream disconnected", type: "server_error", param: null } },
    ];

    await expect(stream(async () => sseResponse(frames))).rejects.toBeDefined();
  });

  it("does not hang when the response body dies mid-stream (early-closed connection)", async () => {
    // A truncated chunked body: undici errors the stream instead of closing it, so no
    // finish part ever arrives. Awaiting `object` here would hang forever — it never
    // settles on a transport failure — so the error has to propagate, and the classifier
    // must read it as transport rather than a schema problem.
    const { content } = fixture("findings-two");
    const dying: typeof fetch = async () => {
      const encoder = new TextEncoder();
      const first = contentFrames(content, "stop")[0];
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(first)}\n\n`));
            controller.error(new TypeError("terminated"));
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };

    await expect(stream(dying)).rejects.toBeDefined();

    // End to end: the abstention it produces is a transport failure, promptly.
    const result = await reviewWithModel(ENVELOPE, {
      model: "deepseek/deepseek-v4-flash",
      apiKey: "sk-test",
      fetch: dying,
      maxRetries: 0,
      maxAttempts: 1,
    });
    expect(result.verdict).toBe("error");
    expect(result.failure).toBe("transport");
  }, 10_000);

  it("throws instead of awaiting object when the stream ends with no finish part", async () => {
    // Defensive backstop, unreachable through the shipped providers: both transforms
    // synthesize a finish part on flush, so only a future/misbehaving provider can end
    // a stream finishless. The SDK's own test model is the one way to exercise the
    // branch directly — everything else in this file rides the real provider stack.
    const { content } = fixture("findings-two");
    const finishless = new MockLanguageModelV1({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-delta", textDelta: content });
            controller.close(); // no finish part, no error part
          },
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      }),
    });
    const err: unknown = await streamVerdict({
      model: finishless,
      system: "You are a code reviewer.",
      prompt: "Review the following pull request diff.",
      maxTokens: 4096,
      maxRetries: 0,
      abortSignal: new AbortController().signal,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    if (!(err instanceof Error)) throw new Error("expected an Error");
    // Transport-classified per AC-5: NOT the SDK's schema-failure class.
    expect(NoObjectGeneratedError.isInstance(err)).toBe(false);
    expect(err.message).toBe("model stream ended without a finish or error part");
  });
});
