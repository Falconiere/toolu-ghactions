// pipeline/reviewCall.ts — the model-facing phase of a review run: gather the
// trusted context (project rules, deterministic SARIF findings, the bot's prior
// threads), run the four review layers, then validate + fingerprint-stamp the
// findings. Split out of pipeline.ts so the orchestrator stays lean.
//
// LAYER ORDER (spec §Architecture), all wired here:
//   0. distill()  — deterministic, zero-token: strata, pattern groups, and a
//      SHRUNK review diff (src/git/distill.ts). Runs BEFORE any model call.
//   1. mapPr()    — one small, fail-open cartographer call over the MANIFEST
//      (never diff text) yielding the shared brief (src/review/cartographer.ts).
//      It goes through reviewWithModel's RAW-JSON mode: the brief does not fit the
//      Verdict schema (whose `other_checks` caps at 600 chars) and enforcing it
//      would silently truncate the brief away.
//   2. reviewChunked() — bounded package reviewers, packaged from the brief's
//      hints (src/pipeline/packages.ts) with the module-coupling fallback.
// Every path either layer touched lands in the coverage ledger (spec §Coverage
// ledger), which is this phase's other output: publish() renders it, degrades a
// would-be approval from it, and carries findings forward on it.
import { gatherRules } from "@/rules.js";
import { buildPrompt } from "@/prompt.js";
import type { PriorThreadContext } from "@/prompt.js";
import { gatherMechanical } from "@/mechanical/gather.js";
import type { MechanicalFinding } from "@/mechanical/sarif.js";
import { reviewWithModel } from "@/llm/reviewWithModel.js";
import type { ProviderResult, ReviewOptions } from "@/llm/reviewWithModel.js";
import type { Finding } from "@/llm/schema.js";
import { reviewChunked } from "@/review/chunked.js";
import { validateFindings } from "@/review/validate.js";
import { distill, type Distillation } from "@/git/distill.js";
import { mapPr, type Brief } from "@/review/cartographer.js";
import { buildRoundLedger, type CoverageEntry, type CoverageLedger } from "@/review/ledger.js";
import { splitGlobs } from "@/git/globs.js";
import { fingerprint } from "@/state.js";
import type { DiffData } from "@/git/diff.js";
import type { PriorThread } from "@/github/threads.js";
import type { EventResolution } from "@/github/event.js";
import type { ActionInputs } from "@/inputs.js";
import { resolveChecklistPath } from "./bodies.js";
import { groupByBrief } from "./packages.js";
import { readFileAt } from "./git.js";

/** A validated finding with its state fingerprint attached. */
export type StampedFinding = Finding & { fp: string };

/**
 * Path globs whose changed files make the BASE-ref project rules stale — the
 * tiers `gatherRules` reads (src/rules.ts), expressed as globs. `*` matches any
 * run INCLUDING `/` (git/globs.ts), so `*CLAUDE.md` covers both the root file and
 * every nested one. Used ONLY to compute `rules_changed` for the trusted
 * rules-changed notice; the user's own RULES_GLOB is appended by
 * {@link rulesPathGlobs}.
 */
const RULES_PATH_GLOBS: readonly string[] = [
  "*CLAUDE.md",
  "*AGENTS.md",
  ".cursorrules",
  ".windsurfrules",
  ".github/copilot-instructions.md",
  ".cursor/rules/**",
  ".windsurf/rules/**",
  "CONVENTIONS.md",
  "CONTRIBUTING.md",
  "docs/conventions/**",
];

/** What {@link reviewAndValidate} needs from the run in flight. */
export interface ReviewCallInput {
  inputs: ActionInputs;
  /** The diff to review — already narrowed to this round's tree scope (pipeline/scope.ts). */
  diff: DiffData;
  event: EventResolution;
  priorThreads: PriorThread[];
  reviewHead: string;
  cwd: string;
  sarifDir?: string | undefined;
  fetch?: typeof fetch | undefined;
  /** The PR title, UNTRUSTED — sanitized+fenced by the cartographer (Layer 1). */
  prTitle?: string;
  /** The PR body, UNTRUSTED — sanitized+fenced by the cartographer (Layer 1). */
  prBody?: string;
  /** Changed paths dropped from `diff` by the tree scope: not reviewed this round,
   *  ledgered `carried` so their prior findings survive (spec §Carry-forward). */
  carriedPaths?: readonly string[];
  /** Epoch-ms wall deadline (MAX_WALL_MS, run start + budget), or undefined when
   *  the budget is off. Threaded straight into `reviewChunked` — see chunked.ts. */
  wallDeadline?: number;
}

