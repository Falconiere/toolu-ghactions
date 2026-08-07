// scenario-05-rebase-identical-tree — AC-15 (5). The author rebases and force-
// pushes: every commit sha changes, the CONTENT does not. Because the marker
// records a root TREE sha and trees are content-addressed (spec §True incremental),
// round 2's file set is empty and the round costs zero model calls — no
// cartographer, no package reviewers.
//
// The trap this pins: zero files reviewed must NOT read as "everything is clean".
// The prior finding is carried, its thread stays open, and the verdict stands.
import { afterEach, describe, expect, it } from "vitest";
import { runReview } from "@/pipeline.js";
import { git, writeFile } from "@/git/__tests__/helpers.js";
import { extractFpMarker } from "@/review/fpmarker.js";
import {
  baseInputs,
  cleanupRepos,
  inlineComments,
  lastBody,
  markerState,
  prContext,
  scratchRepo,
  treeSha,
  type Scratch,
} from "./harness.js";
import { fakeOctokit, type SeedThread } from "./github.js";
import { changes, diffPaths, modelServer } from "./model.js";

afterEach(cleanupRepos);

const BUGGY = "src/util.ts";
const BUG_TEXT = "Function add performs subtraction.";

function smallRepo(): Scratch {
  return scratchRepo((dir) => {
    writeFile(
      dir,
      BUGGY,
      "export function add(a: number, b: number): number {\n  return a - b;\n}\n",
    );
    for (let i = 0; i < 3; i++) writeFile(dir, `src/pad/f${i}.ts`, `export const pad = ${i};\n`);
  });
}

describe("scenario 5 — a rebase that preserves the tree (AC-15.5)", () => {
  it("reviews nothing at all, and carries every prior finding instead of clearing it", async () => {
    const { dir, headSha } = smallRepo();
    const threads: SeedThread[] = [];
    const { octokit, rec } = fakeOctokit({ threads });
    const bug = {
      path: BUGGY,
      line: 2,
      severity: "high" as const,
      confidence: "high" as const,
      category: "correctness",
      text: BUG_TEXT,
    };
    const round1 = modelServer({
      reply: (call) => (diffPaths(call).includes(BUGGY) ? changes([bug]) : changes([])),
    });

    await runReview({
      inputs: baseInputs(),
      octokit,
      context: prContext(headSha),
      fetch: round1.fetch,
      cwd: dir,
      now: () => 1_700_000_000_000,
    });

    const tree1 = treeSha(dir);
    expect("reviewed_tree" in markerState(rec) && markerState(rec).reviewed_tree).toBe(tree1);
    const posted = inlineComments(rec)[0];
    threads.push({
      threadId: "T_util",
      rootCommentId: 8001,
      fp: extractFpMarker(posted?.body ?? "") ?? "",
      path: posted?.path ?? "",
      line: posted?.line ?? null,
      rootBody: posted?.body ?? "",
    });

    // ── The force-push: amend rewrites the commit (new sha, new message) while
    // the tree it points at is byte-identical.
    git(dir, "commit", "--amend", "-m", "rebased onto main", "--quiet");
    const head2 = git(dir, "rev-parse", "HEAD").trim();
    expect(head2).not.toBe(headSha);
    expect(treeSha(dir)).toBe(tree1);

    const round2 = modelServer({ reply: () => changes([]) });
    const second = await runReview({
      inputs: baseInputs(),
      octokit,
      context: prContext(head2),
      fetch: round2.fetch,
      cwd: dir,
      now: () => 1_700_000_100_000,
    });

    // Zero files in scope → zero model calls of ANY layer: the round is free.
    expect(round2.calls).toEqual([]);
    expect(lastBody(rec)).toContain("carried: 4");

    // And a round that read nothing cannot approve anything away.
    expect(second.verdict).toBe("changes");
    expect(second.findingsCount).toBe(1);
    expect(rec.resolved).toEqual([]);
    const state = markerState(rec);
    expect("findings" in state ? state.findings.map((f) => f.path) : []).toEqual([BUGGY]);
  }, 60_000);
});
