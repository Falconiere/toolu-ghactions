// llm/reviewWithModel.ts — the provider-agnostic review LLM call, via the Vercel AI SDK.
// One model, structured output (the Zod Verdict schema), temperature 0. Review calls
// STREAM (streamVerdict.ts), so a response cut at max_tokens comes back as a returned
// outcome carrying the findings completed before the cut instead of a thrown parse
// failure; the cartographer's raw-JSON call stays on generateObject. The backend is
// chosen by resolveModel() (providers.ts), the budget policy and salvage wording live in
// budget.ts, and this file owns only the LOOP (timeout/abort, hang retries, budget
// escalation, salvage, abstain). The export is reviewWithModel().
//
// REASONING-OFF: every provider must have hidden reasoning DISABLED, because reasoning
// tokens are billed against max_tokens — a thinking model spends the whole budget before
// emitting a byte of JSON and returns finish_reason "length" with empty content. Each
// backend spells it differently and both spellings live in providers.ts: OpenRouter's
// `reasoning:{effort:"none"}` (plus require_parameters) is baked into the client via
// OPENROUTER_EXTRA_BODY, while native DeepSeek's `thinking:{type:"disabled"}` rides on
// the CALL via providerOptionsFor(). See request-shape.test.ts and deepseek.test.ts.
//
// RECOVER-THEN-ABSTAIN: the call throws on empty content, a JSON parse or schema
// validation failure, or an API error (after retries). We CATCH every throw; recover()
// (recover.ts) first tries to rescue a usable review from the raw output, and only when
// nothing trustworthy survives does abstain() return a verdict:"error" ProviderResult.
// Never throw to the caller, never return a null verdict: a failed call abstains, it
// does not block.
import { generateObject } from "ai";
import { resolveModel, providerOptionsFor, type ProviderId } from "./providers.js";
import type { Finding } from "./schema.js";
import {
  abstain,
  bestPrefix,
  hasPartialOutput,
  isLengthTruncation,
  recover,
  salvageResult,
  type Prefix,
} from "./recover.js";
import { budgetExhausted, isProviderCap, nextBudget } from "./budget.js";
import { streamVerdict } from "./streamVerdict.js";
import type { Envelope } from "@/prompt.js";

/**
 * PER-ATTEMPT deadline for one review attempt, in milliseconds — NOT a single
 * global deadline. generateObject has HTTP-transient retries but NO timeout, and
 * the AI SDK never retries an abort: a single upstream STALL on the first attempt
 * used to burn the whole budget and abstain with zero recovery, even though the
 * same request usually succeeds. So each ATTEMPT gets this budget; a hung attempt
 * is aborted and RETRIED up to {@link MAX_ATTEMPTS} with a fresh attempt, for a
 * total ceiling of ≈ MAX_ATTEMPTS × this. A final-attempt abort salvages whatever
 * prefix arrived, or abstains as a timeout when none ever did.
 * Input-overridable via {@link ReviewOptions.timeoutMs} (REQUEST_TIMEOUT_MS input).
 *
 * Default is 180s, not 60s: the default model is a large 1M-context model whose
 * structured-output generation on a full diff chunk routinely runs past a minute, so
 * a 60s deadline aborted most chunks ("This operation was aborted") and abstained.
 */
export const REQUEST_TIMEOUT_MS = 180_000;

/**
 * Outer attempts against a hang/timeout. Each gets its own {@link REQUEST_TIMEOUT_MS}
 * deadline; an aborted (hung) attempt is retried with a fresh AbortController.
 * HTTP-transient retries (5xx, network) are still handled INSIDE the SDK via `maxRetries`
 * — this loop only recovers from hangs the SDK would never retry on its own, and budget
 * escalations are counted separately. Input-overridable via {@link ReviewOptions.maxAttempts}.
 */
export const MAX_ATTEMPTS = 3;

/** Options for {@link reviewWithModel}: the provider, model id, API key, and test seams. */
export interface ReviewOptions {
  /** Backend provider; defaults to "openrouter" when omitted (preserves legacy callers). */
  provider?: ProviderId;
  /** Model id for the chosen provider (e.g. "deepseek-v4-flash" or "deepseek/deepseek-v4-pro"). */
  model: string;
  /** Provider API key (Authorization: Bearer). */
  apiKey: string;
  /** Custom fetch — injected by tests to replay recorded responses; real fetch in prod. */
  fetch?: typeof fetch;
  /** Max retries on transient failure (default 2, matching the AI SDK default). */
  maxRetries?: number;
  /** Per-attempt deadline in ms before THAT attempt is aborted (default {@link REQUEST_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** Outer attempts against a hang/timeout (default {@link MAX_ATTEMPTS}); each gets its own timeoutMs. */
  maxAttempts?: number;
  /**
   * RAW-JSON mode: do NOT enforce the {@link Verdict} schema on this call.
   *
   * The one non-review structured call in the pipeline is Layer 1's cartographer
   * (`src/review/cartographer.ts`), whose brief does not fit the Verdict shape at all —
   * in particular `other_checks` is `.max(600)`, while a real brief serializes well past
   * that, so routing `mapPr` through the enforced schema would silently truncate it
   * (spec §Layer 1). With `rawJson`, generateObject runs with `output: "no-schema"` (the
   * model is still asked for JSON, but no schema is injected or validated) and the parsed
   * object is handed back SERIALIZED on {@link ProviderResult.other_checks} — the channel
   * `extractBriefPayload` already reads — with the neutral, non-abstaining
   * `verdict: "approved"` and no findings. Recovery is skipped on this path:
   * `recover()` reconstructs a Verdict-shaped result, which is meaningless here.
   */
  rawJson?: boolean;
}

