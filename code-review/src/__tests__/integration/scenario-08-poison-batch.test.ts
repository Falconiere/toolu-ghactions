// scenario-08-poison-batch — AC-15 (8). Fifty findings meet a hostile Reviews API:
// five files GitHub does not show in its own PR diff (no `patch` → nothing to
// anchor to), and one comment it rejects with the REAL 422 body PR-72 got back
// (github/__tests__/fixtures/pr72-createreview-422.txt).
//
// Before publish hardening, that single rejection zeroed the whole review. Now:
// comments post in batches of ≤ MAX_COMMENTS_PER_REVIEW, a 422 bisects its batch
// until the poison comment is alone, the survivors post, and NEITHER failure bucket
// disappears — the unanchored five and the dropped one are both reported in the
// sticky comment, because a finding the review produced may never just vanish.
import { afterEach, describe, expect, it } from "vitest";
import { runReview } from "@/pipeline.js";
import { writeFile } from "@/git/__tests__/helpers.js";
import { MAX_COMMENTS_PER_REVIEW } from "@/github/review.js";
import {
  baseInputs,
  cleanupRepos,
  inlineComments,
  lastBody,
  prContext,
  scratchRepo,
  type Scratch,
} from "./harness.js";
import { fakeOctokit, patchCovering, pr72FixtureText } from "./github.js";
import { changes, modelServer, type ScriptedFinding } from "./model.js";

afterEach(cleanupRepos);

const TOTAL = 50;
const UNANCHORABLE = 5; // the last five: GitHub returns no patch for them
const POISON = "src/f05.ts";
const path = (n: number): string => `src/f${String(n).padStart(2, "0")}.ts`;
const findingText = (n: number): string => `Finding number ${n} needs a bounds check.`;

function fiftyFileRepo(): Scratch {
  return scratchRepo((dir) => {
    for (let i = 0; i < TOTAL; i++) writeFile(dir, path(i), `export const f${i} = ${i};\n`);
  });
}

/** One distinct finding per file — distinct text, so nothing clusters and each one
 *  really does need its own inline comment. */
function fiftyFindings(): ScriptedFinding[] {
  return Array.from({ length: TOTAL }, (_, i) => ({
    path: path(i),
    line: 1,
    severity: "medium" as const,
    confidence: "high" as const,
    category: "correctness",
    text: findingText(i),
  }));
}

/** GitHub's own view of the PR: a patch for every file except the last five. */
function githubPatches(): Map<string, string | undefined> {
  const patches = new Map<string, string | undefined>();
  for (let i = 0; i < TOTAL; i++) {
    patches.set(path(i), i < TOTAL - UNANCHORABLE ? patchCovering(1) : undefined);
  }
  return patches;
}

describe("scenario 8 — a poison comment and five unanchorable files (AC-15.8)", () => {
  it("batches ≤30, bisects the 422 down to the poison comment, and reports both failures", async () => {
    const { dir, headSha } = fiftyFileRepo();
    const { octokit, rec } = fakeOctokit({ patches: githubPatches(), poisonPath: POISON });
    const server = modelServer({ reply: () => changes(fiftyFindings()) });

    const result = await runReview({
      inputs: baseInputs(),
      octokit,
      context: prContext(headSha),
      fetch: server.fetch,
      cwd: dir,
      now: () => 1_700_000_000_000,
    });

    // The fixture really is the 422 the Reviews API answers with (AC-5's evidence).
    expect(pr72FixtureText()).toContain("Unprocessable Entity");
    expect(result.findingsCount).toBe(TOTAL);

    // No request body ever carried more than one batch's worth of comments…
    for (const review of rec.reviews) {
      expect(review.comments.length).toBeLessThanOrEqual(MAX_COMMENTS_PER_REVIEW);
    }
    // …and the poison batch really was bisected: far more attempts than accepted
    // reviews, ending in a single-comment attempt that GitHub still refused.
    expect(rec.attempts.length).toBeGreaterThan(rec.reviews.length);
    expect(rec.attempts).toContain(1);

    // Every anchorable finding but the poison one posted — one bad comment no
    // longer sinks its 29 siblings.
    const postedPaths = inlineComments(rec).map((c) => c.path);
    expect(postedPaths.length).toBe(TOTAL - UNANCHORABLE - 1);
    expect(postedPaths).not.toContain(POISON);
    for (let i = 0; i < TOTAL - UNANCHORABLE; i++) {
      if (path(i) !== POISON) expect(postedPaths).toContain(path(i));
    }

    // Both failure buckets are reported in the sticky comment, by name.
    const body = lastBody(rec);
    expect(body).toContain(`### Unanchored findings (${UNANCHORABLE})`);
    for (let i = TOTAL - UNANCHORABLE; i < TOTAL; i++) {
      expect(body).toContain(`\`${path(i)}:1\`: medium: ${findingText(i)}`);
    }
    expect(body).toContain("### Findings GitHub rejected inline (1)");
    expect(body).toContain(`\`${POISON}:1\`: medium: ${findingText(5)}`);
  }, 60_000);
});
