// evals/__tests__/args.test.ts — pure argument-parsing tests (no gh/network/
// key). Run directly with `bun test evals/__tests__` — NOT part of `bun run
// check` (evals/ is outside every leg's project, see .oxlintrc.json + tsconfig).
import { describe, it, expect } from "bun:test";
import { parseArgs, parsePrRef, usage, ArgError, DEFAULT_PR } from "../args.js";

describe("parsePrRef", () => {
  it("splits owner/repo#number", () => {
    expect(parsePrRef("Falconiere/comemory#72")).toEqual({
      owner: "Falconiere",
      repo: "comemory",
      prNumber: 72,
    });
  });

  it("throws ArgError on a malformed ref", () => {
    expect(() => parsePrRef("not-a-ref")).toThrow(ArgError);
    expect(() => parsePrRef("owner/repo")).toThrow(ArgError);
    expect(() => parsePrRef("owner/repo#abc")).toThrow(ArgError);
  });

  it("rejects PR #0 (not a valid PR number)", () => {
    expect(() => parsePrRef("owner/repo#0")).toThrow(ArgError);
  });
});

describe("parseArgs", () => {
  it("defaults to DEFAULT_PR, openrouter, and its default model", () => {
    const args = parseArgs([]);
    expect(args.help).toBe(false);
    expect(`${args.owner}/${args.repo}#${args.prNumber}`).toBe(DEFAULT_PR);
    expect(args.provider).toBe("openrouter");
    expect(args.model.length).toBeGreaterThan(0);
    expect(args.maxWallMs).toBe(0);
    expect(args.out).toBeNull();
  });

  it("--help short-circuits without requiring a valid --pr", () => {
    const args = parseArgs(["--help"]);
    expect(args.help).toBe(true);
    const short = parseArgs(["-h"]);
    expect(short.help).toBe(true);
  });

  it("parses every flag", () => {
    const args = parseArgs([
      "--pr",
      "acme/widgets#9",
      "--provider",
      "deepseek",
      "--model",
      "deepseek-v4-flash",
      "--max-wall-ms",
      "12000",
      "--out",
      "/tmp/out.json",
    ]);
    expect(args.owner).toBe("acme");
    expect(args.repo).toBe("widgets");
    expect(args.prNumber).toBe(9);
    expect(args.provider).toBe("deepseek");
    expect(args.model).toBe("deepseek-v4-flash");
    expect(args.maxWallMs).toBe(12000);
    expect(args.out).toBe("/tmp/out.json");
  });

  it("rejects an unsupported --provider", () => {
    expect(() => parseArgs(["--provider", "anthropic"])).toThrow(ArgError);
  });

  it("rejects a malformed --pr", () => {
    expect(() => parseArgs(["--pr", "nope"])).toThrow(ArgError);
  });

  it("rejects an unrecognized flag", () => {
    expect(() => parseArgs(["--nope"])).toThrow(ArgError);
  });

  it("rejects a flag missing its value", () => {
    expect(() => parseArgs(["--pr"])).toThrow(ArgError);
    expect(() => parseArgs(["--provider"])).toThrow(ArgError);
    expect(() => parseArgs(["--model"])).toThrow(ArgError);
    expect(() => parseArgs(["--out"])).toThrow(ArgError);
    expect(() => parseArgs(["--max-wall-ms"])).toThrow(ArgError);
    expect(() => parseArgs(["--max-wall-ms", "not-a-number"])).toThrow(ArgError);
    expect(() => parseArgs(["--max-wall-ms", "-5"])).toThrow(ArgError);
  });

  it("rejects trailing-garbage integers instead of silently truncating them", () => {
    expect(() => parseArgs(["--max-wall-ms", "12abc"])).toThrow(ArgError);
    expect(() => parseArgs(["--max-wall-ms", "abc"])).toThrow(ArgError);
    expect(() => parseArgs(["--max-wall-ms", "-5"])).toThrow(ArgError);
  });

  it("treats a value starting with '--' as a missing value, naming the starved flag", () => {
    expect(() => parseArgs(["--pr", "--provider", "deepseek"])).toThrow(/--pr requires a value/);
  });
});

describe("usage", () => {
  it("mentions every flag and the API_KEY env var", () => {
    const text = usage();
    for (const flag of ["--pr", "--provider", "--model", "--max-wall-ms", "--out", "--help"]) {
      expect(text).toContain(flag);
    }
    expect(text).toContain("API_KEY");
  });
});
