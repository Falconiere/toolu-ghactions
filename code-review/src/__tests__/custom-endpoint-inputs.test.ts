// Exercise the actual Actions input reader and SDK factory without mocks.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readInputs } from "@/inputs.js";
import { parseExtraBody } from "@/llm/extraBody.js";
import {
  canonicalProviderId,
  DEFAULT_MODEL,
  resolveModel,
  validateBaseUrl,
} from "@/llm/providers.js";

const savedEnv = { ...process.env };

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("INPUT_")) delete process.env[key];
  }
  process.env["INPUT_PROVIDER"] = "openai-compatible";
  process.env["INPUT_BASE_URL"] = "http://127.0.0.1:8000/v1/";
  process.env["INPUT_MODEL_ID"] = "qwen3:0.6b";
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
});

describe("custom endpoint configuration", () => {
  it("accepts oMLX thinking options without allowing overrides of the review contract", () => {
    process.env["INPUT_EXTRA_BODY"] = '{"chat_template_kwargs":{"enable_thinking":false}}';
    expect(readInputs().extraBody).toEqual({ chat_template_kwargs: { enable_thinking: false } });
    expect(() => parseExtraBody('{"max_tokens":0}')).toThrow("cannot override");
    expect(() => parseExtraBody("[]")).toThrow("valid JSON object");
    expect(() => parseExtraBody("{")).toThrow("valid JSON object");
    expect(() => parseExtraBody('{"top_p":1e999}')).toThrow("valid JSON object");
    delete process.env["INPUT_BASE_URL"];
    delete process.env["INPUT_PROVIDER"];
    expect(readInputs).toThrow("EXTRA_BODY requires PROVIDER=openai-compatible");
  });
  it.each([
    "model",
    "messages",
    "max_tokens",
    "temperature",
    "response_format",
    "stream",
    "stream_options",
    "tools",
    "tool_choice",
  ])("protects the %s request field from custom options", (key) => {
    expect(() => parseExtraBody(JSON.stringify({ [key]: null }))).toThrow("cannot override");
  });
  it("preserves OpenRouter and its model as the defaults", () => {
    delete process.env["INPUT_PROVIDER"];
    delete process.env["INPUT_BASE_URL"];
    delete process.env["INPUT_MODEL_ID"];
    process.env["INPUT_API_KEY"] = "configuration-only";
    const inputs = readInputs();
    expect(inputs.provider).toBe("openrouter");
    expect(inputs.model).toBe(DEFAULT_MODEL);
    expect(inputs.baseUrl).toBeUndefined();
    const resolved = resolveModel(inputs);
    expect(resolved.provider).toBe("openrouter.chat");
  });

  it("accepts a keyless endpoint and the exact server model id", () => {
    const inputs = readInputs();
    expect(inputs.provider).toBe("openai-compatible");
    expect(inputs.baseUrl).toBe("http://127.0.0.1:8000/v1");
    expect(inputs.model).toBe("qwen3:0.6b");
    expect(inputs.apiKey).toBe("");
    const resolved = resolveModel(inputs);
    expect(resolved.provider).toBe("openai-compatible.chat");
    expect(resolved.modelId).toBe(inputs.model);
    expect(canonicalProviderId(" OpenAI-Compatible ")).toBe(inputs.provider);
  });

  it("requires an explicit custom API root and model", () => {
    delete process.env["INPUT_BASE_URL"];
    expect(readInputs).toThrow("BASE_URL is required");
    process.env["INPUT_BASE_URL"] = "http://127.0.0.1:8000/v1";
    delete process.env["INPUT_MODEL_ID"];
    expect(readInputs).toThrow("MODEL_ID is required");
  });

  it("rejects Jev before it can send a local endpoint key to OpenRouter", () => {
    process.env["INPUT_JEV_ENABLED"] = "true";
    expect(readInputs).toThrow("JEV_ENABLED requires PROVIDER=openrouter");
  });

  it("requires an explicit compatible provider to use a custom root", () => {
    delete process.env["INPUT_PROVIDER"];
    expect(readInputs).toThrow("BASE_URL requires PROVIDER=openai-compatible");
    expect(() =>
      resolveModel({ model: DEFAULT_MODEL, apiKey: "", baseUrl: "http://127.0.0.1:8000/v1" }),
    ).toThrow("BASE_URL requires");
  });

  it.each([
    "localhost:8000/v1",
    "file:///tmp/server",
    "https://user:secret@server/v1",
    "https://server/v1?key=secret",
    "https://server/v1#fragment",
  ])("rejects invalid or credential-bearing API root %s", (url) => {
    expect(() => validateBaseUrl(url)).toThrow("BASE_URL must");
  });
});
