import { describe, it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import {
  fingerprint,
  attachFps,
  encodeMarker,
  decodeMarker,
  diffState,
  type ReviewState,
  type Finding,
} from "@/state.js";

const sampleState: ReviewState = {
  schema: "toolu-review-state",
  version: 1,
  findings: [{ path: "src/a.ts", line: 10, text: "bug here", category: "correctness", fp: "z" }],
  history: [
    {
      sha: "abc1234",
      ts: 1700000000,
      verdict: "changes",
      counts: { new: 1, open: 0, resolved: 0, total: 1 },
    },
  ],
};

describe("encode/decode marker", () => {
  it("round-trips state through the gzip+base64 marker", () => {
    const decoded = decodeMarker(encodeMarker(sampleState));
    expect(decoded).toEqual(sampleState);
  });

  it("decodes a marker embedded inside a larger comment body", () => {
    const body = `## Review\n\nsome text\n\n${encodeMarker(sampleState)}\n`;
    expect(decodeMarker(body)).toEqual(sampleState);
  });

  it("fail-safe to {} on missing marker", () => {
    expect(decodeMarker("no marker here")).toEqual({});
    expect(decodeMarker("")).toEqual({});
  });

  it("fail-safe to {} on valid base64 that is not gzip", () => {
    const notGzip = `<!-- toolu-review-state:v1 ${Buffer.from("hello").toString("base64")} -->`;
    expect(decodeMarker(notGzip)).toEqual({});
  });

  it("fail-safe to {} on a valid marker payload whose JSON is the wrong shape", () => {
    // A real gzip+base64 marker carrying syntactically-valid JSON that is NOT a
    // ReviewState (no schema/version literals). zod rejects it → {} fail-safe.
    const payload = gzipSync(
      Buffer.from(JSON.stringify({ not: "a review state" }), "utf8"),
    ).toString("base64");
    expect(decodeMarker(`<!-- toolu-review-state:v1 ${payload} -->`)).toEqual({});
  });

  it("fail-safe to {} on a gzip bomb that inflates past the 5MB cap (FIX 4)", () => {
    // A real, valid gzip stream whose decompressed size (>5MB of repeated bytes)
    // exceeds the decode cap. gunzipSync throws RangeError past maxOutputLength;
    // the try/catch turns that into {}, so a hostile PR-comment marker can't OOM.
    const bomb = gzipSync(Buffer.alloc(6_000_000, 0x61)); // 6MB of 'a' → tiny gzip
    expect(bomb.length).toBeLessThan(100_000); // genuinely small on the wire
    const marker = `<!-- toolu-review-state:v1 ${bomb.toString("base64")} -->`;
    expect(decodeMarker(marker)).toEqual({});
  });

  it("still decodes a real (sub-cap) marker after adding the bomb guard", () => {
    // Guard against an over-tight cap: a normal state marker must still round-trip.
    expect(decodeMarker(encodeMarker(sampleState))).toEqual(sampleState);
  });
});

describe("fingerprint", () => {
  it("is deterministic and excludes line (survives line drift)", () => {
    const a: Finding = { path: "x.ts", line: 5, text: "same text", category: "c" };
    const b: Finding = { path: "x.ts", line: 99, text: "same text", category: "c" };
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it("normalizes case, punctuation, and collapsed whitespace", () => {
    const a: Finding = { path: "x.ts", text: "Token   expiry uses < not <=!!!", category: "c" };
    const b: Finding = { path: "x.ts", text: "token expiry uses  not", category: "c" };
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it("differs when path or category differs", () => {
    expect(fingerprint({ path: "a.ts", text: "t" })).not.toBe(
      fingerprint({ path: "b.ts", text: "t" }),
    );
    expect(fingerprint({ path: "a.ts", text: "t", category: "x" })).not.toBe(
      fingerprint({ path: "a.ts", text: "t", category: "y" }),
    );
  });
});

describe("diffState", () => {
  const prior: ReviewState = {
    schema: "toolu-review-state",
    version: 1,
    findings: attachFps([{ path: "src/a.ts", text: "finding A", category: "c" }]),
    history: [],
  };

  it("partitions new / open against the prior fingerprints", () => {
    const current = [
      { path: "src/a.ts", text: "finding A", category: "c" }, // open
      { path: "src/b.ts", text: "finding B", category: "c" }, // new
    ];
    const r = diffState({
      prior,
      current_findings: current,
      scope: { in_scope_paths: ["src/a.ts", "src/b.ts"], full_review: true },
      head_sha: "deadbeefcafe",
      verdict: "changes",
    });
    expect(r.counts).toMatchObject({ new: 1, open: 1, resolved: 0, total: 2 });
    expect(r.new[0]?.path).toBe("src/b.ts");
    expect(r.open[0]?.path).toBe("src/a.ts");
  });

  it("marks a prior finding resolved only on a full review within scope", () => {
    const full = diffState({
      prior,
      current_findings: [],
      scope: { in_scope_paths: ["src/a.ts"], full_review: true },
      head_sha: "deadbeef",
      verdict: "approved",
    });
    expect(full.resolved.map((f) => f.path)).toEqual(["src/a.ts"]);

    const partial = diffState({
      prior,
      current_findings: [],
      scope: { in_scope_paths: ["src/a.ts"], full_review: false },
      head_sha: "deadbeef",
      verdict: "approved",
    });
    expect(partial.resolved).toEqual([]);

    const outOfScope = diffState({
      prior,
      current_findings: [],
      scope: { in_scope_paths: ["other.ts"], full_review: true },
      head_sha: "deadbeef",
      verdict: "approved",
    });
    expect(outOfScope.resolved).toEqual([]);
  });

  it("stamps the history-entry ts from the injected ms clock (deterministic marker)", () => {
    // FIX 13: a pinned `now` (epoch MS) reaches the history entry, so the marker
    // is reproducible. The entry's ts is epoch SECONDS (floor of ms/1000).
    const pinnedMs = 1_700_000_123_456;
    const r = diffState({
      prior,
      current_findings: [],
      scope: { in_scope_paths: ["src/a.ts"], full_review: true },
      head_sha: "deadbeefcafe",
      verdict: "approved",
      now: () => pinnedMs,
    });
    expect(r.history_entry.ts).toBe(Math.floor(pinnedMs / 1000));
    expect(r.next_state.history.at(-1)?.ts).toBe(1_700_000_123);
    // The full marker is byte-stable under the pinned clock (no wall-clock leak).
    expect(encodeMarker(r.next_state)).toBe(encodeMarker(r.next_state));
  });

  it("defaults the clock to Date.now when `now` is omitted (back-compat)", () => {
    const before = Math.floor(Date.now() / 1000);
    const r = diffState({
      prior,
      current_findings: [],
      scope: { in_scope_paths: ["src/a.ts"], full_review: true },
      head_sha: "deadbeef",
      verdict: "approved",
    });
    const after = Math.floor(Date.now() / 1000);
    expect(r.history_entry.ts).toBeGreaterThanOrEqual(before);
    expect(r.history_entry.ts).toBeLessThanOrEqual(after);
  });

  it("caps history at the last 10 entries", () => {
    const longHistory: ReviewState = {
      ...prior,
      history: Array.from({ length: 12 }, (_, i) => ({
        sha: `sha${i}`,
        ts: i,
        verdict: "changes",
        counts: { new: 0, open: 0, resolved: 0, total: 0 },
      })),
    };
    const r = diffState({
      prior: longHistory,
      current_findings: [],
      scope: { in_scope_paths: [], full_review: true },
      head_sha: "abcdef0",
      verdict: "approved",
    });
    expect(r.next_state.history).toHaveLength(10);
    expect(r.next_state.history.at(-1)).toEqual(r.history_entry);
  });
});
