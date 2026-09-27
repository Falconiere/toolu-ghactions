// gate.ts — merge-gate policy for the action's exit status. Maps the FAIL_ON
// input to the set of verdicts that should fail the job (turning this check red
// so branch protection can block the PR). Pure + side-effect-free except for a
// single core.warning when an input token is unrecognized.
import * as core from "@actions/core";
import { SEVERITY_ALIASES, type Severity } from "@/llm/schema.js";

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

/** Severity rank, lowest first — mirrors "blocker > high > medium > low > nit". */
const SEVERITY_RANK: Record<Severity, number> = { nit: 0, low: 1, medium: 2, high: 3, blocker: 4 };

const SEVERITIES: readonly Severity[] = ["blocker", "high", "medium", "low", "nit"];

/** Type guard narrowing an arbitrary string to a known Severity, so a finding's
 *  (unvalidated at this layer) severity can index {@link SEVERITY_RANK} safely. */
function isSeverity(value: string): value is Severity {
  return SEVERITIES.some((s) => s === value);
}

/**
 * Parse the APPROVE_BELOW input into a Severity: the lowest severity that still
 * withholds `merge-approved`. Case/synonym-insensitive via SEVERITY_ALIASES (the
 * same normalization Finding.severity itself goes through), so "critical" resolves
 * to "blocker". Empty or unrecognized input falls back to "nit" — the lowest
 * severity, which preserves "any finding blocks" (nothing ranks below it) — with a
 * single core.warning naming an unrecognized non-empty token.
 */
export function parseApproveBelow(raw: string): Severity {
  const token = raw.trim().toLowerCase();
  if (token === "") return "nit";
  const resolved = SEVERITY_ALIASES[token];
  if (resolved !== undefined) return resolved;
  core.warning(
    `APPROVE_BELOW: unrecognized severity '${raw}' — valid values are 'blocker', 'high', 'medium', 'low', or 'nit'. Falling back to 'nit'.`,
  );
  return "nit";
}

/**
 * The label-only verdict: `verdict` unchanged unless it is "changes" AND every
 * finding's severity ranks strictly below `approveBelow`, in which case the
 * label should read "approved" instead. "approved"/"skip"/"error" always pass
 * through unchanged — this only ever turns a "changes" into an "approved" for
 * label purposes; it never touches a verdict already fail-closed to "error"
 * (an incomplete/partial review), and never invents a new "changes".
 *
 * A finding whose severity does not resolve to a known rank (should not happen
 * post-schema-validation) is treated as blocking, so malformed input fails closed
 * rather than silently going advisory.
 */
export function resolveLabelVerdict(opts: {
  verdict: "approved" | "changes" | "skip" | "error";
  findings: ReadonlyArray<{ severity?: string }>;
  approveBelow: Severity;
}): "approved" | "changes" | "skip" | "error" {
  const { verdict, findings, approveBelow } = opts;
  if (verdict !== "changes") return verdict;
  const threshold = SEVERITY_RANK[approveBelow];
  const blocking = findings.some((f) => {
    const rank =
      f.severity !== undefined && isSeverity(f.severity) ? SEVERITY_RANK[f.severity] : undefined;
    return rank === undefined || rank >= threshold;
  });
  return blocking ? "changes" : "approved";
}
