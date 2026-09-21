import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Finding } from "@/llm/schema.js";
import { applyRecheck } from "@/jev/recheck.js";
import { selectRiskPackages } from "@/jev/enhance.js";

const recorded = z
  .object({
    source: z.object({ path: z.string(), lines: z.record(z.string()) }),
    comments: z.array(Finding),
  })
  .parse(
    JSON.parse(
      readFileSync(
        new URL("../../review/__tests__/fixtures/pr175-evidence.json", import.meta.url),
        "utf8",
      ),
    ),
  );
const finding = recorded.comments[0];
if (!finding) throw new Error("Missing recorded PR175 finding");
const findings = [{ ...finding, fp: "recorded-pr175" }];
const evidence = {
  diff: "",
  files: [{ path: recorded.source.path, content: Object.values(recorded.source.lines).join("\n") }],
  rules: "",
  inventory: "",
  omitted: [],
};

describe("focused generative recheck safety", () => {
  it("requires explicit per-finding source-backed dismissal", () => {
    const dismissal = {
      id: "recorded-pr175",
      decision: "dismiss",
      explanation: "The prefix handler calls onKeyPrefixEdited, contrary to the claim.",
      evidence: [{ path: recorded.source.path, quote: "onKeyPrefixEdited();" }],
    };
    expect(
      applyRecheck({ decisions: [dismissal], findings: [] }, findings, evidence).dismissed,
    ).toEqual(["recorded-pr175"]);
    expect(
      applyRecheck(
        { decisions: [{ ...dismissal, evidence: [] }], findings: [] },
        findings,
        evidence,
      ).dismissed,
    ).toEqual([]);
    expect(
      applyRecheck(
        {
          decisions: [
            { ...dismissal, evidence: [{ path: "absent.ts", quote: "onKeyPrefixEdited();" }] },
          ],
          findings: [],
        },
        findings,
        evidence,
      ).dismissed,
    ).toEqual([]);
  });
  it("preserves findings on missing, duplicate or malformed decisions", () => {
    for (const payload of [
      {},
      { decisions: [], findings: [] },
      { decisions: [{ id: "recorded-pr175", decision: "dismiss" }], findings: [] },
    ]) {
      expect(applyRecheck(payload, findings, evidence).dismissed).toEqual([]);
    }
  });
  it("never dismisses a scanner finding", () => {
    const payload = {
      decisions: [
        {
          id: "recorded-pr175",
          decision: "dismiss",
          explanation: "The source contradicts this.",
          evidence: [{ path: recorded.source.path, quote: "onKeyPrefixEdited();" }],
        },
      ],
      findings: [],
    };
    expect(
      applyRecheck(
        payload,
        [{ ...findings[0], ...finding, fp: "recorded-pr175", source: "opengrep" }],
        evidence,
      ).dismissed,
    ).toEqual([]);
  });
});

describe("bounded risk routing", () => {
  it("selects at most two high-confidence packages with stable probability ties", () => {
    expect(
      selectRiskPackages([
        { index: 0, choice: "high", confidence: 0.9, probability: 0.9 },
        { index: 1, choice: "high", confidence: 0.79, probability: 1 },
        { index: 2, choice: "ordinary", confidence: 1, probability: 0 },
        { index: 3, choice: "high", confidence: 0.95, probability: 0.95 },
        { index: 4, choice: "high", confidence: 0.9, probability: 0.9 },
      ]),
    ).toEqual([3, 0]);
  });
});

it("accepts quotes in the actual line-primed diff, without full-file duplication", () => {
  const payload = {
    decisions: [
      {
        id: "recorded-pr175",
        decision: "dismiss",
        explanation: "The prefix handler already calls the callback.",
        evidence: [{ path: recorded.source.path, quote: "onKeyPrefixEdited();" }],
      },
    ],
    findings: [],
  };
  const diff = `diff --git a/${recorded.source.path} b/${recorded.source.path}\n--- a/${recorded.source.path}\n+++ b/${recorded.source.path}\n@@ -140,1 +140,2 @@\nL141: +              onChange={(event) => {\nL142: +                onKeyPrefixEdited();\n`;
  expect(applyRecheck(payload, findings, { ...evidence, files: [], diff }).dismissed).toEqual([
    "recorded-pr175",
  ]);
});

it("uses the recorded generative recheck rather than Jev alone to dismiss PR175", () => {
  const fixture = z
    .object({
      request: z.object({ messages: z.array(z.object({ role: z.string(), content: z.string() })) }),
      response: z.object({
        choices: z.array(z.object({ message: z.object({ content: z.string() }) })),
      }),
    })
    .parse(
      JSON.parse(
        readFileSync(
          new URL("./fixtures/generative-recheck-exact-id.json", import.meta.url),
          "utf8",
        ),
      ),
    );
  const user = fixture.request.messages.find((m) => m.role === "user");
  const payload = z
    .object({
      evidence: z.object({
        diff: z.string(),
        files: z.array(z.object({ path: z.string(), content: z.string() })),
        rules: z.string(),
        inventory: z.string(),
        omitted: z.array(z.string()),
      }),
    })
    .parse(JSON.parse(user?.content ?? "{}"));
  const response: unknown = JSON.parse(fixture.response.choices[0]?.message.content ?? "{}");
  expect(applyRecheck(response, findings, payload.evidence).dismissed).toEqual(["recorded-pr175"]);
});

it("does not report missing decisions as completed rechecks", () => {
  expect(applyRecheck({ decisions: [], findings: [] }, findings, evidence).rechecked).toEqual([]);
  const decision = {
    id: "recorded-pr175",
    decision: "retain",
    explanation: "The available source does not establish a dismissal.",
    evidence: [],
  };
  expect(
    applyRecheck({ decisions: [decision], findings: [] }, findings, evidence).rechecked,
  ).toEqual(["recorded-pr175"]);
  expect(
    applyRecheck(
      { decisions: [decision, { id: "recorded-pr175" }], findings: [] },
      findings,
      evidence,
    ).rechecked,
  ).toEqual([]);
});
