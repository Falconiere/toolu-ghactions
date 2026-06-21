// llm/providers.ts — the provider factory. Maps a ProviderId to a constructed AI SDK
// model object, applying that provider's request-body extras INSIDE the factory. This
// is the single seam that keeps reviewWithModel (the review loop) provider-agnostic:
// it calls resolveModel() and feeds the returned model to generateObject.
//
// FAIL FAST on unsupported providers: action.yml advertises more (openai, anthropic,
// moonshot, minimax) but only the ones in SUPPORTED_PROVIDERS have a real native
// backend. The rest must error here rather than silently routing through OpenRouter
// (the prior bug — every provider hit OpenRouter regardless of the `provider` field).
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createDeepSeek } from "@ai-sdk/deepseek";
import type { LanguageModel } from "ai";

/** Providers with a real native backend wired in this action. */
export type ProviderId = "openrouter" | "deepseek";

/** The providers {@link resolveModel} can construct; anything else throws. */
export const SUPPORTED_PROVIDERS: readonly ProviderId[] = ["openrouter", "deepseek"];

/** Narrow an arbitrary string to a supported {@link ProviderId}. */
export function isSupportedProvider(s: string): s is ProviderId {
  return SUPPORTED_PROVIDERS.some((p) => p === s);
}

/**
 * Per-provider default model id, used when the config omits one. Single source of
 * truth shared with inputs.ts so the two never disagree on a default.
 */
const DEFAULT_MODEL: Record<ProviderId, string> = {
  // OpenRouter id (slash namespace): 1M context, 384k output, structured-output capable.
  openrouter: "deepseek/deepseek-v4-pro",
  // Native DeepSeek id (no namespace): deepseek-v4-flash is non-thinking, fast, cheap,
  // 1M context. deepseek-chat/deepseek-reasoner are deprecated (2026-07-24) — don't use.
  deepseek: "deepseek-v4-flash",
};

/** The default model id for a provider. */
export function defaultModelFor(provider: ProviderId): string {
  return DEFAULT_MODEL[provider];
}

/**
 * OpenRouter-only request-body extras, forwarded verbatim on every OpenRouter call.
 * Moved here from openrouter.ts: these fields are the OpenRouter envelope and are NOT
 * valid on the native DeepSeek API, which rejects them.
 */
const OPENROUTER_EXTRA_BODY = {
  // Disable reasoning so the model spends max_tokens on the answer, not hidden thinking.
  // "none" is not in the SDK's typed reasoning-effort union, so it rides in extraBody.
  reasoning: { effort: "none" },
  // Require the upstream provider to honor the structured-output parameters.
  provider: { require_parameters: true },
} as const;

/** Options for {@link resolveModel}: resolved provider, model id, key, and a test fetch. */
export interface ResolveModelOptions {
  /** The resolved, validated provider (callers narrow via {@link isSupportedProvider}). */
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
 * request-body extras inside the factory. The returned {@link LanguageModel} is what
 * generateObject consumes. Throws on an unsupported provider — a backstop, since
 * callers resolve the provider via {@link isSupportedProvider} before reaching here.
 */
export function resolveModel(opts: ResolveModelOptions): LanguageModel {
  const { provider, model, apiKey } = opts;
  const fetchOpt = opts.fetch ? { fetch: opts.fetch } : {};
  switch (provider) {
    case "openrouter":
      return createOpenRouter({ apiKey, ...fetchOpt, extraBody: OPENROUTER_EXTRA_BODY })(model);
    case "deepseek":
      // No extraBody: the native API rejects OpenRouter's reasoning/provider fields, and
      // deepseek-v4-flash is non-thinking by default (no reasoning to disable). The SDK
      // sends response_format:{type:"json_object"} for mode:"json" — DeepSeek-compatible.
      return createDeepSeek({ apiKey, ...fetchOpt })(model);
    default:
      // Exhaustiveness backstop: a new ProviderId without a branch is a compile error.
      throw new Error(
        `provider '${String(provider)}' has no factory branch ` +
          `(supported: ${SUPPORTED_PROVIDERS.join(", ")})`,
      );
  }
}
