import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as core from "@actions/core";
// @actions/core is native ESM (v3+), whose namespace is frozen, so `vi.spyOn(core, …)`
// below needs this spy-mode mock: every export stays the real implementation, wrapped
// in a spy that vi.spyOn can then redirect. Nothing about the logger is faked.
vi.mock(import("@actions/core"), { spy: true });
import { readInputs } from "@/inputs.js";

/** Set an action input as @actions/core reads it (process.env.INPUT_<NAME>). */
function setInput(name: string, value: string): void {
  process.env[`INPUT_${name}`] = value;
}

/** Snapshot the env so each test starts from a known state. */
const savedEnv = { ...process.env };

function clearInputs(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("INPUT_")) delete process.env[key];
  }
}

beforeEach(() => {
  clearInputs();
  // API_KEY is required; default it so tests that don't exercise it never throw.
  setInput("API_KEY", "sk-test");
  setInput("TOKEN", "ghs_token");
});

afterEach(() => {
  vi.restoreAllMocks();
  clearInputs();
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
});

describe("REQUEST_TIMEOUT_MS", () => {
  it("defaults to 180000ms", () => {
    expect(readInputs().requestTimeoutMs).toBe(180000);
  });

  it("honors a valid override", () => {
    setInput("REQUEST_TIMEOUT_MS", "300000");
    expect(readInputs().requestTimeoutMs).toBe(300000);
  });

  it("falls back to the default on a non-positive value, with a warning", () => {
    setInput("REQUEST_TIMEOUT_MS", "0");
    const warn = vi.spyOn(core, "warning").mockImplementation(() => {});
    expect(readInputs().requestTimeoutMs).toBe(180000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not a positive timeout"));
  });

  it("falls back to the default on a non-numeric value", () => {
    setInput("REQUEST_TIMEOUT_MS", "abc");
    expect(readInputs().requestTimeoutMs).toBe(180000);
  });
});

describe("MAX_CHUNKS", () => {
  it("defaults to 0 (unlimited)", () => {
    expect(readInputs().maxChunks).toBe(0);
  });

  it("honors a positive override", () => {
    setInput("MAX_CHUNKS", "5");
    expect(readInputs().maxChunks).toBe(5);
  });
});

describe("MAX_WALL_MS", () => {
  it("defaults to ten minutes", () => {
    expect(readInputs().maxWallMs).toBe(600000);
  });

  it("parses a positive override", () => {
    setInput("MAX_WALL_MS", "600000");
    expect(readInputs().maxWallMs).toBe(600000);
  });

  it("falls back to ten minutes on a non-numeric value", () => {
    setInput("MAX_WALL_MS", "abc");
    expect(readInputs().maxWallMs).toBe(600000);
  });

  it("allows an explicit zero to disable the budget", () => {
    setInput("MAX_WALL_MS", "0");
    expect(readInputs().maxWallMs).toBe(0);
  });

  it("rejects a negative budget instead of silently disabling it", () => {
    setInput("MAX_WALL_MS", "-1");
    expect(() => readInputs()).toThrow("MAX_WALL_MS must be a non-negative integer");
  });

  it.each(["-0.5", "0.5", "1.5"])("rejects fractional budget %s", (value) => {
    setInput("MAX_WALL_MS", value);
    expect(() => readInputs()).toThrow("MAX_WALL_MS must be a non-negative integer");
  });

  it("does not interpret malformed zero text as an explicit opt-out", () => {
    setInput("MAX_WALL_MS", "0ms");
    expect(readInputs().maxWallMs).toBe(600000);
  });
});

describe("FAIL_ON", () => {
  it("defaults to blocking on 'changes' when unset (gate on by default)", () => {
    const failOn = readInputs().failOn;
    expect(failOn.has("changes")).toBe(true);
    expect(failOn.has("error")).toBe(false);
  });

  it("FAIL_ON=none disables the gate", () => {
    setInput("FAIL_ON", "none");
    expect([...readInputs().failOn]).toEqual([]);
  });

  it("FAIL_ON=changes,error blocks on both verdicts", () => {
    setInput("FAIL_ON", "changes,error");
    const failOn = readInputs().failOn;
    expect(failOn.has("changes")).toBe(true);
    expect(failOn.has("error")).toBe(true);
  });
});

describe("MAX_TOKENS", () => {
  it("defaults to 8192", () => {
    expect(readInputs().maxTokens).toBe(8192);
  });

  it("honors a valid override", () => {
    setInput("MAX_TOKENS", "2048");
    expect(readInputs().maxTokens).toBe(2048);
  });

  it("falls back to the default on a non-positive value, with a warning", () => {
    setInput("MAX_TOKENS", "0");
    const warn = vi.spyOn(core, "warning").mockImplementation(() => {});
    expect(readInputs().maxTokens).toBe(8192);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not a positive token budget"));
  });
});

describe("VERBOSITY", () => {
  it("defaults to compact when unset", () => {
    expect(readInputs().verbosity).toBe("compact");
  });

  it("honors an explicit full", () => {
    setInput("VERBOSITY", "full");
    expect(readInputs().verbosity).toBe("full");
  });

  it("is case-insensitive and trims", () => {
    setInput("VERBOSITY", "  Full  ");
    expect(readInputs().verbosity).toBe("full");
  });

  it("falls back to compact on an unrecognized value, with a warning", () => {
    setInput("VERBOSITY", "verbose");
    const warn = vi.spyOn(core, "warning").mockImplementation(() => {});
    expect(readInputs().verbosity).toBe("compact");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('is not "compact" or "full"'));
  });
});

