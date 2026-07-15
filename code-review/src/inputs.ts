// inputs.ts — read and normalize every action.yml input into a typed ActionInputs
// object, ONCE, so the pipeline takes a plain typed object and never reads process.env.
//
// FLAT PROVIDER CONTRACT (v4): the action runs a SINGLE model, selected by three flat
// inputs — PROVIDER ("openrouter" | "deepseek"), MODEL_ID, and API_KEY. The old
// multi-provider PROVIDERS array and the legacy OPENROUTER_API_KEY/MODEL inputs (plus
// the MERGE_STRATEGY/FALLBACK_MODEL/REVIEW_MODE/ENFORCE_JSON_SCHEMA no-ops) were removed
// in v4 — a breaking change. PROVIDER defaults to "openrouter"; MODEL_ID defaults per
// provider (see llm/providers.ts defaultModelFor); an unsupported PROVIDER or an empty
// API_KEY throws so a misconfig fails loud instead of silently abstaining.
import * as core from "@actions/core";
import {
  type ProviderId,
  SUPPORTED_PROVIDERS,
  isSupportedProvider,
  defaultModelFor,
} from "./llm/providers.js";
import { parseFailOn, type BlockableVerdict } from "./review/gate.js";
import { splitGlobs } from "./git/globs.js";

/** Minimum confidence floor for the validate gate (high|medium). */
export type MinConfidence = "high" | "medium";

/** The fully-resolved, typed inputs the pipeline consumes (no env reads downstream). */
export interface ActionInputs {
  /** Resolved backend provider (PROVIDER | "openrouter"); selects the LLM API. */
  provider: ProviderId;
  /** Effective model id for the provider (MODEL_ID | per-provider default). */
  model: string;
  /** Provider API key (Authorization: Bearer); required, validated non-empty. */
  apiKey: string;
  /** Max completion tokens per request. */
  maxTokens: number;
  /** Confidence floor for keeping findings. */
  minConfidence: MinConfidence;
  /** Always true — the single-model path always enforces the JSON schema. */
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
  /** Ref the convention files are read from: "base" (anti-injection default) or
   *  "merge" (the checked-out PR merge ref — trusted same-repo PRs only). */
  rulesRef: "base" | "merge";
  /** Extra path globs to EXCLUDE from the reviewed diff, on top of the built-in generated/vendored set. */
  excludeGlobs: string[];
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
  /** Per-attempt model deadline in ms before an attempt is aborted and retried (must fit the model). */
  requestTimeoutMs: number;
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
  /** Review rounds after which a blocker-free "changes" verdict surrenders to
   *  "approved" (0 = never; requires reviewMemory for the round count). */
  maxRounds: number;
  /** Verdicts that should fail the job (parsed from FAIL_ON; defaults to blocking on "changes"). */
  failOn: ReadonlySet<BlockableVerdict>;
  /** Comment verbosity: "compact" (default) collapses the checklist and renders recap
   *  buckets as refs; "full" restores the multi-line checklist and recap text. */
  verbosity: "compact" | "full";
}

/**
 * Default completion-token budget — kept in sync with action.yml MAX_TOKENS default.
 * 8192 (not 4096): a single chunk's structured output (review_plan + findings +
 * other_checks) overran 4096 and truncated mid-JSON (finish_reason "length"). This
 * is a cap, billed on actual output, so the headroom is free for small reviews.
 */
const DEFAULT_MAX_TOKENS = 8192;

/**
 * Default per-attempt model deadline (ms) — kept in sync with action.yml
 * REQUEST_TIMEOUT_MS default. 180s, not 60s: the default 1M-context model's
 * structured-output generation on a full chunk routinely runs past a minute, so a
 * 60s deadline aborted most chunks ("This operation was aborted") and abstained.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 180000;

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
 * that would force a provider 400 → silent abstain, so it falls back to
 * {@link DEFAULT_MAX_TOKENS} with a `core.warning` instead of being forwarded.
 * 0 is NOT "unlimited" here — the budget must be positive.
 */
function validateTokenBudget(value: number, source: string): number {
  if (Number.isFinite(value) && value > 0) return value;
  core.warning(
    `${source}=${value} is not a positive token budget; falling back to ${DEFAULT_MAX_TOKENS}.`,
  );
  return DEFAULT_MAX_TOKENS;
}

/**
 * Validate the per-attempt model deadline (ms): a non-positive value (≤0) would abort
 * every attempt instantly (setTimeout(0)) or clamp negative to 1ms, abstaining the whole
 * review — a config typo, never intended. Falls back to {@link DEFAULT_REQUEST_TIMEOUT_MS}
 * with a `core.warning`. 0 is NOT "unlimited" here.
 */
function validateTimeout(value: number, source: string): number {
  if (Number.isFinite(value) && value > 0) return value;
  core.warning(
    `${source}=${value} is not a positive timeout; falling back to ${DEFAULT_REQUEST_TIMEOUT_MS}ms.`,
  );
  return DEFAULT_REQUEST_TIMEOUT_MS;
}

/** Read MIN_CONFIDENCE, defaulting to "high"; only "medium" relaxes the floor. */
function readMinConfidence(): MinConfidence {
  return core.getInput("MIN_CONFIDENCE").trim().toLowerCase() === "medium" ? "medium" : "high";
}

/**
 * Read VERBOSITY, defaulting to "compact"; only an explicit "full" restores the
 * multi-line comment shape. An unrecognized non-empty value is a config typo: warn and
 * fall back to compact rather than silently picking a shape the user did not ask for.
 */
