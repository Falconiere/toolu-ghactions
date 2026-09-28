// review/selfNegating.ts — one responsibility: decide whether a finding's own
// TEXT concludes there is no defect (spec §rev-5 self-negation rule). Split out
// of validate.ts so that file stays a pure gate pipeline and this stays a pure
// text predicate — the case that motivated it is real: deepseek-v4-flash on
// actacanvas PR #6 emitted one junk "finding" per reviewed line reading "The
// comment is accurate. No issue." — structurally valid (anchored, high
// confidence), so the purely-structural gates in validate.ts never touched it.
//
// Rule: normalize the text, split it into
// sentences, and drop the finding when ANY sentence — in full, after an optional
// leading "This is|That is|It is" and its own trailing punctuation are stripped —
// equals one of the no-defect phrases below. Some conclusions only count in the
// FINAL sentence, because a concede-then-accuse finding ("This is fine. The real
// bug is the missing await on line 12.") must keep its actionable claim.
//
// The final sentence is also split into CLAUSES (comemory PR #307: models reason
// inside the finding and conclude only at its end — "… is safe. No defect,
// abstain.", "…; the direct write is a narrow simulation acceptable for testing
// the client-side refusal."). Its LAST clause may be a no-defect conclusion; its
// FIRST clause may be one only when no contrastive or causal clause follows, so
// "No defect, but `as` is a lossy cast." keeps its claim. Clause patterns are
// anchored full-clause matches too, and an affirmation never carries a negation.
//
// Deliberately FULL-SENTENCE matching, never substring: "Clamping to 0 here is
// not acceptable for negative counts." contains "acceptable" but is not, in full,
// the word "acceptable" — a substring match would wrongly drop a real finding. The
// same discipline is why "…does not work as intended." never trips any pattern
// here — none of the phrases below mention "intended" at all.

/** Sentence boundary: a `.`/`!`/`?` immediately followed by whitespace. Does not
 *  split abbreviations mid-sentence (no whitespace after the period) — acceptable
 *  here because a false non-split only makes the merged "sentence" less likely to
 *  equal one of the short phrases below, never more. */
const SENTENCE_SPLIT = /(?<=[.!?])\s+/;

/** Optional lead-in a no-defect sentence often carries ("This is fine."). Stripped
 *  before the full-sentence match so the match targets the phrase itself. */
const LEADING_PREFIX = /^(?:this is|that is|it is)\s+/i;

/** Trailing sentence terminator(s), stripped before matching. */
const TRAILING_PUNCTUATION = /[.!?]+$/;

/** Phrases that are NEVER a legitimate defect conclusion, checked against ANY
 *  sentence in the finding's text (anchored full-string match). */
const NEGATION_PATTERNS: readonly RegExp[] = [
  /^no issues?( here| found)?$/i,
  /^no violations?$/i,
  /^no (?:real )?(?:problem|bug|concern)$/i,
  /^no defects?( here| found)?$/i,
  /^not a (?:real )?issue$/i,
  /^no action needed$/i,
  /^no changes? needed$/i,
];

/** No-finding and affirmative conclusions count only as the LAST sentence, so a
 *  later defect claim is not discarded as praise. */
const FINAL_ONLY_PATTERNS: readonly RegExp[] = [
  /^no findings?$/i,
  /^acceptable$/i,
  /^fine$/i,
  /^a theoretical edge case, not a practical concern$/i,
];

/** Clause boundary inside a sentence: `,` `;` `:` or a spaced dash. */
const CLAUSE_SPLIT = /\s*[,;:]\s+|\s+[—–-]{1,2}\s+/;

/** "no [≤2 qualifiers] defect|risk|…", optionally "observed"/"evident"/… and a
 *  trailing "from|in|… <scope>" — "No deadlock risk", "no defect observed from
 *  diff", "no defect in the production code path". The noun list is what keeps
 *  "No bounds check guards the index" (a real defect) out. */
const NO_DEFECT_CLAUSE =
  /^(?:(?:thus|so|therefore|hence|overall)\s+)?no\s+(?:[\w-]+\s+){0,2}?(?:defects?|issues?|problems?|bugs?|risks?|concerns?|violations?|regressions?)(?:\s+(?:observed|evident|evidenced|visible|found|present|apparent|introduced|here))?(?:\s+(?:from|in|within|on|for|at)\s+.+)?$/i;

/** "no excessive|unbounded|significant <thing> [evidenced]" — denies the defect's
 *  magnitude, which a real finding never does. */
const NO_EXCESS_CLAUSE = /^no\s+(?:excessive|unbounded|significant)\s+[\w-]+(?:\s+[\w-]+){0,2}$/i;