describe("RULES_REF", () => {
  it("defaults to base when unset (the anti rule-injection default)", () => {
    expect(readInputs().rulesRef).toBe("base");
  });

  it("honors an explicit merge", () => {
    setInput("RULES_REF", "merge");
    expect(readInputs().rulesRef).toBe("merge");
  });

  it("is case-insensitive and trims", () => {
    setInput("RULES_REF", "  Merge  ");
    expect(readInputs().rulesRef).toBe("merge");
  });

  it("falls back to base on an unrecognized value, with a warning", () => {
    setInput("RULES_REF", "head");
    const warn = vi.spyOn(core, "warning").mockImplementation(() => {});
    expect(readInputs().rulesRef).toBe("base");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('is not "base" or "merge"'));
  });
});

describe("string inputs are trimmed", () => {
  it("trims REVIEW_PROMPT_FILE and CODEBASE_OVERVIEW", () => {
    setInput("REVIEW_PROMPT_FILE", "  ./custom-prompt.md  ");
    setInput("CODEBASE_OVERVIEW", "  a TypeScript GitHub Action  ");
    const inputs = readInputs();
    expect(inputs.reviewPromptFile).toBe("./custom-prompt.md");
    expect(inputs.codebaseOverview).toBe("a TypeScript GitHub Action");
  });

  it("parses EXCLUDE_GLOBS into a trimmed list (default empty)", () => {
    expect(readInputs().excludeGlobs).toEqual([]);
    setInput("EXCLUDE_GLOBS", "migrations/**, **/*.snap\n vendor/ ");
    expect(readInputs().excludeGlobs).toEqual(["migrations/**", "**/*.snap", "vendor/"]);
  });
});

describe("provider contract (PROVIDER / MODEL_ID / API_KEY)", () => {
  it("AC-3: defaults PROVIDER to openrouter and MODEL_ID to the openrouter default", () => {
    const inputs = readInputs();
    expect(inputs.provider).toBe("openrouter");
    expect(inputs.model).toBe("deepseek/deepseek-v4-pro");
  });

  it("honors an explicit MODEL_ID over the default", () => {
    setInput("MODEL_ID", "anthropic/claude-sonnet-4-5");
    expect(readInputs().model).toBe("anthropic/claude-sonnet-4-5");
  });

  it("reads the API_KEY input", () => {
    setInput("API_KEY", "sk-live");
    expect(readInputs().apiKey).toBe("sk-live");
  });

  it("AC-5: throws when API_KEY is empty", () => {
    setInput("API_KEY", "");
    expect(() => readInputs()).toThrow(/API_KEY is required/);
  });

  it("resolves PROVIDER=openrouter case-insensitively, whitespace and all", () => {
    setInput("PROVIDER", "  OpenRouter ");
    expect(readInputs().provider).toBe("openrouter");
  });

  it("AC-6: an unsupported PROVIDER throws, naming the supported set and the workaround", () => {
    setInput("PROVIDER", "openai");
    expect(() => readInputs()).toThrow(/is not supported \(supported: openrouter\)/);
    expect(() => readInputs()).toThrow(/MODEL_ID:"openai\/<model>"/);
  });

  it("throws on a REMOVED native provider instead of silently routing its key to OpenRouter", () => {
    // A workflow still pinned to a native vendor carries THAT vendor's key; accepting the
    // input and sending it to OpenRouter would 401 mid-review. The error names the
    // OpenRouter id to switch to instead.
    for (const removed of ["deepseek", "minimax", "kimi", "moonshot"]) {
      setInput("PROVIDER", removed);
      expect(() => readInputs()).toThrow(
        new RegExp(`PROVIDER "${removed}" is not supported \\(supported: openrouter\\)`),
      );
      expect(() => readInputs()).toThrow(new RegExp(`MODEL_ID:"${removed}/<model>"`));
    }
  });

  it("never warns about a namespaced MODEL_ID — OpenRouter ids are namespaced by design", () => {
    setInput("MODEL_ID", "moonshotai/kimi-k2");
    const warn = vi.spyOn(core, "warning").mockImplementation(() => {});
    readInputs();
    expect(warn).not.toHaveBeenCalled();
  });
});
