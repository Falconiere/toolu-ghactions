// scenario-10-rules-changed — AC-15 (10). The PR edits CLAUDE.md, a project-rules
// file. The rules block every reviewer reads is gathered from the BASE ref (anti
// rule-injection), so it is now potentially stale — and the model has no way to know
// that unless we tell it.
//
// Two trust boundaries have to hold at once in every package envelope:
//   - the rules-changed notice is TRUSTED and code-generated (a list of paths this
//     pipeline classified), so it is rendered OUTSIDE any untrusted fence;
//   - the Layer 1 brief is UNTRUSTED (it can echo the PR title/body straight back),
//     so every byte of it stays INSIDE `<<<BRIEF … BRIEF>>>` and nowhere else.
import { afterEach, describe, expect, it } from "vitest";
import { runReview } from "@/pipeline.js";
import { writeFile } from "@/git/__tests__/helpers.js";
import {
  baseInputs,
  cleanupRepos,
  prContext,
  scratchRepo,
  segmentLines,
  type Scratch,
} from "./harness.js";
import { fakeOctokit } from "./github.js";
import { APPROVED, modelServer, packageCalls } from "./model.js";

afterEach(cleanupRepos);

const NOTICE = "## Rules files changed in this PR (TRUSTED, code-generated)";
const FENCE_OPEN = "<<<BRIEF";
const FENCE_CLOSE = "BRIEF>>>";
/** A string that exists nowhere but the cartographer's answer, so finding it in a
 *  package prompt proves the brief reached it — and WHERE. */
const SENTINEL = "SENTINEL-BRIEF-INTENT-9f2a";

/** A repo whose PR edits the rules file itself alongside real code. */
function rulesChangedRepo(): Scratch {
  const base: Record<string, string> = { "CLAUDE.md": "# Rules\n\nAlways use tabs.\n" };
  for (let i = 0; i < 4; i++) base[`src/m${i}.ts`] = `export const m${i} = ${i};\n`;
  return scratchRepo((dir) => {
    writeFile(dir, "CLAUDE.md", "# Rules\n\nAlways use spaces.\n");
    for (let i = 0; i < 4; i++) writeFile(dir, `src/m${i}.ts`, `export const m${i} = ${i + 10};\n`);
  }, base);
}

describe("scenario 10 — a PR that edits the rules file (AC-15.10)", () => {
  it("puts the trusted rules-changed notice in every envelope, with the brief fenced", async () => {
    const { dir, headSha } = rulesChangedRepo();
    const { octokit } = fakeOctokit();
    // Half the diff per package → several packages, so "every envelope" has teeth.
    const budget = Math.ceil(segmentLines(dir, "") / 2);
    const server = modelServer({
      brief: {
        intent: `${SENTINEL} — tightens the formatting rule and updates four modules.`,
        global_facts: ["The rules file itself changed in this PR."],
        package_hints: [],
      },
      reply: () => ({ ok: APPROVED }),
    });

    await runReview({
      inputs: baseInputs({ maxChunkLines: budget, checkProjectRules: true }),
      octokit,
      context: prContext(headSha),
      fetch: server.fetch,
      cwd: dir,
      now: () => 1_700_000_000_000,
    });

    const packages = packageCalls(server.calls);
    expect(packages.length).toBeGreaterThanOrEqual(2);

    for (const call of packages) {
      const noticeAt = call.user.indexOf(NOTICE);
      const fenceOpenAt = call.user.indexOf(FENCE_OPEN);
      const fenceCloseAt = call.user.indexOf(FENCE_CLOSE);
      // The notice is present, names the changed rules file, and says the base-ref
      // rules may be stale.
      expect(noticeAt).toBeGreaterThanOrEqual(0);
      expect(call.user).toContain("Rules file(s) CLAUDE.md changed in this PR");
      expect(call.user).toContain("base-ref rules may be stale");
      // …and it sits OUTSIDE the untrusted brief fence.
      expect(fenceOpenAt).toBeGreaterThanOrEqual(0);
      expect(fenceCloseAt).toBeGreaterThan(fenceOpenAt);
      expect(noticeAt < fenceOpenAt || noticeAt > fenceCloseAt).toBe(true);

      // The brief's own content appears exactly once, and only inside that fence.
      const occurrences = call.user.split(SENTINEL).length - 1;
      expect(occurrences).toBe(1);
      const sentinelAt = call.user.indexOf(SENTINEL);
      expect(sentinelAt).toBeGreaterThan(fenceOpenAt);
      expect(sentinelAt).toBeLessThan(fenceCloseAt);
    }
  }, 60_000);
});
