// deadline.test.ts — what OUR per-attempt deadline does to a stream (AC-11).
//
// Retry-first with loop-scoped retention: an abort below the attempt ceiling is retried
// exactly as a hang always was, the FINAL attempt's abort settles for the best prefix ANY
// attempt received, and only a run where no attempt ever completed a finding abstains as
// a timeout. Every case runs the real loop over a real response body that stops arriving —
// the same shape a stalled provider produces — with recorded review content in the frames.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { reviewWithModel } from "@/llm/reviewWithModel.js";
import type { Envelope } from "@/prompt.js";
import { contentFrames, replayCompletion } from "@/__tests__/integration/sse.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

const Recorded = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).nonempty(),
});

/** A recorded body, and the review content inside it. */
function fixture(name: string): { body: unknown; content: string } {
  const body: unknown = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));
  return { body, content: Recorded.parse(body).choices[0].message.content };
}

const ENVELOPE: Envelope = {
  system: "You are a code reviewer.",
  user: "Review the following pull request diff.",
  max_tokens: 4096,
  enforce_json_schema: true,
};

/**
 * A body that delivers `frames` and then NEVER closes, dying only when the caller's own
 * per-attempt deadline fires — exactly how a real response body behaves on abort. The
 * signal is the one the AI SDK put on the request, so each attempt gets its own.
 */
function stallingBody(frames: unknown[], signal: AbortSignal | null | undefined): Response {
  if (signal === null || signal === undefined) {
    // A silently hung suite is far worse to debug than a loud failure.
    throw new Error("the AI SDK always signs its requests — a missing signal is a test bug");
  }
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

/** Every content frame of a recorded review EXCEPT the terminal finish frame: the whole
 *  review arrives, then the stream stops — a stall after the useful part. */
function framesWithoutFinish(name: string): unknown[] {
  return contentFrames(fixture(name).content, "stop").slice(0, -1);
}

describe("deadline aborts (AC-11)", () => {
  it("retries an early abort as a hang instead of settling for its prefix", async () => {
    // Attempt 1 receives a complete two-finding prefix and then stalls. There are attempts
    // left, and a transient stall usually clears — so the loop must RETRY rather than bank
    // the prefix. Attempt 2 answers in full, and the review is not partial at all.
    let calls = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls++;
      if (calls === 1) return stallingBody(framesWithoutFinish("findings-two"), init?.signal);
      return replayCompletion(fixture("success").body, init);
    };

    const result = await reviewWithModel(ENVELOPE, {
      model: "deepseek/deepseek-v4-flash",
      apiKey: "sk-test",
      fetch: fetchImpl,
      maxRetries: 0,
      timeoutMs: 100,
      maxAttempts: 3,
    });

    expect(calls).toBe(2);
    expect(result.verdict).toBe("changes");
    expect(result.partial).toBeUndefined();
    expect(result.error).toBeUndefined();
    expect(result.review_plan).toContain("Review Plan");
  }, 20_000);

  it("salvages a prefix from an EARLIER attempt when the final attempt also aborts", async () => {
    // Attempt 1 delivers the findings and stalls; attempt 2 (the last) delivers NOTHING and
    // stalls, so on its own it is barren. Abstaining there would throw away findings we
    // genuinely received, so the retained prefix is returned — with deadline wording, and
    // pointedly WITHOUT the "length" finish reason or any budget advice: the token budget
    // was never the problem here.
    let calls = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls++;
      const frames = calls === 1 ? framesWithoutFinish("findings-two") : [];
      return stallingBody(frames, init?.signal);
    };

    const result = await reviewWithModel(ENVELOPE, {
      model: "deepseek/deepseek-v4-flash",
      apiKey: "sk-test",
      fetch: fetchImpl,
      maxRetries: 0,
      timeoutMs: 100,
      maxAttempts: 2,
    });

    expect(calls).toBe(2);
    expect(result.verdict).toBe("changes");
    expect(result.partial).toBe(true);
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]?.path).toBe("src/util.ts");
    expect(result.error).toContain("per-attempt deadline");
    expect(result.error).not.toContain("MAX_TOKENS");
    expect(result.finishReason).toBeUndefined();
    expect(result.budgetExhausted).toBeUndefined();
  }, 20_000);

  it("abstains as a timeout when NO attempt ever completed a finding", async () => {
    // Barren all the way down: nothing to salvage, so the honest answer is the abstention
    // — classified "timeout" (our own deadline), which review/bisect.ts never bisects.
    let calls = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls++;
      return stallingBody([], init?.signal);
    };

    const result = await reviewWithModel(ENVELOPE, {
      model: "deepseek/deepseek-v4-flash",
      apiKey: "sk-test",
      fetch: fetchImpl,
      maxRetries: 0,
      timeoutMs: 100,
      maxAttempts: 2,
    });

    expect(calls).toBe(2);
    expect(result.verdict).toBe("error");
    expect(result.findings).toEqual([]);
    expect(result.partial).toBeUndefined();
    expect(result.failure).toBe("timeout");
  }, 20_000);
});
