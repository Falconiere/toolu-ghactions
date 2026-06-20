import { describe, expect, it } from "vitest";
import { appendFpMarker, extractFpMarker } from "@/review/fpmarker.js";

describe("fpmarker", () => {
  it("round-trips a fingerprint through append → extract", () => {
    const fp = "a".repeat(40);
    const body = appendFpMarker("**high**: a real finding", fp);
    expect(extractFpMarker(body)).toBe(fp);
  });

  it("appends the marker as an HTML comment that does not disturb the visible body", () => {
    const body = appendFpMarker("the finding text", "deadbeef");
    expect(body).toContain("the finding text");
    expect(body).toContain("<!-- toolu-fp:deadbeef -->");
    // The marker is the LAST thing in the body (an HTML comment GitHub renders invisibly).
    expect(body.trimEnd().endsWith("-->")).toBe(true);
  });

  it("returns null when no marker is present (e.g. a human-authored comment)", () => {
    expect(extractFpMarker("just a normal review reply, no marker here")).toBeNull();
  });

  it("returns null for a malformed marker (non-hex payload)", () => {
    expect(extractFpMarker("<!-- toolu-fp:NOT-HEX -->")).toBeNull();
  });

  it("extracts the first marker's fingerprint from a real rendered finding body", () => {
    const fp = "0123456789abcdef0123456789abcdef01234567";
    const rendered = appendFpMarker(
      "**medium** (correctness): off-by-one in the loop\n\n```suggestion\nfor (i=0;i<=n;i++)\n```",
      fp,
    );
    expect(extractFpMarker(rendered)).toBe(fp);
  });
});
