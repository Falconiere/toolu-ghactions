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
