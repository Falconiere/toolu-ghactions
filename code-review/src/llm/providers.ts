// llm/providers.ts — the model factory. Builds the AI SDK model object the review loop
// consumes, applying OpenRouter's request-body extras INSIDE the factory. This is the
// single seam that keeps reviewWithModel (the review loop) free of transport details:
// it calls resolveModel() and feeds the returned model to the structured-output call.
//
// OpenRouter remains the default; custom API roots use the generic compatible
// transport so OpenRouter routing/reasoning extras never reach another server.
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { JSONValue, LanguageModel } from "ai";

/** Supported backends. Kept as a type so the input contract, the report
 *  payload and the eval CLI all name the same resolved value. */
export type ProviderId = "openrouter" | "openai-compatible";

/** The default provider id. */
export const PROVIDER_ID: ProviderId = "openrouter";

/**
 * The default model id, used when the config omits one. An OpenRouter id (slash
 * namespace): 1M context, 384k output, structured-output capable.
 */
export const DEFAULT_MODEL = "deepseek/deepseek-v4-pro";

/**
 * The canonical {@link ProviderId} for a raw spelling — case-insensitive and trimmed —
 * or undefined when it names an unsupported backend. The one resolver every input
 * surface (action inputs, the eval CLI) goes through.
 */
export function canonicalProviderId(raw: string): ProviderId | undefined {
  const id = raw.trim().toLowerCase();
  if (id === "openrouter") return "openrouter";
  if (id === "openai-compatible") return "openai-compatible";
  return undefined;
}

/** Validate an explicit API root without logging embedded credentials. */
export function validateBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("BASE_URL must be an absolute HTTP(S) API root (including /v1 when needed).");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "BASE_URL must use HTTP(S), without credentials, query parameters or a fragment.",
    );
  }
  return url.toString().replace(/\/+$/, "");
}

/**
 * Where a reader looks up the OpenRouter id for a model. Quoted in every "that PROVIDER
 * is gone / that MODEL_ID is not namespaced" message instead of a COMPOSED id: a vendor's
 * OpenRouter namespace is not always its name (Kimi publishes under "moonshotai/", not
 * "kimi/"), the catalog is external and changes continuously, and this action cannot
 * query it from an input-validation path that must not touch the network. Advice built by
 * interpolating the spelling the user typed is how `MODEL_ID:"kimi/<model>"` shipped — a
 * suggestion that 400s. Point at the catalog; never guess an id.
 */
export const OPENROUTER_MODELS_URL = "https://openrouter.ai/models";

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
  /** Defaults to OpenRouter for existing callers. */
  provider?: ProviderId;
  /** API root required for openai-compatible. */
  baseUrl?: string | undefined;
  /** Optional server-specific request fields, for custom endpoints only. */
  extraBody?: Record<string, JSONValue> | undefined;
  /** The resolved, non-empty model id. */
  model: string;
  /** Bearer API key; empty for an unauthenticated custom endpoint. */
  apiKey: string;
  /** Custom fetch — injected by tests to replay recorded responses; real fetch in prod. */
  fetch?: typeof fetch;
}

/**
 * Construct the model with the selected backend's wire contract. The returned {@link LanguageModel} is what the structured
 * call consumes.
 */
export function resolveModel(opts: ResolveModelOptions): LanguageModel {
  const fetchOpt = opts.fetch ? { fetch: opts.fetch } : {};
  if (opts.provider === "openai-compatible") {
    if (!opts.baseUrl) throw new Error("BASE_URL is required for PROVIDER=openai-compatible.");
    const extra = opts.extraBody;
    return createOpenAICompatible({
      name: "openai-compatible",
      baseURL: validateBaseUrl(opts.baseUrl),
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      // EXTRA_BODY is merged into the WIRE body: passed as provider metadata, the SDK's
      // getArgs re-sets `reasoning_effort` from its own camelCase option and drops ours.
      // Reserved keys never get here — parseExtraBody rejects them. The SDK always posts
      // a JSON string; any other body is passed through untouched.
      ...(extra
        ? {
            fetch: (url: Parameters<typeof fetch>[0], init?: RequestInit) =>
              (opts.fetch ?? fetch)(
                url,
                typeof init?.body === "string"
                  ? { ...init, body: JSON.stringify({ ...JSON.parse(init.body), ...extra }) }
                  : init,
              ),
          }
        : fetchOpt),
    })(opts.model);
  }
  if (opts.baseUrl) throw new Error("BASE_URL requires PROVIDER=openai-compatible.");
  if (opts.extraBody) throw new Error("EXTRA_BODY requires PROVIDER=openai-compatible.");
  return createOpenRouter({
    apiKey: opts.apiKey,
    ...fetchOpt,
    extraBody: OPENROUTER_EXTRA_BODY,
  })(opts.model);
}
