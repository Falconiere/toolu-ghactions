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
