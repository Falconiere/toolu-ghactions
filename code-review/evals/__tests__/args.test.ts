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
      "openrouter",
      "--model",
      "deepseek/deepseek-v4-flash",
      "--max-wall-ms",
      "12000",
      "--out",
      "/tmp/out.json",
    ]);
    expect(args.owner).toBe("acme");
    expect(args.repo).toBe("widgets");
    expect(args.prNumber).toBe(9);
    expect(args.provider).toBe("openrouter");
    expect(args.model).toBe("deepseek/deepseek-v4-flash");
    expect(args.maxWallMs).toBe(12000);
    expect(args.out).toBe("/tmp/out.json");
  });

  it("rejects an unsupported --provider, naming the supported id and the workaround", () => {
    expect(() => parseArgs(["--provider", "anthropic"])).toThrow(ArgError);
    expect(() => parseArgs(["--provider", "anthropic"])).toThrow(/\(openrouter\)/);
    expect(() => parseArgs(["--provider", "anthropic"])).toThrow(/--model <id>/);
    expect(() => parseArgs(["--provider", "anthropic"])).toThrow(
      /https:\/\/openrouter\.ai\/models/,
    );
  });

  it("rejects the REMOVED native vendor providers, pointing at the OpenRouter catalog", () => {
    // The advice never composes an id from the --provider spelling: a vendor's OpenRouter
    // namespace is not always its name (Kimi publishes under "moonshotai"), so
    // "kimi/<model>" would be an id OpenRouter does not serve.
    for (const removed of ["deepseek", "minimax", "kimi", "MoonShot"]) {
      expect(() => parseArgs(["--provider", removed])).toThrow(ArgError);
      expect(() => parseArgs(["--provider", removed])).toThrow(/https:\/\/openrouter\.ai\/models/);
      expect(() => parseArgs(["--provider", removed])).not.toThrow(
        new RegExp(`--model "${removed}/`),
      );
    }
  });

  it("treats a BLANK flag value as missing, naming the starved flag", () => {
    // `--model ""` used to resolve to an empty model id and only fail at the model call;
    // whitespace-only slipped through the same way. --max-wall-ms reaches the same guard
    // through requireInt, so its blank error is the flag-name one too.
    for (const flag of ["--pr", "--provider", "--model", "--out", "--max-wall-ms"]) {
      for (const blank of ["", "   "]) {
        expect(() => parseArgs([flag, blank])).toThrow(new RegExp(`${flag} requires a value`));
      }
    }
  });

  it("trims a flag value, so a padded id never reaches the model call", () => {
    expect(parseArgs(["--model", "  anthropic/claude-sonnet-4-5  "]).model).toBe(
      "anthropic/claude-sonnet-4-5",
    );
    // The trim runs BEFORE parsePrRef, whose regex has no room for whitespace, so a
    // padded --pr ref now parses instead of being rejected for its padding.
    const padded = parseArgs(["--pr", "  acme/widgets#9  "]);
    expect([padded.owner, padded.repo, padded.prNumber]).toEqual(["acme", "widgets", 9]);
  });

  it("reads a padded next flag as a missing value, not as this flag's value", () => {
    // The next-flag guard runs on the TRIMMED value: " --pr" must not slip past it on a
    // leading space and become the model id.
    expect(() => parseArgs(["--model", " --pr"])).toThrow(/--model requires a value/);
  });

  it("resolves --provider case-insensitively and defaults --model to the action's own", () => {
    const args = parseArgs(["--provider", "OpenRouter"]);
    expect(args.provider).toBe("openrouter");
    expect(args.model).toBe("deepseek/deepseek-v4-pro");
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
    expect(() => parseArgs(["--pr", "--provider", "openrouter"])).toThrow(/--pr requires a value/);
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

it("paired Jev evaluation rejects native providers", () => {
  expect(() => parseArgs(["--compare-jev", "--provider", "deepseek"])).toThrow(
    /is not supported \(openrouter\)/,
  );
});

it("enables paired evaluation with pinned revision overrides", () => {
  expect(parseArgs(["--compare-jev", "--head-sha", "abc", "--base-sha", "def"])).toMatchObject({
    compareJev: true,
    headSha: "abc",
    baseSha: "def",
  });
});
