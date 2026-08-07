// pipeline/settle.ts — the two deterministic decisions publish() makes before it
// touches GitHub: what the VERDICT is, and what the state MARKER carries. Split out
// of pipeline/publish.ts (at its size ceiling) so each file stays readable; the
// publish orchestration, the inline reconcile execution and the reporting hand-off
// stay there.
//
// Both functions read the round's COVERAGE LEDGER (spec §Coverage ledger): it is
// what makes "approved" honest (a would-be approval over unreviewed or pending
// files degrades to `error`, exactly as mergeResults does for a failed chunk) and
// what makes the marker resumable (`complete`, the exception lists, `reviewed_tree`).
import { renderRecapSection, renderHistorySection } from "@/review/recap.js";
import { resolveVerdict } from "@/review/verdict.js";
import { diffState, encodeMarker } from "@/state.js";
import { dropSettled } from "@/review/reconcile.js";
import { dropOutOfScope } from "@/review/incremental.js";
import { applyRoundCap } from "@/review/gate.js";
import { pathsWithStatus, type CoverageLedger } from "@/review/ledger.js";
import type { ProviderResult } from "@/llm/reviewWithModel.js";
import type { PublishInput } from "./publish.js";
import type { Reduction } from "./reduce.js";
import type { StampedFinding } from "./reviewCall.js";

/** The ledger's exception view: the two loud statuses plus the completeness flag
 *  derived from them (`complete` is what advances `reviewed_sha`/`reviewed_tree`
 *  and appends a history entry — state.ts). */
export interface LedgerExceptions {
  unreviewed: string[];
  pending: string[];
  complete: boolean;
}

/** Read the exception lists off a ledger once, for both consumers below. */
export function ledgerExceptions(ledger: CoverageLedger): LedgerExceptions {
  const unreviewed = pathsWithStatus(ledger, "unreviewed");
  const pending = pathsWithStatus(ledger, "pending");
  return { unreviewed, pending, complete: unreviewed.length === 0 && pending.length === 0 };
}

/** The settled verdict: out-of-scope + suppressed findings removed, flips and caps applied. */
export interface SettledVerdict {
  validated: ProviderResult;
  /** The surviving cluster REPRESENTATIVES (expand before persisting/reporting). */
  findings: StampedFinding[];
  /** Findings dropped because their thread was already settled (resolved/dismissed). */
  suppressed: StampedFinding[];
  verdict: "approved" | "changes" | "skip" | "error";
  capNote: string;
  /** Whether MAX_ROUNDS surrendered this run — reported as `run.capped` (report/report-run.ts). */
  capped: boolean;
}

/**
 * Settle the verdict deterministically: drop out-of-scope findings (incremental
 * review — new findings only from lines changed since the last reviewed sha, with
 * the resume exception paths always in scope), respect settled threads at CLUSTER
 * level — resolved on GitHub or dismissed in a reply, where dismissing the exemplar
 * dismisses the pattern — flip a now-findingless "changes" to "approved", then apply
 * the (optional) MAX_ROUNDS surrender cap and the ledger's own degrade rule.
 */
export function settleVerdict(
  input: PublishInput,
  reduction: Reduction,
  exceptions: LedgerExceptions,
): SettledVerdict {
  const scoped = dropOutOfScope(
    reduction.representatives,
    input.scope,
    input.priorThreads,
    input.prior?.findings ?? [],
    input.exceptionPaths,
  );
  if (scoped.dropped.length > 0) {
    process.stdout.write(
      `  Dropped ${scoped.dropped.length} finding(s) about code unchanged since the last review\n`,
    );
  }
  const { kept: findings, suppressed } = dropSettled(
    scoped.kept,
    input.priorThreads,
    reduction.ctx,
  );
  if (suppressed.length > 0) {
    process.stdout.write(
      `  Suppressed ${suppressed.length} finding(s) already settled on existing threads ` +
        `(resolved, accepted, or dismissed by the author)\n`,
    );
  }
  const validated: ProviderResult = { ...input.result, findings };
  // `verdict` is the ONLY thing the rules below move; `validated.verdict` is written
  // from it once, just before the return. Deliberately not paired per rule: a rule
  // that updates one half and forgets the other is how the returned verdict and the
  // ProviderResult the comment renders from come to disagree.
  let verdict = resolveVerdict(validated.verdict, findings.length);
  const removed = suppressed.length + scoped.dropped.length;
  if (verdict === "changes" && findings.length === 0 && removed > 0) {
    // Every concrete finding was either settled on its thread (resolved or
    // dismissed by the author) or out of the incremental scope; keeping the
    // model's request-changes would re-block on code that was already reviewed
    // or decisions a human already made.
    verdict = "approved";
  }
  // A CARRIED finding was not re-examined this round (its path was out of the tree
  // scope, collapsed, or unreviewable), so this round's approval speaks only for the
  // files it actually read. When the last completed round asked for changes over
  // those very findings, that decision stands until a round reads their code again —
  // otherwise a push touching one unrelated file would approve the whole PR.
  if (
    verdict === "approved" &&
    lastVerdict(input) === "changes" &&
    hasCarried(findings, reduction)
  ) {
    verdict = "changes";
  }

  // MAX_ROUNDS surrender: on round N with only sub-blocker findings left, a
  // "changes" verdict downgrades to "approved" (findings stay listed as advisory)
  // so a reviewer that generates fresh findings every push cannot block forever.
  const cap = applyRoundCap({
    verdict,
    findings,
    priorRounds: input.prior?.history?.length ?? 0,
    maxRounds: input.inputs.reviewMemory ? input.inputs.maxRounds : 0,
  });
  let capNote = "";
  if (cap.capped) {
    verdict = "approved";
    capNote =
      `Round cap reached (MAX_ROUNDS=${input.inputs.maxRounds}): no blocker findings after ` +
      `${input.inputs.maxRounds} review rounds — verdict auto-approved; the findings below are advisory.`;
    process.stdout.write(`  ${capNote}\n`);
  }
  verdict = degradeOnCoverage(validated, verdict, exceptions);
  if (scoped.dropped.length > 0) {
    const note =
      `Incremental review: ${scoped.dropped.length} finding(s) about code unchanged since the ` +
      `last review were not re-raised — comment \`@toolu review\` for a full re-review.`;
    capNote = capNote === "" ? note : `${capNote}\n\n${note}`;
  }
  // The one place the settled verdict reaches the ProviderResult the comment body
  // and the toolu.sh report are rendered from (pipeline/publish.ts:138). Every rule
  // above moves `verdict` only, so no rule can leave the two disagreeing.
  validated.verdict = verdict;
  return { validated, findings, suppressed, verdict, capNote, capped: cap.capped };
}

