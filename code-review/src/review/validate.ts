// review/validate.ts — deterministic finding gate (no LLM). Port of
// validate-findings.sh, plus the intra-result dedup carried over from
// coordinate-findings.sh (the single-model path never coordinates multiple
// providers, so the dedup that used to live there runs here instead).
//
// Four drops, in order, matching the bash jq pipeline plus the rev-5 noise gate:
//   1. Anchored — the cited `line` must be a real changed line in the diff for
//      that path (anti-hallucination). Unanchored findings are dropped.
//   2. Self-negation — the model set `conclusion: "no_defect"`, or the finding's
//      own text concludes there is no defect (review/selfNegating.ts: "No issue.",
//      "This is acceptable. No violation.").
//      Purely structural gates never catch this: the finding is anchored and can
//      carry high confidence, it just says nothing is wrong. Runs BEFORE the
//      confidence gate so a high-confidence "No issue." cannot survive it.
//   3. Confidence gate — every severity must meet MIN_CONFIDENCE (high floor
//      keeps high only; medium floor keeps high or medium). Missing confidence
//      is "low".
//   4. Suggestion strip — keep `suggestion` only when confidence is high, the
//      whole [line..end_line] span is inside the diff, it changes that full span,
//      and it is not a recorded imperative-prose payload. A bad patch never drops
//      its finding.
// Then dedup by (path|line|end_line|normalized-text) fingerprint, keeping the
// max severity within each group.
import type { Finding } from "@/llm/schema.js";
// SEVERITY_RANK is owned by findings.ts (single source of truth) — imported here
// so the dedup's max-severity comparison can never drift from the render ordering.
import { SEVERITY_RANK } from "./findings.js";
import { isSelfNegating } from "./selfNegating.js";

/** Confidence floor: "high" keeps high only; "medium" keeps high or medium. */
export type MinConfidence = "high" | "medium";

/** {@link validateFindings}'s output: the surviving findings plus the count
 *  dropped as self-negating — the caller plumbs that count into
 *  `settleVerdict`'s `removed` (pipeline/settle.ts) so an all-junk review still
 *  flips a findingless "changes" to "approved" instead of blocking on noise. */
export interface ValidateFindingsResult {
  findings: Finding[];
  selfNegating: number;
  /** LLM findings rejected because their required source evidence was absent or invalid. */
  unsupportedEvidence: number;
  /** Of {@link unsupportedEvidence}, the ones that carried NO `quoted_line` at all. */
  missingQuote: number;
  /** Of {@link unsupportedEvidence}, the ones whose quote could not be matched to the
   *  cited source line. Split from {@link missingQuote} because the two mean different
   *  things: a model that never emits quotes is a prompt/schema problem, a model whose
   *  quotes do not match is misreading the diff. Without the split a run where the gate
   *  rejects everything is undebuggable from the log. */
  unverifiedQuote: number;
  /** Changed paths with a finding that carried NO `quoted_line`, unique in
   *  first-rejection order. Only these can cost a path its coverage: a model that
   *  never quotes leaves nothing to verify, while a quote that fails to match is the
   *  model misreading one line of a file it did review — an ordinary dropped finding. */
  missingQuotePaths: string[];
}

/** Options for {@link validateFindings}. Legacy callers keep optional quotes;
 * fresh live model responses set `requireQuote` and must provide one. */
export interface ValidateFindingsOptions {
  requireQuote?: boolean;
}

/**
 * Filter and dedup model findings against the diff's changed lines.
 *
 * @param findings - raw findings from the model.
 * @param changedLinesByPath - map of path → the new-file line numbers present in
 *   the diff for that path (from ShapedFile.changed_lines). A path with no entry
 *   has no anchorable lines, so all its findings are unanchored and dropped.
 * @param minConfidence - the MIN_CONFIDENCE floor (high|medium).
 * @param lineTextByPath - post-change source lines, used for quote and suggestion checks.
 * @param options - fresh live calls require a non-empty source-matching quote;
 * legacy recorded responses may omit one.
 * @returns the kept findings (deduped, in input order — dedup keeps the first
 *   occurrence of each fingerprint, upgraded to the group's max severity) and the
 *   self-negating drop count.
 */
