// sanitize.test.ts — sanitizeSarif (region repair) + sanitize-cli.ts (the env-driven
// nested-action entry), run as a real subprocess.
//
// Fixture: gitleaks-pr6-zero-region.sarif replicates the exact shape GitHub Code
// Scanning rejected on CodaSignal/actacanvas PR #6 (run 31343588712) — that run's
// artifact/log were no longer retrievable (`gh run view --log`/`--log-failed` both
// returned empty; `gh api .../artifacts` returned zero artifacts), so this is
// replicated field-for-field from the rejection log's own description: gitleaks
// 8.30.1 `detect --no-git --report-format sarif` producing `runs[0].results[2..6]`
// (five results) whose `locations[0].physicalLocation.region` carries `startLine`,
// `startColumn`, `endLine`, `endColumn` ALL 0. It's layered onto the real
// gitleaks.sarif envelope (results[0..1], a genuine planted-secret scan) so the
// two untouched results double as the "deep-equal the source" assertion.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeSarif } from "@/mechanical/sanitize.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");
const CODE_REVIEW_DIR = join(HERE, "..", "..", ".."); // code-review/
const CLI = join(CODE_REVIEW_DIR, "src", "mechanical", "sanitize-cli.ts");

// Minimal SARIF shape for defensively narrowing JSON.parse()'d test fixtures/output —
// fields are `unknown` because these are test doubles, not the sanitizer's own domain.
interface Region {
  startLine?: unknown;
  startColumn?: unknown;
  endLine?: unknown;
  endColumn?: unknown;
  snippet?: unknown;
}
interface Location {
  physicalLocation: { region: Region };
}
interface SarifResult {
  ruleId?: unknown;
  locations?: Location[];
}
interface SarifRun {
  results: SarifResult[];
}
interface SarifDoc {
  runs: SarifRun[];
}

function resultAt(doc: SarifDoc, runIndex: number, resultIndex: number): SarifResult {
  const run = doc.runs[runIndex];
  if (run === undefined) throw new Error(`expected runs[${runIndex}]`);
  const result = run.results[resultIndex];
  if (result === undefined) throw new Error(`expected runs[${runIndex}].results[${resultIndex}]`);
  return result;
}

function regionAt(doc: SarifDoc, runIndex: number, resultIndex: number, locationIndex = 0): Region {
  const locations = resultAt(doc, runIndex, resultIndex).locations ?? [];
  const location = locations[locationIndex];
  if (location === undefined) {
    throw new Error(
      `expected runs[${runIndex}].results[${resultIndex}].locations[${locationIndex}]`,
    );
  }
  return location.physicalLocation.region;
}

const COLUMN_KEYS: Array<"startColumn" | "endLine" | "endColumn"> = [
  "startColumn",
  "endLine",
  "endColumn",
];

