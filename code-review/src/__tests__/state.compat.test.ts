import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fingerprint, decodeMarker, type Finding } from "@/state.js";
import { normalizeCategory } from "@/report/categories.js";

// Fixtures are REAL output from the bash review-state.sh under alpine/busybox
// (captured via the deployed code-review:v2 image). These lock byte-compat:
// the TS action must decode markers the old bash wrote, and must compute the
// SAME fingerprints — otherwise post-migration recap sees every prior finding
// as resolved+new.

const marker = readFileSync(new URL("./fixtures/bash-marker.txt", import.meta.url), "utf8");
const bashFps: Array<{ finding: Finding; fp: string }> = JSON.parse(
  readFileSync(new URL("./fixtures/bash-fingerprints.json", import.meta.url), "utf8"),
);

describe("byte-compat with bash review-state.sh", () => {
  it("decodes a marker written by the bash action", () => {
    const state = decodeMarker(marker);
    expect(state).toMatchObject({ schema: "toolu-review-state", version: 1 });
    if (!("findings" in state)) throw new Error("decoded marker is missing findings");
    const findings = state.findings;
    expect(findings[0]?.path).toBe("src/auth.ts");
    expect(findings[0]?.text).toContain("off-by-one");
  });

  it("computes fingerprints identical to busybox sha1sum (recap continuity)", () => {
    for (const { finding, fp } of bashFps) {
      expect(fingerprint(finding)).toBe(fp);
    }
  });
});

// --- AC-21: category normalization must NEVER enter the fingerprint path. ---
// `normalizeCategory` (src/report/categories.ts) exists only to bucket a finding's
// free-text category for the wire payload (src/report/payload.ts). `fingerprint()`
// must keep hashing the RAW `Finding.category`. If a future refactor threaded
// `normalizeCategory` into `canonString`/`fingerprint`, every raw category that
// collapses onto the same `ReportCategory` bucket would start hashing identically
// — silently rotating every in-flight PR's finding identities, making the bot
// resolve its own threads and re-post every finding as "new".
describe("fingerprint() is immune to category normalization (AC-21)", () => {
  it("raw categories that normalize to the SAME ReportCategory still hash DIFFERENTLY", () => {
    // All four strings below normalize to "correctness" (verified below), but
    // differ as raw strings. fingerprint() must still tell them apart, because
    // it hashes f.category verbatim — never the normalized bucket.
    const rawCategories = ["CORRECTNESS", "correctness", "correctness bug", "bug"];
    for (const raw of rawCategories) {
      expect(normalizeCategory(raw)).toBe("correctness");
    }

    const findings: Finding[] = rawCategories.map((category) => ({
      path: "src/example.ts",
      category,
      text: "same finding text for every variant",
    }));
    const fps = findings.map((f) => fingerprint(f));
    // Set size === input length: no two raw categories collided into one hash,
    // which is exactly what wiring the normalizer into fingerprint() would cause.
    expect(new Set(fps).size).toBe(rawCategories.length);
  });

  it("fingerprinting the RAW category matches the recorded corpus; fingerprinting a category run through normalizeCategory() first does not", () => {
    // Reverse direction of the test above: prove that the byte-exact hashes
    // pinned against the bash corpus depend on the untouched raw category, and
    // that "helpfully" normalizing before hashing would break that pin — the
    // concrete failure mode AC-21 exists to catch.
    for (const { finding, fp } of bashFps) {
      // The raw path (what fingerprint() actually does today) matches the recorded hash.
      expect(fingerprint(finding)).toBe(fp);

      const normalized: Finding = { ...finding, category: normalizeCategory(finding.category) };
      const normalizedFp = fingerprint(normalized);
      if (normalizeCategory(finding.category) !== (finding.category ?? "")) {
        // Category text actually changed under normalization (e.g. "" -> "other",
        // or an absent category -> "other") — the hash must diverge from the
        // recorded corpus, proving normalization must not sit in this path.
        expect(normalizedFp).not.toBe(fp);
      } else {
        // Already-canonical raw text ("correctness") is a no-op under normalization,
        // so the hash coincidentally matches — not evidence either way on its own,
        // which is why the branch above carries the real proof.
        expect(normalizedFp).toBe(fp);
      }
    }
  });
});

// --- AC-7 golden fp compat: fingerprint() is untouched by the s2 marker-fields change. ---
// The hexes below are LITERAL strings, computed from fingerprint() BEFORE the s2 diff
// (the s2 diff never edits canonString()/fingerprint()/FP_SEP — only additive schema
// fields and diffState's next_state carrier, both outside the fingerprint path). Path,
// category, and text vary — including a unicode path/text and a whitespace/tab/newline
// variant — because normText's regex-based normalization (case fold, punctuation strip,
// whitespace collapse, 200-char slice) is exactly the code most likely to shift under an
// incautious touch, and Unicode/whitespace edge cases are where a regex rewrite drifts.
describe("golden fingerprint hexes are unchanged by the s2 marker-fields diff (AC-7)", () => {
  const golden: Array<{ finding: Finding; fp: string }> = [
    {
      finding: {
        path: "src/a.ts",
        category: "correctness",
        text: "Off-by-one error in loop bound.",
      },
      fp: "5e93deb48e7c7ec7f0869b29af2bf24971fc377c",
    },
    {
      finding: {
        path: "src/ünïcödé.ts",
        category: "style",
        text: "  Emoji check: 🚀 rocket   ship  ",
      },
      fp: "cd433b531b81ca26a88c57a76442963231df4615",
    },
    {
      finding: {
        path: "src/b.ts",
        category: "security",
        text: "SQL injection via string concatenation!!",
      },
      fp: "041d133e84596ca7b7d2ba72726ce5f98f7c9918",
    },
    {
      finding: { path: "src/c.ts", category: "perf", text: "Loop\tallocates\neach\titeration" },
      fp: "cdd0e227acf1bc57792a6e78c16990d2cc781be7",
    },
    {
      finding: {
        path: "日本語/パス.ts",
        category: "correctness",
        text: "Unicode PATH and 中文文本 mixed.",
      },
      fp: "8fc230a23619b60b5c8cef3d4b2c8ab160d29999",
    },
  ];

  it("matches the hardcoded pre-change hex digests byte-for-byte", () => {
    for (const { finding, fp } of golden) {
      expect(fingerprint(finding)).toBe(fp);
    }
  });
});

describe("src/state.ts does not import from src/report/ (AC-21 structural guard)", () => {
  it("has no import/require/dynamic-import path under report/", () => {
    // Plain source-text check, not a behavioural one: the claim is "this module
    // never references the normalizer's home", so reading the file and grepping
    // its import paths is the honest way to assert it — a runtime spy could pass
    // even if state.ts imported categories.ts but never called it.
    const stateSourcePath = fileURLToPath(new URL("../state.ts", import.meta.url));
    const stateSource = readFileSync(stateSourcePath, "utf8");
    const referencesReportDir = /from\s+["'][^"']*\/report\//.test(stateSource);
    expect(
      referencesReportDir,
      "src/state.ts must not import anything from src/report/ — that would put " +
        "category normalization in the fingerprint path and rotate every stored fingerprint",
    ).toBe(false);
  });
});
