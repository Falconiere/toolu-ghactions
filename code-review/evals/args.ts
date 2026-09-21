// evals/args.ts — CLI argument parsing + usage text for the eval harness
// (evals/run.ts, AC-16). Pure and side-effect-free: given argv, returns a typed
// EvalArgs or throws ArgError — no env reads, no I/O, so `--help` and bad-flag
// tests never need a key, gh, or a network.
import {
  DEFAULT_MODEL,
  PROVIDER_ID,
  canonicalProviderId,
  type ProviderId,
} from "@/llm/providers.js";

/** The default PR the harness targets when `--pr` is omitted (spec §Eval harness). */
export const DEFAULT_PR = "Falconiere/comemory#72";

/** The resolved, typed CLI arguments (whatever `--help` needs to short-circuit
 *  on is filled with harmless placeholders — callers check `help` FIRST). */
export interface EvalArgs {
  help: boolean;
  compareJev?: boolean;
  baseSha?: string;
  headSha?: string;
  expectations?: string;
  owner: string;
  repo: string;
  prNumber: number;
  provider: ProviderId;
  model: string;
  maxWallMs: number;
  out: string | null;
}

/** A malformed flag or value — the CLI's own fault, not an infra failure. */
export class ArgError extends Error {}

/** `owner/repo#123` -> its three parts. Throws {@link ArgError} on any other
 *  shape, including a PR number below 1 (`#0` is not a valid PR). */
export function parsePrRef(ref: string): { owner: string; repo: string; prNumber: number } {
  const m = ref.match(/^([^/\s#]+)\/([^#\s]+)#(\d+)$/);
  const prNumber = m === null ? 0 : Number(m[3] ?? "0");
  if (!m || prNumber < 1) {
    throw new ArgError(`--pr must look like "owner/repo#123" (got "${ref}").`);
  }
  const owner = m[1] ?? "";
  const repo = m[2] ?? "";
  return { owner, repo, prNumber };
}

/** The `--help` usage text — printed verbatim, no key/network required to see it. */
export function usage(): string {
  return `Usage: bun evals/run.ts [options]
Also: bun run eval -- [options]

Runs the size-proof review pipeline (distill -> cartographer -> chunked ->
cluster -> render) against a REAL pull request, with a REAL model call, but
WITHOUT posting to GitHub (a recording Octokit fake stands in) — then prints
an AC-16 scorecard. Requires the API_KEY env var and the \`gh\` CLI, authenticated,
on PATH.

Options:
  --pr <owner/repo#number>   PR to review (default: ${DEFAULT_PR})
  --provider <id>            "${PROVIDER_ID}" — the only supported backend
                              (default: openrouter)
  --model <id>                OpenRouter model id (default: the action's own
                              ${DEFAULT_MODEL})
  --max-wall-ms <ms>          Soft wall-clock budget forwarded to MAX_WALL_MS
                              (default: 0 = off)
  --compare-jev              Paired baseline/enhanced review of one exact Git tree
  --base-sha <sha>            Pin comparison base revision
  --head-sha <sha>            Pin comparison head revision
  --expectations <file>       Labeled known defects/false positives (JSON)
  --out <file>                Also write the scorecard as JSON to this path
  --help, -h                  Print this usage and exit 0 (no key/network needed)

Env:
  API_KEY                     Required for a live run: the OpenRouter API key.

Example:
  API_KEY=sk-or-... bun run eval -- --pr Falconiere/comemory#72 \\
    --provider openrouter --model deepseek/deepseek-v4-pro
`;
}

/** Read the next argv slot as a flag's value, or throw a clear ArgError. A
 *  value starting with "--" is treated as the NEXT flag, not this one's value
 *  (so `--pr --provider openrouter` reports `--pr` as missing its value instead
 *  of silently swallowing "--provider" as the PR ref). */
function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new ArgError(`${flag} requires a value.`);
  }
  return value;
}

/** Read the next argv slot as a non-negative integer, or throw a clear
 *  ArgError. Requires the raw text to be ALL digits (`/^\d+$/`) — `parseInt`
 *  alone would silently accept a trailing-garbage value like "12abc" as 12. */
function requireInt(argv: readonly string[], index: number, flag: string): number {
  const raw = requireValue(argv, index, flag);
  if (!/^\d+$/.test(raw)) {
    throw new ArgError(`${flag} must be a non-negative integer (got "${raw}").`);
  }
  return Number.parseInt(raw, 10);
}

/**
 * Parse argv into {@link EvalArgs}. `--help`/`-h` short-circuits: every other
 * flag is still parsed (so a typo'd flag next to `--help` is still caught), but
 * PR-ref validation is skipped so `--help` alone never needs `--pr` to be valid.
 */
export function parseArgs(argv: readonly string[]): EvalArgs {
  let prRef = DEFAULT_PR;
  let provider: ProviderId = PROVIDER_ID;
  let model: string | null = null;
  let maxWallMs = 0;
  let out: string | null = null;
  let help = false;
  let compareJev = false;
  let baseSha: string | undefined;
  let headSha: string | undefined;
  let expectations: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        help = true;
        break;
      case "--compare-jev":
        compareJev = true;
        break;
      case "--base-sha":
        baseSha = requireValue(argv, ++i, "--base-sha");
        break;
      case "--head-sha":
        headSha = requireValue(argv, ++i, "--head-sha");
        break;
      case "--expectations":
        expectations = requireValue(argv, ++i, "--expectations");
        break;
      case "--pr":
        prRef = requireValue(argv, ++i, "--pr");
        break;
      case "--provider": {
        const raw = requireValue(argv, ++i, "--provider");
        const id = canonicalProviderId(raw);
        if (id === undefined) {
          throw new ArgError(
            `--provider "${raw}" is not supported (${PROVIDER_ID}). ` +
              `Route a vendor's models through OpenRouter with --model "${raw}/<model>".`,
          );
        }
        provider = id;
        break;
      }
      case "--model":
        model = requireValue(argv, ++i, "--model");
        break;
      case "--max-wall-ms":
        maxWallMs = requireInt(argv, ++i, "--max-wall-ms");
        break;
      case "--out":
        out = requireValue(argv, ++i, "--out");
        break;
      default:
        throw new ArgError(`Unrecognized argument "${arg}" — see --help.`);
    }
  }

  const comparison = compareJev ? { compareJev, baseSha, headSha, expectations } : {};
  const resolvedModel = model ?? DEFAULT_MODEL;
  if (help) {
    return {
      ...comparison,
      help: true,
      owner: "",
      repo: "",
      prNumber: 0,
      provider,
      model: resolvedModel,
      maxWallMs,
      out,
    };
  }
  const { owner, repo, prNumber } = parsePrRef(prRef);
  return {
    ...comparison,
    help: false,
    owner,
    repo,
    prNumber,
    provider,
    model: resolvedModel,
    maxWallMs,
    out,
  };
}
