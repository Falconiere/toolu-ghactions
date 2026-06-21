import { describe, expect, it } from "vitest";
import { splitGlobs, globMatcher, globToRegExp, anyGlobMatches } from "@/git/globs.js";

describe("splitGlobs", () => {
  it("splits on commas and newlines, trims, drops blanks", () => {
    expect(splitGlobs("a, b\n c ,, \n")).toEqual(["a", "b", "c"]);
    expect(splitGlobs("")).toEqual([]);
    expect(splitGlobs("   ")).toEqual([]);
  });
});

describe("globMatcher", () => {
  it("dir/** is a prefix match (everything under dir)", () => {
    const m = globMatcher("node_modules/**");
    expect(m("node_modules/x/y.js")).toBe(true);
    expect(m("src/node_modules.ts")).toBe(false);
  });

  it("dir/ is a prefix match", () => {
    expect(globMatcher("dist/")("dist/index.cjs")).toBe(true);
    expect(globMatcher("dist/")("src/a.ts")).toBe(false);
  });

  it("* matches any run including '/'; ? matches one char", () => {
    expect(globMatcher("*.snap")("a/b/c.snap")).toBe(true);
    expect(globMatcher("migrations/*.sql")("migrations/001.sql")).toBe(true);
    expect(globMatcher("v?.ts")("v1.ts")).toBe(true);
    expect(globMatcher("v?.ts")("v10.ts")).toBe(false);
  });

  it("treats regex metachars in literals as literal", () => {
    expect(globMatcher("a.b")("a.b")).toBe(true);
    expect(globMatcher("a.b")("axb")).toBe(false);
  });
});

describe("globToRegExp", () => {
  it("anchors the whole path", () => {
    expect(globToRegExp("x.ts").test("x.ts")).toBe(true);
    expect(globToRegExp("x.ts").test("ax.ts")).toBe(false);
  });
});

describe("anyGlobMatches", () => {
  it("true iff any entry matches", () => {
    expect(anyGlobMatches(["dist/**", "*.lock"], "x.lock")).toBe(true);
    expect(anyGlobMatches(["dist/**"], "src/x.ts")).toBe(false);
    expect(anyGlobMatches([], "anything")).toBe(false);
  });
});
