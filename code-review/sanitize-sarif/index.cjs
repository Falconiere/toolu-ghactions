"use strict";

// src/mechanical/sanitize-cli.ts
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");

// src/mechanical/sanitize.ts
function sanitizeSarif(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(doc)) return null;
  let fixed = 0;
  const runs = Array.isArray(doc["runs"]) ? doc["runs"] : [];
  for (const run of runs) {
    if (!isRecord(run)) continue;
    const results = Array.isArray(run["results"]) ? run["results"] : [];
    for (const result of results) {
      if (fixResult(result)) fixed++;
    }
  }
  return { out: JSON.stringify(doc, null, 2), fixed };
}
function fixResult(result) {
  if (!isRecord(result)) return false;
  const locations = Array.isArray(result["locations"]) ? result["locations"] : [];
  let touched = false;
  for (const location of locations) {
    if (!isRecord(location)) continue;
    const physical = location["physicalLocation"];
    if (!isRecord(physical)) continue;
    const region = physical["region"];
    if (!isRecord(region)) continue;
    if (fixRegion(region)) touched = true;
  }
  return touched;
}
function fixRegion(region) {
  let touched = false;
  const startLine = region["startLine"];
  if (typeof startLine === "number" && startLine < 1) {
    region["startLine"] = 1;
    touched = true;
  }
  for (const key of ["startColumn", "endLine", "endColumn"]) {
    const value = region[key];
    if (typeof value === "number" && value < 1) {
      delete region[key];
      touched = true;
    }
  }
  return touched;
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/mechanical/sanitize-cli.ts
function message(err) {
  return err instanceof Error ? err.message : String(err);
}
function log(command, text) {
  process.stdout.write(`::${command}::${text}
`);
}
function sanitizeDir(srcDir, destDir) {
  let names;
  try {
    names = (0, import_node_fs.readdirSync)(srcDir);
  } catch (err) {
    log("warning", `SRC_DIR '${srcDir}' is not readable: ${message(err)}`);
    return { copied: 0, fixed: 0 };
  }
  let copied = 0;
  let fixed = 0;
  for (const name of names) {
    if (!name.endsWith(".sarif")) continue;
    let text;
    try {
      text = (0, import_node_fs.readFileSync)((0, import_node_path.join)(srcDir, name), "utf8");
    } catch (err) {
      log("warning", `Could not read '${name}': ${message(err)} \u2014 not copied.`);
      continue;
    }
    const result = sanitizeSarif(text);
    if (result === null) {
      log("warning", `Skipping unparseable SARIF file '${name}' \u2014 not copied.`);
      continue;
    }
    try {
      (0, import_node_fs.writeFileSync)((0, import_node_path.join)(destDir, name), result.out, "utf8");
    } catch (err) {
      log("warning", `Could not write '${name}' to DEST_DIR: ${message(err)} \u2014 not copied.`);
      continue;
    }
    copied++;
    fixed += result.fixed;
  }
  return { copied, fixed };
}
function main() {
  const srcDir = process.env["INPUT_SRC_DIR"] ?? "";
  const destDir = process.env["INPUT_DEST_DIR"] ?? "";
  if (destDir === "") {
    log("warning", "DEST_DIR is not set \u2014 nothing to sanitize into.");
    return;
  }
  try {
    (0, import_node_fs.mkdirSync)(destDir, { recursive: true });
  } catch (err) {
    log("warning", `Could not create DEST_DIR '${destDir}': ${message(err)}`);
    return;
  }
  if (srcDir === "") {
    log("warning", "SRC_DIR is not set \u2014 no SARIF files to sanitize.");
    log("notice", "Sanitized 0 SARIF file(s), fixed 0 result(s).");
    return;
  }
  const { copied, fixed } = sanitizeDir(srcDir, destDir);
  if (copied === 0) {
    log("warning", `No SARIF files copied from '${srcDir}' \u2014 Code Scanning upload may be empty.`);
  }
  log("notice", `Sanitized ${copied} SARIF file(s), fixed ${fixed} result(s).`);
}
try {
  main();
} catch (err) {
  log("warning", `Unexpected sanitize-sarif failure: ${message(err)}`);
}
