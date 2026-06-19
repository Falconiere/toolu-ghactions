import { describe, it, expect } from "vitest";
import { errorMessage } from "@/errors.js";

// FIX 14: one shared errorMessage() replacing four byte-identical copies.
// Real values only (Error / string / object / Error-with-cause) — no mocks.
describe("errorMessage", () => {
  it("returns an Error's message verbatim", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("returns a thrown string as-is", () => {
    expect(errorMessage("plain string failure")).toBe("plain string failure");
  });

  it("falls back for a bare object that stringifies to [object Object]", () => {
    expect(errorMessage({})).toBe("unknown error");
    expect(errorMessage({}, "labels API request failed")).toBe("labels API request failed");
  });

  it("unwraps Error.cause when the outer message is empty (openrouter behavior kept)", () => {
    const err = new Error("");
    err.name = "APICallError";
    err.cause = new Error("ECONNRESET");
    expect(errorMessage(err)).toBe("APICallError: ECONNRESET");
  });

  it("falls through to the error name when message and cause are empty", () => {
    const err = new Error("");
    err.name = "AbortError";
    expect(errorMessage(err)).toBe("AbortError");
  });

  it("uses the fallback only for an empty stringification, not for null/undefined", () => {
    // String(null/undefined) is non-empty ("null"/"undefined"), so — matching the
    // four original copies — those pass through; only "" or "[object Object]" fall back.
    expect(errorMessage(undefined)).toBe("undefined");
    expect(errorMessage(null)).toBe("null");
    expect(errorMessage("", "OpenRouter request failed")).toBe("OpenRouter request failed");
  });
});
