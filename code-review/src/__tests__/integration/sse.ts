// sse.ts — chat-completions SSE framing for the recorded-replay harnesses.
//
// The review call streams (llm/streamVerdict.ts), so every fake `fetch` in the suite has
// to answer `stream: true` with a real event stream instead of one JSON body. Nothing
// here invents review CONTENT: the recorded fixtures stay byte-identical and are simply
// re-chunked into deltas — the synthetic part is the framing, which is exactly what the
// wire does to a completion. The cartographer still posts a non-streaming request
// (generateObject), so routing is `body.stream === true` → SSE, everything else → JSON.
//
// FRAMES MUST BE COMPLETE. Both shipped providers zod-validate every chunk, and a frame
// that fails validation is enqueued as an `{type:"error"}` stream part — i.e. a
// half-specified frame would silently become a transport failure in every test that used
// it. So each frame carries id/object/created/model and a full `choices[0]` with `index`,
// `delta` and `finish_reason`, the terminal frame carries the finish reason and usage,
// and the stream ends with `[DONE]`.
import { z } from "zod";

/** Delta size the recorded content is sliced into — small enough that a fixture spans
 *  many frames (so partial-JSON snapshots really do accumulate), large enough to keep
 *  the streams cheap. */
const DELTA_CHARS = 80;

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
};

/**
 * The shape every recorded fixture in this repo shares: one chat-completions choice
 * carrying the model's content and its finish reason. `.parse` THROWS on anything else —
 * a fixture that is not a recorded completion is a test bug, not something to paper over.
 */
const RecordedCompletion = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullish(),
        message: z.object({ content: z.string().nullish() }),
      }),
    )
    .nonempty(),
});

/** One chat-completion chunk frame, as the provider's chunk schema expects it. */
export interface ChunkFrame {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: {
    index: 0;
    delta: { role?: "assistant"; content?: string };
    finish_reason: string | null;
  }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

/** True when the outgoing request asked the provider to stream. Throws on a body that is
 *  not JSON — the AI SDK always posts JSON, so anything else is a broken fake. */
export function wantsStream(init: RequestInit | undefined): boolean {
  const raw = typeof init?.body === "string" ? init.body : "";
  if (raw === "") return false;
  const parsed = z.object({ stream: z.boolean().optional() }).safeParse(JSON.parse(raw));
  return parsed.success && parsed.data.stream === true;
}

/**
 * Re-chunk `content` into the frames a provider would emit for it: one role-opening
 * delta, `DELTA_CHARS`-sized content deltas, then a terminal frame carrying
 * `finishReason` and usage. Empty content yields the terminal frame alone — the shape of
 * the recorded reasoning-budget bug (finish_reason "length", nothing emitted).
 */
export function contentFrames(content: string, finishReason: string): ChunkFrame[] {
  const frames: ChunkFrame[] = [];
  for (let at = 0; at < content.length; at += DELTA_CHARS) {
    const slice = content.slice(at, at + DELTA_CHARS);
    // The wire opens with the assistant role on the first delta, then sends content only.
    frames.push(frame(at === 0 ? { role: "assistant", content: slice } : { content: slice }, null));
  }
  const last = frame({}, finishReason);
  last.usage = { prompt_tokens: 974, completion_tokens: 98, total_tokens: 1072 };
  frames.push(last);
  return frames;
}

/** One frame with the shared envelope filled in. */
export function frame(
  delta: { role?: "assistant"; content?: string },
  finishReason: string | null,
): ChunkFrame {
  return {
    id: "gen-sse-replay",
    object: "chat.completion.chunk",
    created: 1_781_827_528,
    model: "deepseek/deepseek-v4-flash",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

/**
 * An event-stream Response over `frames`. `done` appends the `[DONE]` sentinel (the
 * default; omit it to model a body that stops arriving). Values are serialized as-is, so
 * a caller can also push a provider ERROR frame (`{ error: { … } }`) mid-stream.
 */
export function sseResponse(frames: unknown[], done = true): Response {
  const payloads = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`);
  if (done) payloads.push("data: [DONE]\n\n");
  return new Response(payloads.join(""), { status: 200, headers: SSE_HEADERS });
}

/**
 * Serve a recorded chat-completions body the way the request asked for it: as SSE when
 * it streamed (the review call), as the recorded JSON otherwise (the cartographer). The
 * recorded content and finish reason are reproduced exactly — only the framing changes.
 */
export function replayCompletion(body: unknown, init: RequestInit | undefined): Response {
  if (!wantsStream(init)) {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  const choice = RecordedCompletion.parse(body).choices[0];
  return sseResponse(contentFrames(choice.message.content ?? "", choice.finish_reason ?? "stop"));
}
