import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fingerprint, decodeMarker, type Finding } from "../state.js";

// Fixtures are REAL output from the bash review-state.sh under alpine/busybox
// (captured via the deployed code-review:v2 image). These lock byte-compat:
// the TS action must decode markers the old bash wrote, and must compute the
// SAME fingerprints — otherwise post-migration recap sees every prior finding
// as resolved+new.

const marker = readFileSync(new URL("./fixtures/bash-marker.txt", import.meta.url), "utf8");
const bashFps = JSON.parse(
  readFileSync(new URL("./fixtures/bash-fingerprints.json", import.meta.url), "utf8"),
) as Array<{ finding: Finding; fp: string }>;

describe("byte-compat with bash review-state.sh", () => {
  it("decodes a marker written by the bash action", () => {
    const state = decodeMarker(marker);
    expect(state).toMatchObject({ schema: "toolu-review-state", version: 1 });
    const findings = (state as { findings: Finding[] }).findings;
    expect(findings[0]?.path).toBe("src/auth.ts");
    expect(findings[0]?.text).toContain("off-by-one");
  });

  it("computes fingerprints identical to busybox sha1sum (recap continuity)", () => {
    for (const { finding, fp } of bashFps) {
      expect(fingerprint(finding)).toBe(fp);
    }
  });
});