/**
 * Normalized result of one review call. `verdict` carries the model's two-value verdict
 * OR the third "error" abstention state. On error, `findings` is empty, `error` holds the
 * message, and `finishReason` carries the model's stop reason when the SDK exposed it
 * (e.g. "length" for the reasoning-budget-exhausted bug).
 */
export interface ProviderResult {
  verdict: "approved" | "changes" | "error";
  findings: Finding[];
  review_plan?: string;
  other_checks?: string;
  top_must_fix?: string[];
  error?: string;
  finishReason?: string;
  /** True when the result was salvaged from a length-truncated response: the
   *  findings completed before the cut were recovered, later ones may be missing. */
  partial?: boolean;
  /** Set on a salvaged partial whose output budget could grow no further — the ceiling
   *  (budget.ts's MAX_TOKEN_CEILING) was reached, or the provider refused the budget. It
   *  is what tells the reader (via the budget.ts wording) that MAX_TOKENS is no longer
   *  the knob to turn; merge.ts propagates it so a chunked review says the same thing. */
  budgetExhausted?: boolean;
  /**
   * Present ONLY when `verdict` is "error": why the call failed, so a caller (Layer 2's
   * bisection) can tell a bisectable failure from one that would only multiply load if
   * retried. `"schema"` — NoObjectGeneratedError: empty content, a length-truncation cut
   * too early to recover, or output that never matched the Verdict schema. `"timeout"` —
   * every attempt was aborted by our own per-attempt deadline (see
   * {@link REQUEST_TIMEOUT_MS}); a transient stall, not a schema problem. `"transport"` —
   * an HTTP or network-level failure reaching the provider at all (5xx after the SDK's own
   * retries, DNS/connection errors): an APICallError or a bare fetch failure, never
   * NoObjectGeneratedError.
   */
  failure?: "schema" | "transport" | "timeout";
}

/**
 * Run one structured code review against the configured provider's model. Delegates the
 * call to {@link streamVerdict} (schema + temperature 0); the backend client (and any
 * provider-specific request-body extras) comes from {@link resolveModel} — OpenRouter
 * sends the reasoning-off + require_parameters extras, native DeepSeek sends neither.
 * NEVER throws: any failure after retries (empty content, parse/validation error, API
 * error) is caught and returned as a verdict:"error" abstention.
 */
