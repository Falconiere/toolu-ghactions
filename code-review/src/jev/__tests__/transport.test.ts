import { readFileSync } from "node:fs";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { assess, splitQuestions } from "@/jev/transport.js";

const question = {
  type: "choice",
  instructions: "Assess source support",
  criteria: {
    supported: "Supported",
    contradicted: "Contradicted",
    insufficient_evidence: "Unknown",
  },
} as const;

describe("OpenRouter System One transport", () => {
  it("never dispatches after the shared deadline", async () => {
    let calls = 0;
    const result = await assess(
      "source",
      { finding: question },
      {
        apiKey: "private",
        model: "typesafe/jev-1.13",
        wallDeadline: Date.now() - 1,
        fetch: async () => {
          calls++;
          throw new Error("unexpected");
        },
      },
    );
    expect(calls).toBe(0);
    expect(result.reason).toBe("deadline");
  });
  it("reuses the credential only at the OpenRouter endpoint and hides authentication bodies", async () => {
    let calls = 0;
    const result = await assess(
      "source",
      { finding: question },
      {
        apiKey: "private",
        model: "typesafe/jev-1.13",
        fetch: async (url, init) => {
          calls++;
          expect(url).toBe("https://openrouter.ai/api/v1/systemone");
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer private");
          return new Response('{"error":{"message":"User not found.","code":401}}', {
            status: 401,
          });
        },
      },
    );
    expect(calls).toBe(1);
    expect(result.reason).toBe("http-401");
    expect(JSON.stringify(result)).not.toContain("private");
  });
  it("splits independent questions without truncating source evidence", () => {
    const batches = splitQuestions(
      "x".repeat(60000),
      Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [String(i), question])),
    );
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.reduce((n, b) => n + Object.keys(b).length, 0)).toBe(2000);
    expect(splitQuestions("x".repeat(96000), { finding: question })).toEqual([]);
  });
  it("rejects malformed and missing answers without inventing a judgment", async () => {
    for (const body of [
      "{}",
      '{"model":"typesafe/jev-1.13","answers":{},"usage":{"input_tokens":1,"output_tokens":0}}',
    ]) {
      const result = await assess(
        "source",
        { finding: question },
        { apiKey: "private", model: "typesafe/jev-1.13", fetch: async () => new Response(body) },
      );
      expect(result.answers).toEqual({});
    }
  });
  it("aborts an active request at the original deadline", async () => {
    const start = Date.now();
    const result = await assess(
      "source",
      { finding: question },
      {
        apiKey: "private",
        model: "typesafe/jev-1.13",
        wallDeadline: start + 30,
        fetch: async (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      },
    );
    expect(result.answers).toEqual({});
    expect(Date.now() - start).toBeLessThan(500);
  });
});

const Fixture = z.object({
  request: z.object({
    state: z.unknown(),
    questions: z.record(
      z.object({
        type: z.literal("choice"),
        instructions: z.string(),
        criteria: z.record(z.string()),
      }),
    ),
  }),
  response: z
    .object({
      model: z.string(),
      answers: z.record(z.unknown()),
      usage: z.object({ cost: z.number() }).passthrough(),
    })
    .passthrough(),
});
describe("recorded OpenRouter Jev responses", () => {
  it.each(["supported", "contradicted", "insufficient", "adversarial", "full-counterexample"])(
    "validates %s and preserves usage/model metadata",
    async (name) => {
      const fixture = Fixture.parse(
        JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")),
      );
      const result = await assess(
        JSON.stringify(fixture.request.state),
        fixture.request.questions,
        {
          apiKey: "private",
          model: "typesafe/jev-1.13",
          fetch: async () => new Response(JSON.stringify(fixture.response)),
        },
      );
      expect(result.reason).toBeUndefined();
      expect(result.answers).toEqual(fixture.response.answers);
      expect(result.model).toBe(fixture.response.model);
      expect(result.usage?.cost).toBe(fixture.response.usage.cost);
      expect(result.reason).toBeUndefined();
    },
  );
  it("retries a transient failure within the original budget", async () => {
    const fixture = Fixture.parse(
      JSON.parse(readFileSync(new URL("./fixtures/supported.json", import.meta.url), "utf8")),
    );
    let calls = 0;
    const result = await assess(JSON.stringify(fixture.request.state), fixture.request.questions, {
      apiKey: "private",
      model: "typesafe/jev-1.13",
      wallDeadline: Date.now() + 2000,
      fetch: async () =>
        ++calls === 1
          ? new Response("", { status: 529 })
          : new Response(JSON.stringify(fixture.response)),
    });
    expect(result.calls).toBe(2);
    expect(result.answers.finding?.choice).toBe("supported");
  });
});

it("server context-limit rejection never retries with truncated source", async () => {
  let calls = 0;
  const result = await assess(
    "evidence",
    { finding: question },
    {
      apiKey: "private",
      model: "typesafe/jev-1.13",
      fetch: async () => {
        calls++;
        return new Response("{}", { status: 422 });
      },
    },
  );
  expect(calls).toBe(1);
  expect(result.reason).toBe("http-422");
  expect(result.answers).toEqual({});
});
it("does not schedule backoff beyond the shared deadline", async () => {
  let calls = 0;
  const result = await assess(
    "evidence",
    { finding: question },
    {
      apiKey: "private",
      model: "typesafe/jev-1.13",
      wallDeadline: Date.now() + 100,
      fetch: async () => {
        calls++;
        return new Response("{}", { status: 429 });
      },
    },
  );
  expect(calls).toBe(1);
  expect(result.reason).toBe("deadline");
});

it("rejects malformed probabilities and incomplete answers independently", async () => {
  const fixture = Fixture.parse(
    JSON.parse(readFileSync(new URL("./fixtures/supported.json", import.meta.url), "utf8")),
  );
  const response = {
    ...fixture.response,
    answers: {
      ...fixture.response.answers,
      finding: {
        type: "choice",
        choice: "supported",
        confidence: 1,
        probabilities: { supported: 1 },
      },
    },
  };
  const result = await assess(JSON.stringify(fixture.request.state), fixture.request.questions, {
    apiKey: "private",
    model: "typesafe/jev-1.13",
    fetch: async () => new Response(JSON.stringify(response)),
  });
  expect(result.answers.finding).toBeUndefined();
  expect(result.answers.risk).toEqual(fixture.response.answers.risk);
  expect(result.reason).toBe("missing-or-invalid-answers");
});
