// llm/providers.ts — the provider factory. Maps a ProviderId to a constructed AI SDK
// model object, applying that provider's request-body extras INSIDE the factory. This
// is the single seam that keeps reviewWithModel (the review loop) provider-agnostic:
// it calls resolveModel() and feeds the returned model to the structured-output call.
//
// FAIL FAST on unsupported providers: only the ids in SUPPORTED_PROVIDERS have a real
// native backend (openai, anthropic and the rest do not). Anything else must error here
// rather than silently routing through OpenRouter (the prior bug — every provider hit
// OpenRouter regardless of the `provider` field).
//
// FOUR BACKENDS, ONE WIRE CONTRACT: every backend is an OpenAI-style chat-completions
// endpoint (Authorization: Bearer) answering the SDK's JSON mode. MiniMax and Kimi ride
// the generic @ai-sdk/openai-compatible client pointed at the vendor's own host, so the
// review is billed to the vendor's key instead of OpenRouter's. What differs per vendor
// (reasoning switch, whether an empty length cut is recoverable) is tabulated in
// CALL_TUNING below; Kimi's sampling gate is a model middleware (NO_TEMPERATURE) applied
// in its factory branch. The review loop itself never names a provider.
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { wrapLanguageModel, type LanguageModelV1Middleware } from "ai";
import type { LanguageModel, ProviderMetadata } from "ai";

/** Providers with a real native backend wired in this action. */
export type ProviderId = "openrouter" | "deepseek" | "minimax" | "kimi";

/** The providers {@link resolveModel} can construct; anything else throws. */
export const SUPPORTED_PROVIDERS: readonly ProviderId[] = [
  "openrouter",
  "deepseek",
  "minimax",
  "kimi",
];

/** Narrow an arbitrary string to a supported {@link ProviderId}. */
export function isSupportedProvider(s: string): s is ProviderId {
  return SUPPORTED_PROVIDERS.some((p) => p === s);
}

/**
 * Alternate spellings accepted for a provider. "moonshot" is Kimi's vendor (Moonshot AI)
 * and the name this action advertised before the native backend existed, so it keeps
 * working as an alias of "kimi" — the vendor's current branding.
 */
const PROVIDER_ALIASES: ReadonlyMap<string, ProviderId> = new Map([["moonshot", "kimi"]]);

/**
 * The canonical {@link ProviderId} for a raw spelling — case-insensitive, trimmed, with
 * {@link PROVIDER_ALIASES} applied — or undefined when it names no supported provider.
 * The one resolver every input surface (action inputs, the eval CLI) goes through.
 */
export function canonicalProviderId(raw: string): ProviderId | undefined {
  const s = raw.trim().toLowerCase();
  if (isSupportedProvider(s)) return s;
  return PROVIDER_ALIASES.get(s);
}

/**
 * Per-provider default model id, used when the config omits one. Single source of
 * truth shared with inputs.ts so the two never disagree on a default.
 */
const DEFAULT_MODEL: Record<ProviderId, string> = {
  // OpenRouter id (slash namespace): 1M context, 384k output, structured-output capable.
  openrouter: "deepseek/deepseek-v4-pro",
  // Native DeepSeek id (no namespace): fast, cheap, 1M context. NOT non-thinking by
  // default — see DEEPSEEK_PROVIDER_OPTIONS. deepseek-chat/deepseek-reasoner are
  // deprecated (2026-07-24) — don't use.
  deepseek: "deepseek-v4-flash",
  // Native MiniMax id: the only 1M-context MiniMax model, priced in the deepseek-v4-flash
  // tier (~$0.30/M in, $1.20/M out), and the one MiniMax model whose thinking switch is
  // honoured — see MINIMAX_PROVIDER_OPTIONS. The M2.x ids (MiniMax-M2.7, -M2.5, …) work
  // too but think on every call regardless.
  minimax: "MiniMax-M3",
  // Native Kimi id: the code-specialised model (262K context) with the most stable
  // structured output of Kimi's current line-up; kimi-k3 is the 1M-context flagship at
  // roughly 4x the price, kimi-k2.7-code-highspeed the same model with faster output.
  // Reasons on every call and cannot be told not to — see CALL_TUNING.kimi.
  kimi: "kimi-k2.7-code",
};

/** The default model id for a provider. */
export function defaultModelFor(provider: ProviderId): string {
  return DEFAULT_MODEL[provider];
}

/** MiniMax's international chat-completions host (api.minimaxi.com is the China host). */
const MINIMAX_BASE_URL = "https://api.minimax.io/v1";

/** Moonshot AI's international chat-completions host — unchanged by the platform.kimi.ai
 *  rebrand (api.moonshot.cn is the China host, with its own key namespace). */
