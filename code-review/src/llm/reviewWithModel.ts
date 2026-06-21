// llm/reviewWithModel.ts — the provider-agnostic review LLM call, via the Vercel AI SDK.
// One model, structured output (generateObject + the Zod Verdict schema), temperature 0.
// The backend (OpenRouter or native DeepSeek) is chosen by resolveModel() in
// providers.ts; this file owns only the provider-agnostic review loop (timeout/abort,
// retries, budget escalation, salvage, abstain). The export is reviewWithModel().
//
// REASONING-OFF / require_parameters: the OpenRouter-only request-body extras that
// disable hidden reasoning and force schema honoring now live in providers.ts
// (OPENROUTER_EXTRA_BODY). They are NOT sent on the native DeepSeek path, which rejects
// them (deepseek-v4-flash is non-thinking by default). See request-shape.test.ts
// (OpenRouter extras present) and deepseek.test.ts (native: extras absent) for the proof.
//
// ABSTAIN-ON-ERROR: generateObject throws on empty content, JSON parse failure,
// schema-validation failure, or an API error (after retries). We CATCH every
// throw and return a verdict:"error" ProviderResult — never throw to the caller,
// never return a null verdict. A failed model call abstains; it does not block.
import { generateObject, NoObjectGeneratedError } from "ai";
import { jsonrepair } from "jsonrepair";
import { errorMessage } from "@/errors.js";
import { resolveModel, type ProviderId } from "./providers.js";
import { Verdict, Finding, PartialVerdict } from "./schema.js";
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
  const model = resolveModel({
    provider: opts.provider ?? "openrouter",
    model: opts.model,
    apiKey: opts.apiKey,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });

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
      const { object } = await generateObject({
        model,
        schema: Verdict,
        // JSON mode (not the SDK default "tool" mode): the bash reads the verdict
        // from .choices[0].message.content via response_format, NOT from a tool
        // call. "json" sends response_format and parses message.content, matching
        // the deployed wire contract and the recorded fixtures.
        mode: "json",
        system: envelope.system,
        prompt: envelope.user,
        temperature: 0,
        maxTokens: budget,
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
      // the token limit mid-JSON, so the response is truncated but salvageable. Empty
      // content + finish_reason "length" is instead the reasoning-budget bug this file
      // exists to fix (the model burned the whole budget on hidden reasoning and emitted
      // nothing) — a larger budget would only burn MORE reasoning tokens, so we neither
      // escalate nor salvage that; we fall straight through to a fast abstain.
      if (isLengthTruncation(err) && hasPartialOutput(err)) {
        // Prefer a COMPLETE response: retry with a doubled output budget while there's
        // room. Not an abort and not rate-limited, so no backoff. Capped at the ceiling.
        if (budget < MAX_TOKEN_CEILING && attempt < maxAttempts) {
          budget = Math.min(budget * 2, MAX_TOKEN_CEILING);
          continue;
        }
        // No room left to grow the budget — salvage the findings completed before the
        // cut so the chunk is a partial success, not a total loss.
        const salvaged = salvageTruncated(err);
        if (salvaged !== null) return salvaged;
      }
      // Empty content, schema mismatch, or unsalvageable truncation: abstain.
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
 * True when generateObject failed because the model hit the output-token limit
 * mid-JSON (finish_reason "length"): the truncated response cannot be parsed.
 * Distinct from empty content / schema mismatch — those keep finishReason "stop".
 */
function isLengthTruncation(err: unknown): boolean {
  return NoObjectGeneratedError.isInstance(err) && err.finishReason === "length";
}

/**
 * True when a NoObjectGeneratedError carries non-empty raw model output. Separates a
 * real mid-JSON truncation (partial text present — worth a bigger budget + salvage)
 * from the reasoning-budget bug (empty content + finish_reason "length": the model
 * emitted nothing, so escalating the budget only burns more reasoning tokens).
 */
function hasPartialOutput(err: unknown): boolean {
  return (
    NoObjectGeneratedError.isInstance(err) && typeof err.text === "string" && err.text.trim() !== ""
  );
}

/**
 * Recover the findings completed before a length-truncation cut. The raw (truncated)
 * model output is on {@link NoObjectGeneratedError.text}; jsonrepair closes the open
 * JSON, then each finding is validated INDIVIDUALLY so the incomplete trailing one is
 * dropped while the finished ones survive — turning a total chunk loss into a partial
 * success. Returns null when nothing usable can be recovered (caller then abstains).
 */
function salvageTruncated(err: unknown): ProviderResult | null {
  if (!NoObjectGeneratedError.isInstance(err) || typeof err.text !== "string") return null;
  let repaired: unknown;
  try {
    repaired = JSON.parse(jsonrepair(err.text));
  } catch {
    return null;
  }
  const loose = PartialVerdict.safeParse(repaired);
  if (!loose.success) return null;
  const findings: Finding[] = [];
  for (const f of loose.data.findings ?? []) {
    const r = Finding.safeParse(f);
    if (r.success) findings.push(r.data);
  }
  if (findings.length === 0) return null;
  return {
    // Salvage only returns when findings survived, so the verdict is necessarily
    // "changes" — never carry a truncated "approved" forward alongside findings.
    verdict: "changes",
    findings,
    // Match the main-path cap: PartialVerdict leaves review_plan unbounded, so truncate
    // here too rather than carry an over-length plan that the strict path would reject.
    review_plan: (loose.data.review_plan ?? "").slice(0, 280),
    other_checks: "",
    top_must_fix: [],
    partial: true,
    finishReason: "length",
    error:
      `output truncated at the token limit — recovered ${findings.length} finding(s) ` +
      `completed before the cut; later findings may be missing. Raise MAX_TOKENS to avoid.`,
  };
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
