// evals/__tests__/scratch.test.ts — evals/scratch.ts's own tests: replaying a
// PrFile's patch into a REAL scratch git repo and reading the result back off
// disk / git itself (no mocks of scratch.ts's own logic). Run directly with
// `bun test evals/__tests__` — NOT part of `bun run check` (see scratch.ts's
// module doc).
import { describe, it, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { git, setupGitRepo, writeFile, removeRepo } from "../../src/git/__tests__/helpers.js";
import { parseFiles, buildScratchRepo, type Scratch } from "../scratch.js";
import type { PrFile } from "../fetch.js";

/** Build a REAL unified-diff hunk (via actual `git diff`) for one file's
 *  before/after content, then strip the `diff --git`/`---`/`+++` headers so
 *  the result matches GitHub's `patch` field shape exactly (hunk-only — see
 *  scratch.ts's module doc). This is the same real diff engine (git) GitHub
 *  itself runs to produce that field, just invoked directly instead of via
 *  `gh`. */
function realPatchFor(before: string, after: string): string {
  const dir = setupGitRepo();
  try {
    writeFile(dir, "sample.txt", before);
    git(dir, "add", "sample.txt");
    git(dir, "commit", "-m", "before", "--quiet");
    writeFile(dir, "sample.txt", after);
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "after", "--quiet");
    const raw = git(dir, "diff", "--no-color", "HEAD~1", "HEAD", "--", "sample.txt");
    const hunkStart = raw.indexOf("\n@@");
    if (hunkStart === -1) throw new Error(`no hunk in generated diff:\n${raw}`);
    return raw.slice(hunkStart + 1);
  } finally {
    removeRepo(dir);
  }
}

describe("scratch.ts — no-trailing-newline replay", () => {
  const scratchDirs: string[] = [];
  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) removeRepo(dir);
  });

  it("replays a post-image with no trailing newline VERBATIM (real patch with the marker)", () => {
    const patch = realPatchFor("alpha\nbeta\n", "alpha\nbeta-changed");
    expect(patch).toContain("\\ No newline at end of file");

    const file: PrFile = { filename: "sample.txt", status: "modified", patch };
    const scratch: Scratch = buildScratchRepo(parseFiles([file]), "main");
    scratchDirs.push(scratch.dir);

    // buildScratchRepo leaves "eval-head" (the post-image commit) checked out.
    const onDisk = readFileSync(join(scratch.dir, "sample.txt"), "utf8");
    expect(onDisk).toBe("alpha\nbeta-changed");
    expect(onDisk.endsWith("\n")).toBe(false);
  }, 60000);

  it("replays a pre-image with no trailing newline VERBATIM", () => {
    const patch = realPatchFor("alpha\nbeta", "alpha\nbeta\ngamma\n");
    expect(patch).toContain("\\ No newline at end of file");

    const file: PrFile = { filename: "sample.txt", status: "modified", patch };
    const scratch: Scratch = buildScratchRepo(parseFiles([file]), "main");
    scratchDirs.push(scratch.dir);

    const preImage = git(scratch.dir, "show", `${scratch.baseSha}:sample.txt`);
    expect(preImage).toBe("alpha\nbeta");
    expect(preImage.endsWith("\n")).toBe(false);
  }, 60000);

  it("still appends the trailing newline when the patch carries no marker", () => {
    const patch = realPatchFor("alpha\n", "alpha\nbeta\n");
    expect(patch).not.toContain("No newline at end of file");

    const file: PrFile = { filename: "sample.txt", status: "modified", patch };
    const scratch: Scratch = buildScratchRepo(parseFiles([file]), "main");
    scratchDirs.push(scratch.dir);

    const onDisk = readFileSync(join(scratch.dir, "sample.txt"), "utf8");
    expect(onDisk).toBe("alpha\nbeta\n");
  }, 60000);
});