const KIMI_BASE_URL = "https://api.moonshot.ai/v1";

/**
 * OpenRouter-only request-body extras, forwarded verbatim on every OpenRouter call.
 * Moved here from openrouter.ts: these fields are the OpenRouter envelope and are NOT
 * valid on the native vendor APIs, which reject them.
 */
const OPENROUTER_EXTRA_BODY = {
  // Disable reasoning so the model spends max_tokens on the answer, not hidden thinking.
  // "none" is not in the SDK's typed reasoning-effort union, so it rides in extraBody.
  reasoning: { effort: "none" },
  // Require the upstream provider to honor the structured-output parameters.
  provider: { require_parameters: true },
} as const;

/**
 * Native-DeepSeek request-body extras, forwarded through the AI SDK's `providerOptions`
 * (the openai-compatible layer spreads `providerOptions.deepseek` verbatim into the
 * chat-completions body, so this arrives as a top-level `thinking` field).
 *
 * WHY: thinking is ENABLED BY DEFAULT on api.deepseek.com — for deepseek-v4-flash as
 * well as -pro — and reasoning tokens are billed against `max_tokens`. A review that
 * reasons past the budget therefore returns finish_reason "length" with EMPTY content
 * and no JSON at all, which the structured call reports as "could not parse the
 * response" and reviewWithModel can neither salvage nor escalate (a bigger budget just
 * buys more hidden reasoning). Every chunk of every PR failed that way. Disabling
 * thinking is the native equivalent of OpenRouter's `reasoning: { effort: "none" }`.
 */
const DEEPSEEK_PROVIDER_OPTIONS: ProviderMetadata = {
  deepseek: { thinking: { type: "disabled" } },
};

/**
 * Native-MiniMax request-body extras. The key is the `name` handed to
 * createOpenAICompatible, which the SDK uses as the providerOptions slot it spreads into
 * the body — so both fields arrive top-level, exactly as MiniMax documents them.
 */
const MINIMAX_PROVIDER_OPTIONS: ProviderMetadata = {
  minimax: {
    // MiniMax-M3 thinks by default (adaptively) and honours this switch; the M2.x ids
    // accept it and think anyway. Same reason as DeepSeek's: reasoning is billed
    // against max_tokens.
    thinking: { type: "disabled" },
    // When a model DOES think (an M2.x id), keep the reasoning out of message.content:
    // without this MiniMax embeds it there inside <think>…</think> ahead of the JSON and
    // the review never parses. With it the reasoning rides in reasoning_content, which
    // the SDK routes away from the object text.
    reasoning_split: true,
  },
};

/**
 * How one provider's calls deviate from the shared chat-completions baseline. Every
 * entry is a documented vendor fact, not a preference; the review loop reads them
 * through {@link providerOptionsFor} and {@link escalatesEmptyCut} and never names a
 * provider itself; Kimi's sampling gate is enforced by {@link NO_TEMPERATURE} instead.
 */
interface CallTuning {
  /** Per-CALL request-body extras (the vendor's reasoning switch), or undefined. */
  providerOptions: ProviderMetadata | undefined;
  /**
   * Whether an EMPTY response cut at max_tokens (finish_reason "length", no content) is
   * worth retrying at a doubled budget. False where reasoning is switched off, so that
   * shape can only be the hidden-reasoning bug and a bigger budget would buy more of it.
   * True where the vendor offers no switch: the model reasoned past the budget before
   * writing a byte of JSON, and — as the vendor's own docs advise — a larger budget lets
   * the answer through.
   */
  escalatesEmptyCut: boolean;
}

const CALL_TUNING: Record<ProviderId, CallTuning> = {
  // Reasoning off via OPENROUTER_EXTRA_BODY (baked into the client), so nothing per call.
  openrouter: { providerOptions: undefined, escalatesEmptyCut: false },
  // Reasoning off per call — createDeepSeek exposes no extraBody hook.
  deepseek: { providerOptions: DEEPSEEK_PROVIDER_OPTIONS, escalatesEmptyCut: false },
  // The switch holds on M3 only, so an empty cut from an M2.x id is a real reasoning
  // overrun and escalates. (temperature 0 is accepted: the current M2.x/M3 endpoint
  // takes [0, 2]; only the legacy abab API rejected 0.)
  minimax: { providerOptions: MINIMAX_PROVIDER_OPTIONS, escalatesEmptyCut: true },
  // Kimi's current models reason on every call: kimi-k3 and kimi-k2.7-code cannot be
  // switched off (`thinking:{type:"disabled"}` is an ERROR on k2.7-code and unknown to
  // k3), and only kimi-k2.6 accepts it — so no switch is sent for any id, the reasoning
  // lands in reasoning_content (never inside the JSON), and its budget overrun escalates.
  // The sampling gate is handled by NO_TEMPERATURE in the factory.
  kimi: { providerOptions: undefined, escalatesEmptyCut: true },
};

