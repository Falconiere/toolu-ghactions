import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
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
