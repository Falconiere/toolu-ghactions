// report/post.ts — the best-effort HTTP POST of one review-run payload to
// toolu.sh. Mirrors the AbortController + timeout.unref?.() pattern already at
// llm/reviewWithModel.ts:139-160. One attempt, no retry (design doc, "Failure is
// silent by design"): a dropped run costs one data point, and a retry loop on a
// best-effort reporting path is a liability, not a safety net.
//
// MUST NOT import @actions/core and MUST NOT throw: every failure mode — a
// non-2xx response, a thrown error (DNS/network), or a timed-out request —
// resolves to `{ ok: false, reason }` instead. The caller (report/report-run.ts)
// is the one place that turns that into a `core.warning`, so this module stays
// framework-free and trivially unit-testable with an injected `fetch`.
import type { ReviewRunPayload } from "./payload.js";

/** Per-attempt deadline before the request is aborted. Short by design: this is
 *  a best-effort metadata ping, not a call worth blocking the job on. */
export const POST_TIMEOUT_MS = 5_000;

/** Everything {@link post} needs to send one review-run payload. */
export interface PostInput {
  /** Base URL of the toolu.sh API (`inputs.touluApiUrl`); no trailing slash assumed. */
  touluApiUrl: string;
  /** The org's `toolu_…` bearer token (`inputs.touluApiKey`). */
  touluApiKey: string;
  /** The wire body built by {@link import("./payload.js").buildPayload}. */
  payload: ReviewRunPayload;
  /** Injectable for tests (replays a recorded response, or simulates a hang);
   *  defaults to global `fetch` in production. */
  fetch?: typeof fetch;
  /** Override the per-attempt deadline; tests only (default {@link POST_TIMEOUT_MS}). */
  timeoutMs?: number;
}

/** The outcome of one POST attempt — never thrown, always returned. */
export type PostResult = { ok: true } | { ok: false; reason: string };

/**
 * POST one review-run payload to `${touluApiUrl}/machine/review-runs`. Never
 * throws and never retries: a non-2xx status, a thrown fetch error, and an
 * aborted (timed-out) request all resolve to `{ ok: false, reason }`.
 */
export async function post(input: PostInput): Promise<PostResult> {
  const doFetch = input.fetch ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? POST_TIMEOUT_MS);
  timeout.unref?.();

  try {
    const res = await doFetch(`${input.touluApiUrl}/machine/review-runs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.touluApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input.payload),
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, reason: `toolu.sh responded ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}
