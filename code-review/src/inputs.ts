// inputs.ts — read and normalize every action.yml input into a typed
// ActionInputs object. Port of the env-reading + provider-resolution logic that
// build_providers_list() / build-prompt.sh / fetch-diff.sh split across the bash:
// done ONCE here so the pipeline takes a plain typed object, never process.env.
//
// LEGACY → EFFECTIVE PROVIDER: the TS action runs a SINGLE OpenRouter model
// (see llm/openrouter.ts). We collapse the legacy single-provider inputs
// (OPENROUTER_API_KEY + MODEL) and the multi-provider PROVIDERS array down to one
// effective {model, apiKey}. When PROVIDERS is given, the FIRST entry's
// model/api_key wins; any extra entries are a no-op and warned. The other
// multi-provider knobs (MERGE_STRATEGY, FALLBACK_MODEL, REVIEW_MODE) and
// ENFORCE_JSON_SCHEMA=false are deprecated no-ops that emit a core.warning.
import * as core from "@actions/core";
import { z } from "zod";

/** Minimum confidence floor for the validate gate (high|medium). */
export type MinConfidence = "high" | "medium";

/** The fully-resolved, typed inputs the pipeline consumes (no env reads downstream). */
export interface ActionInputs {
  /** Effective OpenRouter model id (PROVIDERS[0].model | MODEL | default). */
  model: string;
  /** Effective OpenRouter API key (PROVIDERS[0].api_key | OPENROUTER_API_KEY | ""). */
  apiKey: string;
  /** Max completion tokens per request. */
  maxTokens: number;
  /** Confidence floor for keeping findings. */
  minConfidence: MinConfidence;
  /** When true, request response_format json_schema + require_parameters. */
  enforceJsonSchema: boolean;
  /** When true, post per-line inline review comments in addition to the summary. */
  inlineComments: boolean;
  /** When true, set/clear the verdict PR label chip. */
  manageLabels: boolean;
  /** Base branch for diff comparison (default "main"). */
  baseBranch: string;
  /** Custom system-prompt file path (relative to the workspace), or "". */
  reviewPromptFile: string;
  /** High-level codebase description injected into the prompt, or "". */
  codebaseOverview: string;
  /** When true, gather + inject project convention files from the base ref. */
  checkProjectRules: boolean;
  /** Extra path globs to include as project rules (newline/comma-separated), or "". */
  rulesGlob: string;
  /** Total byte cap on gathered project-rules text. */
  rulesMaxBytes: number;
  /** Max changed files before the action skips (0 = unlimited). */
  maxFiles: number;
  /** Max diff lines before truncation (0 = unlimited); applied before chunking. */
  maxDiffLines: number;
  /** Per-chunk diff-line budget; diffs over this are chunked into separate calls (0 = never chunk). */
  maxChunkLines: number;
  /** Max chunks (= model calls) per review, bounding cost; files beyond are skipped (0 = unlimited). */
  maxChunks: number;
  /** GitHub token for posting/editing comments. */
  token: string;
  /** GitHub App id (empty when no App identity configured). */
  appId: string;
  /** GitHub App private key, raw or base64 PEM (empty when unset). */
  appPrivateKey: string;
  /** @mention prefix that re-triggers a review from a PR comment. */
  triggerPhrase: string;
  /** Minimum repo permission a commenter needs to trigger via @mention. */
  minTriggerPermission: "write" | "admin";
  /** Display name in the comment header. */
  botName: string;
  /** Logo image URL in the comment header. */
  botLogoUrl: string;
  /** When true, recap changes since the last review via the hidden state marker. */
  reviewMemory: boolean;
}

/**
 * One PROVIDERS array entry; only the fields we read are typed (loose by design —
 * unknown keys like `provider` are stripped). Validated, not asserted: a non-object
 * entry or a wrong-typed field is rejected by {@link parseProviders} instead of
 * being silently mistyped.
 */
const ProviderEntrySchema = z.object({
  model: z.string().optional(),
  api_key: z.string().optional(),
  enforce_json_schema: z.boolean().optional(),
  max_tokens: z.number().optional(),
});
type ProviderEntry = z.infer<typeof ProviderEntrySchema>;

/** Default model — kept in sync with action.yml MODEL default. deepseek-v4-pro:
 * 1M-token context (huge diffs fit without aggressive chunking) and a 384k-token max
 * output, so structured review output almost never hits the budget; it advertises
 * `response_format` + `structured_outputs` on OpenRouter, so `require_parameters`
 * routes to a provider that honors the JSON schema. Reasoning is disabled
 * (EXTRA_BODY `reasoning.effort: "none"`) to avoid the reasoning-budget empty-content
 * failure older deepseek json-mode showed.
 * NOTE: on an exceptionally large diff the structured output can still truncate — the
 * pipeline mitigates it by CHUNKING the diff (MAX_CHUNK_LINES / MAX_CHUNKS), and a
 * length-truncated chunk is retried with a larger budget then salvaged (openrouter.ts),
 * so the findings completed before the cut survive. */
