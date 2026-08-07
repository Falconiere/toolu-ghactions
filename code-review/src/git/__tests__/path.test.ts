// Unit coverage for the C-quote decoder at the git boundary. The literal strings
// asserted here are the exact bytes `git` prints — each one is reproduced against
// a real repo in the fetchDiff/scope tests; these cases pin the decoding itself,
// including the forms only reachable under a specific core.quotepath setting.
import { describe, it, expect } from "vitest";
import { unquoteGitPath, headerOperandPath } from "@/git/path.js";

describe("unquoteGitPath", () => {
  it("returns an unquoted path unchanged", () => {
    expect(unquoteGitPath("src/app.ts")).toBe("src/app.ts");
    expect(unquoteGitPath("dir with spaces/a b.ts")).toBe("dir with spaces/a b.ts");
    expect(unquoteGitPath("")).toBe("");
    // Non-ASCII arrives raw under core.quotepath=false and needs no decoding.
    expect(unquoteGitPath("日本語.txt")).toBe("日本語.txt");
  });

  it("decodes octal escapes as UTF-8 bytes (core.quotepath=true form)", () => {
    // What `git diff --name-only` prints for 日本語.txt under git's DEFAULT config.
    expect(unquoteGitPath('"\\346\\227\\245\\346\\234\\254\\350\\252\\236.txt"')).toBe(
      "日本語.txt",
    );
    // Two-byte character: café.ts.
    expect(unquoteGitPath('"caf\\303\\251.ts"')).toBe("café.ts");
    // Four-byte character (astral plane): 😀.ts.
    expect(unquoteGitPath('"\\360\\237\\230\\200.ts"')).toBe("😀.ts");
  });

  it("decodes named escapes (emitted even under core.quotepath=false)", () => {
    expect(unquoteGitPath('"we\\"ird.ts"')).toBe('we"ird.ts');
    expect(unquoteGitPath('"back\\\\slash.ts"')).toBe("back\\slash.ts");
    expect(unquoteGitPath('"tab\\there.ts"')).toBe("tab\there.ts");
    expect(unquoteGitPath('"new\\nline.ts"')).toBe("new\nline.ts");
    expect(unquoteGitPath('"ret\\rurn.ts"')).toBe("ret\rurn.ts");
  });

  it("keeps RAW non-ASCII bytes that sit inside a quoted path (core.quotepath=false form)", () => {
    // A quote FORCES quoting while quotepath=false leaves 日本 unescaped — decoding
    // this per JS char code would truncate U+65E5 to a single byte.
    expect(unquoteGitPath('"日本\\"x.txt"')).toBe('日本"x.txt');
    expect(unquoteGitPath('"café\\tx.ts"')).toBe("café\tx.ts");
  });

  it("mixes octal and named escapes in one path", () => {
    expect(unquoteGitPath('"caf\\303\\251\\"x.ts"')).toBe('café"x.ts');
  });

  it("preserves a trailing lone backslash instead of dropping it", () => {
    // git never emits this (a backslash is always doubled), so the only contract
    // is that malformed input loses no characters.
    expect(unquoteGitPath('"trail\\"')).toBe("trail\\");
  });

  it("leaves a lone escape character it does not define as that character", () => {
    expect(unquoteGitPath('"od\\zd.ts"')).toBe("odzd.ts");
  });

  it("does not treat a bare quote-wrapped-looking name as quoted by mistake", () => {
    // A single `"` is not a quoted path (needs both ends), and an empty pair decodes
    // to the empty string, which callers filter out.
    expect(unquoteGitPath('"')).toBe('"');
    expect(unquoteGitPath('""')).toBe("");
  });
});

describe("headerOperandPath", () => {
  it("strips the a/ and b/ side prefixes", () => {
    expect(headerOperandPath("b/src/app.ts")).toBe("src/app.ts");
    expect(headerOperandPath("a/src/app.ts")).toBe("src/app.ts");
  });

  it("decodes quoting BEFORE stripping the side prefix (the prefix is inside the quotes)", () => {
    expect(headerOperandPath('"b/caf\\303\\251.ts"')).toBe("café.ts");
    expect(headerOperandPath('"b/we\\"ird.ts"')).toBe('we"ird.ts');
  });

  it("drops git's trailing-tab separator", () => {
    expect(headerOperandPath("b/src/app.ts\t2024-01-01")).toBe("src/app.ts");
  });

  it("passes /dev/null through for callers to detect an add/delete side", () => {
    expect(headerOperandPath("/dev/null")).toBe("/dev/null");
  });
});
