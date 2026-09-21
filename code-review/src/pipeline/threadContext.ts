// Prior-thread evidence shared by baseline package prompts.
import type { PriorThreadContext } from "@/prompt.js";
import type { PriorThread } from "@/github/threads.js";
/**
 * Map the bot's prior threads to the prompt's context block: accept-or-argue for
 * still-live threads, DISMISSED (settled, do not re-raise or reword) for those the
 * author resolved on GitHub or dismissed in a reply (see review/dismissal.ts).
 */
export function buildThreadContexts(priorThreads: PriorThread[]): PriorThreadContext[] {
  return priorThreads.map((t) => ({
    path: t.path,
    line: t.line,
    finding: cleanFindingBody(t.rootBody),
    replies: t.replies,
    resolved: t.isResolved,
    ...(t.dismissal !== undefined ? { dismissal: t.dismissal } : {}),
  }));
}

/** Strip the hidden fp marker and any ```suggestion block from a stored finding body,
 *  leaving the human-readable finding text for the accept-or-argue prompt block. */
export function cleanFindingBody(body: string): string {
  return body
    .replace(/<!-- toolu-fp:[0-9a-f]+ -->/g, "")
    .replace(/```suggestion[\s\S]*?```/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
