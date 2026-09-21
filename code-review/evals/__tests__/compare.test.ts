import { it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { accounting, quality } from "../compare.js";

it("reads real OpenRouter usage without retaining response text", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("../../src/jev/__tests__/fixtures/supported.json", import.meta.url),
      "utf8",
    ),
  );
  const result = accounting(JSON.stringify(fixture.response));
  expect(result.model).toBe("typesafe/jev-1.13-20260917");
  expect(result.usage?.cost).toBe(fixture.response.usage.cost);
  expect(JSON.stringify(result)).not.toContain("answers");
});
it("scores known PR175 false positives separately from unclassified findings", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("../../src/review/__tests__/fixtures/pr175-evidence.json", import.meta.url),
      "utf8",
    ),
  );
  const label = {
    path: fixture.source.path,
    text: "nothing in the diff ever sets keyPrefixAuto",
    expected: "false_positive" as const,
  };
  expect(quality(fixture.comments, [label]).knownFalsePositives).toBe(1);
  expect(quality([], [label]).knownFalsePositives).toBe(0);
});
