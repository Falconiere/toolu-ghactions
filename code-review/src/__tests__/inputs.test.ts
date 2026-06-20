import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as core from "@actions/core";
import { readInputs } from "@/inputs.js";

// readInputs() reads real INPUT_* env vars via @actions/core.getInput (the same
// pattern main.test.ts uses). No mocks of getInput — we set the env directly and
// only SPY on core.warning to assert the FIX 8 fallback warnings fire. This is
// the real resolution path end to end.

const savedEnv = { ...process.env };

/** core.getInput("FOO_BAR") reads process.env.INPUT_FOO_BAR. */
function setInput(name: string, value: string): void {
  process.env[`INPUT_${name}`] = value;
}

beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("INPUT_")) delete process.env[k];
  }
  // A legacy key so a provider resolves without throwing.
  setInput("OPENROUTER_API_KEY", "sk-test");
  setInput("TOKEN", "ghs_token");
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("INPUT_")) delete process.env[k];
  }
  Object.assign(process.env, savedEnv);
});

describe("REQUEST_TIMEOUT_MS — per-attempt model deadline", () => {
  it("defaults to 180000ms (3 min) when unset — generous for the slow default model", () => {
    expect(readInputs().requestTimeoutMs).toBe(180000);
  });

  it("is overridable via the input", () => {
    setInput("REQUEST_TIMEOUT_MS", "300000");
    expect(readInputs().requestTimeoutMs).toBe(300000);
  });

  it('"0" falls back to the 180000 default with a warning (would abort instantly)', () => {
    setInput("REQUEST_TIMEOUT_MS", "0");
    const warn = vi.spyOn(core, "warning").mockImplementation(() => {});
    expect(readInputs().requestTimeoutMs).toBe(180000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("REQUEST_TIMEOUT_MS=0"));
  });

  it('"-5" (negative) falls back to 180000 with a warning', () => {
    setInput("REQUEST_TIMEOUT_MS", "-5");
    const warn = vi.spyOn(core, "warning").mockImplementation(() => {});
    expect(readInputs().requestTimeoutMs).toBe(180000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("REQUEST_TIMEOUT_MS=-5"));
  });

  it("a non-numeric value falls back to 180000 (intInput's own non-finite guard, silent)", () => {
    setInput("REQUEST_TIMEOUT_MS", "not-a-number");
    expect(readInputs().requestTimeoutMs).toBe(180000);
  });
});

describe("FIX 8 — token budget must be positive", () => {
  it('MAX_TOKENS="0" falls back to the 8192 default with a warning', () => {
    setInput("MAX_TOKENS", "0");
    const warn = vi.spyOn(core, "warning").mockImplementation(() => {});
    const inputs = readInputs();
    expect(inputs.maxTokens).toBe(8192);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("MAX_TOKENS=0"));
  });

  it('MAX_TOKENS="-1" (negative) also falls back to 8192 with a warning', () => {
    setInput("MAX_TOKENS", "-1");
    const warn = vi.spyOn(core, "warning").mockImplementation(() => {});
    const inputs = readInputs();
    expect(inputs.maxTokens).toBe(8192);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("MAX_TOKENS=-1"));
  });

  it("a PROVIDERS entry with max_tokens:0 falls back to 8192 with a warning", () => {
    setInput(
      "PROVIDERS",
      JSON.stringify([{ model: "deepseek/deepseek-v4-flash", api_key: "k", max_tokens: 0 }]),
    );
    const warn = vi.spyOn(core, "warning").mockImplementation(() => {});
    const inputs = readInputs();
    expect(inputs.maxTokens).toBe(8192);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("PROVIDERS[0].max_tokens=0"));
  });

  it("a valid positive MAX_TOKENS is preserved and does NOT warn", () => {
    setInput("MAX_TOKENS", "8192");
    const warn = vi.spyOn(core, "warning").mockImplementation(() => {});
    const inputs = readInputs();
    expect(inputs.maxTokens).toBe(8192);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("token budget"));
  });

  it("a valid positive PROVIDERS max_tokens is preserved", () => {
    setInput("PROVIDERS", JSON.stringify([{ model: "x/y", api_key: "k", max_tokens: 2048 }]));
    vi.spyOn(core, "warning").mockImplementation(() => {});
    const inputs = readInputs();
    expect(inputs.maxTokens).toBe(2048);
  });
});

describe("FIX 9 — REVIEW_PROMPT_FILE / CODEBASE_OVERVIEW are trimmed", () => {
  it('REVIEW_PROMPT_FILE="\\n  " (whitespace-only YAML block scalar) resolves to ""', () => {
    setInput("REVIEW_PROMPT_FILE", "\n  ");
    vi.spyOn(core, "warning").mockImplementation(() => {});
    const inputs = readInputs();
    // Trimmed to "" → prompt.ts uses the default checklist instead of a bogus path.
    expect(inputs.reviewPromptFile).toBe("");
  });

  it("CODEBASE_OVERVIEW is trimmed of surrounding whitespace/newlines", () => {
    setInput("CODEBASE_OVERVIEW", "\n  A monorepo of TS actions.  \n");
    vi.spyOn(core, "warning").mockImplementation(() => {});
    const inputs = readInputs();
    expect(inputs.codebaseOverview).toBe("A monorepo of TS actions.");
  });

  it("a real REVIEW_PROMPT_FILE path survives trimming", () => {
    setInput("REVIEW_PROMPT_FILE", "  prompts/custom.txt  ");
    vi.spyOn(core, "warning").mockImplementation(() => {});
    const inputs = readInputs();
    expect(inputs.reviewPromptFile).toBe("prompts/custom.txt");
  });
});

describe("PROVIDERS zod validation (rejects malformed entries instead of mistyping them)", () => {
  it("throws when a PROVIDERS entry is not an object", () => {
    setInput("PROVIDERS", JSON.stringify(["deepseek/deepseek-v4-flash"]));
    expect(() => readInputs()).toThrow(/PROVIDERS entries are not valid/);
  });

  it("throws when a PROVIDERS entry has a wrong-typed field", () => {
    setInput("PROVIDERS", JSON.stringify([{ model: 123 }]));
    expect(() => readInputs()).toThrow(/PROVIDERS entries are not valid/);
  });
});
