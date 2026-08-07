// evals/scratch.ts — replay a fetched PR's per-file changes (evals/fetch.ts's
// `PrFile[]`, from GitHub's "list pull request files" API) into a REAL scratch
// git repo, so the pipeline's own git plumbing (fetchDiff, distill's batched
// check-attr, review/chunked's whole-file reads) runs against real git rather
// than a hand-built DiffData object (AC-16: "the goal is exercising distill ->
// cartographer -> chunked -> cluster -> render FOR REAL").
//
// WHAT THIS REPLAYS FAITHFULLY: which paths changed, their status (added /
// removed / modified / renamed), and every hunk's added/removed/context lines
// VERBATIM — reused unmodified both as the scratch repo's file content source
// AND as the "GitHub patch" text handed to the recording octokit's
// `listFiles` fake (github.ts), so inline-comment anchor validation runs
// against the SAME bytes real GitHub itself reports for that file.
//
// WHAT THIS APPROXIMATES: a file's content OUTSIDE its hunks is not knowable
// from a patch alone (GitHub's `patch` field shows a few lines of context per
// hunk, never the whole file) — so each file's synthesized "pre"/"post"
// content is the CONCATENATION of its hunks' context+removed / context+added
// lines, in hunk order, not the true file. Any pipeline behavior that reads
// content beyond what a hunk shows (e.g. review/chunked.ts's whole-file read
// for an oversized single-file chunk) sees only this hunk-adjacent slice. A
// pure rename with no patch (GitHub omits `patch` for a content-identical
// rename) replays as an empty file on both sides — still correctly a
// content-identical rename, just not the real bytes. A file with no `patch` at
// all (binary, or too large to diff) replays as a short NUL-containing
// placeholder, so git's own binary detection still classifies it as binary. A
// "copied" status (rare) is replayed as "added" at the new path — the copy
// relationship itself is not reconstructed.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { git, setupGitRepo, writeFile, removeRepo } from "../src/git/__tests__/helpers.js";
import type { PrFile } from "./fetch.js";

export { removeRepo };

/** How a changed file's two sides relate, for REPLAY purposes (not
 *  git/distill.ts's `Stratum` — this is about reconstructing content). */
export type FileStatus = "added" | "deleted" | "modified" | "renamed";

/** One file's reconstructed sides, parsed from a {@link PrFile}. */
export interface ParsedFile {
  /** Post-image path (the path under review after this change). */
  path: string;
  /** Pre-image path, only when it differs from `path` (a rename). */
  oldPath: string | null;
  status: FileStatus;
  binary: boolean;
  preLines: string[];
  postLines: string[];
  /** True when the pre-image's LAST line has no trailing newline in the real
   *  file (git's `\ No newline at end of file` marker on the removed/context
   *  side). Keeps replay byte-for-byte VERBATIM instead of adding a `\n` the
   *  real file never had. */
  preNoNewline: boolean;
  /** Same as {@link preNoNewline}, for the post-image's last line (marker on
   *  the added/context side). */
  postNoNewline: boolean;
  /** GitHub's own per-file patch text, reused verbatim as the recording
   *  octokit's `listFiles` patch (possibly ""). */
  patch: string;
}

/** A placeholder for a binary/undiffable file's content — real bytes are
 *  never present in a text patch. The embedded NUL makes git classify it as
 *  binary on its own, the same way it would a real binary blob. */
const BINARY_PLACEHOLDER = "\0evals/scratch.ts: binary content omitted\0";

/** Map GitHub's file `status` to a replay {@link FileStatus}. "copied" has no
 *  replay equivalent (see the module doc) and becomes "added"; "changed" and
 *  "unchanged" (rare, e.g. a pure mode change) become "modified". */
function replayStatus(file: PrFile): FileStatus {
  switch (file.status) {
    case "added":
    case "copied":
      return "added";
    case "removed":
      return "deleted";
    case "renamed":
      return "renamed";
    default:
      return "modified";
  }
}

/** {@link parseHunks}'s result: the reconstructed lines plus whether either
 *  side's LAST line lacks a trailing newline. */
interface ParsedHunks {
  preLines: string[];
  postLines: string[];
  preNoNewline: boolean;
  postNoNewline: boolean;
}

/** Parse one file's `patch` into pre/post line lists. A `\ No newline at end
 *  of file` marker is not content — it describes whichever line (removed,
 *  added, or context) immediately precedes it in the patch text — so it is
 *  folded into `preNoNewline`/`postNoNewline` rather than dropped outright:
 *  dropping it would make {@link joinLines} append a `\n` the real file never
 *  had, contradicting this module's VERBATIM-replay claim (see module doc).
 *  `patch` is already hunk-only (GitHub never includes `diff --git`/`---`/
 *  `+++` headers in this field). */
