// providers.test.ts — unit coverage for the provider factory's pure helpers and that
// resolveModel constructs a real AI SDK model carrying the requested id for each
// supported provider. The actual native request shapes are proven in deepseek.test.ts
// (deepseek) and request-shape.test.ts (openrouter).
import { describe, expect, it } from "vitest";
import {
  SUPPORTED_PROVIDERS,
  defaultModelFor,
  isSupportedProvider,
  providerOptionsFor,
  resolveModel,
} from "@/llm/providers.js";

describe("provider factory", () => {
  it("exposes the per-provider default model ids", () => {
    expect(defaultModelFor("openrouter")).toBe("deepseek/deepseek-v4-pro");
    expect(defaultModelFor("deepseek")).toBe("deepseek-v4-flash");
  });

  it("recognizes exactly the supported providers", () => {
    expect([...SUPPORTED_PROVIDERS]).toEqual(["openrouter", "deepseek"]);
    expect(isSupportedProvider("openrouter")).toBe(true);
    expect(isSupportedProvider("deepseek")).toBe(true);
    expect(isSupportedProvider("openai")).toBe(false);
    expect(isSupportedProvider("")).toBe(false);
  });

  it("builds an AI SDK model for each supported provider, carrying the requested id", () => {
    for (const provider of SUPPORTED_PROVIDERS) {
      const id = defaultModelFor(provider);
      const model = resolveModel({ provider, model: id, apiKey: "sk-test" });
      expect(model.modelId).toBe(id);
    }
  });

  // Native DeepSeek turns thinking off through per-CALL providerOptions rather than the
  // client-level extraBody OpenRouter uses, so this is the only provider knowledge that
  // does NOT travel inside the model object. deepseek.test.ts proves it reaches the wire;
  // this pins the mapping itself, including the openrouter branch returning nothing.
  it("returns the thinking-off options for native DeepSeek and none for OpenRouter", () => {
    expect(providerOptionsFor("deepseek")).toEqual({
      deepseek: { thinking: { type: "disabled" } },
    });
    expect(providerOptionsFor("openrouter")).toBeUndefined();
  });
});
