import { describe, it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import {
  fingerprint,
  attachFps,
  encodeMarker,
  decodeMarker,
  extractMarker,
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

  it("decodes a pre-change v1 marker (no reviewed_tree/unreviewed_paths/pending_paths/clusters) fine (AC-7)", () => {
    // sampleState predates this change: it carries none of the four new fields, only
    // schema/version/findings/history. A marker built from it must still decode cleanly
    // — additive fields on a v1 schema are backward-compatible by construction (zod
    // strips/omits unknown-absent keys, never rejects a marker for missing optionals).
    const marker = encodeMarker(sampleState);
    const decoded = decodeMarker(marker);
    expect(decoded).toEqual(sampleState);
    if (!("schema" in decoded)) throw new Error("decoded marker is missing schema");
    expect(decoded.reviewed_tree).toBeUndefined();
    expect(decoded.unreviewed_paths).toBeUndefined();
    expect(decoded.pending_paths).toBeUndefined();
    expect(decoded.clusters).toBeUndefined();
  });

  it("round-trips a state carrying all four new marker fields (AC-7)", () => {
    const withNewFields: ReviewState = {
      ...sampleState,
      reviewed_tree: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      unreviewed_paths: ["src/skipped.ts", "src/also-skipped.ts"],
      pending_paths: ["src/not-yet.ts"],
      clusters: { fp_member_1: "fp_exemplar", fp_member_2: "fp_exemplar" },
    };
    const decoded = decodeMarker(encodeMarker(withNewFields));
    expect(decoded).toEqual(withNewFields);
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
      complete: true,
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
      complete: true,
    });
    expect(full.resolved.map((f) => f.path)).toEqual(["src/a.ts"]);

    const partial = diffState({
      prior,
      current_findings: [],
      scope: { in_scope_paths: ["src/a.ts"], full_review: false },
      head_sha: "deadbeef",
      verdict: "approved",
      complete: true,
    });
    expect(partial.resolved).toEqual([]);

    const outOfScope = diffState({
      prior,
      current_findings: [],
      scope: { in_scope_paths: ["other.ts"], full_review: true },
      head_sha: "deadbeef",
      verdict: "approved",
      complete: true,
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
      complete: true,
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
      complete: true,
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
      complete: true,
    });
    expect(r.next_state.history).toHaveLength(10);
    expect(r.next_state.history.at(-1)).toEqual(r.history_entry);
  });

  it("complete:true threads reviewed_tree/unreviewed_paths/pending_paths/clusters into next_state (AC-7)", () => {
    // diffState is the ONLY carrier into next_state: every new field must round-trip
    // through it or the next round silently drops it.
    const r = diffState({
      prior,
      current_findings: [{ path: "src/a.ts", text: "finding A", category: "c" }],
      scope: { in_scope_paths: ["src/a.ts"], full_review: true },
      head_sha: "deadbeefcafe",
      verdict: "changes",
      complete: true,
      reviewed_tree: "tree-sha-round2",
      unreviewed_paths: ["src/failed.ts"],
      pending_paths: ["src/pending.ts"],
      clusters: { fp1: "fpExemplar" },
    });
    expect(r.next_state.reviewed_sha).toBe("deadbeefcafe");
    expect(r.next_state.reviewed_tree).toBe("tree-sha-round2");
    expect(r.next_state.unreviewed_paths).toEqual(["src/failed.ts"]);
    expect(r.next_state.pending_paths).toEqual(["src/pending.ts"]);
    expect(r.next_state.clusters).toEqual({ fp1: "fpExemplar" });
    // A complete run still appends this round's history entry (unchanged behavior).
    expect(r.next_state.history.at(-1)).toEqual(r.history_entry);
  });

  it("complete:false appends no history entry and preserves the prior reviewed_sha/reviewed_tree", () => {
    const priorWithTree: ReviewState = {
      ...prior,
      reviewed_sha: "prior-sha",
      reviewed_tree: "prior-tree",
    };
    const r = diffState({
      prior: priorWithTree,
      current_findings: [{ path: "src/a.ts", text: "finding A", category: "c" }],
      scope: { in_scope_paths: ["src/a.ts"], full_review: true },
      head_sha: "new-head-sha",
      verdict: "changes",
      complete: false,
      // A partial run is still passing this round's reviewed_tree along, but it must
      // NOT be adopted — only a complete run advances reviewed_sha/reviewed_tree.
      reviewed_tree: "would-be-new-tree",
      unreviewed_paths: ["src/failed.ts"],
      pending_paths: ["src/pending.ts"],
    });
    // History stays exactly the prior round's — no entry appended for a partial run.
    expect(r.next_state.history).toEqual(priorWithTree.history);
    expect(r.next_state.history).not.toContainEqual(r.history_entry);
    // reviewed_sha/reviewed_tree stay pinned to the PRIOR complete-coverage head, not
    // the in-progress one.
    expect(r.next_state.reviewed_sha).toBe("prior-sha");
    expect(r.next_state.reviewed_tree).toBe("prior-tree");
    // Exception lists are still threaded from this round's input either way.
    expect(r.next_state.unreviewed_paths).toEqual(["src/failed.ts"]);
    expect(r.next_state.pending_paths).toEqual(["src/pending.ts"]);
  });

  // Regression: a complete round with no reviewed_tree used to write `undefined`
  // over the prior tree, permanently disabling tree-based incremental scoping.
  // settle.ts OMITS reviewed_tree whenever head-tree resolution fails, so this is
  // the real, reachable path — not a hypothetical one.
  it("complete:true WITHOUT a reviewed_tree preserves the prior tree instead of erasing it", () => {
    const priorWithTree: ReviewState = {
      ...prior,
      reviewed_sha: "prior-sha",
      reviewed_tree: "prior-tree",
    };
    const r = diffState({
      prior: priorWithTree,
      current_findings: [{ path: "src/a.ts", text: "finding A", category: "c" }],
      scope: { in_scope_paths: ["src/a.ts"], full_review: true },
      head_sha: "new-head-sha",
      verdict: "changes",
      complete: true,
      // no reviewed_tree: settle.ts could not resolve the head tree this round.
    });
    // reviewed_sha advances (head_sha is always supplied); the tree holds its
    // last known-good value rather than becoming undefined.
    expect(r.next_state.reviewed_sha).toBe("new-head-sha");
    expect(r.next_state.reviewed_tree).toBe("prior-tree");
  });

  it("complete:true WITH a reviewed_tree advances it past the prior tree", () => {
    const priorWithTree: ReviewState = {
      ...prior,
      reviewed_sha: "prior-sha",
      reviewed_tree: "prior-tree",
    };
    const r = diffState({
      prior: priorWithTree,
      current_findings: [{ path: "src/a.ts", text: "finding A", category: "c" }],
      scope: { in_scope_paths: ["src/a.ts"], full_review: true },
      head_sha: "new-head-sha",
      verdict: "changes",
      complete: true,
      reviewed_tree: "new-tree",
    });
    expect(r.next_state.reviewed_tree).toBe("new-tree");
  });

  it("complete:true with no prior and no reviewed_tree leaves the tree unset", () => {
    const r = diffState({
      prior: null,
      current_findings: [{ path: "src/a.ts", text: "finding A", category: "c" }],
      scope: { in_scope_paths: ["src/a.ts"], full_review: true },
      head_sha: "new-head-sha",
      verdict: "changes",
      complete: true,
    });
    expect(r.next_state.reviewed_tree).toBeUndefined();
    expect(r.next_state.reviewed_sha).toBe("new-head-sha");
  });
});

describe("extractMarker", () => {
  it("returns the raw marker line from a body, verbatim", () => {
    const marker = encodeMarker(sampleState);
    const body = `### Code Review — repo\n\nsome findings\n\n${marker}\n`;
    expect(extractMarker(body)).toBe(marker);
  });

  it("extracted marker decodes to the same state (carry-forward is lossless)", () => {
    const marker = encodeMarker(sampleState);
    const carried = extractMarker(`header\n${marker}`);
    expect(carried).not.toBeNull();
    expect(decodeMarker(carried ?? "")).toEqual(sampleState);
  });

  it("returns null when the body carries no marker", () => {
    expect(extractMarker("### PR Review in Progress\n- [ ] steps")).toBeNull();
  });
});
