// scenario-06-wall-clock-resume — AC-15 (6). MAX_WALL_MS runs out before the first
// package is even attempted, so round 1 is a PARTIAL run: every path is `pending`,
// the exception list persists, and — the part that matters for MAX_ROUNDS — NO
// history entry is appended and `reviewed_tree` is NOT advanced. A resumed round
// must never burn a review round or make the next push think it was covered.
//
// Then `@toolu resume` (github/event.ts) picks the round back up. It reviews the
// exception paths ONLY — a file added in the meantime is carried, not swept in —
// its findings survive all the way to the posted comment, and because coverage is
// finally complete the round appends EXACTLY ONE history entry and records its tree.
import { afterEach, describe, expect, it } from "vitest";
import { runReview } from "@/pipeline.js";
import { git, writeFile } from "@/git/__tests__/helpers.js";
import {
  baseInputs,
  cleanupRepos,
  commentContext,
  commitAll,
  lastBody,
  markerState,
  prContext,
  scratchRepo,
  treeSha,
  type Scratch,
} from "./harness.js";
import { fakeOctokit } from "./github.js";
import { changes, diffPaths, modelServer, packageCalls } from "./model.js";

afterEach(cleanupRepos);

const A = "src/a.ts";
const B = "src/b.ts";
const LATER = "src/later.ts";
const FINDING_TEXT = "This branch drops the error instead of propagating it.";

function twoFileRepo(): Scratch {
  return scratchRepo((dir) => {
    writeFile(dir, A, "export const a = 1;\n");
    writeFile(dir, B, "export const b = 2;\n");
  });
}

describe("scenario 6 — the wall clock, then @toolu resume (AC-15.6)", () => {
  it("persists pending work without burning a round, then resumes it to completion", async () => {
    const { dir, headSha } = twoFileRepo();
    const { octokit, rec } = fakeOctokit();
    // A pinned clock far in the past + any positive budget ⇒ the deadline is
    // already expired when review/bisect.ts reads the REAL clock. Deterministic:
    // no sleeping, no race.
    const round1 = modelServer({ reply: () => changes([]) });
    const partial = await runReview({
      inputs: baseInputs({ maxWallMs: 1 }),
      octokit,
      context: prContext(headSha),
      fetch: round1.fetch,
      cwd: dir,
      now: () => 1_700_000_000_000,
    });

    // Not one package was attempted — the budget is checked BEFORE each call.
    expect(packageCalls(round1.calls)).toEqual([]);
    expect(partial.verdict).toBe("error");
    const body1 = lastBody(rec);
    expect(body1).toContain(`\`${A}\`: pending`);
    expect(body1).toContain(`\`${B}\`: pending`);

    // AC-10: pending (not unreviewed) persists; no history entry, no tree.
    const state1 = markerState(rec);
    expect("pending_paths" in state1 && state1.pending_paths).toEqual([A, B]);
    expect("history" in state1 && state1.history.length).toBe(0);
    expect("reviewed_tree" in state1).toBe(false);

    // ── Meanwhile the author pushes another file, then comments `@toolu resume`.
    writeFile(dir, LATER, "export const later = 3;\n");
    commitAll(dir, "add later");
    git(dir, "fetch", dir, "HEAD"); // real fetch writes FETCH_HEAD (update-ref refuses pseudorefs on newer git)

    const round2 = modelServer({
      reply: () =>
        changes([
          {
            path: A,
            line: 1,
            severity: "high",
            confidence: "high",
            category: "error-handling",
            text: FINDING_TEXT,
          },
        ]),
    });
    const resumed = await runReview({
      inputs: baseInputs(),
      octokit,
      context: commentContext(headSha, "@toolu resume"),
      fetch: round2.fetch,
      cwd: dir,
      now: () => 1_700_000_100_000,
      lookupPermission: async () => "write",
    });

    // Only the exception paths were reviewed — the newly pushed file is carried,
    // to be picked up by the next push's own tree diff.
    const packages = packageCalls(round2.calls);
    expect(packages.length).toBe(1);
    expect(diffPaths(packages[0] ?? { system: "", user: "" }).sort()).toEqual([A, B]);

    // The resume run's finding reaches the verdict AND the comment body.
    expect(resumed.verdict).toBe("changes");
    expect(resumed.findingsCount).toBe(1);
    const body2 = lastBody(rec);
    expect(body2).toContain(FINDING_TEXT);
    expect(body2).toContain("reviewed: 2 · carried: 1");

    // Coverage is complete now, so exactly ONE history entry exists for the two
    // runs together, the exception list is cleared, and the tree is recorded.
    const state2 = markerState(rec);
    expect("history" in state2 && state2.history.length).toBe(1);
    expect("pending_paths" in state2).toBe(false);
    expect("reviewed_tree" in state2 && state2.reviewed_tree).toBe(treeSha(dir));
  }, 60_000);
});