export async function reviewWithModel(
  envelope: Envelope,
  opts: ReviewOptions,
): Promise<ProviderResult> {
  const provider = opts.provider ?? "openrouter";
  const model = resolveModel({
    provider,
    model: opts.model,
    apiKey: opts.apiKey,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  // Per-CALL request-body extras (native DeepSeek's reasoning switch); OpenRouter's
  // equivalent is baked into the client by resolveModel, so it is undefined there.
  const providerOptions = providerOptionsFor(provider);
  const perAttemptMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;

  // TWO INDEPENDENT COUNTERS, because the failures they answer are unrelated:
  //   `attempt`     — hang retries (≤ maxAttempts), each with its OWN deadline and a fresh
  //                   AbortController; the SDK never retries an abort, so we do. .unref()
  //                   keeps a pending timer from holding the process open; cleared in
  //                   finally on the normal (fast) path.
  //   `escalations` — length-truncation redoublings (≤ MAX_ESCALATIONS, budget.ts). A
  //                   truncation is a healthy response that did not fit, so it must NOT
  //                   spend a hang attempt (nor reset one) — otherwise the budget could
  //                   never climb from the default 8192 to the ceiling. Worst case is
  //                   maxAttempts + MAX_ESCALATIONS calls for one chunk.
  // `best` retains the largest prefix salvaged across ALL attempts and escalations, so a
  // final-attempt deadline abort returns findings an EARLIER attempt received.
  let budget = envelope.max_tokens;
  let attempt = 1;
  let escalations = 0;
  let best: Prefix | undefined;

  while (attempt <= maxAttempts) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), perAttemptMs);
    timeout.unref?.();
    const lastAttempt = attempt >= maxAttempts;

    try {
      const call = {
        model,
        system: envelope.system,
        prompt: envelope.user,
        maxTokens: budget,
        maxRetries: opts.maxRetries ?? 2,
        abortSignal: controller.signal,
        providerOptions,
      };

      // Raw-JSON mode (the cartographer — see ReviewOptions.rawJson): no schema is
      // injected into the prompt and none is validated; the model's JSON object rides
      // back serialized on `other_checks`. NOT streamed — a brief has no findings prefix
      // to salvage. JSON mode (not the SDK default "tool" mode) is the deployed wire
      // contract: the verdict is read from message.content via response_format, never
      // from a tool call. streamVerdict pins the same mode + temperature for reviews.
      if (opts.rawJson === true) {
        const json = { mode: "json" as const, temperature: 0, output: "no-schema" as const };
        const { object } = await generateObject({ ...call, ...json });
        return { verdict: "approved", findings: [], other_checks: JSON.stringify(object) };
      }

      const streamed = await streamVerdict(call);
      // A validated Verdict carries exactly this result's success fields (its two-value
      // verdict widening into the three-value one) plus the model's stop reason.
      if (streamed.outcome === "complete")
        return { ...streamed.object, finishReason: streamed.finishReason };
      best = bestPrefix(best, streamed);
      if (streamed.outcome === "truncated") {
        // Headroom left → one more call at a doubled budget, preferring a COMPLETE review
        // over a prefix; not an abort, so no backoff and no hang attempt spent. None left
        // → the prefix IS the answer, worded for the knob still worth turning.
        const next = nextBudget(budget, escalations);
        if (next !== null) {
          budget = next;
          escalations++;
          continue;
        }
        return salvageResult(best, { reason: "length", exhausted: budgetExhausted(budget) });
      }
      // OUR deadline cut a stream that had produced findings. Retry FIRST (a transient
      // stall usually clears), keeping the prefix as the fallback the last attempt takes.
      if (!lastAttempt) {
        await hangBackoff(attempt);
        attempt++;
        continue;
      }
      return salvageResult(best, { reason: "deadline" });
    } catch (err) {
      // FIRST, before any other classification: the provider REFUSING this budget (400
      // naming max_tokens). A bigger budget would fail identically, so a retained prefix
      // resolves right here, marked budget-exhausted. With NO prefix we deliberately fall
      // through to transport classification and abstain — an empty "partial" would be a
      // zero-finding blocking review by the back door.
      if (isProviderCap(err) && best !== undefined) {
        return salvageResult(best, { reason: "length", exhausted: true });
      }
      // A hang: OUR per-attempt timer fired. Retry it (the SDK never retries an abort); on
      // the FINAL attempt fall back to whatever any attempt salvaged, abstaining as a
      // timeout only when no attempt ever completed a finding.
      if (controller.signal.aborted) {
        if (!lastAttempt) {
          await hangBackoff(attempt);
          attempt++;
          continue;
        }
        if (best !== undefined) return salvageResult(best, { reason: "deadline" });
      }
      // The UNSALVAGEABLE truncations — nothing completed before the cut, so streamVerdict
      // let the SDK's own NoObjectGeneratedError through instead of returning a prefix.
      // With partial output present the cut landed mid-JSON before the first finding
      // closed: a doubled budget can still finish it, same as above. Empty content +
      // finish_reason "length" is instead the hidden-reasoning bug — the model burned the
      // budget thinking and emitted nothing, and a larger budget only buys MORE reasoning,
      // so it is neither escalated nor recoverable (the fix is providers.ts's reasoning-off).
      if (isLengthTruncation(err) && hasPartialOutput(err)) {
        const next = nextBudget(budget, escalations);
        if (next !== null) {
          budget = next;
          escalations++;
          continue;
        }
      }
      // Recover what the response DID contain rather than discarding a whole pass: the
      // findings completed before a truncation cut, or a complete response whose values
      // deviate from the strict schema (null when nothing is usable). The budget state
      // rides along so a recovered truncation names the right knob. Skipped in raw-JSON
      // mode: recover() rebuilds a VERDICT-shaped result, not the cartographer's brief.
      const recovered = opts.rawJson === true ? null : recover(err, budgetExhausted(budget));
      if (recovered !== null) return recovered;
      // Nothing recoverable: abstain. `controller.signal.aborted` is the source of truth
      // for "our own per-attempt deadline fired", read here in the controller's scope.
      return abstain(err, controller.signal.aborted);
    } finally {
      clearTimeout(timeout);
    }
  }

  // Unreachable: every loop path either returns or continues, and the final attempt
  // always returns. Present so TypeScript sees a total function.
  return abstain(new Error("OpenRouter request failed"), false);
}

/**
 * The short backoff between hang retries. Do NOT unref this timer: the per-attempt
 * timeout CAN be unref'd because the live fetch socket keeps the event loop alive during
 * the request — but the abort just DESTROYED that socket, so during this backoff the
 * timer is the only pending handle. An unref'd timer here lets Node see an empty event
 * loop and exit 0 mid-retry: the backoff never resolves, the loop never resumes, the
 * pipeline never finalizes the comment, and the job goes GREEN with the in-progress
 * comment frozen.
 */
function hangBackoff(attempt: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 300 * attempt);
  });
}
