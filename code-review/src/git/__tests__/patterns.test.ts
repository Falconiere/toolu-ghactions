// Unit coverage for the pattern normalizer split out of distill.ts. The grouping
// path runs against a REAL scratch git repo (identical edits landing at different
// line numbers in files of different lengths); the normalizer's strictness rules
// are asserted on literal SHAPED segments — that string form is the module's real
// input, produced verbatim by git/shape.ts.
import { describe, it, expect, afterEach } from "vitest";
import { fetchDiff } from "@/git/diff.js";
import { splitDiffByFile } from "@/git/chunk.js";
import { detectPatternGroups, parseHunkBody, hunkHash, type PatternInput } from "@/git/patterns.js";
import { git, setupGitRepo, writeFile, removeRepo } from "./helpers.js";

const repos: string[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) removeRepo(r);
});

const BASE = { baseBranch: "main", githubBaseRef: "main", maxFiles: 0, maxDiffLines: 0 } as const;

/** A file whose common tail block is preceded by `pad` identical filler lines. */
function padded(pad: number, inserted: boolean): string {
  const filler = Array.from({ length: pad }, () => "// filler");
  const tail = [
    "const p = 1;",
    "const q = 2;",
    ...(inserted ? ["const inserted = 0;"] : []),
    "const r = 3;",
  ];
  return `${[...filler, ...tail].join("\n")}\n`;
}

/** One literal shaped segment (git/shape.ts output form) for the normalizer tests. */
function shapedSegment(path: string, hunkHeader: string, body: string[]): PatternInput {
  return {
    path,
    diff: `${[
      `diff --git a/${path} b/${path}`,
      "index 1111111..2222222 100644",
      `--- a/${path}`,
      `+++ b/${path}`,
      hunkHeader,
      ...body,
    ].join("\n")}\n`,
  };
}

describe("detectPatternGroups", () => {
  it("groups the same edit landing at different line numbers (real git diff)", () => {
    const dir = setupGitRepo();
    repos.push(dir);
    const pads = { "src/a.ts": 6, "src/b.ts": 1, "src/c.ts": 3 };
    for (const [path, pad] of Object.entries(pads)) writeFile(dir, path, padded(pad, false));
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "base", "--quiet");
    git(dir, "checkout", "-b", "feature", "--quiet");
    for (const [path, pad] of Object.entries(pads)) writeFile(dir, path, padded(pad, true));
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "insert", "--quiet");

    const segments = splitDiffByFile(fetchDiff({ ...BASE, cwd: dir }).diff);
    // The hunks really do sit at different offsets…
    const headers = segments.map((s) => s.diff.match(/^@@ .*$/m)?.[0]);
    expect(new Set(headers).size).toBe(3);
    // …yet normalize to one hash.
    const groups = detectPatternGroups(segments);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(groups[0]?.exemplar).toBe("src/a.ts");
    expect(groups[0]?.summary).toBe("identical 1-line insertion in 3 files");
  });

  it("summarizes deletions and mixed changes by their real line counts", () => {
    const deletions = ["x.ts", "y.ts", "z.ts"].map((p) =>
      shapedSegment(p, "@@ -1,3 +1,1 @@", ["L1:  keep", "L---: -gone one", "L---: -gone two"]),
    );
    expect(detectPatternGroups(deletions)[0]?.summary).toBe("identical 2-line deletion in 3 files");

    const mixed = ["x.ts", "y.ts", "z.ts"].map((p) =>
      shapedSegment(p, "@@ -1,2 +1,2 @@", ["L---: -old", "L1: +new"]),
    );
    expect(detectPatternGroups(mixed)[0]?.summary).toBe("identical 2-line change in 3 files");
  });

  it("keeps differently-headed hunks apart (section heading is not stripped)", () => {
    const body = ["L---: -old", "L1: +new"];
    const inFoo = ["a.ts", "b.ts"].map((p) => shapedSegment(p, "@@ -1,2 +1,2 @@ fn foo()", body));
    const inBar = ["c.ts"].map((p) => shapedSegment(p, "@@ -9,2 +9,2 @@ fn bar()", body));
    expect(detectPatternGroups([...inFoo, ...inBar])).toEqual([]);
    // Same heading, different coordinates → one group of 3.
    const sameHeading = ["c.ts"].map((p) => shapedSegment(p, "@@ -9,2 +9,2 @@ fn foo()", body));
    expect(detectPatternGroups([...inFoo, ...sameHeading])[0]?.members).toEqual([
      "a.ts",
      "b.ts",
      "c.ts",
    ]);
  });

  it("ignores hunkless segments, unpathed segments, and sub-threshold sets", () => {
    const renameOnly = {
      path: "new.ts",
      diff: "diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n",
    };
    expect(parseHunkBody(renameOnly.diff)).toBeNull();

    const body = ["L---: -old", "L1: +new"];
    const three = ["a.ts", "b.ts", "c.ts"].map((p) => shapedSegment(p, "@@ -1,2 +1,2 @@", body));
    expect(detectPatternGroups([...three, renameOnly])[0]?.members).toEqual([
      "a.ts",
      "b.ts",
      "c.ts",
    ]);
    expect(detectPatternGroups(three.slice(0, 2))).toEqual([]);
    // An empty path can never be a member (it identifies no file to collapse).
    const unpathed = three.map((s) => ({ ...s, path: "" }));
    expect(detectPatternGroups(unpathed)).toEqual([]);
  });
});

