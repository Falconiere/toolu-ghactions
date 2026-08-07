// llm/reviewWithModel.ts — the provider-agnostic review LLM call, via the Vercel AI SDK.
// One model, structured output (generateObject + the Zod Verdict schema), temperature 0.
// The backend (OpenRouter or native DeepSeek) is chosen by resolveModel() in
// providers.ts; this file owns only the provider-agnostic review loop (timeout/abort,
// retries, budget escalation, salvage, abstain). The export is reviewWithModel().
//
// REASONING-OFF: every provider must have hidden reasoning DISABLED, because reasoning
// tokens are billed against max_tokens — a thinking model spends the whole budget before
// emitting a byte of JSON and returns finish_reason "length" with empty content. Each
// backend spells it differently and both spellings live in providers.ts: OpenRouter's
// `reasoning:{effort:"none"}` (plus require_parameters) is baked into the client via
// OPENROUTER_EXTRA_BODY, while native DeepSeek's `thinking:{type:"disabled"}` rides on
// the CALL via providerOptionsFor(). See request-shape.test.ts and deepseek.test.ts.
//
// RECOVER-THEN-ABSTAIN: generateObject throws on empty content, JSON parse failure,
// schema-validation failure, or an API error (after retries). We CATCH every throw.
// recover() first tries to rescue a usable review from the raw output — a truncated
// response's completed findings, or a complete response normalized back onto the schema.
// Only when nothing trustworthy survives do we return a verdict:"error" ProviderResult.
// Never throw to the caller, never return a null verdict: a failed model call abstains,
// it does not block.
import { generateObject, NoObjectGeneratedError } from "ai";
import { errorMessage } from "@/errors.js";
import { resolveModel, providerOptionsFor, type ProviderId } from "./providers.js";
import { Verdict, type Finding } from "./schema.js";
import { recover, isLengthTruncation, hasPartialOutput } from "./recover.js";
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
 * Input-overridable via {@link ReviewOptions.timeoutMs} (REQUEST_TIMEOUT_MS input).
 *
 * Default is 180s, not 60s: the default model is a large 1M-context model whose
 * structured-output generation on a full diff chunk routinely runs past a minute, so
 * a 60s deadline aborted most chunks ("This operation was aborted") and abstained.
 */
export const REQUEST_TIMEOUT_MS = 180_000;

/**
 * Outer attempts against a hang/timeout. Each attempt gets its own
 * {@link REQUEST_TIMEOUT_MS} deadline; an aborted (hung) attempt is retried with a
 * fresh AbortController. HTTP-transient retries (5xx, network) are still handled
 * INSIDE generateObject via `maxRetries` — this loop only recovers from hangs that
 * the SDK would never retry on its own. Input-overridable via
 * {@link ReviewOptions.maxAttempts}.
 */
export const MAX_ATTEMPTS = 3;

/**
 * Output-budget ceiling for length-truncation retries. When a chunk's structured
 * output overruns max_tokens the model stops mid-JSON (finish_reason "length") and
 * the truncated response cannot be parsed. We retry with a DOUBLED budget; this
 * caps the escalation so a pathological chunk never requests an absurd budget the
 * provider would reject.
 */
export const MAX_TOKEN_CEILING = 32_768;

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
   * (`src/review/cartographer.ts`), whose brief does not fit the Verdict shape at
   * all — in particular `other_checks` is `.max(600)`, while a real brief
   * serializes well past that, so routing `mapPr` through the enforced schema
   * would silently truncate it (spec §Layer 1). With `rawJson`, generateObject
   * runs with `output: "no-schema"` (the model is still asked for JSON, but no
   * schema is injected or validated) and the parsed object is handed back
   * SERIALIZED on {@link ProviderResult.other_checks} — the channel
   * `extractBriefPayload` already reads — with the neutral, non-abstaining
   * `verdict: "approved"` and no findings. Recovery is skipped on this path:
   * `recover()` reconstructs a Verdict-shaped result, which is meaningless here.
   */
  rawJson?: boolean;
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
  /** True when the result was salvaged from a length-truncated response: the
   *  findings completed before the cut were recovered, later ones may be missing. */
  partial?: boolean;
  /**
   * Present ONLY when `verdict` is "error": why the call failed, so a caller (Layer 2's
   * bisection, upcoming) can tell a bisectable failure from one that would only multiply
   * load if retried. `"schema"` — {@link NoObjectGeneratedError}: empty content, a
   * length-truncation cut too early to recover, or output that never matched the Verdict
   * schema. `"timeout"` — every attempt was aborted by our own per-attempt deadline
   * (see {@link REQUEST_TIMEOUT_MS}); a transient stall, not a schema problem. `"transport"`
   * — an HTTP or network-level failure reaching the provider at all (5xx after the SDK's
   * own retries, DNS/connection errors) — surfaces as {@link APICallError} or a bare fetch
   * failure, never {@link NoObjectGeneratedError}.
   */
  failure?: "schema" | "transport" | "timeout";
}

