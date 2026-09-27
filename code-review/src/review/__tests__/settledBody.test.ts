import { describe, it, expect } from "vitest";
import { formatVerdict } from "@/review/verdict.js";
import type { Finding } from "@/llm/schema.js";
import { encodeMarker } from "@/state.js";
import { patchSettledBody } from "@/review/settledBody.js";
import type { RecomputeOutcome } from "@/review/recompute.js";

// Every body here is rendered by the REAL formatVerdict — the exact sticky a completed
// "changes" round posts — so the patch is proven against the layout it must edit.
const MARKER = encodeMarker({
  schema: "toolu-review-state",
  version: 1,
  findings: [{ path: "src/a.ts", line: 3, text: "Rename this export.", category: "c", fp: "x" }],
  history: [
    {
      sha: "9891331",
      ts: 1790000000,
      verdict: "changes",
      counts: { new: 1, open: 0, resolved: 0, total: 1 },
    },
  ],
  reviewed_sha: "9891331d0123456789abcdef0123456789abcdef",
});

const MEDIUM: Finding = {
  path: "src/a.ts",
  line: 3,
  severity: "medium",
  category: "correctness",
  text: "Rename this export.",
};

function changesBody(verbosity: "compact" | "full"): string {
  return formatVerdict(
    { verdict: "changes", findings: [MEDIUM], review_plan: "Checked the export surface." },
    { historyMarker: MARKER, verbosity, branch: "feat/x", changedFiles: 1 },
  ).body;
}

type Approve = Extract<RecomputeOutcome, { kind: "approve" }>;
const APPROVED: Approve = {
  kind: "approve",
  verdict: "approved",
  remaining: [],
  settled: 1,
  total: 1,
};
const ADVISORY: Approve = {
  kind: "approve",
  verdict: "changes",
  remaining: [{ path: "src/d.ts", line: 2, fp: "d", text: "Prefer const.", severity: "medium" }],
  settled: 1,
  total: 2,
};

const lines = (body: string) => body.split("\n");
const lastLine = (body: string) => body.replace(/\n+$/, "").split("\n").at(-1);

describe("patchSettledBody", () => {
  it("flips a compact changes body to Approved, swaps the label line, keeps the marker last", () => {
    const body = changesBody("compact");
    const out = patchSettledBody(body, APPROVED);
    if (out === null) throw new Error("expected a patched body");
    expect(lines(out).find((l) => l.startsWith("**Verdict:**"))).toBe("**Verdict:** ✅ Approved");
    expect(out).toContain("> ✅ **Settled:** 1 of 1 finding(s)");
    expect(out).toContain("without a new model call");
    expect(lines(out)).toContain("`merge-approved`");
    expect(lines(out)).not.toContain("`request-changes`");
    expect(lastLine(out)).toBe(MARKER);
    // Everything else — header, review plan, findings list — is left exactly as it was.
    expect(out).toContain("### Review Plan\nChecked the export surface.");
    expect(out).toContain("### Findings (1)");
  });

  it("also swaps the full-mode checklist label", () => {
    const out = patchSettledBody(changesBody("full"), APPROVED);
    expect(out).toContain("- [x] Set verdict label (`merge-approved`)");
    expect(out).not.toContain("request-changes");
  });

  it("an advisory remainder keeps the Changes-requested verdict and label line, adding only the note", () => {
    const body = changesBody("compact");
    const out = patchSettledBody(body, ADVISORY);
    if (out === null) throw new Error("expected a patched body");
    expect(out).toContain("⚠️ Changes requested");
    expect(lines(out)).toContain("`request-changes`");
    expect(out).toContain("> ✅ **Settled:** 1 of 2 finding(s)");
    expect(out).toContain("below `APPROVE_BELOW`");
    expect(lastLine(out)).toBe(MARKER);
  });

  it("is idempotent — patching an already-patched body changes nothing", () => {
    const once = patchSettledBody(changesBody("compact"), APPROVED);
    if (once === null) throw new Error("expected a patched body");
    expect(patchSettledBody(once, APPROVED)).toBe(once);
  });

  it("refuses a body it does not recognise (no verdict line) — the caller then writes nothing", () => {
    expect(
      patchSettledBody("**AI Code Review skipped**\n\n**Skipped:** too big\n", APPROVED),
    ).toBeNull();
  });

  it("refuses an approval when the label line is missing", () => {
    const body = changesBody("compact").replace("\n`request-changes`\n", "\n");
    expect(patchSettledBody(body, APPROVED)).toBeNull();
  });

  it("refuses the in-progress body even though it carries a marker", () => {
    const inProgress = `**AI Code Review running**\n\n---\n### PR Review in Progress\n\n- [ ] Post findings\n\n${MARKER}\n`;
    expect(patchSettledBody(inProgress, APPROVED)).toBeNull();
  });
});