describe("sanitizeSarif", () => {
  it("repairs the PR #6 rejected gitleaks shape: 5 zero-region results fixed, 2 valid ones untouched", () => {
    const source = readFileSync(join(FIXTURES, "gitleaks-pr6-zero-region.sarif"), "utf8");
    const sourceDoc: SarifDoc = JSON.parse(source);
    const result = sanitizeSarif(source);
    if (result === null) throw new Error("expected a sanitized result, got null");
    expect(result.fixed).toBe(5);

    const doc: SarifDoc = JSON.parse(result.out);
    const run = doc.runs[0];
    if (run === undefined) throw new Error("expected runs[0]");
    expect(run.results).toHaveLength(7);

    // Every predicate the rejection log named now holds for every result.
    for (let i = 0; i < run.results.length; i++) {
      const region = regionAt(doc, 0, i);
      expect(typeof region.startLine).toBe("number");
      if (typeof region.startLine !== "number") throw new Error("expected numeric startLine");
      expect(region.startLine).toBeGreaterThanOrEqual(1);
      for (const key of COLUMN_KEYS) {
        if (!(key in region)) continue;
        const value = region[key];
        expect(typeof value).toBe("number");
        if (typeof value !== "number") throw new Error(`expected numeric ${key}`);
        expect(value).toBeGreaterThanOrEqual(1);
      }
    }

    // Untouched (already-valid) results deep-equal the parsed source exactly.
    expect(resultAt(doc, 0, 0)).toEqual(resultAt(sourceDoc, 0, 0));
    expect(resultAt(doc, 0, 1)).toEqual(resultAt(sourceDoc, 0, 1));

    // The 5 formerly-zero-region results: startLine clamped, columns/endLine deleted,
    // sibling fields (message, ruleId, snippet) survive untouched.
    for (let i = 2; i < run.results.length; i++) {
      const region = regionAt(doc, 0, i);
      expect(region.startLine).toBe(1);
      expect(region).not.toHaveProperty("startColumn");
      expect(region).not.toHaveProperty("endLine");
      expect(region).not.toHaveProperty("endColumn");
      expect(region.snippet).toBeDefined();
      expect(resultAt(doc, 0, i).ruleId).toBe("generic-api-key");
    }
  });

  it("clamps negative startLine, deletes negative/zero columns, leaves non-numeric fields and malformed siblings alone", () => {
    const doc = {
      version: "2.1.0",
      runs: [
        {
          results: [
            {
              ruleId: "planted",
              locations: [
                {
                  physicalLocation: {
                    region: { startLine: -3, startColumn: -1, endLine: 0, endColumn: "5" },
                  },
                },
              ],
            },
            { ruleId: "malformed-locations", locations: "not-an-array" },
            { ruleId: "no-locations" },
            "not-an-object-result",
          ],
        },
        "not-an-object-run",
      ],
    };
    const result = sanitizeSarif(JSON.stringify(doc));
    if (result === null) throw new Error("expected a sanitized result, got null");
    expect(result.fixed).toBe(1);

    const out: SarifDoc = JSON.parse(result.out);
    const region = regionAt(out, 0, 0);
    expect(region.startLine).toBe(1);
    expect(region).not.toHaveProperty("startColumn");
    expect(region).not.toHaveProperty("endLine");
    expect(region.endColumn).toBe("5"); // non-numeric — untouched by the numeric-only policy
  });

  it("reports fixed:0 and an unchanged document for a report with no invalid regions", () => {
    const source = readFileSync(join(FIXTURES, "opengrep.sarif"), "utf8");
    const result = sanitizeSarif(source);
    if (result === null) throw new Error("expected a sanitized result, got null");
    expect(result.fixed).toBe(0);
    expect(JSON.parse(result.out)).toEqual(JSON.parse(source));
  });

  it("returns null for unparseable JSON", () => {
    expect(sanitizeSarif("{ not json")).toBeNull();
  });

  it("returns null for a non-object JSON root (array or scalar)", () => {
    expect(sanitizeSarif("[1,2,3]")).toBeNull();
    expect(sanitizeSarif("42")).toBeNull();
    expect(sanitizeSarif('"just a string"')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// sanitize-cli.ts — the nested-action entry point. Node-type actions get no argv,
// so it's entirely env-driven (INPUT_SRC_DIR / INPUT_DEST_DIR); run it as a real
// `bun` subprocess against real temp dirs — no mocking of fs or the CLI module.
// ---------------------------------------------------------------------------

function resolveBin(name: string): string {
  return execFileSync("bash", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
}

const BUN_BIN = resolveBin("bun");

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** What a failed `execFileSync` throws (Node's child_process contract). */
interface ExecError extends Error {
  status?: number;
  stdout?: string;
  stderr?: string;
}

function isExecError(err: unknown): err is ExecError {
  return err instanceof Error;
}

/** Run the real sanitize-cli.ts as a subprocess with a controlled INPUT_* env. */
function runCli(env: Record<string, string | undefined>): RunResult {
  try {
    const stdout = execFileSync(BUN_BIN, [CLI], {
      encoding: "utf8",
      env: { ...process.env, INPUT_SRC_DIR: "", INPUT_DEST_DIR: "", ...env },
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    if (!isExecError(err)) throw err;
    return { status: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

function mkTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("sanitize-cli", () => {
  it("warns and no-ops (but still creates DEST_DIR) when SRC_DIR is unset", () => {
    const base = mkTempDir("sanitize-cli-unset-");
    const destDir = join(base, "nested", "dest"); // must not exist yet — proves mkdir -p
    try {
      const result = runCli({ INPUT_DEST_DIR: destDir });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("::warning::SRC_DIR is not set");
      expect(result.stdout).toContain("::notice::Sanitized 0 SARIF file(s), fixed 0 result(s).");
      expect(readdirSync(destDir)).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("creates DEST_DIR and warns zero-files-copied when SRC_DIR is an existing empty directory", () => {
    const base = mkTempDir("sanitize-cli-empty-");
    const srcDir = join(base, "src");
    const destDir = join(base, "deep", "nested", "dest");
    mkdirSync(srcDir, { recursive: true });
    try {
      const result = runCli({ INPUT_SRC_DIR: srcDir, INPUT_DEST_DIR: destDir });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("::warning::No SARIF files copied");
      expect(result.stdout).toContain("::notice::Sanitized 0 SARIF file(s), fixed 0 result(s).");
      expect(readdirSync(destDir)).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("copies and fixes real SARIF files, leaves the source untouched, skips non-.sarif files", () => {
    const base = mkTempDir("sanitize-cli-copy-");
    const srcDir = join(base, "src");
    const destDir = join(base, "dest");
    mkdirSync(srcDir, { recursive: true });
    const original = readFileSync(join(FIXTURES, "gitleaks-pr6-zero-region.sarif"), "utf8");
    writeFileSync(join(srcDir, "gitleaks.sarif"), original, "utf8");
    writeFileSync(join(srcDir, "README.md"), "not a sarif file\n", "utf8");
    try {
      const result = runCli({ INPUT_SRC_DIR: srcDir, INPUT_DEST_DIR: destDir });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("::notice::Sanitized 1 SARIF file(s), fixed 5 result(s).");
      expect(result.stdout).not.toContain("::warning::");

      expect(readdirSync(destDir)).toEqual(["gitleaks.sarif"]);
      const copied: SarifDoc = JSON.parse(readFileSync(join(destDir, "gitleaks.sarif"), "utf8"));
      expect(regionAt(copied, 0, 2).startLine).toBe(1);

      // Originals are read-only inputs to the LLM triage — must be byte-identical after the run.
      expect(readFileSync(join(srcDir, "gitleaks.sarif"), "utf8")).toBe(original);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("warns and skips an unparseable SARIF file without copying garbage, but still copies valid siblings", () => {
    const base = mkTempDir("sanitize-cli-garbage-");
    const srcDir = join(base, "src");
    const destDir = join(base, "dest");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      join(srcDir, "good.sarif"),
      readFileSync(join(FIXTURES, "opengrep.sarif"), "utf8"),
      "utf8",
    );
    writeFileSync(join(srcDir, "garbage.sarif"), "{ this is not valid JSON", "utf8");
    try {
      const result = runCli({ INPUT_SRC_DIR: srcDir, INPUT_DEST_DIR: destDir });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("::warning::Skipping unparseable SARIF file 'garbage.sarif'");
      expect(result.stdout).toContain("::notice::Sanitized 1 SARIF file(s), fixed 0 result(s).");
      expect(readdirSync(destDir).sort()).toEqual(["good.sarif"]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
