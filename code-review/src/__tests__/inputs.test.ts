import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as core from "@actions/core";
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

  it("AC-4: PROVIDER=deepseek without MODEL_ID defaults to deepseek-v4-flash", () => {
    setInput("PROVIDER", "deepseek");
    const inputs = readInputs();
    expect(inputs.provider).toBe("deepseek");
    expect(inputs.model).toBe("deepseek-v4-flash");
  });

  it("honors an explicit MODEL_ID over the per-provider default", () => {
    setInput("PROVIDER", "deepseek");
    setInput("MODEL_ID", "deepseek-v4-pro");
    expect(readInputs().model).toBe("deepseek-v4-pro");
  });

  it("reads the API_KEY input", () => {
    setInput("API_KEY", "sk-live");
    expect(readInputs().apiKey).toBe("sk-live");
  });

  it("AC-5: throws when API_KEY is empty", () => {
    setInput("API_KEY", "");
    expect(() => readInputs()).toThrow(/API_KEY is required/);
  });

  it("AC-6: an unsupported PROVIDER throws, naming the supported set and the workaround", () => {
    setInput("PROVIDER", "openai");
    expect(() => readInputs()).toThrow(/is not supported \(supported: openrouter, deepseek\)/);
    expect(() => readInputs()).toThrow(/PROVIDER:"openrouter"/);
  });

  it("resolves PROVIDER case-insensitively", () => {
    setInput("PROVIDER", "DeepSeek");
    expect(readInputs().provider).toBe("deepseek");
  });

  it("warns when a deepseek MODEL_ID looks like an OpenRouter id (slash namespace)", () => {
    setInput("PROVIDER", "deepseek");
    setInput("MODEL_ID", "deepseek/deepseek-v4-pro");
    const warn = vi.spyOn(core, "warning").mockImplementation(() => {});
    readInputs();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("looks like an OpenRouter id"));
  });
});