export function validateFindings(
  findings: Finding[],
  changedLinesByPath: Map<string, number[]>,
  minConfidence: MinConfidence,
  lineTextByPath?: Map<string, Map<number, string>>,
  options: ValidateFindingsOptions = {},
): ValidateFindingsResult {
  // Build each path's changed-line Set once, not once per finding: the Set depends
  // only on f.path, and N findings can span far fewer files than N.
  const changedSetByPath = new Map<string, Set<number>>();
  for (const [path, lines] of changedLinesByPath) {
    changedSetByPath.set(path, new Set(lines));
  }
  const EMPTY_CHANGED = new Set<number>();

  const kept: Finding[] = [];
  let selfNegating = 0;
  let missingQuote = 0;
  let unverifiedQuote = 0;
  const missingQuotePaths = new Set<string>();
  for (const f of findings) {
    const changedSet = changedSetByPath.get(f.path) ?? EMPTY_CHANGED;

    // 1. Anchored: the cited line must be a real changed line in the diff.
    if (!changedSet.has(f.line)) continue;

    // 2. Self-negation: the model withdrew the finding (`conclusion: "no_defect"`)
    // or its own text concludes there is no defect ("No issue.", "… is safe. No
    // defect, abstain."). Runs before source evidence validation so an explicit
    // retraction is recorded as self-negating noise, not as an unsupported-evidence
    // failure.
    if (f.conclusion === "no_defect" || isSelfNegating(f.text)) {
      selfNegating++;
      continue;
    }

    // 1b. Quote-anchored (LLM findings only): if the finding quotes a line, it
    // must match the real new-file text at the cited line (spilling onto adjacent
    // wrapped lines is tolerated — see quoteInSpan). The motivating case is
    // a diff misread — the model cites a valid line number but quotes content from
    // a removed (`L---:`) line, flagging deleted code as if still present. The gate
    // is deliberately broader: ANY mismatch is dropped, because a quote that does
    // not come from the cited line means the model is unsure what it is flagging
    // (precision over recall, per the checklist). It only fires when the model
    // supplied a quote AND we have the line's text; mechanical scanners (which
    // anchor exactly) are exempt.
    const isLlm = f.source === undefined || f.source === "llm";
    const failure = isLlm ? quoteFailure(f, lineTextByPath, options.requireQuote === true) : null;
    if (failure !== null) {
      if (failure === "missing") {
        missingQuote++;
        missingQuotePaths.add(f.path);
      } else {
        unverifiedQuote++;
      }
      if (missingQuote + unverifiedQuote <= 5) {
        // Locations only: never copy potentially sensitive source into CI logs.
        const quote = stripDiffPrefixes(f.quoted_line ?? "");
        const quoteAtLines = [...(lineTextByPath?.get(f.path) ?? [])]
          .filter(([, text]) => quoteMatches(text, quote))
          .slice(0, 3)
          .map(([line]) => line);
        process.stdout.write(
          `  Source evidence rejected: ${JSON.stringify({
            path: f.path.slice(0, 240),
            line: f.line,
            reason: failure,
            quoteAtLines,
          })}\n`,
        );
      }
      continue;
    }

    // 3. Confidence gate. Missing confidence is treated as below medium ("low").
    const c = f.confidence ?? "low";
    const keep =
      (minConfidence === "high" && c === "high") ||
      (minConfidence === "medium" && (c === "high" || c === "medium"));
    if (!keep) continue;

    // 4. Suggestion strip: keep it only when high-confidence AND the whole span
    // is in the diff; otherwise drop just the suggestion, keep the finding.
    const spanInDiff = spanIsInDiff(f, changedSet);
    if (f.suggestion !== undefined && !suggestionIsSafe(f, lineTextByPath, spanInDiff)) {
      const { suggestion: _dropped, ...rest } = f;
      kept.push(rest);
    } else {
      kept.push(f);
    }
  }

  if (selfNegating > 0) {
    process.stdout.write(`  Dropped ${selfNegating} self-negating finding(s)\n`);
  }
  // The sibling of the self-negating line above. Without it a run where the gate
  // rejects every finding reports only its downstream effect (a degraded verdict over
  // "unreviewed" files) and the cause is unrecoverable from the log.
  if (missingQuote + unverifiedQuote > 0) {
    process.stdout.write(
      `  Dropped ${missingQuote + unverifiedQuote} finding(s) lacking source evidence ` +
        `(${missingQuote} with no quoted_line, ${unverifiedQuote} whose quote did not ` +
        `match the cited line)\n`,
    );
  }
  return {
    findings: dedup(kept),
    selfNegating,
    unsupportedEvidence: missingQuote + unverifiedQuote,
    missingQuote,
    unverifiedQuote,
    missingQuotePaths: [...missingQuotePaths],
  };
}

