// action-inputs.test.ts — the JOIN between action.yml's declared `inputs:` and the way this
// COMPOSITE action actually delivers them to the reviewer.
//
// WHY THIS EXISTS: the real work runs in a nested node24 action (`$/code-review/run`) which
// declares NO inputs of its own — it reads `process.env.INPUT_*` through
// @actions/core.getInput. So the composite must hand-copy every input either into that
// step's `env:` block as `INPUT_<NAME>: ${{ inputs.<NAME> }}`, or consume it in one of its
// own bash steps. src/__tests__/inputs.test.ts cannot catch a miss: it sets `INPUT_*` on
// process.env itself, so it passes green for a variable the real action can never produce.
// That is exactly how APPROVE_BELOW shipped declared-but-never-forwarded (#127) — a
// consumer setting `APPROVE_BELOW: high` silently got the "nit" default.
//
// PARSING: no YAML parser is a dependency of this package (neither `yaml` nor `js-yaml` is
// in package.json or node_modules), so this reads the REAL action.yml from disk and scans
// it as text with indentation-anchored line matching. The scans are STRUCTURAL, never
// name-based: nothing here lists which inputs are bash-only, so the next input anyone
// declares and forgets to forward fails this test with no allowlist to update.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ACTION_YML_PATH = fileURLToPath(new URL("../../action.yml", import.meta.url));
const LINES = readFileSync(ACTION_YML_PATH, "utf8").split("\n");

/** Leading-space count of a line (-1 for a blank one, which carries no structure). */
function indentOf(line: string): number {
  return line.trim() === "" ? -1 : line.length - line.trimStart().length;
}

/** Index of the first line matching `re`, or -1. */
function findLine(re: RegExp, from = 0): number {
  for (let i = from; i < LINES.length; i++) {
    if (re.test(LINES[i] ?? "")) return i;
  }
  return -1;
}

/**
 * The names declared under the TOP-LEVEL `inputs:` key. A declared input is a line at
 * exactly two spaces of indent holding an UPPER_SNAKE key and nothing else; the scan stops
 * at the next zero-indent key (`outputs:`, `runs:`).
 */
function declaredInputs(): string[] {
  const start = findLine(/^inputs:\s*$/);
  if (start === -1) return [];
  const names: string[] = [];
  for (let i = start + 1; i < LINES.length; i++) {
    const line = LINES[i] ?? "";
    const indent = indentOf(line);
    if (indent === 0) break; // next top-level key
    const match = /^ {2}([A-Z][A-Z0-9_]*):\s*$/.exec(line);
    if (match?.[1]) names.push(match[1]);
  }
  return names;
}

/** The half-open line range of the nested node24 review step (`uses: $/code-review/run`). */
function nestedStepRange(): { start: number; end: number } {
  const uses = findLine(/^\s*uses: \$\/code-review\/run\s*$/);
  if (uses === -1) return { start: -1, end: -1 };
  const stepIndent = indentOf(LINES[uses] ?? "");
  let end = LINES.length;
  for (let i = uses + 1; i < LINES.length; i++) {
    const indent = indentOf(LINES[i] ?? "");
    if (indent !== -1 && indent < stepIndent) {
      end = i;
      break;
    }
  }
  return { start: uses, end };
}

/** One `INPUT_<NAME>: ${{ inputs.<NAME> }}` forwarding line in the nested step's env. */
const FORWARD_LINE = /^ {8}INPUT_([A-Z][A-Z0-9_]*): \$\{\{ inputs\.([A-Z][A-Z0-9_]*) \}\}\s*$/;

/**
 * The inputs the composite hands to the node step, as [env key name, expression name]
 * pairs — pairs, not a set, so a cross-wired forward (`INPUT_A: ${{ inputs.B }}`) is
 * visible instead of silently counting as both.
 */
function forwardedInputs(range: { start: number; end: number }): [string, string][] {
  const pairs: [string, string][] = [];
  for (let i = range.start + 1; i < range.end; i++) {
    const match = FORWARD_LINE.exec(LINES[i] ?? "");
    if (match?.[1] && match[2]) pairs.push([match[1], match[2]]);
  }
  return pairs;
}

/**
 * The inputs the composite consumes ITSELF, in its own bash steps — an `if:` gate like
 * `${{ inputs.RUN_SECRET_SCAN == 'true' && … }}` or an interpolation inside a `run:` body
 * like `--config "${{ inputs.SAST_RULES }}"`. Scanned over the `runs:` section OUTSIDE the
 * nested step, so a description string cannot satisfy this and a forwarding line is never
 * double-counted as a bash reference.
 */
function bashReferencedInputs(range: { start: number; end: number }): string[] {
  const runs = findLine(/^runs:\s*$/);
  if (runs === -1) return [];
  const names = new Set<string>();
  for (let i = runs; i < LINES.length; i++) {
    if (i > range.start && i < range.end) continue;
    for (const match of (LINES[i] ?? "").matchAll(/inputs\.([A-Z][A-Z0-9_]*)/g)) {
      if (match[1]) names.add(match[1]);
    }
  }
  return [...names];
}

