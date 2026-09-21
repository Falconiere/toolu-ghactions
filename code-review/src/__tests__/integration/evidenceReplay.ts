// evidenceReplay.ts — explicit protocol adapter for historical happy-path fixtures.
// Recordings remain immutable. Their findings predate required quoted_line, so these
// wiring tests add ONLY the exact cited source line from the actual outgoing diff.
// This is not a new model recording or a semantic judgment. Raw missing-evidence
// regression tests deliberately use replayCompletion without this adapter.
import { z } from "zod";
import { shapeDiff } from "@/git/shape.js";
import { replayCompletion, wantsStream } from "./sse.js";

const Completion = z
  .object({
    choices: z.array(
      z
        .object({
          message: z.object({ content: z.string() }).passthrough(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const Review = z
  .object({
    findings: z.array(
      z
        .object({
          path: z.string(),
          line: z.number(),
          quoted_line: z.string().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

/** Replay a historical complete review with source quotes for the current protocol. */
export function replayWithSourceQuotes(body: unknown, init: RequestInit | undefined): Response {
  if (!wantsStream(init)) return replayCompletion(body, init);
  const completion = Completion.safeParse(body);
  if (!completion.success) return replayCompletion(body, init);
  const request: { messages?: { role: string; content: string }[] } = JSON.parse(
    typeof init?.body === "string" ? init.body : "{}",
  );
  const prompt = request.messages?.find((m) => m.role === "user")?.content ?? "";
  const at = prompt.indexOf("\n\n## Diff\n");
  const rawDiff = at < 0 ? "" : prompt.slice(at).replace(/^L(?:\d+|---): /gm, "");
  const source = new Map(shapeDiff(rawDiff).files.map((f) => [f.path, f.line_text]));
  const choices = completion.data.choices.map((choice) => {
    // Truncated/malformed recordings exercise recovery and must stay untouched.
    let parsed: unknown;
    try {
      parsed = JSON.parse(choice.message.content);
    } catch {
      return choice;
    }
    const review = Review.safeParse(parsed);
    if (!review.success) return choice;
    const findings = review.data.findings.map((finding) => {
      const quoted = source.get(finding.path)?.[finding.line];
      if (finding.quoted_line !== undefined || quoted === undefined) return finding;
      return { ...finding, quoted_line: quoted };
    });
    return {
      ...choice,
      message: { ...choice.message, content: JSON.stringify({ ...review.data, findings }) },
    };
  });
  return replayCompletion({ ...completion.data, choices }, init);
}
