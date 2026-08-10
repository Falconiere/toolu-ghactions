// scenario-11-junk-only-approved — AC-8. The actacanvas PR #6 failure mode,
// replayed end to end: the model raises one "finding" per file, every single one
// self-negating ("The comment is accurate. No issue.", verbatim from that run)
// under an otherwise "changes" verdict. Before the rev-5 noise gate this sustained
// a blocking "Changes requested" with zero real findings; now `validateFindings`
// drops every one of them, `settleVerdict` sums the drop count into `removed`, and
// the findingless "changes" flips to "approved" — proven on the real pipeline
// (`runReview`), not just `validateFindings`/`settleVerdict` in isolation.
import { afterEach, describe, expect, it } from "vitest";
import { runReview } from "@/pipeline.js";
import { writeFile } from "@/git/__tests__/helpers.js";
import {
  baseInputs,
  cleanupRepos,
  inlineComments,
  lastBody,
  prContext,
  scratchRepo,
  type Scratch,
} from "./harness.js";
import { fakeOctokit } from "./github.js";
import { changes, diffPaths, modelServer, type ScriptedFinding } from "./model.js";

afterEach(cleanupRepos);

const FILES = 4;
const path = (n: number): string => `src/f${n}.ts`;

// The verbatim actacanvas PR #6 junk texts (AC-2), cycled across files so the
// end-to-end proof exercises more than one shape of the same failure.
const JUNK_TEXTS = [
  "The comment is accurate. No issue.",
  "No issue.",
  "This is acceptable. No violation.",
  "Not a real issue.",
];

function junkRepo(): Scratch {
  return scratchRepo((dir) => {
    for (let i = 0; i < FILES; i++) writeFile(dir, path(i), `export const f${i} = ${i};\n`);
  });
}

/** One junk finding per file the package was given, anchored to its one real
 *  changed line — nothing here fails the anchoring/confidence gates; ONLY the
 *  self-negation filter can be what drops them. */
function junkFindingsFor(paths: string[]): ScriptedFinding[] {
  return paths.map((p, i) => ({
    path: p,
    line: 1,
    severity: "medium" as const,
    confidence: "high" as const,
    category: "correctness",
    text: JUNK_TEXTS[i % JUNK_TEXTS.length] ?? "No issue.",
  }));
}

describe("scenario 11 — an all-junk review settles approved (AC-8)", () => {
  it("junk under an APPROVED verdict is also dropped, and the approval stands", async () => {
    // The other settle path: the model approves but still emits self-negating
    // noise — the filter must strip it without flipping the verdict.
    const { dir, headSha } = junkRepo();
    const { octokit, rec } = fakeOctokit();
    const server = modelServer({
      reply: (call) => ({
        ok: {
          review_plan: "Reviewed the package.",
          verdict: "approved",
          findings: junkFindingsFor(diffPaths(call)),
        },
      }),
    });

    const result = await runReview({
      inputs: baseInputs(),
      octokit,
      context: prContext(headSha),
      fetch: server.fetch,
      cwd: dir,
      now: () => 1_700_000_000_000,
    });

    expect(result.verdict).toBe("approved");
    const body = lastBody(rec);
    for (const text of JUNK_TEXTS) expect(body).not.toContain(text);
    expect(inlineComments(rec)).toHaveLength(0);
  });

  it("every finding is self-negating noise: validateFindings drops all of them and the findingless changes flips to approved", async () => {
    const { dir, headSha } = junkRepo();
    const { octokit, rec } = fakeOctokit();
    const server = modelServer({ reply: (call) => changes(junkFindingsFor(diffPaths(call))) });

    const result = await runReview({
      inputs: baseInputs(),
      octokit,
      context: prContext(headSha),
      fetch: server.fetch,
      cwd: dir,
      now: () => 1_700_000_000_000,
    });

    // The model itself said "changes" (it thought it had findings) — the flip is
    // entirely the noise gate's doing, not the model changing its mind.
    expect(result.verdict).toBe("approved");
    expect(result.findingsCount).toBe(0);
    expect(inlineComments(rec)).toHaveLength(0);

    const body = lastBody(rec);
    expect(body).toContain("✅ Approved");
    expect(body).toContain("### Findings (0)");
    expect(body).toContain("_No findings._");
    for (const text of JUNK_TEXTS) expect(body).not.toContain(text);
  }, 30_000);
});