/** The model phase's output: the raw result, validated+stamped findings, the
 *  mechanical findings (re-used by the verdict comment's summary), the round's
 *  coverage ledger, and the brief (null when Layer 1 failed open). */
export interface ReviewCallOutput {
  result: ProviderResult;
  stamped: StampedFinding[];
  mechanical: MechanicalFinding[];
  ledger: CoverageLedger;
  brief: Brief | null;
}

/**
 * Map the bot's prior threads to the prompt's context block: accept-or-argue for
 * still-live threads, DISMISSED (settled, do not re-raise or reword) for those the
 * author resolved on GitHub or dismissed in a reply (see review/dismissal.ts).
 */
export function buildThreadContexts(priorThreads: PriorThread[]): PriorThreadContext[] {
  return priorThreads.map((t) => ({
    path: t.path,
    line: t.line,
    finding: cleanFindingBody(t.rootBody),
    replies: t.replies,
    resolved: t.isResolved,
    ...(t.dismissal !== undefined ? { dismissal: t.dismissal } : {}),
  }));
}

/** Strip the hidden fp marker and any ```suggestion block from a stored finding body,
 *  leaving the human-readable finding text for the accept-or-argue prompt block. */
export function cleanFindingBody(body: string): string {
  return body
    .replace(/<!-- toolu-fp:[0-9a-f]+ -->/g, "")
    .replace(/```suggestion[\s\S]*?```/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Run the model review for the diff (chunking when it exceeds the per-chunk
 * budget — see review/chunked.ts), then validate findings against the diff's
 * changed lines (anti-hallucination, confidence gate, suggestion strip, dedup)
 * and stamp each survivor with its state fingerprint. On an error abstain the
 * validation runs over the (empty) findings — the flow stays uniform.
 */
export async function reviewAndValidate(input: ReviewCallInput): Promise<ReviewCallOutput> {
  const { inputs, diff, event, cwd, reviewHead } = input;

  // Project rules ONCE (best-effort, never throws): from the base ref by default
  // (anti rule-injection), or the PR merge ref when RULES_REF=merge (trusted).
  const projectRules = gatherRules({
    check: inputs.checkProjectRules,
    baseSha: diff.base_sha,
    rulesRef: inputs.rulesRef,
    mergeRef: reviewHead,
    changedFiles: diff.changed_files,
    rulesGlob: inputs.rulesGlob,
    maxBytes: inputs.rulesMaxBytes,
    cwd,
  });

  // Deterministic findings (gitleaks/opengrep SARIF); absent dir → [].
  const mechanical = gatherMechanical(input.sarifDir);
  const priorThreadContexts = buildThreadContexts(input.priorThreads);

  // Layer 0 — deterministic distillation. `review_diff` is the shrunk diff every
  // model call below reads; `changed_files` on it stays the FULL list (distill.ts),
  // so the prompt and the ledger still describe the whole change.
  const distillation = distill(diff, { rulesPaths: rulesPathGlobs(inputs), cwd });

  // Nothing left for a model to read: every in-scope path was carried out of scope,
  // collapsed into a pattern exemplar, or is a non-reviewable stratum. Skip Layers 1
  // and 2 — an empty-diff call costs a request and can only hallucinate — and let the
  // ledger account for the round. `publish()` will not let this approve away findings
  // carried from earlier rounds (nothing was re-reviewed, so nothing was cleared).
  if (distillation.review_diff.total_files === 0) {
    return {
      result: { verdict: "approved", findings: [] },
      stamped: [],
      mechanical,
      ledger: roundLedger(input, distillation, new Map()),
      brief: null,
    };
  }

  // Layer 1 — the cartographer. Fail-open: a null brief just means no brief block.
  const brief = await mapPr({
    manifest: distillation.manifest,
    patternGroups: distillation.pattern_groups,
    rulesChanged: distillation.rules_changed,
    prTitle: input.prTitle ?? "",
    prBody: input.prBody ?? "",
    review: (envelope) => reviewWithModel(envelope, { ...modelOptions(input), rawJson: true }),
  });

  // Layer 2 — bounded package reviewers over the shrunk diff.
  const coverage = new Map<string, CoverageEntry>();
  const result: ProviderResult = await reviewChunked({
    diff: distillation.review_diff,
    maxChunkLines: inputs.maxChunkLines,
    maxChunks: inputs.maxChunks,
    mechanical,
    brief,
    onCoverage: (path, entry) => coverage.set(path, entry),
    wallDeadline: input.wallDeadline,
    groupSegments: (segments) => groupByBrief(segments, brief, inputs.maxChunkLines),
    buildEnvelope: (subDiff, chunkMechanical, chunkBrief) =>
      buildPrompt({
        diff: subDiff,
        checklistPath: resolveChecklistPath(),
        maxTokens: inputs.maxTokens,
        enforceJsonSchema: inputs.enforceJsonSchema,
        reviewPromptFile: inputs.reviewPromptFile,
        codebaseOverview: inputs.codebaseOverview,
        reviewInstruction: event.instruction ?? "",
        projectRules,
        githubWorkspace: cwd,
        mechanicalFindings: chunkMechanical,
        priorThreads: priorThreadContexts,
        ...(chunkBrief !== null ? { brief: chunkBrief } : {}),
        rulesChanged: distillation.rules_changed,
      }),
    review: (envelope) => reviewWithModel(envelope, modelOptions(input)),
    readFile: readFileAt(reviewHead, cwd),
  });

  // Findings are validated against the SHRUNK diff: a finding on a path the model
  // never saw (a collapsed pattern member, a dropped stratum) is a hallucination
  // by construction — pattern findings are reported once, on the exemplar.
  const stamped = validate(result, distillation.review_diff, inputs);
  return { result, stamped, mechanical, ledger: roundLedger(input, distillation, coverage), brief };
}

/** This round's coverage ledger: Layer 0's strata, overridden by Layer 2's per-path
 *  outcomes, plus the excluded and carried buckets (see review/ledger.ts). */
function roundLedger(
  input: ReviewCallInput,
  distillation: Distillation,
  coverage: ReadonlyMap<string, CoverageEntry>,
): CoverageLedger {
  return buildRoundLedger({
    changedFiles: input.diff.changed_files,
    binaryFiles: input.diff.binary_files,
    droppedFiles: input.diff.dropped_files,
    strata: distillation.strata,
    exemplars: new Set(distillation.pattern_groups.map((g) => g.exemplar)),
    coverage,
    carried: input.carriedPaths ?? [],
  });
}

/** The provider options every model call in this phase shares. */
function modelOptions(input: ReviewCallInput): ReviewOptions {
  return {
    provider: input.inputs.provider,
    model: input.inputs.model,
    apiKey: input.inputs.apiKey,
    timeoutMs: input.inputs.requestTimeoutMs,
    ...(input.fetch ? { fetch: input.fetch } : {}),
  };
}

/** The globs whose changed files make the base-ref rules stale: the tiers
 *  `gatherRules` reads plus the user's RULES_GLOB — empty when rule checking is
 *  off, since there are then no base-ref rules for a diff to invalidate. */
function rulesPathGlobs(inputs: ActionInputs): string[] {
  if (!inputs.checkProjectRules) return [];
  return [...RULES_PATH_GLOBS, ...splitGlobs(inputs.rulesGlob)];
}

/** Validate findings against the diff's changed lines and stamp fingerprints. */
function validate(result: ProviderResult, diff: DiffData, inputs: ActionInputs): StampedFinding[] {
  const changedLinesByPath = new Map<string, number[]>(
    diff.files.map((f) => [f.path, f.changed_lines]),
  );
  const lineTextByPath = new Map<string, Map<number, string>>(
    diff.files.map((f) => [
      f.path,
      new Map(Object.entries(f.line_text).map(([n, text]) => [Number(n), text])),
    ]),
  );
  const anchored = validateFindings(
    result.findings,
    changedLinesByPath,
    inputs.minConfidence,
    lineTextByPath,
  );
  return anchored.map((f) => ({ ...f, fp: fingerprint(f) }));
}
