// OpenRouter-only System One transport. No provider SDK or separate credential.
import { setSecret } from "@actions/core";
import { z } from "zod";
import { wallTimeLeft } from "@/llm/wallDeadline.js";

/** Choice questions name every outcome explicitly, including insufficient evidence. */
export interface Question {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}
const probability = z.number().finite().min(0).max(1);
const Choice = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  confidence: probability,
  probabilities: z.record(probability),
});
const ResponseBody = z.object({
  model: z.string().regex(/^[A-Za-z0-9_.~:/-]{1,200}$/),
  answers: z.record(z.unknown()),
  usage: z
    .object({
      input_tokens: z.number().nonnegative(),
      output_tokens: z.number().nonnegative(),
      cost: z.number().nonnegative().optional(),
    })
    .optional(),
});
/** A validated choice, with relative probabilities and concentration confidence. */
export type ChoiceAnswer = z.infer<typeof Choice>;
/** Only metadata is exposed for logging; response bodies and source stay private. */
export interface Assessment {
  answers: Record<string, ChoiceAnswer>;
  model?: string;
  usage?: z.infer<typeof ResponseBody>["usage"];
  elapsedMs: number;
  calls: number;
  reason?: string;
}
/** Shared credential, original deadline, and injectable HTTP boundary. */
export interface AssessmentOptions {
  apiKey: string;
  model: string;
  wallDeadline?: number | undefined;
  timeoutMs?: number;
  fetch?: typeof fetch | undefined;
}
// Bounded estimate (~3 UTF-8 bytes/token) below documented 32k/64k budgets.
// Tokenization varies: server context rejection is final/unavailable, never a retry
// with truncated source. A strict bytes=token bound skipped every real PR175 package.
const STATE_QUESTION_BYTES = 90000;
const REQUEST_BYTES = 180000;

/** Split only independent questions; never silently truncate package evidence. */
export function splitQuestions(
  state: string,
  questions: Record<string, Question>,
): Record<string, Question>[] {
  const stateBytes = Buffer.byteLength(JSON.stringify(state));
  const batches: Record<string, Question>[] = [];
  let batch: Record<string, Question> = {};
  for (const [id, question] of Object.entries(questions)) {
    if (stateBytes + Buffer.byteLength(JSON.stringify(question)) > STATE_QUESTION_BYTES) return [];
    if (
      stateBytes + Buffer.byteLength(JSON.stringify({ ...batch, [id]: question })) >
      REQUEST_BYTES
    ) {
      batches.push(batch);
      batch = {};
    }
    batch[id] = question;
  }
  if (Object.keys(batch).length) batches.push(batch);
  return batches;
}

function answersFor(
  raw: Record<string, unknown>,
  questions: Record<string, Question>,
): Record<string, ChoiceAnswer> {
  const answers: Record<string, ChoiceAnswer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const parsed = Choice.safeParse(raw[id]);
    if (!parsed.success) continue;
    const a = parsed.data;
    const keys = Object.keys(question.criteria);
    if (
      !keys.includes(a.choice) ||
      keys.length !== Object.keys(a.probabilities).length ||
      keys.some((k) => a.probabilities[k] === undefined)
    )
      continue;
    const values = Object.values(a.probabilities);
    if (
      Math.abs(values.reduce((n, v) => n + v, 0) - 1) > 0.02 ||
      a.probabilities[a.choice] !== Math.max(...values)
    )
      continue;
    answers[id] = a;
  }
  return answers;
}

/** Fail open with no answers, bounded retries and cancellation including response reads. */
export async function assess(
  state: string,
  questions: Record<string, Question>,
  options: AssessmentOptions,
): Promise<Assessment> {
  const started = Date.now();
  let calls = 0;
  const unavailable = (reason: string): Assessment => ({
    answers: {},
    elapsedMs: Date.now() - started,
    calls,
    reason,
  });
  if (!splitQuestions(state, questions).length) return unavailable("context-limit");
  if (Buffer.byteLength(JSON.stringify({ state, questions })) > REQUEST_BYTES)
    return unavailable("context-limit");
  if (process.env["GITHUB_ACTIONS"] === "true") setSecret(options.apiKey);
  for (let attempt = 0; attempt < 3; attempt++) {
    const remaining = wallTimeLeft(options.wallDeadline);
    if (remaining <= 0) return unavailable("deadline");
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(options.timeoutMs ?? 30000, 30000, remaining),
    );
    let retry = false;
    try {
      calls++;
      const response = await (options.fetch ?? fetch)("https://openrouter.ai/api/v1/systemone", {
        method: "POST",
        headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: options.model, state, questions }),
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        retry = response.status === 429 || response.status >= 500;
        if (!retry || attempt === 2) return unavailable(`http-${response.status}`);
      } else {
        const parsed = ResponseBody.safeParse(await response.json());
        if (!parsed.success) return unavailable("invalid-response");
        if (wallTimeLeft(options.wallDeadline) <= 0) return unavailable("deadline");
        const answers = answersFor(parsed.data.answers, questions);
        return {
          answers,
          model: parsed.data.model,
          usage: parsed.data.usage,
          elapsedMs: Date.now() - started,
          calls,
          ...(Object.keys(answers).length < Object.keys(questions).length
            ? { reason: "missing-or-invalid-answers" }
            : {}),
        };
      }
    } catch {
      if (controller.signal.aborted)
        return unavailable(wallTimeLeft(options.wallDeadline) <= 0 ? "deadline" : "timeout");
      retry = true;
    } finally {
      clearTimeout(timer);
    }
    if (retry && attempt < 2) {
      const delay = 250 * 2 ** attempt;
      if (wallTimeLeft(options.wallDeadline) <= delay) return unavailable("deadline");
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  return unavailable("transport");
}