describe("parseHunkBody", () => {
  it("strips priming prefixes and hunk coordinates, keeping markers and content", () => {
    const body = parseHunkBody(
      shapedSegment("a.ts", "@@ -4,3 +4,4 @@ fn f()", [
        "L4:  const p = 1;",
        "L---: -const q = 2;",
        "L5: +const q = 20;",
        "L6:  const r = 3;",
      ]).diff,
    );
    expect(body?.normalized).toBe(
      "@@ fn f()\n const p = 1;\n-const q = 2;\n+const q = 20;\n const r = 3;",
    );
    expect(body?.additions).toBe(1);
    expect(body?.deletions).toBe(1);
    // TRIMMED, not despaced: interior spacing is preserved so that an edit
    // inside a line can never read as whitespace-only (see distill.ts).
    expect(body?.added).toEqual(["const q = 20;"]);
    expect(body?.removed).toEqual(["const q = 2;"]);
    expect(body?.noNewlineMarker).toBe(false);
  });

  it("trims only the ENDS of a changed line, keeping interior whitespace verbatim", () => {
    const body = parseHunkBody(
      shapedSegment("a.ts", "@@ -1,1 +1,1 @@", [
        'L---: -    const sql = "select * from  t";   ',
        'L1: +\tconst sql = "select *from t";',
      ]).diff,
    );
    // Leading indent and trailing spaces gone; the in-literal spacing difference
    // survives, so distill's formatting check sees two DIFFERENT lines.
    expect(body?.removed).toEqual(['const sql = "select * from  t";']);
    expect(body?.added).toEqual(['const sql = "select *from t";']);
    expect(body?.added).not.toEqual(body?.removed);
  });

  it("flags a no-newline-at-eof marker and hashes stably regardless of trailing newlines", () => {
    const withMarker = shapedSegment("a.ts", "@@ -1,1 +1,1 @@", [
      "L---: -x",
      "\\ No newline at end of file",
      "L1: +x",
    ]);
    const body = parseHunkBody(withMarker.diff);
    // fetchDiff strips trailing newlines off the whole shaped diff, so the last
    // file's segment arrives without one: it must still hash identically.
    const trimmed = parseHunkBody(withMarker.diff.replace(/\n+$/, ""));
    if (body === null || trimmed === null) throw new Error("expected both segments to have hunks");
    expect(body.noNewlineMarker).toBe(true);
    expect(hunkHash(trimmed)).toBe(hunkHash(body));
  });
});
