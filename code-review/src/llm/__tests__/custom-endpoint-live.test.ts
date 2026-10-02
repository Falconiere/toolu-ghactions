// Opt-in integration against an actual model server; no transport replacements.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { reviewWithModel } from "@/llm/reviewWithModel.js";
import { parseExtraBody } from "@/llm/extraBody.js";

const baseUrl = process.env["TOOLU_LIVE_BASE_URL"];
const model = process.env["TOOLU_LIVE_MODEL"];
const extraBody = parseExtraBody(process.env["TOOLU_LIVE_EXTRA_BODY"] ?? "");

describe.skipIf(!baseUrl || !model)("live custom endpoint", () => {
  it("reviews repository evidence through streamed structured output", async () => {
    const evidence = execFileSync("git", ["show", "HEAD:code-review/src/llm/providers.ts"], {
      encoding: "utf8",
    });
    const result = await reviewWithModel(
      {
        system:
          "Briefly review the supplied repository source. Report at most one actionable defect with an exact source quote, or no findings if none is supported. Keep review_plan to one sentence and omit optional sections. Return the required JSON verdict.",
        user: `Source: code-review/src/llm/providers.ts\n${evidence}`,
        max_tokens: 2048,
        enforce_json_schema: true,
      },
      {
        provider: "openai-compatible",
        baseUrl,
        extraBody,
        model: model ?? "",
        apiKey: process.env["TOOLU_LIVE_API_KEY"] ?? "",
        maxAttempts: 1,
        maxRetries: 0,
        timeoutMs: 300000,
        wallDeadline: Date.now() + 300000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.verdict).not.toBe("error");
    expect(result.partial).not.toBe(true);
  }, 310000);

  it("supports the cartographer's non-streaming JSON mode", async () => {
    const evidence = execFileSync("git", ["show", "HEAD:code-review/package.json"], {
      encoding: "utf8",
    });
    const result = await reviewWithModel(
      {
        system:
          'Read the real package manifest and return JSON with keys "name" and "dependencies".',
        user: evidence,
        max_tokens: 1024,
        enforce_json_schema: false,
      },
      {
        provider: "openai-compatible",
        baseUrl,
        extraBody,
        model: model ?? "",
        apiKey: process.env["TOOLU_LIVE_API_KEY"] ?? "",
        rawJson: true,
        maxAttempts: 1,
        maxRetries: 0,
        timeoutMs: 180000,
        wallDeadline: Date.now() + 180000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.verdict).toBe("approved");
    expect(JSON.parse(result.other_checks ?? "{}")).toHaveProperty("name", "toolu-code-review");
  }, 190000);
});