/** The verdict of the last COMPLETED round (only complete rounds append history),
 *  or null on a first review. */
function lastVerdict(input: PublishInput): string | null {
  return input.prior?.history?.at(-1)?.verdict ?? null;
}

/** True when any surviving finding was carried in from the marker rather than
 *  produced by a model call this round. A cluster representative stands for its
 *  members, so a carried member counts through its exemplar too. */
function hasCarried(findings: StampedFinding[], reduction: Reduction): boolean {
  return findings.some((f) => {
    const group = reduction.ctx.members.get(f.fp) ?? [f];
    return group.some((m) => reduction.carriedFps.has(m.fp));
  });
}

/**
 * AC-13, keyed off the ledger rather than off chunk failures: any `unreviewed` or
 * `pending` path makes an approval a claim the review cannot honestly make, so a
 * would-be `approved` becomes `error` — the same observable behavior (label, badge,
 * FAIL_ON) as `mergeResults`'s failed-chunk rule, which stays untouched underneath.
 * The detail line is only synthesized when the result carries no error of its own,
 * so a real provider message is never overwritten — that synthesis is this
 * function's ONLY write to `validated`; the degraded verdict travels back as the
 * return value, which `settleVerdict` alone commits to `validated.verdict`.
 */
function degradeOnCoverage(
  validated: ProviderResult,
  verdict: ProviderResult["verdict"],
  exceptions: LedgerExceptions,
): ProviderResult["verdict"] {
  if (exceptions.complete || verdict !== "approved") return verdict;
  const count = exceptions.unreviewed.length + exceptions.pending.length;
  if (validated.error === undefined || validated.error === "") {
    validated.error =
      `${count} file(s) were not reviewed this run (see Coverage below) — an approval ` +
      "over unreviewed files would be a verdict this review cannot make.";
  }
  process.stdout.write(`  Coverage incomplete (${count} file(s)) — verdict degraded to error\n`);
  return "error";
}

/** Review memory: diff current findings vs prior, render recap + history + marker. */
export function renderMemory(
  input: PublishInput,
  findings: StampedFinding[],
  verdict: string,
  reduction: Reduction,
  exceptions: LedgerExceptions,
): { recap: string; history: string; marker: string } {
  if (!input.inputs.reviewMemory) return { recap: "", history: "", marker: "" };
  const state = diffState({
    prior: input.prior,
    current_findings: findings,
    scope: { in_scope_paths: input.diff.changed_files, full_review: input.fullReview },
    head_sha: input.reviewedSha,
    verdict,
    now: input.now, // injected clock → deterministic marker history ts under a pinned clock.
    // Only a COMPLETE round advances reviewed_sha/reviewed_tree and appends a
    // history entry; a partial one persists its exception lists and nothing else,
    // so a resumed round never burns a MAX_ROUNDS slot (spec §True incremental).
    complete: exceptions.complete,
    ...(exceptions.complete && input.headTree !== undefined
      ? { reviewed_tree: input.headTree }
      : {}),
    // Empty lists are OMITTED rather than written: diffState is the only carrier
    // into next_state, so an absent field is how a completing round CLEARS the
    // prior round's exceptions.
    ...(exceptions.unreviewed.length > 0 ? { unreviewed_paths: exceptions.unreviewed } : {}),
    ...(exceptions.pending.length > 0 ? { pending_paths: exceptions.pending } : {}),
    ...(Object.keys(reduction.clusters).length > 0 ? { clusters: reduction.clusters } : {}),
  });
  // Optional-chain the arrays: a decoded marker missing findings/history must
  // not throw (asReviewState only guarantees the "findings" key is present).
  const hadPrior =
    (input.prior?.findings?.length ?? 0) > 0 || (input.prior?.history?.length ?? 0) > 0;
  const recap = hadPrior
    ? renderRecapSection(state, {
        history: [],
        fullReview: input.fullReview,
        hasPrior: true,
        compact: input.inputs.verbosity === "compact",
      })
    : "";
  return {
    recap,
    history: renderHistorySection(state.next_state.history),
    marker: encodeMarker(state.next_state),
  };
}
