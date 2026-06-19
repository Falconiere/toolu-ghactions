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
 * Overall deadline for one review call, in milliseconds. generateObject has
 * retries but NO total timeout, so a hung provider would otherwise stall the job
 * to the 6h runner ceiling (seen in prod). On timeout the AbortController fires;
 * the AI SDK throws the abort (it never retries an abort), which abstain() maps to
 * a verdict:"error". Input-overridable via {@link ReviewOptions.timeoutMs}.
 */
export const REQUEST_TIMEOUT_MS = 180_000;

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
  /** Overall deadline in ms before the call is aborted (default {@link REQUEST_TIMEOUT_MS}). */
  timeoutMs?: number;
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

  // Overall deadline: the AI SDK forwards this signal to fetch, so a hung provider
  // is aborted instead of stalling the job. .unref() so a pending timer never keeps
  // the process alive; cleared in finally on the normal (fast) path.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
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
    return abstain(err);
  } finally {
    clearTimeout(timeout);
  }
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
