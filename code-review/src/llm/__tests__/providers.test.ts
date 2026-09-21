// providers.test.ts — unit coverage for the model factory's pure helpers and that
// resolveModel constructs a real AI SDK model carrying the requested id. The outgoing
// OpenRouter request shape (reasoning off, require_parameters, streaming) is proven in
// request-shape.test.ts.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL,
  OPENROUTER_MODELS_URL,
  PROVIDER_ID,
  canonicalProviderId,
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

  it("points migration advice at the catalog rather than composing a model id", () => {
    // The action cannot query OpenRouter from an input-validation path, and a vendor's
    // namespace is not always its name (Kimi publishes under "moonshotai"), so every
    // "that id is wrong" message names this URL instead of guessing an id.
    expect(OPENROUTER_MODELS_URL).toBe("https://openrouter.ai/models");
  });

  it("builds an AI SDK model carrying the requested id", () => {
    const model = resolveModel({ model: DEFAULT_MODEL, apiKey: "sk-test" });
    expect(model.modelId).toBe(DEFAULT_MODEL);
  });
});
