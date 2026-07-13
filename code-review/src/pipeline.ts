// pipeline.ts — orchestrate one code-review run, replicating main.sh's flow with
// the ported TS modules. Every boundary (octokit, the GitHub event context, the
// LLM fetch, the repo cwd, the clock) is injected through `deps` so the pipeline
// runs end-to-end in tests with NO network and NO process.env reads.
//
// FLOW (main.sh order): resolve event → skip on non-trigger → fetch diff →
// skip/empty handling → read prior sticky (review memory) → post in-progress →
// gather rules → build prompt → review → validate → diff state → render recap →
// format verdict → post comment + label + inline review → return outputs.
//
// ERROR ABSTAIN: a verdict:"error" ProviderResult is NOT an infra failure — we
// format it (request-changes label, "provider error" badge), post it, return
// normally. The job stays green; main.ts decides the exit code.
import { execFileSync } from "node:child_process";
import { fetchDiff } from "./git/diff.js";
import { gatherRules } from "./rules.js";
import { buildPrompt } from "./prompt.js";
import { gatherMechanical } from "./mechanical/gather.js";
import { reviewWithModel } from "./llm/reviewWithModel.js";
import type { ProviderResult } from "./llm/reviewWithModel.js";
import { reviewChunked } from "./review/chunked.js";
import { validateFindings } from "./review/validate.js";
import { renderRecapSection, renderHistorySection } from "./review/recap.js";
import { formatVerdict, resolveVerdict } from "./review/verdict.js";
import { decodeMarker, diffState, encodeMarker, fingerprint } from "./state.js";
import type { ReviewState } from "./state.js";
import { resolveEvent } from "./github/event.js";
import type { EventResolution } from "./github/event.js";
import { findSticky, upsertComment } from "./github/comment.js";
import type { CommentTarget } from "./github/comment.js";
import { postInlineReview } from "./github/review.js";
import type { ReviewTarget } from "./github/review.js";
import { fetchReviewThreads, resolveThread, replyToThread } from "./github/threads.js";
import type { PriorThread } from "./github/threads.js";
import { dropResolved, reconcile } from "./review/reconcile.js";
import { setVerdictLabel } from "./github/label.js";
import type { LabelTarget } from "./github/label.js";
import {
  jobUrl,
  skipBody,
  noopBody,
  inProgressBody,
  resolveChecklistPath,
  formatDuration,
} from "./pipeline/bodies.js";
import type { GithubContext, PipelineOctokit, ReviewDeps, ReviewResult } from "./pipeline/types.js";

// Re-export the public pipeline types so callers keep importing from "./pipeline.js".
export type { GithubContext, PipelineOctokit, ReviewDeps, ReviewResult };

