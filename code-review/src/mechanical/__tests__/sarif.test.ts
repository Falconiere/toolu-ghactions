import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { z } from "zod";
import { parseSarif } from "@/mechanical/sarif.js";

// Real recorded SARIF: gitleaks.sarif is actual `gitleaks detect` output (a planted
// GitHub PAT + GitLab PAT); opengrep.sarif is actual semgrep/Opengrep output (eval rule,
// schema-identical to Opengrep). Machine paths + bulky rule catalog sanitized; results real.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("parseSarif", () => {
  it("parses real gitleaks SARIF into findings (secrets → error severity)", () => {
    const findings = parseSarif(join(FIXTURES, "gitleaks.sarif"), "gitleaks");
    expect(findings.length).toBe(2);
    const rules = findings.map((f) => f.ruleId).sort();
    expect(rules).toEqual(["github-pat", "gitlab-pat"]);
    for (const f of findings) {
      expect(f.tool).toBe("gitleaks");
      expect(f.path).toBe("leak.ts");
      expect(f.severity).toBe("error"); // gitleaks declares no level → secrets default to error
      expect(f.line).toBeGreaterThan(0);
      expect(f.message).toContain("detected secret");
    }
  });

  it("parses real Opengrep/semgrep SARIF (rule-level severity, anchored line)", () => {
    const findings = parseSarif(join(FIXTURES, "opengrep.sarif"), "opengrep");
    expect(findings.length).toBe(1);
    const f = findings[0];
    expect(f?.tool).toBe("opengrep");
    expect(f?.ruleId).toBe("dangerous-eval-call");
    expect(f?.path).toBe("leak.ts");
    expect(f?.line).toBe(4);
    expect(f?.severity).toBe("error"); // from the rule's defaultConfiguration.level
    expect(f?.message).toContain("eval");
  });

  it("returns [] for a missing file (a failed/skipped scan never breaks the review)", () => {
    expect(parseSarif(join(FIXTURES, "does-not-exist.sarif"), "gitleaks")).toEqual([]);
  });

  it("returns [] for garbage / non-SARIF JSON", () => {
    // package.json is valid JSON but has no SARIF `runs` → no findings, no throw.
    expect(parseSarif(join(FIXTURES, "..", "..", "..", "..", "package.json"), "opengrep")).toEqual(
      [],
    );
  });
});

describe("parseSarif — startLine must be a positive integer to be citable", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** The recorded gitleaks report, typed narrowly enough to rewrite ONE region value.
   *  Every level is `.passthrough()`: the rewritten doc is re-serialized to disk, so a
   *  stripped sibling key (artifactLocation, snippet, the driver's rule catalog) would
   *  silently change what parseSarif sees and the test would no longer be about startLine. */
  const SarifDoc = z
    .object({
      runs: z.array(
        z
          .object({
            results: z.array(
              z
                .object({
                  ruleId: z.string(),
                  locations: z.array(
                    z
                      .object({
                        physicalLocation: z
                          .object({
                            region: z.object({ startLine: z.number() }).passthrough(),
                          })
                          .passthrough(),
                      })
                      .passthrough(),
                  ),
                })
                .passthrough(),
            ),
          })
          .passthrough(),
      ),
    })
    .passthrough();

  /**
   * The REAL recorded gitleaks.sarif with `runs[0].results[at]`'s `startLine` replaced,
   * written to a temp file. Only the value under test changes — the envelope, driver, rule
   * ids, artifact URIs, snippets and the sibling result stay exactly as recorded, so the
   * surviving finding is still the genuine one.
   */
  function recordedWithStartLine(at: number, startLine: number): string {
    const recorded: unknown = JSON.parse(readFileSync(join(FIXTURES, "gitleaks.sarif"), "utf8"));
    const doc = SarifDoc.parse(recorded);
    const run = doc.runs[0];
    const result = run?.results[at];
    const region = result?.locations[0]?.physicalLocation.region;
    if (!region) throw new Error(`recorded fixture has no result[${at}] region to rewrite`);
    region.startLine = startLine;

    const dir = mkdtempSync(join(tmpdir(), "sarif-test-"));
    dirs.push(dir);
    const file = join(dir, `gitleaks-startline-${at}-${String(startLine)}.sarif`);
    writeFileSync(file, JSON.stringify(doc));
    return file;
  }

  it("rejects a negative startLine — the shape mechanical/sanitize.ts exists to repair", () => {
    // gitleaks emits sub-1 regions for path-anchored findings; sanitize.test.ts:131 records
    // a real `startLine: -3`. The only bound here used to be `line === 0`, so -3 sailed
    // through and renderMechanicalBlock printed `leak.ts:-3` inside a block the prompt
    // labels TRUSTED.
    const findings = parseSarif(recordedWithStartLine(1, -3), "gitleaks");
    expect(findings.map((f) => f.ruleId)).toEqual(["gitlab-pat"]);
    expect(findings.some((f) => f.line < 1)).toBe(false);
  });

  it("rejects a fractional startLine, which cites no line at all", () => {
    // asNumber accepts any `typeof number`, so 1.5 used to pass the guard and render as
    // `leak.ts:1.5` — a line the model cannot anchor a finding to.
    const findings = parseSarif(recordedWithStartLine(1, 1.5), "gitleaks");
    expect(findings.map((f) => f.ruleId)).toEqual(["gitlab-pat"]);
    expect(findings.every((f) => Number.isInteger(f.line))).toBe(true);
  });

  it("still rejects the recorded startLine: 0 and keeps the valid sibling", () => {
    // The pre-existing zero case must not regress, and one bad result must not take the
    // good one down with it.
    const findings = parseSarif(recordedWithStartLine(1, 0), "gitleaks");
    expect(findings.map((f) => f.ruleId)).toEqual(["gitlab-pat"]);
    expect(findings[0]?.line).toBe(2);
  });
});
