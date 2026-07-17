// pipeline/reviewCall.ts — the model-facing phase of a review run: gather the
// trusted context (project rules, deterministic SARIF findings, the bot's prior
// threads), build the prompt envelope per chunk, run the (possibly chunked)
// review, then validate + fingerprint-stamp the findings. Split out of
// pipeline.ts so the orchestrator stays lean.
import { gatherRules } from "@/rules.js";
import { buildPrompt } from "@/prompt.js";
import type { PriorThreadContext } from "@/prompt.js";
import { gatherMechanical } from "@/mechanical/gather.js";
import type { MechanicalFinding } from "@/mechanical/sarif.js";
import { reviewWithModel } from "@/llm/reviewWithModel.js";
import type { ProviderResult } from "@/llm/reviewWithModel.js";
import type { Finding } from "@/llm/schema.js";
import { reviewChunked } from "@/review/chunked.js";
import { validateFindings } from "@/review/validate.js";
import { fingerprint } from "@/state.js";
import type { DiffData } from "@/git/diff.js";
import type { PriorThread } from "@/github/threads.js";
import type { EventResolution } from "@/github/event.js";
import type { ActionInputs } from "@/inputs.js";
import { resolveChecklistPath } from "./bodies.js";
import { readFileAt } from "./git.js";

/** A validated finding with its state fingerprint attached. */
export type StampedFinding = Finding & { fp: string };

/** What {@link reviewAndValidate} needs from the run in flight. */
export interface ReviewCallInput {
  inputs: ActionInputs;
  diff: DiffData;
  event: EventResolution;
  priorThreads: PriorThread[];
  reviewHead: string;
  cwd: string;
  sarifDir?: string | undefined;
  fetch?: typeof fetch | undefined;
}

/** The model phase's output: the raw result, validated+stamped findings, and
 *  the mechanical findings (re-used by the verdict comment's summary). */
export interface ReviewCallOutput {
  result: ProviderResult;
  stamped: StampedFinding[];
  mechanical: MechanicalFinding[];
}

/**
 * Map the bot's prior threads to the prompt's context block: accept-or-argue
 * for open threads, DISMISSED (settled, do not re-raise or reword) for resolved.
 */
export function buildThreadContexts(priorThreads: PriorThread[]): PriorThreadContext[] {
  return priorThreads.map((t) => ({
    path: t.path,
    line: t.line,
    finding: cleanFindingBody(t.rootBody),
    replies: t.replies,
    resolved: t.isResolved,
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

  const result: ProviderResult = await reviewChunked({
    diff,
    maxChunkLines: inputs.maxChunkLines,
    maxChunks: inputs.maxChunks,
    mechanical,
    buildEnvelope: (subDiff, chunkMechanical) =>
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
      }),
    review: (envelope) =>
      reviewWithModel(envelope, {
        provider: inputs.provider,
        model: inputs.model,
        apiKey: inputs.apiKey,
        timeoutMs: inputs.requestTimeoutMs,
        ...(input.fetch ? { fetch: input.fetch } : {}),
      }),
    readFile: readFileAt(reviewHead, cwd),
  });

  const stamped = validate(result, diff, inputs);
  return { result, stamped, mechanical };
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
