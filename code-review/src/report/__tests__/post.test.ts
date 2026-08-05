// post.test.ts — proves post() is a genuine one-attempt, never-throwing HTTP
// client: the right request shape, and every failure mode (non-2xx, a thrown
// fetch error, and a timed-out/hung request) resolving to `{ ok: false, reason }`
// instead of rejecting. The timeout case drives the abort with a short injected
// `timeoutMs` — never a real 5-second wait — mirroring
// llm/reviewWithModel.ts's own hang test.
import { describe, expect, it } from "vitest";
import { post, POST_TIMEOUT_MS } from "@/report/post.js";
import type { ReviewRunPayload } from "@/report/payload.js";

const PAYLOAD: ReviewRunPayload = {
  schemaVersion: 1,
  repo: { id: "42", fullName: "acme/widgets" },
  pull: { number: 7, headSha: "abc123", baseBranch: "main", authorLogin: "octocat" },
  run: {
    githubRunId: "111",
    githubRunAttempt: 1,
    reportedRound: 1,
    verdict: "approved",
    capped: false,
    fullReview: true,
    provider: "openrouter",
    modelId: "anthropic/claude-sonnet-4-5",
    durationMs: 500,
    startedAt: 1_700_000_000_000,
  },
  findings: { new: [], open: [], fixed: [], dismissed: [] },
};

/** `post()` always calls `doFetch` with a plain string URL and a string JSON
 *  body, but the stub's own signature is the full `typeof fetch` union — narrow
 *  it here rather than `String(...)`ing a type that can include a bodiless
 *  `Request`/stream (oxlint's `no-base-to-string`). */
function stringUrl(url: Parameters<typeof fetch>[0]): string {
  if (typeof url === "string") return url;
  if (url instanceof URL) return url.href;
  return url.url;
}

describe("post — request shape", () => {
  it("POSTs the payload to <touluApiUrl>/machine/review-runs with the bearer + JSON headers", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    let seenBody = "";
    const fetchStub: typeof fetch = async (url, init) => {
      seenUrl = stringUrl(url);
      seenInit = init;
      if (typeof init?.body === "string") seenBody = init.body;
      return new Response("{}", { status: 200 });
    };

    const result = await post({
      touluApiUrl: "https://api.toolu.sh",
      touluApiKey: "toolu_abc123",
      payload: PAYLOAD,
      fetch: fetchStub,
    });

    expect(result).toEqual({ ok: true });
    expect(seenUrl).toBe("https://api.toolu.sh/machine/review-runs");
    expect(seenInit?.method).toBe("POST");
    const headers = new Headers(seenInit?.headers);
    expect(headers.get("Authorization")).toBe("Bearer toolu_abc123");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(seenBody)).toEqual(PAYLOAD);
  });
});

describe("post — every failure mode resolves, never throws (AC-24)", () => {
  it("a non-2xx response", async () => {
    const fetchStub: typeof fetch = async () => new Response("nope", { status: 503 });
    const result = await post({
      touluApiUrl: "https://api.toolu.sh",
      touluApiKey: "toolu_abc123",
      payload: PAYLOAD,
      fetch: fetchStub,
    });
    expect(result).toEqual({ ok: false, reason: "toolu.sh responded 503" });
  });

  it("a thrown fetch error (DNS/network)", async () => {
    const fetchStub: typeof fetch = async () => {
      throw new Error("getaddrinfo ENOTFOUND api.toolu.sh");
    };
    const result = await post({
      touluApiUrl: "https://api.toolu.sh",
      touluApiKey: "toolu_abc123",
      payload: PAYLOAD,
      fetch: fetchStub,
    });
    expect(result).toEqual({ ok: false, reason: "getaddrinfo ENOTFOUND api.toolu.sh" });
  });

  it("a request that never resolves on its own — only the AbortController settles it", async () => {
    // Real fetch behavior: the promise only settles once the injected signal aborts.
    let calls = 0;
    const hangingFetch: typeof fetch = (_url, init) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("This operation was aborted."), { name: "AbortError" }));
        });
      });
    };

    const start = Date.now();
    const result = await post({
      touluApiUrl: "https://api.toolu.sh",
      touluApiKey: "toolu_abc123",
      payload: PAYLOAD,
      fetch: hangingFetch,
      timeoutMs: 20, // short override — never waits the real POST_TIMEOUT_MS default
    });
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/abort/i);
    expect(calls).toBe(1); // one attempt, no retry
    expect(elapsed).toBeLessThan(2_000);
  });

  it("no retry: exactly one fetch call even on failure", async () => {
    let calls = 0;
    const fetchStub: typeof fetch = async () => {
      calls++;
      return new Response("", { status: 500 });
    };
    await post({
      touluApiUrl: "https://api.toolu.sh",
      touluApiKey: "toolu_abc123",
      payload: PAYLOAD,
      fetch: fetchStub,
    });
    expect(calls).toBe(1);
  });
});

describe("post — POST_TIMEOUT_MS", () => {
  it("is a positive, short (best-effort) default", () => {
    expect(POST_TIMEOUT_MS).toBeGreaterThan(0);
    expect(POST_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});