/**
 * Model middleware that drops the sampling temperature before the request is built.
 * Kimi's current models REJECT any explicit value ("invalid temperature: only 1 is
 * allowed for this model" — kimi-k3 and kimi-k2.7-code force 1.0, kimi-k2.6 0.6 without
 * thinking), so the vendor default must apply. ai@4's call layer substitutes temperature
 * 0 whenever a call passes none, so "send no temperature" can only be enforced here, at
 * the model, not at the call site — the review call keeps pinning 0 for everyone else.
 */
const NO_TEMPERATURE: LanguageModelV1Middleware = {
  transformParams: ({ params }) => Promise.resolve({ ...params, temperature: undefined }),
};

/**
 * The `providerOptions` to pass to the structured call for a provider, or undefined when
 * it needs none. Keeps provider-specific request knowledge in this module even though
 * providerOptions is a per-CALL argument (unlike OpenRouter's extraBody, which the
 * factory can bake into the client).
 */
export function providerOptionsFor(provider: ProviderId): ProviderMetadata | undefined {
  return CALL_TUNING[provider].providerOptions;
}

/** Whether an empty length-cut response from this provider should escalate the budget
 *  (see {@link CallTuning.escalatesEmptyCut}). */
export function escalatesEmptyCut(provider: ProviderId): boolean {
  return CALL_TUNING[provider].escalatesEmptyCut;
}

/** Options for {@link resolveModel}: resolved provider, model id, key, and a test fetch. */
export interface ResolveModelOptions {
  /** The resolved, validated provider (callers narrow via {@link canonicalProviderId}). */
  provider: ProviderId;
  /** The resolved, non-empty model id for that provider. */
  model: string;
  /** The provider API key (Authorization: Bearer). */
  apiKey: string;
  /** Custom fetch — injected by tests to replay recorded responses; real fetch in prod. */
  fetch?: typeof fetch;
}

/**
 * Construct the AI SDK model object for `opts.provider`, applying that provider's
 * request-body extras inside the factory. The returned {@link LanguageModel} is what the
 * structured call consumes. Throws on an unsupported provider — a backstop, since
 * callers resolve the provider via {@link canonicalProviderId} before reaching here.
 */
export function resolveModel(opts: ResolveModelOptions): LanguageModel {
  const { provider, model, apiKey } = opts;
  const fetchOpt = opts.fetch ? { fetch: opts.fetch } : {};
  switch (provider) {
    case "openrouter":
      return createOpenRouter({ apiKey, ...fetchOpt, extraBody: OPENROUTER_EXTRA_BODY })(model);
    case "deepseek":
      // No extraBody: the native API rejects OpenRouter's reasoning/provider fields. Its
      // own reasoning switch rides on the CALL instead, via providerOptionsFor("deepseek")
      // — createDeepSeek exposes no extraBody hook. The SDK sends
      // response_format:{type:"json_object"} for mode:"json" — DeepSeek-compatible.
      return createDeepSeek({ apiKey, ...fetchOpt })(model);
    case "minimax":
      // Stock OpenAI-compatible client on MiniMax's own host. MiniMax silently IGNORES
      // response_format on this endpoint (json_object and json_schema alike), so the
      // Verdict schema reaches the model only through the instruction the SDK injects
      // into the prompt in JSON mode — the same text every other backend also gets, minus
      // the server-side hint. The reasoning switch rides on the CALL (MINIMAX_PROVIDER_OPTIONS).
      return createOpenAICompatible({
        name: "minimax",
        baseURL: MINIMAX_BASE_URL,
        apiKey,
        ...fetchOpt,
      })(model);
    case "kimi":
      // Stock OpenAI-compatible client on Moonshot AI's own host, wrapped so the request
      // carries no temperature (NO_TEMPERATURE). Kimi honours
      // response_format:{type:"json_object"} on every current model. No thinking switch
      // rides on the call either (rejected or ignored) — see CALL_TUNING.kimi.
      return wrapLanguageModel({
        model: createOpenAICompatible({
          name: "kimi",
          baseURL: KIMI_BASE_URL,
          apiKey,
          ...fetchOpt,
        })(model),
        middleware: NO_TEMPERATURE,
      });
    default:
      // Exhaustiveness backstop: a new ProviderId without a branch is a compile error.
      throw new Error(
        `provider '${String(provider)}' has no factory branch ` +
          `(supported: ${SUPPORTED_PROVIDERS.join(", ")})`,
      );
  }
}
