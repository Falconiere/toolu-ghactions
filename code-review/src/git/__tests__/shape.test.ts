import { describe, it, expect } from "vitest";
import { shapeDiff } from "@/git/shape.js";

// REAL unified-diff text (the kind `git diff <base> HEAD -- <file>` emits),
// fed straight through shapeDiff — the same payload shape-diff.sh consumes.

const NEW_FILE_DIFF = `diff --git a/app.ts b/app.ts
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/app.ts
@@ -0,0 +1,3 @@
+line one
+line two
+line three
`;

const EDIT_DIFF = `diff --git a/app.ts b/app.ts
index 1111111..2222222 100644
--- a/app.ts
+++ b/app.ts
@@ -1,4 +1,4 @@
 context before
-old line
+new line
 context after
`;

describe("shapeDiff", () => {
  it("primes every added body line with its new-file line number", () => {
    const { diff } = shapeDiff(NEW_FILE_DIFF);
    expect(diff).toContain("L1: +line one");
    expect(diff).toContain("L2: +line two");
    expect(diff).toContain("L3: +line three");
    // Headers pass through unprimed.
    expect(diff).toContain("diff --git a/app.ts b/app.ts");
    expect(diff).toContain("+++ b/app.ts");
  });

  it("records changed_lines (added + context, unique sorted) per file", () => {
    const { files } = shapeDiff(NEW_FILE_DIFF);
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("app.ts");
    expect(files[0]?.changed_lines).toEqual([1, 2, 3]);
  });

  it("primes context lines and marks removed lines with L---", () => {
    const { diff, files } = shapeDiff(EDIT_DIFF);
    // Hunk starts at new-file line 1; context+addition advance the counter,
    // removals do not. Context lines keep their leading diff space, so the
    // primed prefix `L1: ` sits before that space → two spaces total.
    expect(diff).toContain("L1:  context before");
    expect(diff).toContain("L---: -old line");
    expect(diff).toContain("L2: +new line");
    expect(diff).toContain("L3:  context after");
    // changed_lines = context + added new-file line numbers (removed excluded).
    expect(files[0]?.changed_lines).toEqual([1, 2, 3]);
  });

  it("returns empty diff and no files for empty input", () => {
    expect(shapeDiff("")).toEqual({ diff: "", files: [] });
  });

  it("groups changed_lines by path across multiple files", () => {
    const multi = `diff --git a/one.ts b/one.ts
--- a/one.ts
+++ b/one.ts
@@ -0,0 +1,2 @@
+alpha
+beta
diff --git a/two.ts b/two.ts
--- a/two.ts
+++ b/two.ts
@@ -0,0 +1,1 @@
+gamma
`;
    const { files } = shapeDiff(multi);
    expect(files.map((f) => f.path)).toEqual(["one.ts", "two.ts"]);
    expect(files.find((f) => f.path === "one.ts")?.changed_lines).toEqual([1, 2]);
    expect(files.find((f) => f.path === "two.ts")?.changed_lines).toEqual([1]);
  });
});

// `--- `/`+++ ` are FILE-HEADER prefixes only inside the header block that runs
// from `diff --git ` to the first `@@ `. A BODY line can start with them too —
// real git emits `+++ inserted para` for an added line whose content starts
// `++ ` (Markdown insert, C's `++i;`) and `--- drop it` for a removed line
// starting `-- ` (a SQL/Lua/Haskell comment). Read off the prefix alone, such a
// line steals the path, is emitted unprimed, and never advances the new-file
// counter — so every later line in the file is off by one and filed under a
// path that does not exist. Both diffs below are verbatim `git diff` output
// from a repo containing exactly those lines.
describe("shapeDiff — body lines that look like file headers", () => {
  const ADDED_INSERT_DIFF = `diff --git a/f.md b/f.md
index 7804c0a..b81850b 100644
--- a/f.md
+++ b/f.md
@@ -1,3 +1,4 @@
 keep1
 old
+++ inserted para
 keep2
`;

  const REMOVED_COMMENT_DIFF = `diff --git a/g.sql b/g.sql
index 422c2b7..19d0b17 100644
--- a/g.sql
+++ b/g.sql
@@ -1,3 +1,2 @@
 a
--- drop the old index
 b
`;

  it("primes an added `++ ` line as a body line and keeps the real path", () => {
    const { diff, files } = shapeDiff(ADDED_INSERT_DIFF);
    // The added line is primed, not mistaken for a `+++ ` header.
    expect(diff).toContain("L3: +++ inserted para");
    // The path never changed: no phantom "inserted para" file, and f.md keeps
    // all four of its new-file lines (keep1, old, the insert, keep2).
    expect(files.map((f) => f.path)).toEqual(["f.md"]);
    expect(files[0]?.changed_lines).toEqual([1, 2, 3, 4]);
    // The counter advanced past the insert, so the trailing context is L4, not L3.
    expect(diff).toContain("L4:  keep2");
    expect(files[0]?.line_text[3]).toBe("++ inserted para");
    expect(files[0]?.line_text[4]).toBe("keep2");
  });

  it("primes a removed `-- ` line as a body line and keeps the real path", () => {
    const { diff, files } = shapeDiff(REMOVED_COMMENT_DIFF);
    // A removal inside a hunk, not a `--- ` header: it carries the L--- prefix.
    expect(diff).toContain("L---: --- drop the old index");
    expect(files.map((f) => f.path)).toEqual(["g.sql"]);
    // The surviving lines keep their real new-file numbers.
    expect(files[0]?.changed_lines).toEqual([1, 2]);
    expect(diff).toContain("L1:  a");
    expect(diff).toContain("L2:  b");
  });

  it("still reads a real `+++ `/`--- ` header pair in the header block", () => {
    // Guards the fix from over-correcting: headers inside the block are still
    // headers, so `files[].path` comes from `+++ b/…` and not from the body.
    const { diff, files } = shapeDiff(EDIT_DIFF);
    expect(diff).toContain("+++ b/app.ts");
    expect(files[0]?.path).toBe("app.ts");
  });
});
