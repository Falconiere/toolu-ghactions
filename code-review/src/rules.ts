// rules.ts — collect the target repo's project-convention files and assemble
// them as a single text blob for the reviewer to check the diff against. Port of
// gather-rules.sh, driving `git` via execFileSync (not simple-git) so argv and
// exit-code handling match the bash.
//
// SECURITY: convention files live in the repo, so a PR that edits CLAUDE.md could
// otherwise inject instructions into the reviewer. By default we read ONLY tracked
// blobs at the BASE ref (git ls-tree <base> + git show <base>:<path>) — NEVER the
// PR head — so a PR cannot poison the rules until it is merged. RULES_REF=merge is
// the deliberate opt-out for trusted same-repo PRs: it reads the same tracked-blob
// set at the checked-out PR merge ref instead, so a PR that legitimately updates a
// convention is reviewed against its own text — accepting that it can also modify
// the rules it is reviewed against. Either way no working-tree reads occur, and the
// RULES_GLOB cannot path-escape the repo (ls-tree lists tracked blobs only).
import { execFileSync } from "node:child_process";
import { splitGlobs, globMatcher } from "./git/globs.js";

/** Default byte cap matching gather-rules.sh INPUT_RULES_MAX_BYTES. */
const DEFAULT_MAX_BYTES = 32768;

/**
 * Read a blob at the rules ref. Returns the file's bytes, or null when the blob is
 * unreadable (bad ref / vanished path) — the caller logs and skips it, matching
 * the bash `git show <ref>:<path>` with `|| skip`.
 */
export type GitShow = (ref: string, path: string) => Buffer | null;

/**
 * Inputs for gatherRules, mirroring the env vars gather-rules.sh reads — passed in
 * (never read from process.env) so the module is testable: check ←
 * INPUT_CHECK_PROJECT_RULES ("true"), baseSha ← RULES_BASE_SHA / diff base_sha,
 * rulesRef ← INPUT_RULES_REF ("base" | "merge", pre-validated by inputs.ts),
 * mergeRef ← the checked-out PR merge ref read when rulesRef is "merge" (absent →
 * rules are skipped fail-safe, never guessed from HEAD), changedFiles ← diff
 * .changed_files, rulesGlob ← INPUT_RULES_GLOB,
 * maxBytes ← INPUT_RULES_MAX_BYTES (default 32768), cwd ← repo dir, gitShow ←
 * blob reader.
 */
export interface RulesOptions {
  check?: boolean;
  baseSha: string;
  rulesRef?: "base" | "merge";
  mergeRef?: string;
  changedFiles?: string[];
  rulesGlob?: string;
  maxBytes?: number;
  cwd?: string;
  gitShow?: GitShow;
}

/** Run `git` and return stdout, or null when git exits non-zero (the `|| true` idiom). */
function gitOrNull(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
  } catch {
    return null;
  }
}

/**
 * Read a blob at the rules ref as raw bytes (default GitShow). Uses encoding:
 * "buffer" so a binary blob's NUL bytes survive for the binary check; null on a
 * non-zero git exit.
 */
function defaultGitShow(cwd: string): GitShow {
  return (ref: string, path: string): Buffer | null => {
    try {
      return execFileSync("git", ["show", `${ref}:${path}`], {
        cwd,
        encoding: "buffer",
        maxBuffer: 1024 * 1024 * 1024,
      });
    } catch {
      return null;
    }
  };
}

/**
 * Enumerate tracked files at the rules ref via `git ls-tree -r --name-only`, with
 * core.quotePath=false so non-ASCII paths stay verbatim (the default C-quotes
 * them, e.g. "caf\303\251.md", which then never matches git show). Returns the
 * tracked paths in tree order (empty array when none / unreadable).
 */
function listTracked(ref: string, cwd: string): string[] {
  const out = gitOrNull(["-c", "core.quotePath=false", "ls-tree", "-r", "--name-only", ref], cwd);
  if (out === null) return [];
  return out.split("\n").filter((p) => p !== "");
}

// splitGlobs / globMatcher / globToRegExp now live in git/globs.ts (shared with EXCLUDE_GLOBS).

/** Ancestor directories of a changed file, nearest first (root file → none). */
function ancestorDirs(file: string): string[] {
  const dirs: string[] = [];
  let dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : file;
  if (dir === file) return dirs; // no slash -> root file, tier 1 covers it
  while (dir !== "") {
    dirs.push(dir);
    const slash = dir.lastIndexOf("/");
    if (slash === -1) break; // no more slashes
    dir = dir.slice(0, slash);
  }
  return dirs;
}

/**
 * Select convention paths in priority order with dedup, restricted to tracked
 * files at the rules ref. Tiers match gather-rules.sh exactly:
 *   1 root agent-rule files, 2 nested CLAUDE.md/AGENTS.md in changed-file
 *   ancestors, 3 .cursor/.windsurf rule dirs, 4 curated conventions docs,
 *   5 user RULES_GLOB.
 */
