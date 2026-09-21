// providers.test.ts — unit coverage for the model factory's pure helpers and that
// resolveModel constructs a real AI SDK model carrying the requested id. The outgoing
// OpenRouter request shape (reasoning off, require_parameters, streaming) is proven in
// request-shape.test.ts.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL,
  PROVIDER_ID,
  canonicalProviderId,
  openRouterNamespaceFor,
  resolveModel,
} from "@/llm/providers.js";

describe("model factory", () => {
  it("exposes the default model id", () => {
    expect(PROVIDER_ID).toBe("openrouter");
    expect(DEFAULT_MODEL).toBe("deepseek/deepseek-v4-pro");
  });

  it("canonicalizes spelling and rejects every other provider", () => {
    expect(canonicalProviderId("  OpenRouter ")).toBe("openrouter");
    expect(canonicalProviderId("openrouter")).toBe("openrouter");
    // The native vendor backends this action used to wire are gone: their models are
    // reachable as OpenRouter "<vendor>/<model>" ids, so the spelling must NOT resolve —
    // otherwise a workflow pinned to one would silently send that vendor's key here.
    for (const removed of ["deepseek", "minimax", "kimi", "moonshot", "openai", ""]) {
      expect(canonicalProviderId(removed)).toBeUndefined();
    }
  });

  it("maps a rejected spelling to the vendor's OpenRouter author slug, not the spelling", () => {
    // Kimi's models are published under Moonshot AI's slug, so the migration advice must
    // say "moonshotai/kimi-k2" — "kimi/…" and "moonshot/…" are not ids OpenRouter serves.
    expect(openRouterNamespaceFor("kimi")).toBe("moonshotai");
    expect(openRouterNamespaceFor("  MoonShot ")).toBe("moonshotai");
    // Everything else already spells its own slug; the result is still normalized,
    // because OpenRouter ids are lowercase.
    expect(openRouterNamespaceFor("deepseek")).toBe("deepseek");
    expect(openRouterNamespaceFor("MiniMax")).toBe("minimax");
    expect(openRouterNamespaceFor("anthropic")).toBe("anthropic");
  });

  it("builds an AI SDK model carrying the requested id", () => {
    const model = resolveModel({ model: DEFAULT_MODEL, apiKey: "sk-test" });
    expect(model.modelId).toBe(DEFAULT_MODEL);
  });
});