/** Run `git` and return trimmed stdout, or null on non-zero exit (the `|| true` idiom). */
function gitOrNull(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 1024,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Run the full review pipeline for one event, replaying main.sh end to end
 * against the injected boundaries. A non-trigger event or an empty/over-limit
 * diff returns a "skip" verdict (still posting the skip/approved comment, as the
 * bash does); a provider "error" verdict is posted and returned normally
 * (abstain). Only a genuine infra failure (diff resolution, comment-post) throws.
 */
export async function runReview(deps: ReviewDeps): Promise<ReviewResult> {
  const { inputs, octokit, context } = deps;
  const cwd = deps.cwd ?? process.cwd();
  const now = deps.now ?? Date.now;
  const startMs = now();
  const skip = (): ReviewResult => ({ verdict: "skip", findingsCount: 0, commentUrl: "" });

  // --- Resolve the triggering event (pull_request, or an @mention). ---
  const event: EventResolution = await resolveEvent(
    { eventName: context.eventName, payload: context.payload },
    {
      triggerPhrase: inputs.triggerPhrase,
      minTriggerPermission: inputs.minTriggerPermission,
      ...(deps.lookupPermission ? { lookupPermission: deps.lookupPermission } : {}),
      ...(deps.lookupBaseRef ? { lookupBaseRef: deps.lookupBaseRef } : {}),
    },
  );
  if (!event.run) {
    process.stderr.write(`[SKIP] Not triggering a review: ${event.reason ?? "not-triggered"}\n`);
    return skip();
  }

  const prNumber = event.pr_number;
  if (prNumber === undefined) {
    process.stderr.write("[SKIP] No PR number resolved from the event\n");
    return skip();
  }
  const target: CommentTarget & ReviewTarget & LabelTarget = {
    owner: context.repo.owner,
    repo: context.repo.repo,
    prNumber,
    headSha: "", // filled after the diff resolves the review head sha.
  };

  const reviewHead = event.review_head ?? "HEAD";
  const baseBranch = event.base_ref && event.base_ref !== "" ? event.base_ref : inputs.baseBranch;
  const fullReview = event.full_review;

  // --- Fetch diff (throws DiffResolutionError on an unresolvable base). ---
  const diff = fetchDiff({
    baseBranch,
    maxFiles: inputs.maxFiles,
    maxDiffLines: inputs.maxDiffLines,
    excludeGlobs: inputs.excludeGlobs,
    reviewHead,
    githubBaseRef: baseBranch,
    cwd,
  });

  // MAX_FILES skip signal: post a skip comment, return skip.
  if (diff.error !== undefined) {
    process.stderr.write(`[SKIP] ${diff.error}\n`);
    const url = await upsertComment(octokit, target, skipBody(context, diff.error), undefined);
    return { verdict: "skip", findingsCount: 0, commentUrl: url };
  }

  // No file changes: post the approved no-op comment + label, return skip.
  if (diff.total_files === 0) {
    process.stderr.write("[SKIP] No file changes to review\n");
    const url = await upsertComment(octokit, target, noopBody(context), undefined);
    await setVerdictLabel(octokit, "approved", target, { manageLabels: inputs.manageLabels });
    return { verdict: "skip", findingsCount: 0, commentUrl: url };
  }

  // --- Locate the prior sticky ALWAYS (independent of memory): its id drives the
  // upsert dedup, so a pre-existing sticky is updated in place, not duplicated each
  // run. DECODE its marker into `prior` only when memory is on. Best-effort. ---
  let prior: ReviewState | null = null;
  let stickyId: number | undefined;
  const sticky = await findSticky(octokit, target).catch(() => null);
  if (sticky) {
    stickyId = sticky.id;
    if (inputs.reviewMemory) prior = asReviewState(decodeMarker(sticky.body));
  }

  // --- In-progress comment (best-effort: a failure must not abort the review). ---
  try {
    stickyId = await captureUpsertId(octokit, target, inProgressBody(context), stickyId, prNumber);
  } catch {
    process.stderr.write("  Warning: could not post in-progress comment\n");
  }

  // --- Fetch the bot's prior inline review threads (best-effort, never throws). These
  // drive accept-or-argue (the author's replies go into the prompt), dedup/resolve, AND
  // resolved-thread suppression of the verdict, so a re-review reacts to what the author
  // SAID and DID instead of blindly re-raising every finding. Fetched even with inline
  // comments off: threads from earlier inline-enabled runs must still suppress. ---
  const priorThreads: PriorThread[] = await fetchReviewThreads(octokit, target);

  // --- Resolve the head SHA the review/state anchors to. ---
  const headSha = resolveHeadSha(reviewHead, context.sha, cwd);
  target.headSha = headSha;

  // --- Gather project rules ONCE (best-effort, never throws): from the base ref
  // by default (anti rule-injection), or from the checked-out PR merge ref when
  // RULES_REF=merge (trusted same-repo PRs whose convention edits should apply). ---
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

  // --- Deterministic findings (gitleaks/opengrep SARIF the composite steps wrote).
  // Fed to the LLM as triage context AND summarized in the comment; absent dir → []. ---
  const mechanical = gatherMechanical(deps.sarifDir);

  // Map the prior threads to the prompt's context: accept-or-argue for open
  // threads, DISMISSED (settled, do not re-raise or reword) for resolved ones.
  const priorThreadContexts = priorThreads.map((t) => ({
    path: t.path,
    line: t.line,
    finding: cleanFindingBody(t.rootBody),
    replies: t.replies,
    resolved: t.isResolved,
  }));

  // --- Build the prompt + run the review, chunking the diff when it exceeds the
  // per-chunk budget (a large diff would otherwise overwhelm one structured-output
  // call and abstain). A within-budget diff stays a single call. See review/chunked.ts. ---
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
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      }),
    // Full post-change content for oversized-chunk context — read UNTRIMMED (the
    // trimming gitOrNull above would alter file bytes).
    readFile: (path) => {
      try {
        return execFileSync("git", ["show", `${reviewHead}:${path}`], {
          cwd,
          encoding: "utf8",
          maxBuffer: 1024 * 1024 * 1024,
        });
      } catch {
        return null;
      }
    },
  });

  // --- Validate findings against the diff's changed lines (anti-hallucination,
  // confidence gate, suggestion strip, dedup). On an error abstain, validate
  // against the (empty) findings — keeps the flow uniform. ---
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
  // --- Respect human-resolved threads BEFORE the verdict: a finding whose bot thread a
  // human resolved is dropped everywhere — count, verdict comment, and inline posting —
  // instead of being re-litigated forever (fp is stable across line drift). ---
  const stamped = anchored.map((f) => ({ ...f, fp: fingerprint(f) }));
  const { kept: findings, suppressed } = dropResolved(stamped, priorThreads);
  if (suppressed.length > 0) {
    process.stdout.write(
      `  Suppressed ${suppressed.length} finding(s) already resolved on existing threads\n`,
    );
  }
  const validated: ProviderResult = { ...result, findings };
  let verdict = resolveVerdict(validated.verdict, findings.length);
  if (verdict === "changes" && findings.length === 0 && suppressed.length > 0) {
    // Every concrete finding was human-resolved on its thread; keeping the model's
    // request-changes would re-block on decisions a human already made.
    verdict = "approved";
    validated.verdict = "approved";
  }

  // --- Review memory: diff current findings vs prior, render recap + marker. ---
  let recap = "";
  let history = "";
  let marker = "";
  if (inputs.reviewMemory) {
    const state = diffState({
      prior,
      current_findings: findings,
      scope: { in_scope_paths: diff.changed_files, full_review: fullReview },
      head_sha: headSha,
      verdict,
      now, // injected clock → deterministic marker history ts under a pinned clock.
    });
    // Optional-chain the arrays: a decoded marker missing findings/history must
    // not throw (asReviewState only guarantees the "findings" key is present).
    const hadPrior = (prior?.findings?.length ?? 0) > 0 || (prior?.history?.length ?? 0) > 0;
    if (hadPrior) {
      recap = renderRecapSection(state, {
        history: [],
        fullReview,
        hasPrior: true,
        compact: inputs.verbosity === "compact",
      });
    }
    history = renderHistorySection(state.next_state.history);
    marker = encodeMarker(state.next_state);
  }

  // --- Format the verdict comment + label. ---
  const { body } = formatVerdict(validated, {
    botName: inputs.botName,
    botLogoUrl: inputs.botLogoUrl,
    // Heading shows the PR SOURCE branch (bash used GITHUB_HEAD_REF); prefer it.
    branch: context.headRef ?? (reviewHead === "HEAD" ? baseBranch : reviewHead),
    jobUrl: jobUrl(context),
    duration: formatDuration(now() - startMs),
    recap,
    history,
    historyMarker: marker,
    mechanical,
    verbosity: inputs.verbosity,
    changedFiles: diff.total_files,
  });

  // --- Post the verdict comment (a failure here IS an infra error → propagate). ---
  const commentUrl = await upsertComment(octokit, target, body, stickyId);

  // --- Set the verdict label (non-fatal). ---
  await setVerdictLabel(octokit, verdict, target, { manageLabels: inputs.manageLabels });

  // --- Inline review comments, reconciled against the bot's prior threads (non-fatal).
  // Instead of re-posting every finding each run, diff this run's findings against the
  // existing bot threads (see review/reconcile.ts): post only genuinely NEW findings,
  // answer IN PLACE on threads where the author had the last word, and RESOLVE threads
  // whose finding the model dropped (it accepted the rebuttal). This is what stops the
  // "re-raise the same finding forever" loop. ---
  if (inputs.inlineComments) {
    // The Reviews API needs a commit_id that is IN the PR; the merge sha is not (it
    // 422s and the comments vanish), so anchor to the PR head sha when present.
    const reviewTarget: typeof target = { ...target, headSha: context.headSha ?? headSha };
    // Findings were fingerprint-stamped before the resolved-thread suppression above.
    const plan = reconcile(findings, priorThreads);

    // 1. Genuinely new findings → one fresh inline review.
    const r = await postInlineReview(octokit, plan.toCreate, reviewTarget);
    if (!r.posted && r.reason !== "no anchored findings") {
      process.stderr.write(`  Warning: inline review step failed: ${r.reason ?? "unknown"}\n`);
    }

    // 2. Findings that persist where the author had the last word → answer in that thread.
    for (const { thread, finding } of plan.toReply) {
      await replyToThread(
        octokit,
        target,
        thread.rootCommentId,
        `**Still flagging after re-review.** ${finding.text}`,
      );
    }

    // 3. Findings the bot dropped this run → resolve the thread (accepted / no longer
    // applies). Leave a one-line note first unless the hunk is already outdated.
    for (const thread of plan.toResolve) {
      if (!thread.isOutdated) {
        await replyToThread(
          octokit,
          target,
          thread.rootCommentId,
          "Re-reviewed — this no longer applies (addressed, or point taken). Resolving.",
        );
      }
      await resolveThread(octokit, thread.threadId);
    }
  }

  return { verdict, findingsCount: findings.length, commentUrl };
}

