// llm/openrouter.ts — the single OpenRouter LLM call, via the Vercel AI SDK.
// Consolidation target of the bash providers/openrouter/* scripts: one model,
// structured output (generateObject + the Zod Verdict schema), temperature 0.1.
//
// REASONING-OFF (the bug fix): reasoning models burn the whole max_tokens budget
// on hidden reasoning and return empty content (finish_reason "length"). We send
// `reasoning: { effort: "none" }` to disable it. The typed provider setting only
// allows effort high|medium|low, so "none" must ride in `extraBody`, alongside
// `provider: { require_parameters: true }` (the bash sets this when enforcing the
// schema). Both land in every outgoing request body because the provider merges
// the factory `extraBody` into baseArgs for all generation modes — see
// request-shape.test.ts for the proof.
//
// ABSTAIN-ON-ERROR: generateObject throws on empty content, JSON parse failure,
// schema-validation failure, or an API error (after retries). We CATCH every
// throw and return a verdict:"error" ProviderResult — never throw to the caller,
// never return a null verdict. A failed model call abstains; it does not block.
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateObject, NoObjectGeneratedError } from "ai";
import { errorMessage } from "@/errors.js";
import { Verdict } from "./schema.js";
import type { Finding } from "./schema.js";
import type { Envelope } from "@/prompt.js";

/**
 * PER-ATTEMPT deadline for one review attempt, in milliseconds — NOT a single
 * global deadline. generateObject has HTTP-transient retries but NO timeout, and
 * the AI SDK never retries an abort: a single upstream STALL on the first attempt
 * used to burn the whole budget and abstain with zero recovery, even though the
 * same request usually succeeds. So each ATTEMPT gets this budget; a hung attempt
 * is aborted and RETRIED up to {@link MAX_ATTEMPTS} with a fresh attempt. The
 * total ceiling is therefore ≈ MAX_ATTEMPTS × this. On the final attempt's abort
 * the AbortController fires and abstain() maps it to a verdict:"error".
 * Input-overridable via {@link ReviewOptions.timeoutMs}.
 */
export const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Outer attempts against a hang/timeout. Each attempt gets its own
 * {@link REQUEST_TIMEOUT_MS} deadline; an aborted (hung) attempt is retried with a
 * fresh AbortController. HTTP-transient retries (5xx, network) are still handled
 * INSIDE generateObject via `maxRetries` — this loop only recovers from hangs that
 * the SDK would never retry on its own. Input-overridable via
 * {@link ReviewOptions.maxAttempts}.
 */
export const MAX_ATTEMPTS = 3;

/** Options for {@link reviewWithModel}: the model id, API key, and test seams. */
export interface ReviewOptions {
  /** OpenRouter model id, e.g. "deepseek/deepseek-v4-flash". */
  model: string;
  /** OpenRouter API key (Authorization: Bearer). */
  apiKey: string;
  /** Custom fetch — injected by tests to replay recorded responses; real fetch in prod. */
  fetch?: typeof fetch;
  /** Max retries on transient failure (default 2, matching the AI SDK default). */
  maxRetries?: number;
  /** Per-attempt deadline in ms before THAT attempt is aborted (default {@link REQUEST_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** Outer attempts against a hang/timeout (default {@link MAX_ATTEMPTS}); each gets its own timeoutMs. */
  maxAttempts?: number;
}

/**
 * Normalized result of one review call. `verdict` carries the model's two-value
 * verdict OR the third "error" abstention state. On error, `findings` is empty,
 * `error` holds the message, and `finishReason` carries the model's stop reason
 * when the SDK exposed it (e.g. "length" for the reasoning-budget-exhausted bug).
 */
export interface ProviderResult {
  verdict: "approved" | "changes" | "error";
  findings: Finding[];
  review_plan?: string;
  other_checks?: string;
  top_must_fix?: string[];
  error?: string;
  finishReason?: string;
}

/** Extra request-body fields the AI SDK has no typed slot for, forwarded verbatim. */
const EXTRA_BODY = {
  // Disable reasoning so the model spends max_tokens on the answer, not hidden
  // thinking. "none" is not in the SDK's typed reasoning effort union, so it
  // must be carried as raw extraBody.
  reasoning: { effort: "none" },
  // Require the upstream provider to honor the structured-output parameters —
  // the bash sets this whenever it enforces the JSON schema.
  provider: { require_parameters: true },
} as const;

/**
 * Run one structured code review against an OpenRouter model.
 *
 * Wraps generateObject with the {@link Verdict} schema and temperature 0.1, and
 * forwards {@link EXTRA_BODY} (reasoning-off + require_parameters) on every call.
 * NEVER throws: any failure after retries (empty content, parse/validation error,
 * API error) is caught and returned as a verdict:"error" abstention.
 */
export async function reviewWithModel(
  envelope: Envelope,
  opts: ReviewOptions,
): Promise<ProviderResult> {
  const provider = createOpenRouter({
    apiKey: opts.apiKey,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    extraBody: EXTRA_BODY,
  });

  const perAttemptMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;

  // Outer hang/timeout loop: each attempt gets its OWN per-attempt deadline + fresh
  // AbortController. The AI SDK forwards the signal to fetch, so a hung provider is
  // aborted instead of stalling the job — and because the SDK never retries an abort,
  // we retry it here with a clean attempt. .unref() so a pending timer never keeps the
  // process alive; cleared in finally on the normal (fast) path.
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), perAttemptMs);
    timeout.unref?.();

    try {
      const { object } = await generateObject({
        model: provider(opts.model),
        schema: Verdict,
        // JSON mode (not the SDK default "tool" mode): the bash reads the verdict
        // from .choices[0].message.content via response_format, NOT from a tool
        // call. "json" sends response_format and parses message.content, matching
        // the deployed wire contract and the recorded fixtures.
        mode: "json",
        system: envelope.system,
        prompt: envelope.user,
        temperature: 0,
        maxTokens: envelope.max_tokens,
        maxRetries: opts.maxRetries ?? 2,
        abortSignal: controller.signal,
      });

      return {
        verdict: object.verdict,
        findings: object.findings,
        review_plan: object.review_plan,
        other_checks: object.other_checks,
        top_must_fix: object.top_must_fix,
      };
    } catch (err) {
      // Gate retry on OUR per-attempt timer firing (a hang). This deliberately
      // EXCLUDES NoObjectGeneratedError (empty content / parse failure / finishReason
      // "length"): those are not aborts, so they fall through and abstain IMMEDIATELY
      // with no wasted retries.
      if (controller.signal.aborted && attempt < maxAttempts) {
        await new Promise<void>((resolve) => {
          const backoff = setTimeout(resolve, 300 * attempt);
          backoff.unref?.();
        });
        continue;
      }
      return abstain(err);
    } finally {
      clearTimeout(timeout);
    }
  }

  // Unreachable: every loop path either returns or continues, and the final attempt
  // always returns. Present so TypeScript sees a total function.
  return abstain(new Error("OpenRouter request failed"));
}

/**
 * Build the abstention result from a thrown error. Pulls the model's finishReason
 * off a {@link NoObjectGeneratedError} when present (that is the error generateObject
 * throws for empty content — the reasoning-budget bug surfaces here as "length").
 */
function abstain(err: unknown): ProviderResult {
  const result: ProviderResult = {
    verdict: "error",
    findings: [],
    error: errorMessage(err, "OpenRouter request failed"),
  };
  if (NoObjectGeneratedError.isInstance(err) && err.finishReason !== undefined) {
    result.finishReason = err.finishReason;
  }
  return result;
}