function selectPaths(tracked: string[], changedFiles: string[], rulesGlob: string): string[] {
  const isTracked = new Set(tracked);
  const seen = new Set<string>();
  const selected: string[] = [];
  const select = (p: string): void => {
    if (!isTracked.has(p)) return;
    if (seen.has(p)) return;
    seen.add(p);
    selected.push(p);
  };

  // Tier 1: root agent-rule files.
  for (const f of [
    "CLAUDE.md",
    "AGENTS.md",
    ".cursorrules",
    ".windsurfrules",
    ".github/copilot-instructions.md",
  ]) {
    select(f);
  }

  // Tier 2: nested CLAUDE.md/AGENTS.md in ancestor dirs of changed files.
  for (const file of changedFiles) {
    if (file === "") continue;
    for (const dir of ancestorDirs(file)) {
      select(`${dir}/CLAUDE.md`);
      select(`${dir}/AGENTS.md`);
    }
  }

  // Tier 3: rule directories.
  for (const p of tracked) {
    if (p.startsWith(".cursor/rules/") || p.startsWith(".windsurf/rules/")) select(p);
  }

  // Tier 4: curated conventions docs.
  select("CONVENTIONS.md");
  select("CONTRIBUTING.md");
  for (const p of tracked) {
    if (p.startsWith("docs/conventions/")) select(p);
  }

  // Tier 5: user-supplied RULES_GLOB (split on newline and comma).
  for (const entry of splitGlobs(rulesGlob)) {
    const match = globMatcher(entry);
    for (const p of tracked) {
      if (match(p)) select(p);
    }
  }

  return selected;
}

/** True when the blob holds a printable, non-whitespace byte (else blank/empty). */
function hasNonWhitespace(blob: Buffer): boolean {
  const text = blob.toString("utf8");
  return /[^\s]/.test(text);
}

/** True when the blob contains a NUL byte (binary — never injected as rules). */
function hasNulByte(blob: Buffer): boolean {
  return blob.includes(0);
}

/**
 * Gather the project's convention files at the rules ref — the base ref by
 * default, the checked-out PR merge ref when rulesRef is "merge" — and return
 * them as one text blob (empty string when off, no readable ref, no tracked
 * files, or nothing selected). Sections are `### <path>\n<blob>\n` concatenated
 * in priority order until the byte cap; a whole file past the cap is dropped
 * (never a half-rule), and a truncation notice is appended when any file was
 * omitted. Always best-effort — never throws (matches the bash, which always
 * exits 0).
 */
export function gatherRules(opts: RulesOptions): string {
  // Off switch: emit nothing.
  if (opts.check === false) return "";

  // A non-numeric cap fails open in the bash (cap disabled); we fall back to the
  // default on any non-positive / non-finite value.
  const maxBytes =
    typeof opts.maxBytes === "number" && Number.isInteger(opts.maxBytes) && opts.maxBytes > 0
      ? opts.maxBytes
      : DEFAULT_MAX_BYTES;

  // Resolve which ref the rules are read from: the base tip (injection-safe
  // default) or, on explicit opt-in, the checked-out PR merge ref (RULES_REF=merge
  // — trusted same-repo PRs whose convention edits should apply to their own
  // review). Every read below (ls-tree + git show) uses this one ref.
  const useMerge = opts.rulesRef === "merge";
  const ref = useMerge ? (opts.mergeRef ?? "") : (opts.baseSha ?? "");
  const refLabel = useMerge ? "merge" : "base";
  // Fail-safe: with no readable ref we cannot read rules safely. Skip, don't guess.
  if (ref === "") {
    process.stderr.write(`[project-rules] skipped: no ${refLabel} ref\n`);
    return "";
  }
  if (useMerge) {
    process.stderr.write(`[project-rules] RULES_REF=merge: reading rules from ${ref}\n`);
  }

  const cwd = opts.cwd ?? process.cwd();
  const gitShow = opts.gitShow ?? defaultGitShow(cwd);

  const tracked = listTracked(ref, cwd);
  if (tracked.every((p) => p.trim() === "")) {
    process.stderr.write(`[project-rules] skipped: no tracked files at ${refLabel} ref\n`);
    return "";
  }

  const selected = selectPaths(tracked, opts.changedFiles ?? [], opts.rulesGlob ?? "");

  let out = "";
  let totalBytes = 0;
  let omitted = 0;
  for (const path of selected) {
    const blob = gitShow(ref, path);
    if (blob === null) {
      // An unreadable blob is logged and skipped, not silently dropped.
      process.stderr.write(`[project-rules] skipped unreadable: ${path}\n`);
      continue;
    }
    if (!hasNonWhitespace(blob)) continue; // skip blank/empty blobs
    if (hasNulByte(blob)) continue; // skip binary blobs

    const section = `### ${path}\n${blob.toString("utf8")}\n`;
    const secBytes = Buffer.byteLength(section, "utf8");
    if (totalBytes + secBytes > maxBytes) {
      omitted++;
      continue; // whole-file drop: never emit a half-rule
    }
    out += section;
    totalBytes += secBytes;
  }

  // No rule text assembled -> emit nothing. If files existed but every one
  // exceeded the cap, log it rather than emitting a content-free notice.
  if (out === "") {
    if (omitted > 0) {
      process.stderr.write(
        `[project-rules] all ${omitted} rule file(s) exceeded ${maxBytes} bytes; none injected\n`,
      );
    }
    return "";
  }

  if (omitted > 0) {
    out += `\n[Project rules truncated at ${maxBytes} bytes; ${omitted} file(s) omitted.]\n`;
  }
  return out;
}
