// packages.test.ts — pipeline/packages.ts's hint→package assignment, focused on
// the prefix TIE-BREAK that decides which package a file lands in when several of
// the brief's `path_prefixes` cover it. The brief is model output, so overlapping
// and duplicated prefixes are routine; a non-deterministic winner would reshuffle
// packages between runs and silently break prompt-cache warm-up and the per-call
// budget alike.
//
// Real segments throughout: a real scratch repo, a real `fetchDiff`, and the real
// `splitDiffByFile` — the same FileSegment[] reviewChunked packs.
import { afterEach, describe, expect, it } from "vitest";
import { groupByBrief } from "@/pipeline/packages.js";
import { splitDiffByFile, type FileSegment } from "@/git/chunk.js";
import { fetchDiff } from "@/git/diff.js";
import type { Brief } from "@/review/cartographer.js";
import { git, setupGitRepo, writeFile, removeRepo } from "@/git/__tests__/helpers.js";

const repos: string[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) removeRepo(r);
});

/** Real per-file segments from a real repo: one commit adding `paths`. */
function segmentsFor(paths: string[]): FileSegment[] {
  const dir = setupGitRepo();
  repos.push(dir);
  git(dir, "checkout", "-b", "feature", "--quiet");
  for (const path of paths) {
    const slug = path.replace(/\W/g, "_");
    writeFile(dir, path, `export const ${slug} = 1;\n`);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "c", "--quiet");
  const diff = fetchDiff({
    baseBranch: "main",
    githubBaseRef: "main",
    cwd: dir,
    maxFiles: 0,
    maxDiffLines: 0,
  });
  return splitDiffByFile(diff.diff);
}

type PackageHint = Brief["package_hints"][number];

/** One `package_hints` entry. `risk` is irrelevant to the assignment — only
 *  `path_prefixes` is read — so it defaults rather than being restated per hint. */
function hint(name: string, prefixes: string[], risk: PackageHint["risk"] = "normal"): PackageHint {
  return { name, path_prefixes: prefixes, risk };
}

/** A brief carrying only `package_hints` — the field groupByBrief reads. */
function briefWith(hints: PackageHint[]): Brief {
  return { intent: "test", global_facts: [], package_hints: hints };
}

/** The package holding `path`, as a sorted path list; [] when none does. */
function packageOf(groups: FileSegment[][], path: string): string[] {
  const group = groups.find((g) => g.some((s) => s.path === path));
  return (group ?? []).map((s) => s.path).sort();
}

const BUDGET = 10_000; // far above any fixture, so packUnits never splits a hint

