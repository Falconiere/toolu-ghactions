// scenario-03-transport-failure — AC-15 (3). The mirror image of scenario 2: the
// SAME package fails, but at the transport layer (a non-retryable HTTP error, not
// unparseable output). A transport failure says nothing about envelope size, so
// splitting it would only multiply load against an already-struggling provider —
// Layer 2 must NOT bisect it (spec §Layer 2).
//
// The call count is therefore PINNED: today's single retry at depth 0, and nothing
// more. The whole package is ledgered unreviewed (no half of it was ever read) and
// the verdict degrades exactly as it does for any other coverage hole.
import { afterEach, describe, expect, it } from "vitest";
import { runReview } from "@/pipeline.js";
import { writeFile } from "@/git/__tests__/helpers.js";
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

const DOWN = "src/down/";
const DOWN_FILES = [1, 2, 3, 4].map((i) => `src/down/d${i}.ts`);

/** Two four-file packages the brief keeps apart; the provider refuses the second. */
function twoPackageRepo(): Scratch {
  return scratchRepo((dir) => {
    for (let i = 1; i <= 4; i++) {
      writeFile(dir, `src/alpha/a${i}.ts`, `export const a${i} = ${i};\n`);
      writeFile(dir, `src/down/d${i}.ts`, `export const d${i} = ${i};\n`);
    }
  });
}

const BRIEF = {
  intent: "Adds two independent modules.",
  global_facts: [],
  package_hints: [
    { name: "alpha", path_prefixes: ["src/alpha/"], risk: "normal" },
    { name: "down", path_prefixes: [DOWN], risk: "normal" },
  ],
};

describe("scenario 3 — a transport failure (AC-15.3)", () => {
  it("never bisects: the call count is pinned and the whole package is unreviewed", async () => {
    const { dir, headSha } = twoPackageRepo();
    const { octokit, rec } = fakeOctokit();
    const budget = Math.max(segmentLines(dir, "src/alpha/"), segmentLines(dir, DOWN));
    const server = modelServer({
      brief: BRIEF,
      reply: (call) =>
        diffPaths(call).some((p) => p.startsWith(DOWN)) ? { fail: "transport" } : { ok: APPROVED },
    });

    const result = await runReview({
      inputs: baseInputs({ maxChunkLines: budget, verbosity: "full" }),
      octokit,
      context: prContext(headSha),
      fetch: server.fetch,
      cwd: dir,
      now: () => 1_700_000_000_000,
    });

    // PINNED: one call for the clean package, and exactly TWO for the failing one
    // (the attempt plus today's single depth-0 retry). A bisection would have cost
    // five, and every extra call would have carried a strict SUBSET of the package.
    const packages = packageCalls(server.calls);
    const downCalls = packages.filter((c) => diffPaths(c).some((p) => p.startsWith(DOWN)));
    expect(packages.length).toBe(3);
    expect(downCalls.length).toBe(2);
    for (const call of downCalls) expect(diffPaths(call)).toEqual(DOWN_FILES);

    // Nothing in that package was read, so all four files are unreviewed…
    const body = lastBody(rec);
    expect(body).toContain("reviewed: 4 · unreviewed: 4");
    for (const path of DOWN_FILES) expect(body).toContain(`\`${path}\`: unreviewed`);

    // …and the run degrades exactly as any other coverage hole does.
    expect(result.verdict).toBe("error");
    const state = markerState(rec);
    expect("unreviewed_paths" in state && state.unreviewed_paths).toEqual(DOWN_FILES);
    expect("reviewed_tree" in state).toBe(false);
  }, 60_000);
});
