// model.ts — the scripted model provider the integration scenarios inject as
// `ReviewDeps.fetch`. It answers real OpenRouter chat-completions JSON on the wire
// (no module is mocked), records every outgoing envelope for assertions, and also
// sinks the toolu.sh review-run POST — the pipeline hands the SAME `fetch` to
// report/post.ts, so the two are routed apart by URL.
//
// Four answers are scriptable per package call, because the pipeline treats them
// very differently (spec §Layer 2): a verdict payload, a `schema` failure
// (unparseable content → NoObjectGeneratedError → BISECTABLE), a `transport`
// failure (a non-retryable HTTP status → APICallError → never bisects), and a
// `timeout` (the request never answers until reviewWithModel's own per-attempt
// AbortController fires → never bisects, but resumable).

const JSON_HEADERS = { "content-type": "application/json" };

/** One recorded outgoing model request. */
export interface CapturedCall {
  system: string;
  user: string;
}

/** A model-emitted verdict payload (the JSON the provider returns as content). */
export interface VerdictPayload {
  review_plan?: string;
  verdict: "approved" | "changes";
  findings: ScriptedFinding[];
  other_checks?: string;
  top_must_fix?: string[];
}

/** A scripted finding. `confidence: "high"` unless the severity clears the gate. */
export interface ScriptedFinding {
  path: string;
  line: number;
  end_line?: number;
  severity: "blocker" | "high" | "medium" | "low" | "nit";
  category?: string;
  confidence?: "high" | "medium";
  text: string;
  suggestion?: string;
}

/** A scripted answer to one Layer 2 package call. `fail: "schema"` returns
 *  unparseable content (bisectable); `fail: "transport"` returns HTTP 400;
 *  `fail: "timeout"` never answers at all (see {@link hangUntilAborted}). */
export type Reply = { ok: VerdictPayload } | { fail: "schema" | "transport" | "timeout" };

/** A clean package review. */
export const APPROVED: VerdictPayload = { verdict: "approved", findings: [] };

/** A "changes" package review carrying `findings`. */
export function changes(findings: ScriptedFinding[]): Reply {
  return { ok: { review_plan: "Reviewed the package.", verdict: "changes", findings } };
}

/** How the scripted provider answers this run. */
export interface ModelScript {
  /** The cartographer's JSON answer; omitted → an unusable payload (fail-open). */
  brief?: unknown;
  /** Layer 2's answer per package call (default: approved, no findings). */
  reply?: (call: CapturedCall, index: number) => Reply;
  /** When present, each package call appends `start <path>` / `end <path>` around
   *  a real await — the observable for the warm-up-then-fan-out call order. */
  events?: string[];
}

/** The scripted provider: an injectable `fetch` plus everything it recorded. */
export interface ModelServer {
  fetch: typeof fetch;
  /** Every model call, in order (cartographer + packages). */
  calls: CapturedCall[];
  /** The RAW body of every toolu.sh review-run POST (report/post.ts), so a
   *  scenario narrows it with its own typed `JSON.parse`. */
  reports: string[];
}

/** An OpenRouter chat-completions response carrying `value` as JSON content. */
function chatResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      id: "gen-integration",
      object: "chat.completion",
      created: 1_781_827_528,
      model: "deepseek/deepseek-v4-flash",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }),
    { status: 200, headers: JSON_HEADERS },
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The request's AbortSignal, wherever `fetch`'s caller put it (init, or a Request). */
function signalOf(
  url: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
): AbortSignal | null {
  if (init?.signal !== undefined && init.signal !== null) return init.signal;
  return url instanceof Request ? url.signal : null;
}

/**
 * Never answer: hang until the CALLER aborts, then reject exactly the way a real
 * `fetch` does. This is the only way to produce reviewWithModel's `timeout`
 * classification, which is keyed off ITS OWN per-attempt AbortController having
 * fired (`classifyFailure(err, aborted)`) — no wire-level status can reach it, so
 * before this a scenario simply could not exercise the `timeout` path at all.
 *
 * A scenario using it MUST pass a small `requestTimeoutMs` (reviewWithModel's
 * per-attempt deadline, which it retries MAX_ATTEMPTS times), or the run waits
 * out the 30 s default three times over.
 */
function hangUntilAborted(signal: AbortSignal | null): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    // No signal means nothing would ever settle this promise; a silently hung
    // suite is far worse to debug than a loud rejection.
    if (signal === null) {
      reject(new Error('model.ts: fail:"timeout" requires an AbortSignal on the request'));
      return;
    }
    const fail = (): void => {
      reject(new DOMException("This operation was aborted", "AbortError"));
    };
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

/** Build the scripted provider (and toolu.sh sink) for one scenario. */
export function modelServer(script: ModelScript = {}): ModelServer {
  const calls: CapturedCall[] = [];
  const reports: string[] = [];
  let index = 0;

  const impl: typeof fetch = async (url, init) => {
    const raw = typeof init?.body === "string" ? init.body : "{}";
    // `fetch`'s first argument is a string, a URL, or a Request — all three carry
    // the target differently, so narrow rather than stringify blindly.
    const target = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (target.includes("/machine/review-runs")) {
      reports.push(raw);
      return new Response("{}", { status: 200, headers: JSON_HEADERS });
    }
    const body: { messages?: { role: string; content: string }[] } = JSON.parse(raw);
    const messages = body.messages ?? [];
    const call: CapturedCall = {
      system: messages.find((m) => m.role === "system")?.content ?? "",
      user: messages.find((m) => m.role === "user")?.content ?? "",
    };
    calls.push(call);
    if (isCartographer(call)) return chatResponse(JSON.stringify(script.brief ?? { no: "brief" }));

    const id = diffPaths(call)[0] ?? `call-${index}`;
    script.events?.push(`start ${id}`);
    if (script.events) await sleep(5);
    const reply = script.reply?.(call, index++) ?? { ok: APPROVED };
    script.events?.push(`end ${id}`);
    if ("fail" in reply) {
      // A schema failure is unparseable CONTENT (NoObjectGeneratedError → bisectable);
      // a transport failure is a non-retryable HTTP status (APICallError → never
      // bisects); a timeout is no answer at all until the caller's own deadline aborts.
      if (reply.fail === "timeout") return hangUntilAborted(signalOf(url, init));
      return reply.fail === "schema"
        ? chatResponse("this is not JSON at all")
        : new Response('{"error":{"message":"upstream refused"}}', {
            status: 400,
            headers: JSON_HEADERS,
          });
    }
    return chatResponse(JSON.stringify(reply.ok));
  };
  return { fetch: impl, calls, reports };
}

/** The Layer 1 call — its system prompt is unmistakable. */
export function isCartographer(call: CapturedCall): boolean {
  return call.system.includes("You are the cartographer");
}

/** The Layer 2 (package reviewer) calls only. */
export function packageCalls(calls: CapturedCall[]): CapturedCall[] {
  return calls.filter((c) => !isCartographer(c));
}

/** The `## Diff` block of a captured envelope — the ONLY place it shows code. */
export function diffBlock(call: CapturedCall): string {
  const at = call.user.indexOf("\n\n## Diff\n");
  return at === -1 ? "" : call.user.slice(at);
}

/** The paths whose diff this envelope actually carried (`+++ b/<path>` headers). */
export function diffPaths(call: CapturedCall): string[] {
  return [...diffBlock(call).matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1] ?? "");
}
