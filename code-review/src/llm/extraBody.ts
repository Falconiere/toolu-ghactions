// Validate custom server options without allowing overrides of the review wire contract.
import { z } from "zod";
import type { JSONValue } from "ai";

const jsonValue: z.ZodType<JSONValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(jsonValue),
  ]),
);
const bodySchema = z.record(jsonValue);
const reserved = [
  "model",
  "messages",
  "max_tokens",
  "temperature",
  "response_format",
  "stream",
  "stream_options",
  "tools",
  "tool_choice",
];

/** Parse a JSON object of server options; never include its value in errors. */
export function parseExtraBody(raw: string): Record<string, JSONValue> | undefined {
  if (!raw.trim()) return undefined;
  let body: Record<string, JSONValue>;
  try {
    body = bodySchema.parse(JSON.parse(raw));
  } catch {
    throw new Error("EXTRA_BODY must be a valid JSON object.");
  }
  if (reserved.some((key) => Object.hasOwn(body, key))) {
    throw new Error(
      "EXTRA_BODY cannot override model, messages, token budget, temperature, response format, streaming or tools.",
    );
  }
  return body;
}
