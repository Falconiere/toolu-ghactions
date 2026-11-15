import { describe, expect, it } from "vitest";
import { splitGlobs, globMatcher, anyGlobMatches } from "@/git/globs.js";

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

  it("anchors the whole path", () => {
    expect(globMatcher("x.ts")("x.ts")).toBe(true);
    expect(globMatcher("x.ts")("ax.ts")).toBe(false);
    expect(globMatcher("x.ts")("x.tsx")).toBe(false);
  });

  it("matches a wildcard before a dir/** or dir/ suffix", () => {
    expect(globMatcher("**/generated/**")("src/generated/a.ts")).toBe(true);
    expect(globMatcher("**/generated/**")("src/gen/a.ts")).toBe(false);
    expect(globMatcher("packages/*/dist/**")("packages/x/dist/a.js")).toBe(true);
    expect(globMatcher("packages/*/dist/")("packages/x/dist/a.js")).toBe(true);
    expect(globMatcher("packages/*/dist/")("packages/x/src/a.js")).toBe(false);
    expect(globMatcher("src/**/gen/**")("src/a/gen/x.ts")).toBe(true);
  });

  it("stays fast on a deep path that cannot match", () => {
    const deep = `${"a/".repeat(2000)}x.ts`;
    const m = globMatcher("**/*.snap");
    const start = performance.now();
    expect(m(deep)).toBe(false);
    expect(performance.now() - start).toBeLessThan(50);
    expect(m("a/b/c.snap")).toBe(true);
  });
});

describe("anyGlobMatches", () => {
  it("true iff any entry matches", () => {
    expect(anyGlobMatches(["dist/**", "*.lock"], "x.lock")).toBe(true);
    expect(anyGlobMatches(["dist/**"], "src/x.ts")).toBe(false);
    expect(anyGlobMatches([], "anything")).toBe(false);
  });
});