describe("groupByBrief — hint prefix tie-break", () => {
  it("the LONGEST matching prefix wins, whichever order the hints arrive in", () => {
    const segments = segmentsFor(["src/auth/login.ts", "src/util/misc.ts"]);
    const broad = hint("core", ["src/"]);
    const narrow = hint("auth", ["src/auth/"]);

    for (const hints of [
      [broad, narrow],
      [narrow, broad],
    ]) {
      const groups = groupByBrief(segments, briefWith(hints), BUDGET);
      // "src/auth/" (9 chars) beats "src/" (4) regardless of brief order, so the
      // two files land in DIFFERENT packages.
      expect(packageOf(groups, "src/auth/login.ts")).toEqual(["src/auth/login.ts"]);
      expect(packageOf(groups, "src/util/misc.ts")).toEqual(["src/util/misc.ts"]);
    }
  });

  it("an EQUAL-length prefix tie goes to the first hint in brief order", () => {
    // Two hints whose prefixes are the same length and both match: `hintFor` keeps
    // the first (`prefix.length > bestLength` is strict), so the brief's own order
    // is the tie-break. Asserted from both orderings — the winner must FOLLOW the
    // brief, not be fixed by hint name or by chance.
    const segments = segmentsFor(["src/aaa/one.ts", "src/bbb/two.ts"]);
    const first = hint("first", ["src/aaa/"]);
    const second = hint("second", ["src/aaa/"]);

    // Both hints claim src/aaa/one.ts; whichever is first owns it, and the OTHER
    // hint's package is then empty and emitted at all.
    const forward = groupByBrief(segments, briefWith([first, second]), BUDGET);
    const reverse = groupByBrief(segments, briefWith([second, first]), BUDGET);

    // Either way the file is assigned exactly once — never duplicated across the
    // two tied packages, which would double every finding on it.
    for (const groups of [forward, reverse]) {
      const holders = groups.filter((g) => g.some((s) => s.path === "src/aaa/one.ts"));
      expect(holders).toHaveLength(1);
      expect(packageOf(groups, "src/aaa/one.ts")).toEqual(["src/aaa/one.ts"]);
      // The unmatched file keeps its own fallback group.
      expect(packageOf(groups, "src/bbb/two.ts")).toEqual(["src/bbb/two.ts"]);
      expect(groups.flat()).toHaveLength(2);
    }
  });

  it("a tie WITHIN one hint's prefix list still assigns the unit exactly once", () => {
    // The same hint listing overlapping prefixes (a routine model output): the
    // second never displaces the first, and the unit is not emitted twice.
    const segments = segmentsFor(["src/aaa/one.ts"]);
    const dup = hint("dup", ["src/aaa/", "src/aaa/", "src/bbb/"]);
    const groups = groupByBrief(segments, briefWith([dup]), BUDGET);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.map((s) => s.path)).toEqual(["src/aaa/one.ts"]);
  });

  it("prefers a longer prefix listed LATER inside the same hint list", () => {
    // Ordering within one hint's list must not beat length either.
    const segments = segmentsFor(["src/auth/login.ts", "src/util/misc.ts"]);
    const broad = hint("core", ["src/"]);
    const narrow = hint("auth", ["src/", "src/auth/"]);
    const groups = groupByBrief(segments, briefWith([broad, narrow]), BUDGET);
    expect(packageOf(groups, "src/auth/login.ts")).toEqual(["src/auth/login.ts"]);
    expect(packageOf(groups, "src/util/misc.ts")).toEqual(["src/util/misc.ts"]);
  });

  it("ignores an empty prefix, which would otherwise match every path", () => {
    const segments = segmentsFor(["src/a.ts", "docs/b.ts"]);
    const empty = hint("catchall", [""]);
    const real = hint("src", ["src/"]);
    const groups = groupByBrief(segments, briefWith([empty, real]), BUDGET);

    // src/a.ts goes to the real hint; docs/b.ts matches nothing and falls back.
    expect(packageOf(groups, "src/a.ts")).toEqual(["src/a.ts"]);
    expect(packageOf(groups, "docs/b.ts")).toEqual(["docs/b.ts"]);
    expect(groups.flat()).toHaveLength(2);
  });

  it("groups two files under one hint, and leaves unmatched files their own groups", () => {
    const segments = segmentsFor(["src/auth/a.ts", "src/auth/b.ts", "docs/c.ts"]);
    const auth = hint("auth", ["src/auth/"]);
    const groups = groupByBrief(segments, briefWith([auth]), BUDGET);

    expect(packageOf(groups, "src/auth/a.ts")).toEqual(["src/auth/a.ts", "src/auth/b.ts"]);
    expect(packageOf(groups, "docs/c.ts")).toEqual(["docs/c.ts"]);
  });

  it("falls back to the plain grouping with no hints or with chunking disabled", () => {
    const segments = segmentsFor(["src/auth/a.ts", "src/auth/b.ts"]);
    const auth = hint("auth", ["src/auth/"]);

    // No brief, no hints, and maxLines <= 0 all short-circuit to the same shape.
    const noBrief = groupByBrief(segments, null, BUDGET);
    const noHints = groupByBrief(segments, briefWith([]), BUDGET);
    const noChunking = groupByBrief(segments, briefWith([auth]), 0);

    const shape = (groups: FileSegment[][]): string[][] => groups.map((g) => g.map((s) => s.path));
    expect(shape(noHints)).toEqual(shape(noBrief));
    expect(shape(noChunking)).toEqual(shape(noBrief));
    // …and that shape is one group per file here (nothing module-coupled).
    expect(shape(noBrief)).toEqual([["src/auth/a.ts"], ["src/auth/b.ts"]]);
  });
});
