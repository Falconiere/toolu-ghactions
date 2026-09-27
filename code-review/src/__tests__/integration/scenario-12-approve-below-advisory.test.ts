// scenario-12-approve-below-advisory — AC-6. Issue #124's motivating case,
// replayed end to end: a real "changes" review whose only findings are medium
// severity, under APPROVE_BELOW: high, must still set the merge-approved label
// (not request-changes) — proven on the real pipeline (`runReview`), while the
// comment body and the reported verdict still read "changes" (only the label
// rule changes, per the spec's non-goals).
import { afterEach, describe, expect, it } from "vitest";
import { runReview } from "@/pipeline.js";
import { writeFile } from "@/git/__tests__/helpers.js";
import {
  baseInputs,
  cleanupRepos,
  lastBody,
  prContext,
  scratchRepo,
  type Scratch,
} from "./harness.js";
import { fakeOctokit } from "./github.js";
import { changes, diffPaths, modelServer, type ScriptedFinding } from "./model.js";

afterEach(cleanupRepos);

const FILES = 2;
const path = (n: number): string => `src/f${n}.ts`;

function twoFileRepo(): Scratch {
  return scratchRepo((dir) => {
    for (let i = 0; i < FILES; i++) writeFile(dir, path(i), `export const f${i} = ${i};\n`);
  });
}

/** The exact source line {@link twoFileRepo} wrote at `path` — must match verbatim
 *  for source-evidence validation to keep the finding (spec §Publish hardening). */
function lineFor(p: string): string {
  const n = p.slice("src/f".length, -".ts".length);
  return `export const f${n} = ${n};`;
}

function mediumFindingsFor(paths: string[]): ScriptedFinding[] {
  return paths.map((p) => ({
    path: p,
    line: 1,
    severity: "medium" as const,
    confidence: "high" as const,
    category: "correctness",
    quoted_line: lineFor(p),
    text: `Consider renaming this export in ${p}.`,
  }));
}

describe("scenario 12 — sub-threshold findings stay advisory under APPROVE_BELOW (AC-6)", () => {
  it("a 'changes' verdict with only medium findings still sets merge-approved under APPROVE_BELOW: high", async () => {
    const { dir, headSha } = twoFileRepo();
    const { octokit, rec } = fakeOctokit();
    const server = modelServer({
      reply: (call) => changes(mediumFindingsFor(diffPaths(call))),
    });

    const result = await runReview({
      inputs: baseInputs({ approveBelow: "high", manageLabels: true }),
      octokit,
      context: prContext(headSha),
      fetch: server.fetch,
      cwd: dir,
      now: () => 1_700_000_000_000,
    });

    // The verdict/output/comment still read "changes" — only the label differs.
    expect(result.verdict).toBe("changes");
    expect(lastBody(rec)).toContain("Changes requested");

    expect(rec.addedLabels.flat()).toContain("merge-approved");
    expect(rec.addedLabels.flat()).not.toContain("request-changes");
  });

  it("a 'changes' verdict with a high finding present still sets request-changes under APPROVE_BELOW: high", async () => {
    const { dir, headSha } = twoFileRepo();
    const { octokit, rec } = fakeOctokit();
    const server = modelServer({
      reply: (call) => {
        const [first, ...rest] = diffPaths(call);
        const findings: ScriptedFinding[] = [
          ...(first !== undefined
            ? [
                {
                  path: first,
                  line: 1,
                  severity: "high" as const,
                  confidence: "high" as const,
                  category: "correctness",
                  quoted_line: lineFor(first),
                  text: `A real bug in ${first}.`,
                },
              ]
            : []),
          ...mediumFindingsFor(rest),
        ];
        return changes(findings);
      },
    });

    const result = await runReview({
      inputs: baseInputs({ approveBelow: "high", manageLabels: true }),
      octokit,
      context: prContext(headSha),
      fetch: server.fetch,
      cwd: dir,
      now: () => 1_700_000_000_000,
    });

    expect(result.verdict).toBe("changes");
    expect(rec.addedLabels.flat()).toContain("request-changes");
    expect(rec.addedLabels.flat()).not.toContain("merge-approved");
  });
});