/**
 * Run one structured code review against the configured provider's model.
 *
 * Wraps generateObject with the {@link Verdict} schema and temperature 0. The backend
 * client (and any provider-specific request-body extras) comes from {@link resolveModel}
 * — OpenRouter sends the reasoning-off + require_parameters extras; native DeepSeek sends
 * neither. NEVER throws: any failure after retries (empty content, parse/validation error,
 * API error) is caught and returned as a verdict:"error" abstention.
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
  // Per-CALL request-body extras (native DeepSeek's reasoning switch). OpenRouter's
  // equivalent is baked into the client by resolveModel, so this is undefined there.
  const providerOptions = providerOptionsFor(provider);

  const perAttemptMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;

  // Outer hang/timeout loop: each attempt gets its OWN per-attempt deadline + fresh
  // AbortController. The AI SDK forwards the signal to fetch, so a hung provider is
  // aborted instead of stalling the job — and because the SDK never retries an abort,
  // we retry it here with a clean attempt. .unref() so a pending timer never keeps the
  // process alive; cleared in finally on the normal (fast) path.
  //
  // `budget` escalates across attempts: a length-truncated parse failure retries with
  // a doubled output budget (see the catch), so a chunk whose JSON overran max_tokens
  // can finish on a later attempt instead of failing the whole chunk.
  let budget = envelope.max_tokens;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), perAttemptMs);
    timeout.unref?.();

    try {
      const call = {
        model,
        // JSON mode (not the SDK default "tool" mode): the bash reads the verdict
        // from .choices[0].message.content via response_format, NOT from a tool
        // call. "json" sends response_format and parses message.content, matching
        // the deployed wire contract and the recorded fixtures.
        mode: "json" as const,
        system: envelope.system,
        prompt: envelope.user,
        temperature: 0,
        maxTokens: budget,
        maxRetries: opts.maxRetries ?? 2,
        abortSignal: controller.signal,
        providerOptions,
      };

      // Raw-JSON mode (the cartographer — see ReviewOptions.rawJson): no schema is
      // injected into the prompt and none is validated; the model's JSON object
      // rides back serialized on `other_checks`.
      if (opts.rawJson === true) {
        const { object } = await generateObject({ ...call, output: "no-schema" });
        return { verdict: "approved", findings: [], other_checks: JSON.stringify(object) };
      }

      const { object } = await generateObject({ ...call, schema: Verdict });

      return {
        verdict: object.verdict,
        findings: object.findings,
        review_plan: object.review_plan,
        other_checks: object.other_checks,
        top_must_fix: object.top_must_fix,
      };
    } catch (err) {
      // Retry a hang (OUR per-attempt timer fired). The SDK never retries an abort,
      // so we do — with a short backoff.
      if (controller.signal.aborted && attempt < maxAttempts) {
        // Do NOT unref this timer. The per-attempt timeout above CAN be unref'd
        // because the live fetch socket keeps the event loop alive during the
        // request — but the abort just DESTROYED that socket, so during this
        // backoff the timer is the only pending handle. An unref'd timer here lets
        // Node see an empty event loop and exit 0 mid-retry: the backoff never
        // resolves, the loop never resumes, the pipeline never finalizes the
        // comment, and the job goes GREEN with the in-progress comment frozen.
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 300 * attempt);
        });
        continue;
      }
      // Length truncation (finish_reason "length") WITH partial output: the model hit
      // the token limit mid-JSON, so the response is truncated but salvageable — prefer
      // a COMPLETE one by retrying with a doubled output budget while there's room. Not
      // an abort and not rate-limited, so no backoff. Capped at the ceiling.
      //
      // Empty content + finish_reason "length" is instead the hidden-reasoning bug: the
      // model burned the whole budget thinking and emitted nothing. A larger budget only
      // buys MORE reasoning, so it is neither escalated nor recoverable here — the fix
      // is to turn reasoning off in the request (see providers.ts).
      if (
        isLengthTruncation(err) &&
        hasPartialOutput(err) &&
        budget < MAX_TOKEN_CEILING &&
        attempt < maxAttempts
      ) {
        budget = Math.min(budget * 2, MAX_TOKEN_CEILING);
        continue;
      }
      // Recover what the response DID contain rather than discarding a whole pass:
      // the findings completed before a truncation cut, or a complete response whose
      // values deviate from the strict schema. Returns null when nothing is usable.
      // Skipped in raw-JSON mode: recover() rebuilds a VERDICT-shaped result, which
      // would hand the cartographer a salvaged review instead of its brief.
      const recovered = opts.rawJson === true ? null : recover(err);
      if (recovered !== null) return recovered;
      // Empty content, or nothing recoverable: abstain. `controller.signal.aborted` is
      // the source of truth for "our own per-attempt deadline fired" — read here, in the
      // same scope as the controller, rather than re-derived from the error's shape.
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
 * Classify a thrown error into a bisectability cause. `aborted` — read from the live
 * AbortController at the call site — takes priority: an aborted request can ALSO throw
 * something that looks schema-shaped downstream, but the cause was our own deadline, not
 * the model's output. Otherwise a {@link NoObjectGeneratedError} is a schema failure
 * (generateObject only throws that class for empty/truncated/nonconforming output); every
 * other error reaching here — {@link APICallError} for HTTP 5xx after the SDK's own
 * retries, or a bare fetch/network failure — is a transport failure.
 */
function classifyFailure(err: unknown, aborted: boolean): "schema" | "transport" | "timeout" {
  if (aborted) return "timeout";
  if (NoObjectGeneratedError.isInstance(err)) return "schema";
  return "transport";
}

/**
 * Build the abstention result from a thrown error. Pulls the model's finishReason
 * off a {@link NoObjectGeneratedError} when present (that is the error generateObject
 * throws for empty content — the reasoning-budget bug surfaces here as "length").
 */
function abstain(err: unknown, aborted: boolean): ProviderResult {
  const result: ProviderResult = {
    verdict: "error",
    findings: [],
    error: errorMessage(err, "OpenRouter request failed"),
    failure: classifyFailure(err, aborted),
  };
  if (NoObjectGeneratedError.isInstance(err) && err.finishReason !== undefined) {
    result.finishReason = err.finishReason;
  }
  return result;
}
