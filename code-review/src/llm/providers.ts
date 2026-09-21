// llm/providers.ts — the model factory. Builds the AI SDK model object the review loop
// consumes, applying OpenRouter's request-body extras INSIDE the factory. This is the
// single seam that keeps reviewWithModel (the review loop) free of transport details:
// it calls resolveModel() and feeds the returned model to the structured-output call.
//
// ONE BACKEND: OpenRouter. The native vendor backends this action once shipped
// (deepseek, minimax, kimi/moonshot) were removed — every model those vendors publish is
// reachable through OpenRouter under a "<vendor>/<model>" id, so the second wire contract
// bought nothing but per-vendor reasoning switches, sampling gates and empty-cut recovery
// rules to keep working. PROVIDER survives as an input and still accepts only
// "openrouter": a workflow pinned to a removed vendor must fail loudly with a config
// error naming the OpenRouter id to use, not silently send that vendor's key here.
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

/** The only backend this action wires. Kept as a type so the input contract, the report
 *  payload and the eval CLI all name the same resolved value. */
export type ProviderId = "openrouter";

/** The single supported provider id, in its canonical spelling. */
export const PROVIDER_ID: ProviderId = "openrouter";

/**
 * The default model id, used when the config omits one. An OpenRouter id (slash
 * namespace): 1M context, 384k output, structured-output capable.
 */
export const DEFAULT_MODEL = "deepseek/deepseek-v4-pro";

/**
 * The canonical {@link ProviderId} for a raw spelling — case-insensitive and trimmed —
 * or undefined when it names anything but OpenRouter. The one resolver every input
 * surface (action inputs, the eval CLI) goes through.
 */
export function canonicalProviderId(raw: string): ProviderId | undefined {
  return raw.trim().toLowerCase() === PROVIDER_ID ? PROVIDER_ID : undefined;
}

/**
 * Vendor spellings whose OpenRouter AUTHOR SLUG differs from the spelling itself.
 * Kimi's models are published under Moonshot AI's slug ("moonshotai/kimi-k2"), so a
 * workflow migrating off PROVIDER:"kimi"/"moonshot" must be pointed at
 * "moonshotai/<model>" — "kimi/<model>" is not an id OpenRouter serves, and an error
 * that suggested it would send the reader straight into a 400.
 */
const OPENROUTER_NAMESPACE: ReadonlyMap<string, string> = new Map([
  ["kimi", "moonshotai"],
  ["moonshot", "moonshotai"],
]);

/**
 * The OpenRouter model-id namespace to suggest for a REJECTED provider spelling: the
 * vendor's author slug on OpenRouter, which is not always the spelling itself (see
 * {@link OPENROUTER_NAMESPACE}). Trimmed and lowercased, because OpenRouter ids are.
 * The one place the "PROVIDER x is gone, use MODEL_ID y" advice is composed, shared by
 * the action inputs and the eval CLI so the two never suggest different ids.
 */
export function openRouterNamespaceFor(rawProvider: string): string {
  const p = rawProvider.trim().toLowerCase();
  return OPENROUTER_NAMESPACE.get(p) ?? p;
}

/**
 * OpenRouter request-body extras, forwarded verbatim on every call.
 */
const OPENROUTER_EXTRA_BODY = {
  // Disable reasoning so the model spends max_tokens on the answer, not hidden thinking.
  // "none" is not in the SDK's typed reasoning-effort union, so it rides in extraBody.
  reasoning: { effort: "none" },
  // Require the upstream provider to honor the structured-output parameters.
  provider: { require_parameters: true },
} as const;

/** Options for {@link resolveModel}: model id, key, and a test fetch. */
export interface ResolveModelOptions {
  /** The resolved, non-empty OpenRouter model id. */
  model: string;
  /** The OpenRouter API key (Authorization: Bearer). */
  apiKey: string;
  /** Custom fetch — injected by tests to replay recorded responses; real fetch in prod. */
  fetch?: typeof fetch;
}

/**
 * Construct the AI SDK model object for `opts.model`, with the OpenRouter request-body
 * extras baked into the client. The returned {@link LanguageModel} is what the structured
 * call consumes.
 */
export function resolveModel(opts: ResolveModelOptions): LanguageModel {
  const fetchOpt = opts.fetch ? { fetch: opts.fetch } : {};
  return createOpenRouter({
    apiKey: opts.apiKey,
    ...fetchOpt,
    extraBody: OPENROUTER_EXTRA_BODY,
  })(opts.model);
}