const RANGE = nestedStepRange();
const DECLARED = declaredInputs();
const FORWARDED = forwardedInputs(RANGE);
const FORWARDED_NAMES = new Set(FORWARDED.map(([name]) => name));
const BASH_REFERENCED = bashReferencedInputs(RANGE);
const BASH_NAMES = new Set(BASH_REFERENCED);

/** Every declared input, minus the ones the composite actually delivers somewhere. */
function undelivered(): string[] {
  return DECLARED.filter((name) => !FORWARDED_NAMES.has(name) && !BASH_NAMES.has(name));
}

describe("action.yml delivers every declared input to the reviewer", () => {
  it("found the real manifest structure (a silent scan miss would pass everything below)", () => {
    expect(ACTION_YML_PATH).toContain("action.yml");
    expect(DECLARED.length).toBeGreaterThan(30);
    expect(RANGE.start).toBeGreaterThan(-1);
    expect(FORWARDED.length).toBeGreaterThan(30);
    expect(BASH_REFERENCED.length).toBeGreaterThan(0);
  });

  it("forwards or bash-consumes EVERY declared input", () => {
    // This is the assertion that catches the next APPROVE_BELOW: declare an input, forget
    // the `INPUT_<NAME>` line in the nested step's env, and its name lands here.
    expect(undelivered()).toEqual([]);
  });

  it("forwards each env key from the input of the SAME name (no cross-wiring)", () => {
    const crossWired = FORWARDED.filter(([key, expression]) => key !== expression);
    expect(crossWired).toEqual([]);
  });

  it("forwards and bash-references only inputs that are actually declared", () => {
    // The mirror image: an `INPUT_FOO: ${{ inputs.FOO }}` for an undeclared FOO resolves to
    // the empty string at runtime — a silently dead knob, not a loud failure.
    const declared = new Set(DECLARED);
    expect(FORWARDED.filter(([name]) => !declared.has(name)).map(([name]) => name)).toEqual([]);
    expect(BASH_REFERENCED.filter((name) => !declared.has(name))).toEqual([]);
  });

  it("forwards APPROVE_BELOW — the input that shipped dead in #127", () => {
    // Named explicitly because this one already regressed once: declared with a full
    // description, absent from the env block, so getInput("APPROVE_BELOW") always returned
    // "" and parseApproveBelow always fell back to "nit".
    expect(DECLARED).toContain("APPROVE_BELOW");
    expect(FORWARDED).toContainEqual(["APPROVE_BELOW", "APPROVE_BELOW"]);
  });

  it("leaves the scanner switches to the composite's own bash steps", () => {
    // The genuine bash-only inputs, found by the structural scan rather than asserted from a
    // hardcoded allowlist: gitleaks/opengrep run as composite steps BEFORE the node action,
    // so their gates and rule config are consumed there and never reach the reviewer.
    for (const name of ["RUN_SECRET_SCAN", "RUN_SAST", "SAST_RULES"]) {
      expect(DECLARED).toContain(name);
      expect(BASH_NAMES.has(name)).toBe(true);
      expect(FORWARDED_NAMES.has(name)).toBe(false);
    }
  });

  it("keeps the composite manifest shape CI's grep assertions require", () => {
    // Guarding the file this test reads: .github/workflows/tests.yml asserts the composite
    // wraps the nested node24 actions and is not itself a node action.
    const text = LINES.join("\n");
    expect(text).toContain("using: 'composite'");
    expect(text).toContain("uses: $/code-review/run");
    expect(text).toContain("uses: $/code-review/sanitize-sarif");
    expect(text).toContain("opengrep");
    expect(text).not.toContain("using: 'node24'");
  });
});

/** The text of the step whose `- name:` matches `nameRe`, up to the next step. */
function stepText(nameRe: RegExp): string {
  const start = findLine(new RegExp(`^ {4}- name: .*${nameRe.source}`));
  if (start === -1) return "";
  let end = LINES.length;
  for (let i = start + 1; i < LINES.length; i++) {
    if (/^ {4}- name:/.test(LINES[i] ?? "")) {
      end = i;
      break;
    }
  }
  return LINES.slice(start, end).join("\n");
}

/** The step's `if:` expression, or "". */
function ifOf(step: string): string {
  return /^\s*if: (.*)$/m.exec(step)?.[1] ?? "";
}

describe("action.yml skips the SARIF steps when there is nothing to upload", () => {
  const install = stepText(/Install scanners/);
  const sanitize = stepText(/Sanitize SARIF/);
  const upload = stepText(/Upload SARIF/);

  it("found the three steps", () => {
    expect(install).toContain("run:");
    expect(sanitize).toContain("uses: $/code-review/sanitize-sarif");
    expect(upload).toContain("github/codeql-action/upload-sarif");
  });

  it("gates install and sanitize on at least one scanner being enabled", () => {
    for (const step of [install, sanitize]) {
      expect(ifOf(step)).toContain("inputs.RUN_SECRET_SCAN");
      expect(ifOf(step)).toContain("inputs.RUN_SAST");
    }
  });

  it("uploads only when the sanitize step reports copied files", () => {
    expect(sanitize).toMatch(/^ {6}id: sanitize$/m);
    expect(ifOf(upload)).toContain("steps.sanitize.outputs.copied");
  });
});