/** Type guard: a decoded marker is a usable ReviewState (vs the empty `{}` fail-safe). */
function isReviewState(decoded: ReviewState | Record<string, never>): decoded is ReviewState {
  return "findings" in decoded;
}

/** Narrow a decoded marker to a usable ReviewState, or null when it was the empty `{}`. */
function asReviewState(decoded: ReviewState | Record<string, never>): ReviewState | null {
  return isReviewState(decoded) ? decoded : null;
}

/** Strip the hidden fp marker and any ```suggestion block from a stored finding body,
 *  leaving the human-readable finding text for the accept-or-argue prompt block. */
function cleanFindingBody(body: string): string {
  return body
    .replace(/<!-- toolu-fp:[0-9a-f]+ -->/g, "")
    .replace(/```suggestion[\s\S]*?```/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Upsert the sticky and return its comment id so subsequent posts update in place.
 * Re-locates the sticky after creating it (a fresh create has no id otherwise),
 * keeping the in-progress comment and the final verdict comment as ONE sticky.
 */
async function captureUpsertId(
  octokit: PipelineOctokit,
  target: CommentTarget,
  body: string,
  stickyId: number | undefined,
  prNumber: number,
): Promise<number | undefined> {
  await upsertComment(octokit, target, body, stickyId);
  if (stickyId !== undefined) return stickyId;
  const sticky = await findSticky(octokit, {
    owner: target.owner,
    repo: target.repo,
    prNumber,
  }).catch(() => null);
  return sticky?.id;
}

/** Resolve the head sha for state/anchoring: GITHUB_SHA for HEAD, else `git rev-parse`. */
function resolveHeadSha(reviewHead: string, contextSha: string, cwd: string): string {
  if (reviewHead === "HEAD") return contextSha;
  return gitOrNull(["rev-parse", reviewHead], cwd) ?? contextSha;
}
