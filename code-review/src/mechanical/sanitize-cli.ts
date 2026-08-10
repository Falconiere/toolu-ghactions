// mechanical/sanitize-cli.ts — nested node24 action entry, bundled to
// sanitize-sarif/index.cjs (S8). Node-type actions receive NO positional argv
// (`runs.args` is docker-only), so inputs ride as env: INPUT_SRC_DIR / INPUT_DEST_DIR
// (GitHub's INPUT_<NAME> mapping of the action's declared `SRC_DIR`/`DEST_DIR` inputs —
// underscores are REQUIRED in the input names: the runner only replaces spaces, so a
// kebab-case `src-dir` would arrive as INPUT_SRC-DIR and this CLI would read nothing).
// Copies every `*.sarif` from src to dest, fixing regions in the COPIES via
// sanitizeSarif — originals are left untouched for mechanical/gather.ts's LLM-triage
// read. No @actions/core: plain workflow-command writes keep the future bundle lean,
// matching how the composite's scanner steps log today.
//
// ALWAYS exits 0 (best-effort, like the composite's scanner steps) — but every
// failure mode emits a `::warning` so a silent zero-file run is never mistaken for
// a healthy one.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeSarif } from "./sanitize.js";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Emit a GitHub Actions workflow command (`::notice`/`::warning`) to stdout. */
function log(command: "notice" | "warning", text: string): void {
  process.stdout.write(`::${command}::${text}\n`);
}

/** Copy+fix every `*.sarif` in `srcDir` into `destDir`. Never throws — each
 * per-file failure (unreadable, unparseable, unwritable) is skipped with a
 * `::warning` instead of aborting the rest of the batch. */
function sanitizeDir(srcDir: string, destDir: string): { copied: number; fixed: number } {
  let names: string[];
  try {
    names = readdirSync(srcDir);
  } catch (err) {
    log("warning", `SRC_DIR '${srcDir}' is not readable: ${message(err)}`);
    return { copied: 0, fixed: 0 };
  }

  let copied = 0;
  let fixed = 0;
  for (const name of names) {
    if (!name.endsWith(".sarif")) continue;

    let text: string;
    try {
      text = readFileSync(join(srcDir, name), "utf8");
    } catch (err) {
      log("warning", `Could not read '${name}': ${message(err)} — not copied.`);
      continue;
    }

    const result = sanitizeSarif(text);
    if (result === null) {
      log("warning", `Skipping unparseable SARIF file '${name}' — not copied.`);
      continue;
    }

    try {
      writeFileSync(join(destDir, name), result.out, "utf8");
    } catch (err) {
      log("warning", `Could not write '${name}' to DEST_DIR: ${message(err)} — not copied.`);
      continue;
    }
    copied++;
    fixed += result.fixed;
  }
  return { copied, fixed };
}

function main(): void {
  const srcDir = process.env["INPUT_SRC_DIR"] ?? "";
  const destDir = process.env["INPUT_DEST_DIR"] ?? "";

  if (destDir === "") {
    log("warning", "DEST_DIR is not set — nothing to sanitize into.");
    return;
  }
  try {
    // mkdir -p unconditionally: upload-sarif must find an existing (if empty)
    // dest dir even when there's nothing to copy.
    mkdirSync(destDir, { recursive: true });
  } catch (err) {
    log("warning", `Could not create DEST_DIR '${destDir}': ${message(err)}`);
    return;
  }

  if (srcDir === "") {
    log("warning", "SRC_DIR is not set — no SARIF files to sanitize.");
    log("notice", "Sanitized 0 SARIF file(s), fixed 0 result(s).");
    return;
  }

  const { copied, fixed } = sanitizeDir(srcDir, destDir);
  if (copied === 0) {
    log("warning", `No SARIF files copied from '${srcDir}' — Code Scanning upload may be empty.`);
  }
  log("notice", `Sanitized ${copied} SARIF file(s), fixed ${fixed} result(s).`);
}

// Best-effort entry point: an unexpected throw must still exit 0 (matching the
// composite's scanner steps), but is surfaced as a warning, never swallowed silently.
try {
  main();
} catch (err) {
  log("warning", `Unexpected sanitize-sarif failure: ${message(err)}`);
}