/** "<short subject> is|are [≤4 words] acceptable|safe|… [for|in|as <scope>]". */
const AFFIRMATION_CLAUSE =
  /^(?:[\w`'().:&-]+\s+){1,6}(?:is|are)\s+(?:[\w-]+\s+){0,4}?(?:acceptable|safe|correct|consistent|fine|harmless)(?:\s+(?:for|in|as)\s+.+)?$/i;

/** A bare verdict word left as the last clause ("… — consistent.", "No defect, abstain."). */
const BARE_CONCLUSION = /^(?:consistent|safe|correct|harmless|abstain(?:ing)?)$/i;

/** "This is a false positive" — the model's triage rejecting a scanner hit. */
const FALSE_POSITIVE = /^(?:an?\s+)?false positive$/i;

/** Negation inside an affirmation flips it: "is not acceptable for negative counts". */
const NEGATION = /\b(?:not|never|no)\b|n't\b/i;

/** A later clause that carries a claim of its own: "No defect, but …", "…, so X panics". */
const CONTINUATION =
  /\b(?:but|however|although|though|yet|except|still|so|because|since|which|causing|leading)\b/i;

/** PR #125's praise without an explicit "No findings". Match the WHOLE text so
 * a separate defect sentence cannot be hidden by a later compliment. */
const PRAISE_ONLY_PATTERNS: readonly RegExp[] = [
  /^the [^.!?]+ call is unchanged\. it is still called after [^.!?]+, which is correct because [^.!?]+\.$/i,
  /^the [^.!?]+ env var is still set after [^.!?]+\. this is correct and matches [^.!?]+\.$/i,
];

/** An explicit first-person retraction invalidates the entire finding, even when
 * the model tries to pivot that same response to a different claim afterwards. */
const EXPLICIT_RETRACTION = /\bi was wrong\b/i;

/**
 * Whole-text normalization, run once before sentence splitting: outer
 * whitespace, a leading list/heading marker, and a bold/italic/code wrapper
 * around the ENTIRE text (models sometimes emit "**No issue.**" as a one-line
 * verdict). Interior punctuation is left untouched — sentence splitting needs it.
 */
function normalizeText(text: string): string {
  let s = text.trim();
  s = s.replace(/^[-*+]\s+/, ""); // leading list bullet
  s = s.replace(/^#{1,6}\s+/, ""); // leading markdown heading marker
  const wrappers = ["***", "**", "__", "`"];
  for (const w of wrappers) {
    // >=: the degenerate empty body ("****") unwraps to "" instead of surviving
    // as literal asterisks; any real 1+-char body already exceeded the bound.
    if (s.startsWith(w) && s.endsWith(w) && s.length >= w.length * 2) {
      s = s.slice(w.length, -w.length).trim();
      break;
    }
  }
  return s;
}

/** Strip the optional leading phrase and the sentence's own trailing punctuation,
 *  leaving the bare phrase the patterns above match against, in full. */
function stripSentence(sentence: string): string {
  return sentence.trim().replace(LEADING_PREFIX, "").replace(TRAILING_PUNCTUATION, "").trim();
}

/**
 * True when the finding's text concludes — in any sentence for explicit
 * negations, or in its final sentence for affirmative conclusions — that there is no
 * defect. Callers drop the finding rather than report it.
 */
export function isSelfNegating(text: string): boolean {
  if (EXPLICIT_RETRACTION.test(text)) return true;
  const normalized = normalizeText(text);
  if (PRAISE_ONLY_PATTERNS.some((p) => p.test(normalized))) return true;
  const sentences = normalized
    .split(SENTENCE_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (sentences.length === 0) return false;
  const lastIndex = sentences.length - 1;

  return sentences.some((sentence, i) => {
    const stripped = stripSentence(sentence);
    if (NEGATION_PATTERNS.some((p) => p.test(stripped))) return true;
    if (i !== lastIndex) return false;
    return FINAL_ONLY_PATTERNS.some((p) => p.test(stripped)) || concludesNoDefect(stripped);
  });
}

/** The final sentence's clause rule (see the header): its last clause concludes no
 *  defect, or its first clause does and nothing after it carries a claim. */
function concludesNoDefect(sentence: string): boolean {
  const clauses = sentence
    .split(CLAUSE_SPLIT)
    .map(stripSentence)
    .filter((c) => c !== "");
  const first = clauses[0];
  const last = clauses.at(-1);
  if (first === undefined || last === undefined) return false;
  if (
    NO_DEFECT_CLAUSE.test(last) ||
    NO_EXCESS_CLAUSE.test(last) ||
    BARE_CONCLUSION.test(last) ||
    FALSE_POSITIVE.test(last) ||
    (AFFIRMATION_CLAUSE.test(last) && !NEGATION.test(last))
  ) {
    return true;
  }
  const rest = clauses.slice(1).join(" ");
  return (NO_DEFECT_CLAUSE.test(first) || FALSE_POSITIVE.test(first)) && !CONTINUATION.test(rest);
}