const DEFAULT_MODEL = "deepseek/deepseek-v4-pro";

/**
 * Default completion-token budget — kept in sync with action.yml MAX_TOKENS default.
 * 8192 (not 4096): a single chunk's structured output (review_plan + findings +
 * other_checks) overran 4096 and truncated mid-JSON (finish_reason "length"). This
 * is a cap, billed on actual output, so the headroom is free for small reviews.
 */
const DEFAULT_MAX_TOKENS = 8192;

/**
 * Parse a string input as a base-10 integer, falling back to `fallback` for an
 * empty or non-numeric value (mirrors the bash `${VAR:-default}` + arithmetic).
 */
function intInput(name: string, fallback: number): number {
  const raw = core.getInput(name).trim();
  if (raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Validate a completion-token budget: a non-positive value (≤0) is a config typo
 * that would force an OpenRouter 400 → silent abstain, so it falls back to
 * {@link DEFAULT_MAX_TOKENS} with a `core.warning` instead of being forwarded.
 * Unlike MAX_FILES/MAX_DIFF_LINES, 0 is NOT "unlimited" here — the budget must be
 * positive. `source` names where the bad value came from for the warning text.
 */
function validateTokenBudget(value: number, source: string): number {
  if (Number.isFinite(value) && value > 0) return value;
  core.warning(
    `${source}=${value} is not a positive token budget; falling back to ${DEFAULT_MAX_TOKENS}.`,
  );
  return DEFAULT_MAX_TOKENS;
}

/** Read MIN_CONFIDENCE, defaulting to "high"; only "medium" relaxes the floor. */
function readMinConfidence(): MinConfidence {
  return core.getInput("MIN_CONFIDENCE").trim().toLowerCase() === "medium" ? "medium" : "high";
}

/** Read MIN_TRIGGER_PERMISSION, defaulting to "write"; only "admin" tightens it. */
function readMinTriggerPermission(): "write" | "admin" {
  return core.getInput("MIN_TRIGGER_PERMISSION").trim().toLowerCase() === "admin"
    ? "admin"
    : "write";
}

/**
 * Parse the PROVIDERS input as a JSON array. Returns the parsed entries, or null
 * when PROVIDERS is empty/whitespace. Throws on a value that is set but is NOT a
 * non-empty JSON array — matching build_providers_list()'s `return 1` (the bash
 * `fail "No providers configured"` path).
 */
function parseProviders(raw: string): ProviderEntry[] | null {
  if (raw.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("PROVIDERS is set but is not valid JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("PROVIDERS is set but is not a non-empty JSON array.");
  }
  const result = ProviderEntrySchema.array().safeParse(parsed);
  if (!result.success) {
    throw new Error(`PROVIDERS entries are not valid: ${result.error.message}`);
  }
  return result.data;
}

/**
 * Resolve the effective {model, apiKey, enforceJsonSchema, maxTokens} from the
 * PROVIDERS array (first entry wins) or the legacy single-provider inputs.
 * Emits the deprecation warnings build_providers_list() emits: extra PROVIDERS
 * entries (>1), and the legacy/multi conflict.
 */
function resolveProvider(
  providers: ProviderEntry[] | null,
  legacyKey: string,
  legacyModel: string,
  legacyEnforce: boolean,
  legacyMaxTokens: number,
): { model: string; apiKey: string; enforceJsonSchema: boolean; maxTokens: number } {
  if (providers !== null) {
    if (legacyKey !== "") {
      core.warning(
        "OPENROUTER_API_KEY (and other legacy single-provider inputs) ignored; using PROVIDERS",
      );
    }
    if (providers.length > 1) {
      core.warning(
        `PROVIDERS carries ${providers.length} entries, but this action reviews with a single model; ` +
          "only the first entry is used. The remaining entries are a no-op.",
      );
    }
    const first = providers[0] ?? {};
    // A non-positive PROVIDERS[0].max_tokens (e.g. a `max_tokens: 0` typo) would
    // 400 the request → silent abstain; clamp it to the default with a warning.
    const providerMaxTokens =
      typeof first.max_tokens === "number"
        ? validateTokenBudget(first.max_tokens, "PROVIDERS[0].max_tokens")
        : legacyMaxTokens;
    return {
      model: first.model && first.model !== "" ? first.model : DEFAULT_MODEL,
      apiKey: first.api_key ?? "",
      enforceJsonSchema: first.enforce_json_schema ?? true,
      maxTokens: providerMaxTokens,
    };
  }

  // Legacy single-provider path.
  return {
    model: legacyModel !== "" ? legacyModel : DEFAULT_MODEL,
    apiKey: legacyKey,
    enforceJsonSchema: legacyEnforce,
    maxTokens: legacyMaxTokens,
  };
}

/** Warn for each deprecated no-op input that the caller still set. */
function warnDeprecated(legacyEnforce: boolean): void {
  if (core.getInput("MERGE_STRATEGY").trim() !== "") {
    core.warning("MERGE_STRATEGY is a no-op; this action reviews with a single model.");
  }
  if (core.getInput("FALLBACK_MODEL").trim() !== "") {
    core.warning("FALLBACK_MODEL is dropped; configure the model via MODEL or PROVIDERS.");
  }
  const reviewMode = core.getInput("REVIEW_MODE").trim();
  if (reviewMode !== "" && reviewMode !== "single") {
    core.warning("REVIEW_MODE is a no-op; the single-model review replaces per-dimension fan-out.");
  }
  if (!legacyEnforce) {
    core.warning(
      "ENFORCE_JSON_SCHEMA=false is a no-op; the single-model path always enforces the JSON schema.",
    );
  }
}

/**
 * Read every action.yml input and resolve it into a typed {@link ActionInputs}.
 *
 * Collapses the legacy single-provider inputs and the multi-provider PROVIDERS
 * array into one effective model/api_key, and emits a `core.warning` for each
 * deprecated no-op input that was set. Throws when PROVIDERS is present but not a
 * non-empty JSON array (the bash "No providers configured" failure).
 */
export function readInputs(): ActionInputs {
  const legacyKey =
    core.getInput("OPENROUTER_API_KEY").trim() || (process.env["OPENROUTER_API_KEY"] ?? "").trim();
  const legacyModel = core.getInput("MODEL").trim();
  const legacyEnforce = readBool("ENFORCE_JSON_SCHEMA", true);
  // MAX_TOKENS must be a positive budget; MAX_TOKENS="0"/"-1" is a typo that would
  // 400 → silent abstain, so clamp it to the default with a warning (FIX 8).
  const legacyMaxTokens = validateTokenBudget(
    intInput("MAX_TOKENS", DEFAULT_MAX_TOKENS),
    "MAX_TOKENS",
  );

  const providers = parseProviders(core.getInput("PROVIDERS"));
  const effective = resolveProvider(
    providers,
    legacyKey,
    legacyModel,
    legacyEnforce,
    legacyMaxTokens,
  );

  warnDeprecated(legacyEnforce);

  return {
    model: effective.model,
    apiKey: effective.apiKey,
    maxTokens: effective.maxTokens,
    enforceJsonSchema: effective.enforceJsonSchema,
    minConfidence: readMinConfidence(),
    inlineComments: readBool("INLINE_COMMENTS", true),
    manageLabels: readBool("MANAGE_LABELS", true),
    baseBranch: core.getInput("BASE_BRANCH").trim() || "main",
    // Trim both: prompt.ts treats only "" as "use default", so an untrimmed
    // whitespace/newline value (a YAML block scalar) would become a bogus prompt
    // path → readFileSync ENOENT crash. Every other string input here is trimmed.
    reviewPromptFile: core.getInput("REVIEW_PROMPT_FILE").trim(),
    codebaseOverview: core.getInput("CODEBASE_OVERVIEW").trim(),
    checkProjectRules: readBool("CHECK_PROJECT_RULES", true),
    rulesGlob: core.getInput("RULES_GLOB"),
    rulesMaxBytes: intInput("RULES_MAX_BYTES", 32768),
    maxFiles: intInput("MAX_FILES", 0),
    maxDiffLines: intInput("MAX_DIFF_LINES", 0),
    maxChunkLines: intInput("MAX_CHUNK_LINES", 1500),
    maxChunks: intInput("MAX_CHUNKS", 20),
    token: core.getInput("TOKEN") || (process.env["GITHUB_TOKEN"] ?? ""),
    appId: core.getInput("APP_ID").trim(),
    appPrivateKey: core.getInput("APP_PRIVATE_KEY"),
    triggerPhrase: core.getInput("TRIGGER_PHRASE").trim() || "@toolu",
    minTriggerPermission: readMinTriggerPermission(),
    botName: core.getInput("BOT_NAME") || "Toolu — Code Review",
    botLogoUrl:
      core.getInput("BOT_LOGO_URL") ||
      "https://raw.githubusercontent.com/falconiere/toolu-ghactions/main/code-review/assets/logo.png",
    reviewMemory: readBool("REVIEW_MEMORY", true),
  };
}

/**
 * Read a boolean input, defaulting to `fallback` when unset. `getBooleanInput`
 * throws on a non-boolean/non-empty value, so we read the raw string first and
 * fall back on empty (matching the bash `${VAR:-default}` default-when-unset).
 */
function readBool(name: string, fallback: boolean): boolean {
  if (core.getInput(name).trim() === "") return fallback;
  return core.getBooleanInput(name);
}