/** Why an LLM finding's source quote failed the gate. */
type QuoteFailure = "missing" | "unverified";

/**
 * How many consecutive post-change lines a quote may spill onto on each side of the
 * cited span. Hard-wrapped prose (Markdown, doc comments) splits one sentence across
 * lines; a model quoting that sentence is still quoting the cited source. PR #210 in
 * toolu-ghrunner lost every finding on a re-wrapped AGENTS.md this way.
 */
const QUOTE_SPILL_LINES = 3;

/**
 * Validate an LLM finding's source quote, naming the failure so the caller can count
 * the two cases apart. A supplied quote is always non-empty and must come from the
 * cited source span (see {@link quoteInSpan}); only legacy callers may omit it. `null`
 * means the quote is valid (or not required). A quote that was supplied but could not
 * be checked against the source is "unverified" alongside one that simply did not
 * match — both mean the model's claim is ungrounded, and neither is a missing quote.
 */
function quoteFailure(
  finding: Finding,
  lineTextByPath: Map<string, Map<number, string>> | undefined,
  requireQuote: boolean,
): QuoteFailure | null {
  if (finding.quoted_line === undefined) return requireQuote ? "missing" : null;
  if (lineTextByPath === undefined) return requireQuote ? "unverified" : null;
  const lines = lineTextByPath.get(finding.path);
  if (lines !== undefined && quoteInSpan(lines, finding, finding.quoted_line)) return null;
  return "unverified";
}

/**
 * True when the quote, whitespace-normalized and stripped of copied diff prefixes,
 * occurs in the post-change text around the cited span AND that occurrence overlaps
 * the span itself. The overlap keeps the anchor honest: a quote lifted wholly from a
 * neighbouring line still fails, as does one from a removed (`L---:`) line, which is
 * absent from `lines`. Only consecutive present lines join, so a quote never bridges
 * a gap between hunks.
 */
function quoteInSpan(lines: Map<number, string>, finding: Finding, quoted: string): boolean {
  const q = normalize(stripDiffPrefixes(quoted));
  const first = finding.line;
  const last = Math.max(finding.end_line ?? first, first);
  if (q === "" || !lines.has(first)) return false;
  let lo = first;
  while (lo > first - QUOTE_SPILL_LINES && lines.has(lo - 1)) lo--;
  let hi = last;
  while (hi < last + QUOTE_SPILL_LINES && lines.has(hi + 1)) hi++;

  let text = "";
  let spanStart = 0;
  let spanEnd = 0;
  for (let n = lo; n <= hi; n++) {
    const part = normalize(lines.get(n) ?? "");
    if (part !== "") text += text === "" ? part : ` ${part}`;
    if (n === first) spanStart = text.length - part.length;
    if (n <= last) spanEnd = text.length;
  }
  for (let at = text.indexOf(q); at !== -1; at = text.indexOf(q, at + 1)) {
    if (at < spanEnd && at + q.length > spanStart) return true;
  }
  return false;
}

