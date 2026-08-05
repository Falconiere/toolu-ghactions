// report/categories.ts — normalizes a finding's free-text `category` into a
// fixed, reportable vocabulary. Used ONLY on the way into the wire payload
// (src/report/payload.ts); `Finding.category` (src/llm/schema.ts) and
// `fingerprint()` (src/state.ts) hash the RAW category and must never see
// this normalizer, or every in-flight PR's fingerprints would rotate.

/**
 * The fixed set of categories a review-run payload may report. Derived from
 * the eight review-checklist dimensions (`prompts/review-checklist.txt:36-63`),
 * plus `"other"` for anything that does not map onto one of them.
 */
export type ReportCategory =
  | "correctness"
  | "security"
  | "performance"
  | "test-coverage"
  | "doc-accuracy"
  | "assertions"
  | "migration"
  | "conventions"
  | "other";

/** Lowercase + strip everything but letters and digits, collapsing case and
 *  punctuation variants ("Test Coverage", "test_coverage", "TEST-COVERAGE")
 *  onto one canonical lookup key. */
function canonicalKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Alias table, same rationale as `SEVERITY_ALIASES` (`src/llm/schema.ts:136`):
 * only synonyms that map UNAMBIGUOUSLY onto one of the nine categories are
 * listed. Keys are already in canonical form (see {@link canonicalKey}) —
 * the eight checklist headings verbatim, then the paraphrases a model
 * actually emits for each.
 */
export const CATEGORY_ALIASES: Record<string, ReportCategory> = {
  // CORRECTNESS
  correctness: "correctness",
  bug: "correctness",
  correctnessbug: "correctness",
  // SECURITY
  security: "security",
  sec: "security",
  privacy: "security",
  // PERFORMANCE
  performance: "performance",
  perf: "performance",
  scalability: "performance",
  // TEST COVERAGE
  testcoverage: "test-coverage",
  tests: "test-coverage",
  test: "test-coverage",
  coverage: "test-coverage",
  // DOC/COMMENT ACCURACY
  doccommentaccuracy: "doc-accuracy",
  docs: "doc-accuracy",
  documentation: "doc-accuracy",
  comment: "doc-accuracy",
  // TIGHT ASSERTIONS
  tightassertions: "assertions",
  assertion: "assertions",
  assertions: "assertions",
  // MIGRATION WARNINGS
  migrationwarnings: "migration",
  migration: "migration",
  dbmigration: "migration",
  // CONVENTION ADHERENCE
  conventionadherence: "conventions",
  convention: "conventions",
  conventions: "conventions",
  styleguide: "conventions",
  maintainability: "conventions",
};

/**
 * Map a model-authored, free-text `category` onto the fixed reporting
 * vocabulary. Lower-cases, strips non-alphanumerics, and looks up
 * {@link CATEGORY_ALIASES}; absent or unrecognized input becomes `"other"` —
 * never `null`, unlike `normalizeVerdict`, since every reported finding needs
 * a bucket to land in.
 */
export function normalizeCategory(raw?: string): ReportCategory {
  if (raw === undefined) return "other";
  const key = canonicalKey(raw);
  if (key === "") return "other";
  return CATEGORY_ALIASES[key] ?? "other";
}
