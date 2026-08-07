// scenario-02-schema-flaky — AC-15 (2). One file makes the model emit output that
// cannot be parsed, every time it appears in an envelope. That is a `schema`
// failure, the ONE failure Layer 2 bisects (review/bisect.ts): re-sending the
// identical envelope is exactly what failed, so the split IS the retry.
//
// What must come out of that: the poison file — and ONLY the poison file — is
// `unreviewed`; its package costs at most 7 calls (BISECT_MAX_DEPTH = 2); the run
// that would otherwise have approved degrades to `error` because an approval over
// an unread file is a claim the review cannot make (AC-13); and FAIL_ON honors it.
import { afterEach, describe, expect, it } from "vitest";
import { runReview } from "@/pipeline.js";
import { writeFile } from "@/git/__tests__/helpers.js";
import { parseFailOn, shouldBlock } from "@/review/gate.js";
import {
  baseInputs,
  cleanupRepos,
  lastBody,
  markerState,
  prContext,
  scratchRepo,
  segmentLines,
  type Scratch,
} from "./harness.js";
import { fakeOctokit } from "./github.js";
import { APPROVED, diffPaths, modelServer, packageCalls } from "./model.js";

afterEach(cleanupRepos);

const POISON = "src/poison/p4.ts";
const CLEAN = "src/alpha/";

/** Two four-file packages the brief's hints keep apart: `src/alpha/` (clean) and
 *  `src/poison/` (whose fourth file the model chokes on). */
function twoPackageRepo(): Scratch {
  return scratchRepo((dir) => {
    for (let i = 1; i <= 4; i++) {
      writeFile(dir, `src/alpha/a${i}.ts`, `export const a${i} = ${i};\n`);
      writeFile(dir, `src/poison/p${i}.ts`, `export const p${i} = ${i};\n`);
    }
  });
}

const BRIEF = {
  intent: "Adds two independent modules.",
  global_facts: [],
  package_hints: [
    { name: "alpha", path_prefixes: ["src/alpha/"], risk: "normal" },
    { name: "poison", path_prefixes: ["src/poison/"], risk: "high" },
  ],
};

describe("scenario 2 — a schema-failing file (AC-15.2)", () => {
  it("bisects to the poison file alone, leaves the rest reviewed, and degrades the verdict", async () => {
    const { dir, headSha } = twoPackageRepo();
    const { octokit, rec } = fakeOctokit();
    // The budget is read off the REAL diff so each hint's four files pack into
    // exactly one package — never hard-coded from git's byte counts.
    const budget = Math.max(segmentLines(dir, CLEAN), segmentLines(dir, "src/poison/"));
    const server = modelServer({
      brief: BRIEF,
      reply: (call) => (diffPaths(call).includes(POISON) ? { fail: "schema" } : { ok: APPROVED }),
    });

    const result = await runReview({
      inputs: baseInputs({ maxChunkLines: budget, verbosity: "full" }),
      octokit,
      context: prContext(headSha),
      fetch: server.fetch,
      cwd: dir,
      now: () => 1_700_000_000_000,
    });

    // The poison package bisected: whole (4) → halves (2+2) → the failing half's
    // quarters (1+1). Five calls for it, well inside the 7-call ceiling; the clean
    // package was reviewed once and never split.
    const packages = packageCalls(server.calls);
    const poisonCalls = packages.filter((c) =>
      diffPaths(c).every((p) => p.startsWith("src/poison")),
    );
    expect(poisonCalls.length).toBe(5);
    expect(poisonCalls.length).toBeLessThanOrEqual(7);
    expect(packages.length - poisonCalls.length).toBe(1);
    // The last split really did isolate the poison file on its own.
    expect(poisonCalls.map(diffPaths)).toContainEqual([POISON]);

    // Coverage: only the poison file is unreviewed — the other seven were read.
    const body = lastBody(rec);
    expect(body).toContain("reviewed: 7 · unreviewed: 1");
    expect(body).toContain(`\`${POISON}\`: unreviewed`);

    // AC-13: the model approved every package it managed to answer, but a review
    // that never read one file cannot approve the PR — and FAIL_ON honors that.
    expect(result.verdict).toBe("error");
    expect(shouldBlock(result.verdict, parseFailOn("error"))).toBe(true);
    expect(shouldBlock(result.verdict, parseFailOn("changes"))).toBe(false);

    // AC-10: the exception list persists for a resume; the round is NOT complete,
    // so it neither advances the tree nor burns a round.
    const state = markerState(rec);
    expect("unreviewed_paths" in state && state.unreviewed_paths).toEqual([POISON]);
    expect("history" in state && state.history.length).toBe(0);
    expect("reviewed_tree" in state).toBe(false);
  }, 60_000);
});
