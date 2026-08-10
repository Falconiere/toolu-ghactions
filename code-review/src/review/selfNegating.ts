// review/selfNegating.ts — one responsibility: decide whether a finding's own
// TEXT concludes there is no defect (spec §rev-5 self-negation rule). Split out
// of validate.ts so that file stays a pure gate pipeline and this stays a pure
// text predicate — the case that motivated it is real: deepseek-v4-flash on
// actacanvas PR #6 emitted one junk "finding" per reviewed line reading "The
// comment is accurate. No issue." — structurally valid (anchored, high
// confidence), so the purely-structural gates in validate.ts never touched it.
//
// Rule (verbatim from the design doc): normalize the text, split it into
// sentences, and drop the finding when ANY sentence — in full, after an optional
// leading "This is|That is|It is" and its own trailing punctuation are stripped —
// equals one of the no-defect phrases below. `acceptable`/`fine` are the two
// exceptions: they only count in the FINAL sentence, because a concede-then-accuse
// finding ("This is fine. The real bug is the missing await on line 12.") uses
// "fine" to set up the real defect that follows, not to conclude there is none.
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

/** "acceptable"/"fine" alone are common concession words — they only mean
 *  no-defect when they are the LAST sentence (nothing follows to contradict them). */
const FINAL_ONLY_PATTERNS: readonly RegExp[] = [/^acceptable$/i, /^fine$/i];

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
 * True when the finding's text concludes — in any sentence, or in its final
 * sentence for the "acceptable"/"fine" concession words — that there is no
 * defect. Callers drop the finding rather than report it.
 */
export function isSelfNegating(text: string): boolean {
  const sentences = normalizeText(text)
    .split(SENTENCE_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (sentences.length === 0) return false;
  const lastIndex = sentences.length - 1;

  return sentences.some((sentence, i) => {
    const stripped = stripSentence(sentence);
    if (NEGATION_PATTERNS.some((p) => p.test(stripped))) return true;
    return i === lastIndex && FINAL_ONLY_PATTERNS.some((p) => p.test(stripped));
  });
}
