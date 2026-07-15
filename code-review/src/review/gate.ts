// gate.ts — merge-gate policy for the action's exit status. Maps the FAIL_ON
// input to the set of verdicts that should fail the job (turning this check red
// so branch protection can block the PR). Pure + side-effect-free except for a
// single core.warning when an input token is unrecognized.
import * as core from "@actions/core";

/** Verdicts that may be configured to fail the job. "approved"/"skip" can never block. */
export type BlockableVerdict = "changes" | "error";

/** Tokens FAIL_ON accepts: the two blockable verdicts plus the "off" sentinel. */
const RECOGNIZED = new Set(["none", "changes", "error"]);

/**
 * Parse the FAIL_ON input (CSV) into the set of verdicts that should fail the job.
 * Case-insensitive; whitespace trimmed; empty / "none" → empty set (gate off).
 * Unrecognized tokens (incl. "approved"/"skip") are dropped with a SINGLE
 * core.warning per call naming all of them.
 */
export function parseFailOn(raw: string): ReadonlySet<BlockableVerdict> {
  const result = new Set<BlockableVerdict>();
  const unknown: string[] = [];
  for (const part of raw.split(",")) {
    const token = part.trim().toLowerCase();
    if (token === "") continue;
    if (token === "changes" || token === "error") result.add(token);
    else if (!RECOGNIZED.has(token)) unknown.push(token);
    // "none" is recognized and non-blocking → intentionally ignored.
  }
  if (unknown.length > 0) {
    core.warning(
      `FAIL_ON: ignoring unrecognized verdict(s) ${unknown.join(", ")} — valid values are 'changes', 'error', or 'none'.`,
    );
  }
  return result;
}

/**
 * True when this resolved verdict is in the fail-on set (so the job should go red).
 * Only "changes"/"error" can ever be blockable, so we narrow to those before the
 * membership test — "approved"/"skip" short-circuit to false.
 */
export function shouldBlock(
  verdict: "approved" | "changes" | "skip" | "error",
  failOn: ReadonlySet<BlockableVerdict>,
): boolean {
  if (verdict === "changes" || verdict === "error") return failOn.has(verdict);
  return false;
}

/** What {@link applyRoundCap} decided: the (possibly downgraded) verdict, and
 *  whether the round cap fired (so the comment can say so). */
export interface RoundCapDecision {
  verdict: "approved" | "changes" | "skip" | "error";
  capped: boolean;
}

/**
 * MAX_ROUNDS surrender: a generative reviewer can produce a fresh batch of
 * findings on every push, so "zero findings" is not a reachable fixpoint on
 * some PRs and the "changes" verdict would block forever. When this run is
 * review round `maxRounds` (or later) and every remaining finding is below
 * blocker severity, downgrade "changes" to "approved" — the findings are still
 * listed, the label flips, and FAIL_ON stops failing the job. A single blocker
 * disables the cap: a real showstopper must keep blocking no matter the round.
 *
 * `priorRounds` is the persisted history length (one entry per completed
 * review), so `priorRounds + 1` is THIS round's number. `maxRounds <= 0`
 * disables the cap entirely.
 */
export function applyRoundCap(opts: {
  verdict: "approved" | "changes" | "skip" | "error";
  findings: ReadonlyArray<{ severity?: string }>;
  priorRounds: number;
  maxRounds: number;
}): RoundCapDecision {
  const { verdict, findings, priorRounds, maxRounds } = opts;
  if (maxRounds <= 0 || verdict !== "changes") return { verdict, capped: false };
  if (priorRounds + 1 < maxRounds) return { verdict, capped: false };
  if (findings.some((f) => f.severity === "blocker")) return { verdict, capped: false };
  return { verdict: "approved", capped: true };
}