function parseHunks(patch: string): ParsedHunks {
  const preLines: string[] = [];
  const postLines: string[] = [];
  let preNoNewline = false;
  let postNoNewline = false;
  let lastSide: "pre" | "post" | "both" | null = null;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      lastSide = null;
      continue;
    }
    if (line.startsWith("\\")) {
      if (lastSide === "pre" || lastSide === "both") preNoNewline = true;
      if (lastSide === "post" || lastSide === "both") postNoNewline = true;
      continue;
    }
    if (line.startsWith("+")) {
      postLines.push(line.slice(1));
      lastSide = "post";
    } else if (line.startsWith("-")) {
      preLines.push(line.slice(1));
      lastSide = "pre";
    } else if (line.startsWith(" ")) {
      preLines.push(line.slice(1));
      postLines.push(line.slice(1));
      lastSide = "both";
    }
  }
  return { preLines, postLines, preNoNewline, postNoNewline };
}

/** Parse one {@link PrFile} into a {@link ParsedFile}. Never throws: every
 *  field GitHub's API guarantees (`filename`, `status`) is already validated
 *  by evals/fetch.ts's zod schema. */
function parseFile(file: PrFile): ParsedFile {
  const status = replayStatus(file);
  const oldPath =
    status === "renamed" &&
    file.previous_filename !== undefined &&
    file.previous_filename !== file.filename
      ? file.previous_filename
      : null;
  const patch = file.patch ?? "";
  const binary = file.patch === undefined && status !== "renamed";
  const { preLines, postLines, preNoNewline, postNoNewline } = parseHunks(patch);
  return {
    path: file.filename,
    oldPath,
    status,
    binary,
    preLines,
    postLines,
    preNoNewline,
    postNoNewline,
    patch,
  };
}

/** Parse every fetched file into a {@link ParsedFile}. */
export function parseFiles(files: readonly PrFile[]): ParsedFile[] {
  return files.map(parseFile);
}

/** `noTrailingNewline` honors the patch's `\ No newline at end of file`
 *  marker — VERBATIM replay means never adding a `\n` the real file lacked. */
function joinLines(lines: readonly string[], noTrailingNewline: boolean): string {
  if (lines.length === 0) return "";
  const joined = lines.join("\n");
  return noTrailingNewline ? joined : `${joined}\n`;
}

function preContent(f: ParsedFile): string {
  return f.binary ? BINARY_PLACEHOLDER : joinLines(f.preLines, f.preNoNewline);
}

function postContent(f: ParsedFile): string {
  return f.binary ? `${BINARY_PLACEHOLDER}\0post\0` : joinLines(f.postLines, f.postNoNewline);
}

/** A scratch repo built from replayed files: its dir, both commits' shas, and
 *  every path's GitHub-shaped patch (for the recording octokit's `listFiles`). */
export interface Scratch {
  dir: string;
  baseSha: string;
  headSha: string;
  patches: Map<string, string>;
}

/**
 * Build a real scratch git repo whose `git diff <base>..<head>` reproduces the
 * parsed files' changes (see the module doc for what is faithful vs.
 * approximated). `baseBranch` names the branch the pre-image commit lands on
 * (`setupGitRepo` always starts on `main`; renamed when `baseBranch` differs)
 * so `fetchDiff({ baseBranch, ... })` resolves the same ref the real PR used.
 */
export function buildScratchRepo(files: readonly ParsedFile[], baseBranch: string): Scratch {
  const dir = setupGitRepo();
  if (baseBranch !== "main") git(dir, "branch", "-m", "main", baseBranch);

  for (const f of files) {
    if (f.status === "added") continue;
    writeFile(dir, f.oldPath ?? f.path, preContent(f));
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "eval base", "--quiet", "--allow-empty");
  const baseSha = git(dir, "rev-parse", "HEAD").trim();

  git(dir, "checkout", "-b", "eval-head", "--quiet");
  for (const f of files) {
    if (f.status === "deleted") {
      rmSync(join(dir, f.path), { force: true });
      continue;
    }
    // NOT `git mv`: it requires the destination directory to already exist
    // (confirmed against git 2.43 — it does not create one), while `writeFile`
    // already does. `add -A` below stages the delete+add pair; git's own diff
    // then detects the rename from content similarity, same as a real PR.
    if (f.oldPath !== null) rmSync(join(dir, f.oldPath), { force: true });
    writeFile(dir, f.path, postContent(f));
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "eval head", "--quiet", "--allow-empty");
  const headSha = git(dir, "rev-parse", "HEAD").trim();

  const patches = new Map(files.map((f) => [f.path, f.patch]));
  return { dir, baseSha, headSha, patches };
}
