// scenario-17-reverted-file — a file reverted to its base content has LEFT the PR: it is
// in no ledger bucket (the ledger lists every base..head path), so its prior finding is
// not carried. Carrying it kept the PR blocked forever on code that no longer differs
// from base, with a thread nobody could ever see resolved.
import { afterEach, describe, expect, it } from "vitest";
import { runReview } from "@/pipeline.js";
import { git, writeFile } from "@/git/__tests__/helpers.js";
import { extractFpMarker } from "@/review/fpmarker.js";
import {
  baseInputs,
  cleanupRepos,
  commitAll,
  inlineComments,
  markerState,
  prContext,
  scratchRepo,
} from "./harness.js";
import { fakeOctokit, type SeedThread } from "./github.js";
import { APPROVED, changes, modelServer } from "./model.js";

afterEach(cleanupRepos);

describe("scenario 17 — a reverted file's finding is dropped, its thread resolved", () => {
  it("reverting the flagged file to base approves the PR and resolves the old thread", async () => {
    const base = { "src/a.ts": "export const a = 0;\n", "src/b.ts": "export const b = 0;\n" };
    const { dir, headSha } = scratchRepo((d) => {
      writeFile(d, "src/a.ts", "export const a = 1;\n");
      writeFile(d, "src/b.ts", "export const b = 1;\n");
    }, base);
    const threads: SeedThread[] = [];
    const { octokit, rec } = fakeOctokit({ threads });
    const inputs = baseInputs();

    const r1 = await runReview({
      inputs,
      octokit,
      context: prContext(headSha),
      fetch: modelServer({
        reply: () =>
          changes([
            {
              path: "src/b.ts",
              line: 1,
              severity: "high",
              confidence: "high",
              category: "correctness",
              text: "b must stay 0: the wire format pins it.",
              quoted_line: "export const b = 1;",
            },
          ]),
      }).fetch,
      cwd: dir,
    });
    expect(r1.verdict).toBe("changes");
    const posted = inlineComments(rec)[0];
    threads.push({
      threadId: "T_b",
      rootCommentId: 8001,
      fp: extractFpMarker(posted?.body ?? "") ?? "",
      path: "src/b.ts",
      line: 1,
      rootBody: posted?.body ?? "",
    });

    // The author reverts b.ts to base with real git; a.ts is untouched since round 1.
    git(dir, "checkout", "main", "--", "src/b.ts");
    const reverted = commitAll(dir, "revert b");
    const r2 = await runReview({
      inputs,
      octokit,
      context: prContext(reverted),
      fetch: modelServer({ reply: () => ({ ok: APPROVED }) }).fetch,
      cwd: dir,
    });

    expect(r2.verdict).toBe("approved");
    expect(r2.findingsCount).toBe(0);
    expect(rec.resolved).toEqual(["T_b"]);
    const state = markerState(rec);
    expect("findings" in state ? state.findings : ["missing state"]).toEqual([]);
  }, 60_000);
});
