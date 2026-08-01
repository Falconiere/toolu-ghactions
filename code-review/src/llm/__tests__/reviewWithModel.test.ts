import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { reviewWithModel } from "@/llm/reviewWithModel.js";
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

  it("abstains on the FIRST attempt for empty content (reasoning-budget bug), not after escalating", async () => {
    // Empty content + finish_reason "length" is the reasoning-budget bug, NOT a real
    // mid-JSON truncation: the model burned the whole budget on hidden reasoning and
    // emitted nothing, so a larger budget only burns more reasoning tokens. The loop
    // must abstain immediately — one model call, no budget-escalation retries — even
    // though maxAttempts 3 leaves room.
    let calls = 0;
    const countingFetch: typeof fetch = async () => {
      calls++;
      return new Response(JSON.stringify(fixture("empty-content")), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const result = await reviewWithModel(ENVELOPE, {
      model: "deepseek/deepseek-v4-flash",
      apiKey: "sk-test",
      fetch: countingFetch,
      maxRetries: 0,
      maxAttempts: 3,
    });

    expect(result.verdict).toBe("error");
    expect(result.finishReason).toBe("length");
    // The headline fix: empty content does NOT trigger the 3x budget-escalation retries.
    expect(calls).toBe(1);
  });

  it("salvages the findings completed before a length-truncation cut (partial)", async () => {
    // Recorded response truncated mid-third-finding with finish_reason "length":
    // two findings are complete, the third is cut off. maxAttempts 1 skips the
    // budget-escalation retry and goes straight to salvage.
    const result = await reviewWithModel(ENVELOPE, {
      model: "deepseek/deepseek-v4-flash",
      apiKey: "sk-test",
      fetch: replayFetch(fixture("truncated-findings")),
      maxRetries: 0,
      maxAttempts: 1,
    });

    expect(result.verdict).toBe("changes");
    expect(result.partial).toBe(true);
    expect(result.finishReason).toBe("length");
    // The two complete findings survive; the incomplete trailing one is dropped.
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]?.path).toBe("src/auth.ts");
    expect(result.findings[1]?.path).toBe("src/db.ts");
    expect(result.error).toContain("truncated");
  });

  it("abstains when truncation cut before the first finding, despite a readable verdict", async () => {
    // deepseek-truncated-before-findings.json is a REAL recorded completion cut at
    // exactly `"findings":[` — the verdict ("changes") had already been written, the
    // findings had not. jsonrepair closes that to `findings: []`, which means UNKNOWN,
    // not "clean": nothing was dropped, so the dropped-findings guard cannot catch it.
    // Recovering here would post a blocking "changes requested" carrying zero findings,
    // which the author cannot act on. A truncated pass must carry at least one recovered
    // finding to be worth anything.
    const result = await reviewWithModel(ENVELOPE, {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      apiKey: "sk-test",
      fetch: replayFetch(fixture("deepseek-truncated-before-findings")),
      maxRetries: 0,
      maxAttempts: 1,
    });

    expect(result.verdict).toBe("error");
    expect(result.findings).toEqual([]);
    expect(result.partial).toBeUndefined();
    expect(result.finishReason).toBe("length");
  });

  it("recovers a complete response whose values deviate from the strict schema", async () => {
    // Regression: https://github.com/Falconiere/comemory/pull/62 — "response did not
    // match schema. [finish_reason: stop]". The model answered fully and usefully but
    // off-schema, and the whole pass was thrown away as a provider error.
    //
    // deepseek-schema-mismatch.json is a REAL recorded api.deepseek.com completion whose
    // content carries every deviation at once: verdict "request_changes" (outside the
    // enum), a quoted line "42", severity "CRITICAL", confidence "low" (outside the
    // optional enum), and a third finding with no line at all.
    const result = await reviewWithModel(ENVELOPE, {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      apiKey: "sk-test",
      fetch: replayFetch(fixture("deepseek-schema-mismatch")),
      maxRetries: 0,
      maxAttempts: 1,
    });

    expect(result.verdict).toBe("changes");
    // Two findings normalize cleanly; the third (no line, so nothing to anchor it to)
    // is dropped — a lossy recovery, hence partial.
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]?.line).toBe(42);
    expect(result.findings[0]?.severity).toBe("blocker");
    // "low" is not in the confidence enum: the field is dropped, the finding survives.
    expect(result.findings[0]?.confidence).toBeUndefined();
    expect(result.findings[1]?.severity).toBe("medium");
    expect(result.review_plan).toBe("Checked the auth handler.");
    expect(result.top_must_fix).toEqual(["Fix the token comparison."]);
    expect(result.partial).toBe(true);
    expect(result.error).toContain("dropped");
    // Not a length truncation — the model stopped normally.
    expect(result.finishReason).toBeUndefined();
  });

  it("recovers when the decorative fields come back null, not just the verdict", async () => {
    // deepseek-null-fields.json is a REAL recorded completion that pairs an off-enum
    // verdict with `null` for review_plan/other_checks/top_must_fix — a routine model
    // output. Those three are prose and a hint list; a wrong type in any of them must
    // not sink the recovery of a perfectly good finding.
    const result = await reviewWithModel(ENVELOPE, {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      apiKey: "sk-test",
      fetch: replayFetch(fixture("deepseek-null-fields")),
      maxRetries: 0,
      maxAttempts: 1,
    });

    expect(result.verdict).toBe("changes");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.path).toBe("src/auth.ts");
    expect(result.findings[0]?.line).toBe(88);
    expect(result.findings[0]?.severity).toBe("high");
    expect(result.findings[0]?.text).toBe("Session token logged in plaintext.");
    // Nulls become the empty defaults, and nothing was lost — so NOT a partial review.
    expect(result.review_plan).toBe("");
    expect(result.other_checks).toBe("");
    expect(result.top_must_fix).toEqual([]);
    expect(result.partial).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it("keeps a COMPLETE response's 'approved' even though findings rode along", async () => {
    // The strict schema allows "approved" WITH findings — that is how nits ride along
    // without blocking — and merge.ts/gate.ts key blocking off this field. So recovery
    // must not upgrade the verdict: forcing "changes" here would block a PR the model
    // approved, i.e. recovery would diverge from the happy path it stands in for.
    // Real recorded completion: verdict "approved", one nit, line quoted as "12" (which
    // is what makes the strict schema reject it and recovery run at all).
    const result = await reviewWithModel(ENVELOPE, {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      apiKey: "sk-test",
      fetch: replayFetch(fixture("deepseek-approved-with-nit")),
      maxRetries: 0,
      maxAttempts: 1,
    });

    expect(result.verdict).toBe("approved");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.line).toBe(12);
    expect(result.findings[0]?.severity).toBe("nit");
    // Nothing lost — the quoted line normalized cleanly, so this is a plain success.
    expect(result.partial).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it("overrides a TRUNCATED response's 'approved' to changes", async () => {
    // The mirror of the test above, and the reason the two cases cannot share a rule.
    // deepseek-truncated-approved.json is a real completion that wrote "approved" and
    // then got cut mid-findings. A verdict written BEFORE the cut is not the model's
    // conclusion — it never saw the findings it had not written yet — so a recovered
    // truncation carrying findings is "changes", never a stale "approved".
    const result = await reviewWithModel(ENVELOPE, {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      apiKey: "sk-test",
      fetch: replayFetch(fixture("deepseek-truncated-approved")),
      maxRetries: 0,
      maxAttempts: 1,
    });

    expect(result.verdict).toBe("changes");
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.partial).toBe(true);
    expect(result.finishReason).toBe("length");
  });

  it("abstains on a complete response whose verdict is unrecognizable and findings empty", async () => {
    // deepseek-unrecognizable-verdict.json is a REAL recorded completion that answers
    // verdict "unsure" with no findings. Nothing was dropped, so the all-dropped guard
    // does not apply, and it is not truncated — the ONLY thing standing between this and
    // a fabricated verdict is normalizeVerdict returning null. Recovery must not guess:
    // neither "approved" (a clean review the model never gave) nor "changes".
    const result = await reviewWithModel(ENVELOPE, {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      apiKey: "sk-test",
      fetch: replayFetch(fixture("deepseek-unrecognizable-verdict")),
      maxRetries: 0,
      maxAttempts: 1,
    });

    expect(result.verdict).toBe("error");
    expect(result.findings).toEqual([]);
    expect(result.partial).toBeUndefined();
  });

  it("abstains rather than reporting a clean review when every finding is dropped", async () => {
    // The honesty guard on recovery. deepseek-unusable-findings.json is a REAL recorded
    // completion that says verdict "approved" while carrying a finding with no path, no
    // line and an unrankable severity ("showstopper"). Recovering the "approved" would
    // report a clean review over a defect the model DID raise — worse than no review, so
    // recovery declines and the caller abstains.
    const result = await reviewWithModel(ENVELOPE, {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      apiKey: "sk-test",
      fetch: replayFetch(fixture("deepseek-unusable-findings")),
      maxRetries: 0,
      maxAttempts: 1,
    });

    expect(result.verdict).toBe("error");
    expect(result.findings).toEqual([]);
  });

  it("abstains without escalating when thinking burned the budget (empty content, length)", async () => {
    // Regression: https://github.com/Falconiere/toolu-conventions/pull/3 — "3/3 chunks
    // failed (after a retry) ... could not parse the response. [finish_reason: length]".
    // deepseek-thinking-length.json is a REAL api.deepseek.com completion recorded with
    // thinking left at its DEFAULT (enabled): all 200 completion tokens went to
    // reasoning_tokens and content came back "". The request-shape assertion in
    // deepseek.test.ts is the actual fix; this pins the failure mode it prevents, and
    // that recovery does not paper over it with a fabricated verdict.
    let calls = 0;
    const countingFetch: typeof fetch = async () => {
      calls++;
      return new Response(JSON.stringify(fixture("deepseek-thinking-length")), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const result = await reviewWithModel(ENVELOPE, {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      apiKey: "sk-test",
      fetch: countingFetch,
      maxRetries: 0,
      maxAttempts: 3,
    });

    expect(result.verdict).toBe("error");
    expect(result.finishReason).toBe("length");
    // No output to grow into: one call, no budget-escalation retries.
    expect(calls).toBe(1);
  });

  it("aborts every hung attempt and abstains after exhausting the ceiling (verdict error, no hang)", async () => {
    // A fetch that never resolves on its own — it only settles when the per-attempt
    // AbortController fires (real fetch rejects with an AbortError on signal abort).
    // EVERY attempt hangs, so with a short timeoutMs and maxAttempts 2 the loop
    // exhausts its ceiling and still abstains — never throws, never hangs. No mocks:
    // this is exactly how the real fetch behaves.
    let calls = 0;
    const hangingFetch: typeof fetch = (_url, init) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
          });
        }
      });
    };

    const start = Date.now();
    const result = await reviewWithModel(ENVELOPE, {
      model: "deepseek/deepseek-v4-flash",
      apiKey: "sk-test",
      fetch: hangingFetch,
      maxRetries: 0,
      timeoutMs: 20,
      maxAttempts: 2,
    });
    const elapsed = Date.now() - start;

    expect(result.verdict).toBe("error");
    expect(result.findings).toEqual([]);
    // After exhausting attempts it abstains with the abort message.
    expect(result.error).toBeTruthy();
    expect(result.error).toMatch(/abort/i);
    // Both attempts ran against the hang.
    expect(calls).toBe(2);
    // It returned promptly via the per-attempt deadlines — nowhere near a hang.
    expect(elapsed).toBeLessThan(5_000);
  });

  it("retries a hung attempt and succeeds on the next", async () => {
    // The first attempt hangs until its per-attempt AbortController fires (real fetch
    // rejects with an AbortError on signal abort); the SDK never retries an abort, so
    // the OUTER loop retries it. The second attempt replays a recorded success body.
    // A tiny timeoutMs cuts the hang fast; maxAttempts 3 gives the retry room. Real
    // fetch-seam injection only — no generateObject mocks.
    const success = fixture("success");
    let calls = 0;
    const flakyFetch: typeof fetch = (_url, init) => {
      calls++;
      if (calls === 1) {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            signal.addEventListener("abort", () => {
              reject(
                Object.assign(new Error("The operation was aborted."), { name: "AbortError" }),
              );
            });
          }
        });
      }
      return Promise.resolve(
        new Response(JSON.stringify(success), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };

    const result = await reviewWithModel(ENVELOPE, {
      model: "deepseek/deepseek-v4-flash",
      apiKey: "sk-test",
      fetch: flakyFetch,
      maxRetries: 0,
      timeoutMs: 20,
      maxAttempts: 3,
    });

    // The success verdict from the second attempt comes through — no abstention.
    expect(result.verdict).not.toBe("error");
    expect(result.verdict).toBe("changes");
    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.findings)).toBe(true);
    expect(result.review_plan).toContain("Review Plan");
    // Exactly one hung attempt + one successful retry.
    expect(calls).toBe(2);
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
