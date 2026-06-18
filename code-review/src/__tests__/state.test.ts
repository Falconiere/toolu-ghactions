import { describe, it, expect } from "vitest";
import {
  fingerprint,
  attachFps,
  encodeMarker,
  decodeMarker,
  diffState,
  type ReviewState,
  type Finding,
} from "../state.js";

const sampleState: ReviewState = {
  schema: "toolu-review-state",
  version: 1,
  findings: [{ path: "src/a.ts", line: 10, text: "bug here", category: "correctness", fp: "z" }],
  history: [{ sha: "abc1234", ts: 1700000000, verdict: "changes", counts: { new: 1, open: 0, resolved: 0, total: 1 } }],
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
    expect(fingerprint({ path: "a.ts", text: "t" })).not.toBe(fingerprint({ path: "b.ts", text: "t" }));
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
    const r = diffState({ prior, current_findings: current, scope: { in_scope_paths: ["src/a.ts", "src/b.ts"], full_review: true }, head_sha: "deadbeefcafe", verdict: "changes" });
    expect(r.counts).toMatchObject({ new: 1, open: 1, resolved: 0, total: 2 });
    expect(r.new[0]?.path).toBe("src/b.ts");
    expect(r.open[0]?.path).toBe("src/a.ts");
  });

  it("marks a prior finding resolved only on a full review within scope", () => {
    const full = diffState({ prior, current_findings: [], scope: { in_scope_paths: ["src/a.ts"], full_review: true }, head_sha: "deadbeef", verdict: "approved" });
    expect(full.resolved.map((f) => f.path)).toEqual(["src/a.ts"]);

    const partial = diffState({ prior, current_findings: [], scope: { in_scope_paths: ["src/a.ts"], full_review: false }, head_sha: "deadbeef", verdict: "approved" });
    expect(partial.resolved).toEqual([]);

    const outOfScope = diffState({ prior, current_findings: [], scope: { in_scope_paths: ["other.ts"], full_review: true }, head_sha: "deadbeef", verdict: "approved" });
    expect(outOfScope.resolved).toEqual([]);
  });

  it("caps history at the last 10 entries", () => {
    const longHistory: ReviewState = {
      ...prior,
      history: Array.from({ length: 12 }, (_, i) => ({ sha: `sha${i}`, ts: i, verdict: "changes", counts: { new: 0, open: 0, resolved: 0, total: 0 } })),
    };
    const r = diffState({ prior: longHistory, current_findings: [], scope: { in_scope_paths: [], full_review: true }, head_sha: "abcdef0", verdict: "approved" });
    expect(r.next_state.history).toHaveLength(10);
    expect(r.next_state.history.at(-1)).toEqual(r.history_entry);
  });
});
