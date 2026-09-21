// Baseline package review and validation, followed by optional deadline-bounded Jev work.
import { enhance, enhancementNote } from "@/jev/enhance.js";
import { capturePackages } from "@/jev/packages.js";
import { gatherRules } from "@/rules.js";
import { buildPrompt } from "@/prompt.js";
import { buildThreadContexts } from "./threadContext.js";
export { buildThreadContexts, cleanFindingBody } from "./threadContext.js";
import { gatherMechanical } from "@/mechanical/gather.js";
import type { MechanicalFinding } from "@/mechanical/sarif.js";
import { reviewWithModel } from "@/llm/reviewWithModel.js";
import type { ProviderResult, ReviewOptions } from "@/llm/reviewWithModel.js";
import type { Finding } from "@/llm/schema.js";
import { reviewChunked } from "@/review/chunked.js";
import { validate } from "./validate.js";
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
import { createRepositoryContext } from "@/review/repositoryContext.js";
import { dropSettled } from "@/review/reconcile.js";
import { clusterFindings } from "@/review/cluster.js";

/** A validated finding with its state fingerprint attached. */
export type StampedFinding = Finding & { fp: string };

/** Built-in rule paths used to detect a potentially stale base-ref convention. */
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
  priorClusters?: Record<string, string>;
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
  settledBeforeValidation: number;
  result: ProviderResult;
  stamped: StampedFinding[];
  /** Count of findings `validateFindings` dropped as self-negating ("No issue"
   *  chatter) — carried to `PublishInput` and on into `settleVerdict`'s `removed`
   *  (pipeline/settle.ts), so an all-junk review still flips to "approved". */
  selfNegating: number;
  mechanical: MechanicalFinding[];
  ledger: CoverageLedger;
  brief: Brief | null;
}

/** Review and validate the complete baseline before optional enhancement work. */
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
      selfNegating: 0,
      settledBeforeValidation: 0,
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
  const repositoryContext = createRepositoryContext(reviewHead, cwd);
  const captured = capturePackages(inputs.jevEnabled === true);
  const result: ProviderResult = await reviewChunked({
    diff: distillation.review_diff,
    maxChunkLines: inputs.maxChunkLines,
    maxChunks: inputs.maxChunks,
    mechanical,
    brief,
    onCoverage: (path, entry) => coverage.set(path, entry),
    wallDeadline: input.wallDeadline,
    groupSegments: (segments) => groupByBrief(segments, brief, inputs.maxChunkLines),
    buildEnvelope: (subDiff, chunkMechanical, chunkBrief) => {
      const context = repositoryContext(subDiff.changed_files, subDiff.diff);
      return captured.capture(
        buildPrompt({
          diff: subDiff,
          repositoryContext: context,
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
        subDiff,
        context,
        projectRules,
      );
    },
    review: (envelope) => captured.review(envelope, (e) => reviewWithModel(e, modelOptions(input))),
    readFile: readFileAt(reviewHead, cwd),
  });

  // Suppress settled claims before validating against the exact reviewed diff.
  const clusters = clusterFindings(
    result.findings.map((f) => ({ ...f, fp: fingerprint(f) })),
    input.priorClusters,
  );
  const settled = dropSettled(
    clusters.map((c) => c.exemplar),
    input.priorThreads,
    {
      members: new Map(clusters.map((c) => [c.exemplar.fp, c.members])),
      priorClusters: input.priorClusters,
    },
  );
  const keptFps = new Set(settled.kept.map((f) => f.fp));
  const kept = clusters.filter((c) => keptFps.has(c.exemplar.fp)).flatMap((c) => c.members);
  const settledBeforeValidation = result.findings.length - kept.length;
  if (settledBeforeValidation > 0) {
    process.stdout.write(
      `  Suppressed ${settledBeforeValidation} settled finding(s) before source validation\n`,
    );
  }
  result.findings = kept;
  const { stamped, selfNegating, unsupportedPaths } = validate(
    result,
    distillation.review_diff,
    inputs,
  );
  // A rejected quote condemns its path only when NOTHING of the model's work on that
  // path survived. A file the model read and reported on — two findings anchored and
  // quoted, one mis-quoted and dropped — was reviewed; calling it "unreviewed" over the
  // dropped one is false, and via settleVerdict's degradeOnCoverage that single bad
  // quote would turn the whole review into a "Review incomplete" error verdict.
  const pathsWithSurvivors = new Set(stamped.map((f) => f.path));
  const condemned = unsupportedPaths.filter((path) => !pathsWithSurvivors.has(path));
  for (const path of condemned) {
    coverage.set(path, { status: "unreviewed", reason: "unsupported-source-evidence" });
  }
  // Report incomplete evidence only for paths with no surviving finding.
  if (condemned.length > 0) {
    const evidenceError =
      "Review findings lacked valid source evidence; affected files remain unreviewed.";
    result.error = [result.error, evidenceError].filter(Boolean).join(" ");
    result.failure ??= "evidence";
    result.partial = true;
    if (stamped.length === 0) result.verdict = "error";
  }
  const ledger = roundLedger(input, distillation, coverage);
  const enhanced = await enhance({
    enabled: inputs.jevEnabled === true,
    model: inputs.jevModel ?? "typesafe/jev-1.13",
    options: modelOptions(input),
    packages: captured.completed(),
    findings: stamped,
    diff: distillation.review_diff,
    minConfidence: inputs.minConfidence,
    complete:
      result.verdict !== "error" &&
      !result.partial &&
      !diff.truncated &&
      Object.values(ledger.entries).every(
        (entry) => entry.status !== "unreviewed" && entry.status !== "pending",
      ),
  });
  if (enhanced.changesRequested && result.verdict === "approved") result.verdict = "changes";
  if (enhanced.summary) {
    result.enhancement = enhanced.summary;
    process.stdout.write(`  ${enhancementNote(enhanced.summary)}\n`);
    for (const metadata of enhanced.summary.assessments)
      process.stdout.write(`  Jev metadata: ${JSON.stringify(metadata)}\n`);
  }
  return {
    result,
    stamped: enhanced.findings,
    selfNegating,
    settledBeforeValidation,
    mechanical,
    ledger,
    brief,
  };
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

/** The model options every model call in this phase shares. */
function modelOptions(input: ReviewCallInput): ReviewOptions {
  return {
    model: input.inputs.model,
    apiKey: input.inputs.apiKey,
    timeoutMs: input.inputs.requestTimeoutMs,
    wallDeadline: input.wallDeadline,
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