/**
 * Drop the line-priming a model copied along with its quote: a leading `Lnnn: ` and
 * the diff's `+` marker, per line. Only ever shortens the quote, so it can never turn
 * a matching quote into a mismatch. `L---: ` (a removed line) is deliberately kept so
 * a quote of deleted code still fails.
 */
function stripDiffPrefixes(quoted: string): string {
  return quoted
    .split("\n")
    .map((line) => line.replace(/^\s*(?:L\d+: ?)?\+?/, ""))
    .join("\n");
}

/** Whitespace-normalized one-way containment: the quote comes FROM source. */
function quoteMatches(actual: string, quoted: string): boolean {
  const q = normalize(quoted);
  return q !== "" && normalize(actual).includes(q);
}

/** Collapse every whitespace run to one space and trim. */
function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * True when every line in [line..end_line] is present in the diff's changed set
 * (end_line defaults to line). Mirrors the jq set-difference length===0 check.
 */
function spanIsInDiff(f: Finding, changedSet: Set<number>): boolean {
  const end = f.end_line ?? f.line;
  for (let l = f.line; l <= end; l++) {
    if (!changedSet.has(l)) return false;
  }
  return true;
}

/** Whether a suggested replacement is safe to render as a committable patch. */
function suggestionIsSafe(
  finding: Finding,
  lineTextByPath: Map<string, Map<number, string>> | undefined,
  spanInDiff: boolean,
): boolean {
  if (finding.confidence !== "high" || !spanInDiff || finding.suggestion === undefined) {
    return false;
  }
  const source = sourceSpan(finding, lineTextByPath);
  if (source === undefined) return lineTextByPath === undefined;
  if (finding.suggestion === source) return false;
  return !isProseInstruction(finding.suggestion);
}

/** Read the exact post-change source text the suggestion would replace. */
function sourceSpan(
  finding: Finding,
  lineTextByPath: Map<string, Map<number, string>> | undefined,
): string | undefined {
  const lines = lineTextByPath?.get(finding.path);
  if (lines === undefined) return undefined;
  const source: string[] = [];
  for (let line = finding.line; line <= (finding.end_line ?? finding.line); line++) {
    const text = lines.get(line);
    if (text === undefined) return undefined;
    source.push(text);
  }
  return source.join("\n");
}

/**
 * Reject only the imperative prose shape observed in recorded GitHub comments.
 * This deliberately does not try to parse a language-specific replacement: the
 * action reviews many languages and a JavaScript parser would reject valid Rust,
 * TypeScript, JSX, or partial-line replacements. The exact-span no-op check above
 * remains the deterministic safety boundary for every language.
 */
function isProseInstruction(suggestion: string): boolean {
  return /^(?:Add|Call|Change|Ensure|Remove|Update|Use|Wire)\s/.test(suggestion.trim());
}

/**
 * Dedup by (path|line|end_line|normalized-text-prefix), keeping the first
 * occurrence per group upgraded to the group's max (most-severe) severity.
 * Port of coordinate-findings.sh's group_by + min_by(severity rank).
 */
function dedup(findings: Finding[]): Finding[] {
  const byKey = new Map<string, Finding>();
  const order: string[] = [];
  for (const f of findings) {
    const key = dedupKey(f);
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, f);
      order.push(key);
    } else if (SEVERITY_RANK[f.severity] < SEVERITY_RANK[existing.severity]) {
      // Keep the existing object's identity/position but adopt the worse severity.
      byKey.set(key, { ...existing, severity: f.severity });
    }
  }
  return order.map((k) => byKey.get(k)).filter((f) => f !== undefined);
}

/** The dedup group key: path|line|end_line|first-80-chars of normalized text. */
function dedupKey(f: Finding): string {
  const end = f.end_line ?? f.line;
  const normText = f.text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 80);
  return `${f.path}|${f.line}|${end}|${normText}`;
}
