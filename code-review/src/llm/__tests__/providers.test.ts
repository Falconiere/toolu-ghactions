// providers.test.ts — unit coverage for the provider factory's pure helpers and that
// resolveModel constructs a real AI SDK model carrying the requested id for each
// supported provider. The actual native request shapes are proven per provider in
// deepseek.test.ts, minimax.test.ts, kimi.test.ts and request-shape.test.ts (openrouter).
import { describe, expect, it } from "vitest";
import {
  SUPPORTED_PROVIDERS,
  canonicalProviderId,
  defaultModelFor,
  escalatesEmptyCut,
  isSupportedProvider,
  providerFromNormalized,
  providerOptionsFor,
  resolveModel,
} from "@/llm/providers.js";

describe("provider factory", () => {
  it("exposes the per-provider default model ids", () => {
    expect(defaultModelFor("openrouter")).toBe("deepseek/deepseek-v4-pro");
    expect(defaultModelFor("deepseek")).toBe("deepseek-v4-flash");
    expect(defaultModelFor("minimax")).toBe("MiniMax-M3");
    expect(defaultModelFor("kimi")).toBe("kimi-k2.7-code");
  });

  it("recognizes exactly the supported providers", () => {
    expect([...SUPPORTED_PROVIDERS]).toEqual(["openrouter", "deepseek", "minimax", "kimi"]);
    for (const p of SUPPORTED_PROVIDERS) expect(isSupportedProvider(p)).toBe(true);
    expect(isSupportedProvider("openai")).toBe(false);
    expect(isSupportedProvider("moonshot")).toBe(false);
    expect(isSupportedProvider("")).toBe(false);
  });

  it("canonicalizes spelling and the moonshot alias, and rejects the rest", () => {
    expect(canonicalProviderId("  Kimi ")).toBe("kimi");
    expect(canonicalProviderId("MiniMax")).toBe("minimax");
    // Moonshot AI is Kimi's vendor and the name this action advertised first.
    expect(canonicalProviderId("moonshot")).toBe("kimi");
    expect(canonicalProviderId("Moonshot")).toBe("kimi");
    expect(canonicalProviderId("openai")).toBeUndefined();
    expect(canonicalProviderId("")).toBeUndefined();
    // The lookup underneath takes an already-normalized spelling and does not normalize
    // itself — inputs.ts normalizes once and quotes the same text in its error.
    expect(providerFromNormalized("moonshot")).toBe("kimi");
    expect(providerFromNormalized("minimax")).toBe("minimax");
    expect(providerFromNormalized("Moonshot")).toBeUndefined();
  });

  it("builds an AI SDK model for each supported provider, carrying the requested id", () => {
    for (const provider of SUPPORTED_PROVIDERS) {
      const id = defaultModelFor(provider);
      const model = resolveModel({ provider, model: id, apiKey: "sk-test" });
      expect(model.modelId).toBe(id);
    }
  });

  // The per-CALL reasoning switch travels outside the model object, so this pins the
  // mapping itself; the per-provider wire tests prove each one reaches the body. The key
  // of each entry is the providerOptions slot the SDK spreads into the body, which for
  // the openai-compatible client is the `name` the factory registered.
  it("returns the per-call reasoning switch for DeepSeek and MiniMax, none for OpenRouter and Kimi", () => {
    expect(providerOptionsFor("deepseek")).toEqual({
      deepseek: { thinking: { type: "disabled" } },
    });
    expect(providerOptionsFor("minimax")).toEqual({
      minimax: { thinking: { type: "disabled" }, reasoning_split: true },
    });
    expect(providerOptionsFor("openrouter")).toBeUndefined();
    // Kimi's current models error on `thinking:{type:"disabled"}` (k2.7-code) or do not
    // know the field (k3), so nothing is sent.
    expect(providerOptionsFor("kimi")).toBeUndefined();
  });

  it("escalates an empty length cut only where the vendor's reasoning cannot be switched off", () => {
    expect(escalatesEmptyCut("openrouter")).toBe(false);
    expect(escalatesEmptyCut("deepseek")).toBe(false);
    expect(escalatesEmptyCut("minimax")).toBe(true);
    expect(escalatesEmptyCut("kimi")).toBe(true);
  });
});