function readVerbosity(): "compact" | "full" {
  const raw = core.getInput("VERBOSITY").trim().toLowerCase();
  if (raw === "" || raw === "compact") return "compact";
  if (raw === "full") return "full";
  core.warning(`VERBOSITY="${raw}" is not "compact" or "full"; falling back to compact.`);
  return "compact";
}

/**
 * Read RULES_REF, defaulting to "base" (convention files read from the base-branch
 * tip, so a PR cannot modify the rules it is reviewed against); only an explicit
 * "merge" reads them from the checked-out PR merge ref instead. An unrecognized
 * non-empty value is a config typo: warn and fall back to base — the injection-safe
 * default — rather than silently widening what a PR can influence.
 */
function readRulesRef(): "base" | "merge" {
  const raw = core.getInput("RULES_REF").trim().toLowerCase();
  if (raw === "" || raw === "base") return "base";
  if (raw === "merge") return "merge";
  core.warning(`RULES_REF="${raw}" is not "base" or "merge"; falling back to base.`);
  return "base";
}

/** Read MIN_TRIGGER_PERMISSION, defaulting to "write"; only "admin" tightens it. */
function readMinTriggerPermission(): "write" | "admin" {
  return core.getInput("MIN_TRIGGER_PERMISSION").trim().toLowerCase() === "admin"
    ? "admin"
    : "write";
}

/**
 * Resolve and validate the PROVIDER input. Defaults to "openrouter" when omitted;
 * THROWS on an advertised-but-unimplemented provider (openai/anthropic/...) so a
 * misconfig fails loud here instead of silently routing through the wrong backend.
 */
function resolveProviderId(raw: string): ProviderId {
  const p = raw.trim().toLowerCase();
  if (p === "") return "openrouter";
  if (!isSupportedProvider(p)) {
    throw new Error(
      `PROVIDER "${p}" is not supported (supported: ${SUPPORTED_PROVIDERS.join(", ")}). ` +
        `To use "${p}" models, set PROVIDER:"openrouter" and MODEL_ID:"${p}/<model>" to route through OpenRouter.`,
    );
  }
  // The `if (!isSupportedProvider(p)) throw` above narrows p to ProviderId on this branch
  // (isSupportedProvider is a `s is ProviderId` type guard), so no cast is needed.
  return p;
}

/** Warn when a deepseek model id looks like an OpenRouter id (slash namespace) — it will 400.
 *  Heuristic: current native DeepSeek ids have no "/"; revisit if that ever changes. */
function warnSuspiciousModel(provider: ProviderId, model: string): void {
  if (provider === "deepseek" && model.includes("/")) {
    core.warning(
      `MODEL_ID "${model}" looks like an OpenRouter id (contains "/") but PROVIDER is "deepseek"; ` +
        'the native DeepSeek API will reject it. Use a native id like "deepseek-v4-flash".',
    );
  }
}

/**
 * Read every action.yml input and resolve it into a typed {@link ActionInputs}.
 *
 * Resolves the flat PROVIDER/MODEL_ID/API_KEY contract: PROVIDER defaults to
 * "openrouter" (unsupported values throw), MODEL_ID defaults per provider, and an
 * empty API_KEY throws (a keyless review would abstain on every call).
 */
export function readInputs(): ActionInputs {
  const provider = resolveProviderId(core.getInput("PROVIDER"));
  const model = core.getInput("MODEL_ID").trim() || defaultModelFor(provider);
  warnSuspiciousModel(provider, model);

  const apiKey = core.getInput("API_KEY").trim();
  if (apiKey === "") {
    throw new Error(`API_KEY is required (the ${provider} API key).`);
  }

  // MAX_TOKENS must be a positive budget; MAX_TOKENS="0"/"-1" is a typo that would
  // 400 → silent abstain, so clamp it to the default with a warning.
  const maxTokens = validateTokenBudget(intInput("MAX_TOKENS", DEFAULT_MAX_TOKENS), "MAX_TOKENS");

  return {
    provider,
    model,
    apiKey,
    maxTokens,
    // The single-model path always enforces the JSON schema; no longer an input.
    enforceJsonSchema: true,
    minConfidence: readMinConfidence(),
    inlineComments: readBool("INLINE_COMMENTS", true),
    manageLabels: readBool("MANAGE_LABELS", true),
    baseBranch: core.getInput("BASE_BRANCH").trim() || "main",
    // Trim: prompt.ts treats only "" as "use default", so an untrimmed whitespace value
    // (a YAML block scalar) would become a bogus prompt path → readFileSync ENOENT crash.
    reviewPromptFile: core.getInput("REVIEW_PROMPT_FILE").trim(),
    codebaseOverview: core.getInput("CODEBASE_OVERVIEW").trim(),
    checkProjectRules: readBool("CHECK_PROJECT_RULES", true),
    rulesGlob: core.getInput("RULES_GLOB"),
    rulesRef: readRulesRef(),
    excludeGlobs: splitGlobs(core.getInput("EXCLUDE_GLOBS")),
    rulesMaxBytes: intInput("RULES_MAX_BYTES", 32768),
    maxFiles: intInput("MAX_FILES", 0),
    maxRounds: Math.max(0, intInput("MAX_ROUNDS", 0)),
    maxDiffLines: intInput("MAX_DIFF_LINES", 0),
    maxChunkLines: intInput("MAX_CHUNK_LINES", 1500),
    maxChunks: intInput("MAX_CHUNKS", 20),
    requestTimeoutMs: validateTimeout(
      intInput("REQUEST_TIMEOUT_MS", DEFAULT_REQUEST_TIMEOUT_MS),
      "REQUEST_TIMEOUT_MS",
    ),
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
    failOn: parseFailOn(core.getInput("FAIL_ON") || "changes"),
    verbosity: readVerbosity(),
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
