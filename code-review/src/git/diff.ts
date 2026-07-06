// diff.ts — resolve the merge-base, compute the git diff, classify changed
// files (binary / noise / text), line-prime the text diff, and optionally
// truncate at a hunk boundary. Port of fetch-diff.sh, driving `git` via
// execFileSync (not simple-git) so argv and exit-code handling match the bash.
import { execFileSync } from "node:child_process";
import { shapeDiff, type ShapedFile } from "./shape.js";
import { noiseReason } from "./noise.js";
import { anyGlobMatches } from "./globs.js";

/** A file dropped before diffing, with the reason it was classified as noise. */
export interface DroppedFile {
  path: string;
  reason: string;
}

/** A file renamed within the diff range (detected with rename detection, separately
 *  from the `--no-renames` review diff) — surfaced to the prompt so the model reads
 *  a move as a rename, not a delete + add. */
export interface RenamedFile {
  from: string;
  to: string;
}

/** Full post-change file content attached as read-only context (see review/chunked.ts:
 *  when a single file's diff overflows the chunk budget, the model gets the whole file
 *  so a construct spanning past a hunk boundary — e.g. a multi-line raw string — is
 *  never judged from a truncated view). */
export interface ContextFile {
  path: string;
  content: string;
}

/**
 * Result of fetchDiff. `error` is set ONLY on the MAX_FILES skip (a non-throwing
 * signal main reads to post a skip comment); a skip result also carries
 * total_files/max_files and leaves the other fields at their empty defaults.
 */
export interface DiffData {
  diff: string;
  files: ShapedFile[];
  changed_files: string[];
  binary_files: string[];
  dropped_files: DroppedFile[];
  renames: RenamedFile[];
  total_lines: number;
  total_files: number;
  truncated: boolean;
  base_sha: string;
  error?: string;
  max_files?: number;
  /** Full-file read-only context for oversized chunks (set by review/chunked.ts only). */
  context_files?: ContextFile[];
}

/**
 * Inputs for fetchDiff, mirroring the env vars fetch-diff.sh reads — passed in
 * (never read from process.env) so the module is testable: baseBranch ←
 * INPUT_BASE_BRANCH ("main"), maxFiles ← INPUT_MAX_FILES (0=unlimited),
 * maxDiffLines ← INPUT_MAX_DIFF_LINES (0=unlimited), reviewHead ← REVIEW_HEAD
 * ("HEAD"), githubBaseRef ← GITHUB_BASE_REF, cwd ← repo dir (process.cwd()).
 */
export interface DiffOptions {
  baseBranch?: string;
  maxFiles?: number;
  maxDiffLines?: number;
  reviewHead?: string;
  githubBaseRef?: string;
  /** Extra path globs to exclude from the reviewed diff (← INPUT_EXCLUDE_GLOBS, split). */
  excludeGlobs?: string[];
  cwd?: string;
}

/** Thrown when the base branch / merge-base cannot be resolved (bash exits 1 here). */
export class DiffResolutionError extends Error {
  /** The base branch that could not be resolved, echoed for the error payload. */
  readonly baseBranch: string;
  constructor(message: string, baseBranch: string) {
    super(message);
    this.name = "DiffResolutionError";
    this.baseBranch = baseBranch;
  }
}

/** Run `git` and return stdout, or null when git exits non-zero (the `|| true` idiom). */
function gitOrNull(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
  } catch {
    return null;
  }
}

/** True when `git rev-parse --verify <ref>` succeeds (ref is resolvable). */
function refExists(ref: string, cwd: string): boolean {
  return gitOrNull(["rev-parse", "--verify", ref], cwd) !== null;
}

/** True when this is a shallow clone (`git rev-parse --is-shallow-repository` → "true"). */
function isShallow(cwd: string): boolean {
  return gitOrNull(["rev-parse", "--is-shallow-repository"], cwd)?.trim() === "true";
}

/** True when an `origin` remote URL is configured. */
function hasOrigin(cwd: string): boolean {
  return gitOrNull(["remote", "get-url", "origin"], cwd) !== null;
}

/** Empty result for a repo with no changed files (bash early-exit branch). */
function emptyResult(baseSha: string): DiffData {
  return {
    diff: "",
    files: [],
    changed_files: [],
    binary_files: [],
    dropped_files: [],
    renames: [],
    total_lines: 0,
    total_files: 0,
    truncated: false,
    base_sha: baseSha,
  };
}

/**
 * Resolve the base branch to a verifiable ref (`origin/<base>`, fetched if
 * missing, then falling back to a local `<base>`), returning that ref. Throws
 * DiffResolutionError when neither resolves — the bash `exit 1` path.
 */
function resolveRemoteBase(baseBranch: string, cwd: string): string {
  let remoteBase = `origin/${baseBranch}`;
  if (refExists(remoteBase, cwd)) return remoteBase;

  if (hasOrigin(cwd)) {
    gitOrNull(["fetch", "origin", baseBranch, "--depth=1"], cwd);
  }
  if (refExists(remoteBase, cwd)) return remoteBase;

  if (!refExists(baseBranch, cwd)) {
    throw new DiffResolutionError("Cannot resolve base branch", baseBranch);
  }
  remoteBase = baseBranch;
  return remoteBase;
}

/**
 * Find the merge-base of reviewHead and remoteBase, deepening a shallow clone
 * along the 100→500→2000 ladder (then --unshallow as a last resort) until they
 * reconnect. Deepening is skipped for full clones (a no-op there). Throws when
 * no merge-base can be computed — the bash `exit 1` path.
 */
function resolveMergeBase(
  reviewHead: string,
  remoteBase: string,
  baseBranch: string,
  cwd: string,
): string {
  let mergeBase = gitOrNull(["merge-base", reviewHead, remoteBase], cwd)?.trim() ?? "";

  if (mergeBase === "" && isShallow(cwd) && hasOrigin(cwd)) {
    for (const depth of [100, 500, 2000]) {
      gitOrNull(["fetch", "origin", `--deepen=${depth}`], cwd);
      mergeBase = gitOrNull(["merge-base", reviewHead, remoteBase], cwd)?.trim() ?? "";
      if (mergeBase !== "") break;
    }
    if (mergeBase === "") {
      gitOrNull(["fetch", "origin", "--unshallow"], cwd);
      mergeBase = gitOrNull(["merge-base", reviewHead, remoteBase], cwd)?.trim() ?? "";
    }
  }

  if (mergeBase === "") {
    throw new DiffResolutionError("Cannot compute merge-base", baseBranch);
  }
  return mergeBase;
}

/**
 * Classify each changed file from `git diff --numstat`: binary files show the
 * sentinel "-\t-\t<path>"; non-binary files run through noiseReason() and are
 * either dropped (with a reason) or kept as text files. Returns the three
 * buckets in numstat (encounter) order, matching the bash while-loop.
 */
function classifyFiles(
  numstat: string,
  reviewHead: string,
  cwd: string,
  excludeGlobs: readonly string[],
  generatedPaths: ReadonlySet<string>,
  deletedPaths: ReadonlySet<string>,
  mergeBase: string,
): { binary: string[]; text: string[]; dropped: DroppedFile[] } {
  const binary: string[] = [];
  const text: string[] = [];
  const dropped: DroppedFile[] = [];

  // A deleted path has no blob at the review head — `git show HEAD:<path>` dies
  // with `fatal: path … does not exist in 'HEAD'` (once per deleted file, straight
  // into the job log). Read deleted paths from the merge-base, where they DO exist.
  const refFor = (path: string): string => (deletedPaths.has(path) ? mergeBase : reviewHead);
  const readBlob = (path: string): string | null =>
    gitOrNull(["show", `${refFor(path)}:${path}`], cwd);
  const blobSize = (path: string): number => {
    const out = gitOrNull(["cat-file", "-s", `${refFor(path)}:${path}`], cwd);
    return out === null ? 0 : Number.parseInt(out.trim(), 10) || 0;
  };

  for (const row of numstat.split("\n")) {
    if (row === "") continue;
    // numstat columns: added\tremoved\tpath. Split on the first two tabs only,
    // so a rename arrow carrying a tab leaves the path remainder intact.
    const firstTab = row.indexOf("\t");
    if (firstTab === -1) continue;
    const rest = row.slice(firstTab + 1);
    const secondTab = rest.indexOf("\t");
    if (secondTab === -1) continue;
    const added = row.slice(0, firstTab);
    const removed = rest.slice(0, secondTab);
    const path = rest.slice(secondTab + 1);
    if (path === "") continue;

    if (added === "-" && removed === "-") {
      binary.push(path);
      continue;
    }
    // User globs (EXCLUDE_GLOBS) and repo .gitattributes linguist-generated drop a
    // file before the static noise classifier — both are non-authored by definition.
    if (excludeGlobs.length > 0 && anyGlobMatches(excludeGlobs, path)) {
      dropped.push({ path, reason: "excluded" });
      continue;
    }
    if (generatedPaths.has(path)) {
      dropped.push({ path, reason: "generated (.gitattributes)" });
      continue;
    }
    const reason = noiseReason(path, readBlob, blobSize);
    if (reason !== null) {
      dropped.push({ path, reason });
      continue;
    }
    text.push(path);
  }

  return { binary, text, dropped };
}

/**
 * Count primed diff lines the way the bash does: `grep -c ''` counts newline
 * records, so a non-empty string with no trailing newline still counts its last
 * line. An empty string is 0 lines.
 */
export function countLines(diff: string): number {
  if (diff === "") return 0;
  const newlines = (diff.match(/\n/g) ?? []).length;
  return diff.endsWith("\n") ? newlines : newlines + 1;
}

/**
 * Hunk-boundary truncation (port of the awk): once `n` printed lines reaches
 * the budget, drop everything from the NEXT `diff --git`/`@@ ` boundary onward,
 * so a hunk is never cut mid-line. The caller re-strips trailing newlines, so
 * this returns the kept lines joined with no trailing newline.
 */
function truncateAtHunkBoundary(diff: string, max: number): string {
  const kept: string[] = [];
  let n = 0;
  let stop = false;
  for (const line of stripTrailingNewlines(diff).split("\n")) {
    if (!stop && (line.startsWith("diff --git ") || line.startsWith("@@ ")) && n >= max)
      stop = true;
    if (stop) continue;
    kept.push(line);
    n++;
  }
  return kept.join("\n");
}

/**
 * Resolve base/merge-base, build and classify the diff, line-prime the text
 * files, and optionally apply the MAX_FILES skip or MAX_DIFF_LINES truncation.
 * Returns a DiffData. On a MAX_FILES skip the result carries `error` (a signal,
 * NOT a throw); a genuinely unresolvable base/merge-base throws
 * DiffResolutionError, matching fetch-diff.sh's two exit paths.
 */
export function fetchDiff(opts: DiffOptions): DiffData {
  const cwd = opts.cwd ?? process.cwd();
  const maxFiles = opts.maxFiles ?? 0;
  const maxDiffLines = opts.maxDiffLines ?? 0;
  const reviewHead = opts.reviewHead ?? "HEAD";
  const excludeGlobs = opts.excludeGlobs ?? [];

  // Prefer the PR base ref when the caller left the default "main".
  let baseBranch = opts.baseBranch ?? "main";
  if (opts.githubBaseRef && opts.githubBaseRef !== "" && baseBranch === "main") {
    baseBranch = opts.githubBaseRef;
  }

  const remoteBase = resolveRemoteBase(baseBranch, cwd);
  const mergeBase = resolveMergeBase(reviewHead, remoteBase, baseBranch, cwd);
  // base-branch TIP (not the merge-base): project-rules are read at the tip of
  // the branch we merge into, so rules added after this PR branched still apply.
  const baseSha = gitOrNull(["rev-parse", remoteBase], cwd)?.trim() ?? "";
  // --no-renames on the CLASSIFICATION diffs (name-only/numstat/name-status):
  // rename detection would emit an "old => new" arrow path that breaks path
  // handling, while --no-renames lists BOTH real sides of a move. The final
  // REVIEW diff below runs WITH -M so a move renders as a rename, not delete+add.
  const changedFiles =
    gitOrNull(["diff", "--no-renames", "--name-only", mergeBase, reviewHead], cwd) ?? "";
  const changedPaths = changedFiles.split("\n").filter((l) => l.trim() !== "");
  const totalFiles = changedPaths.length;

  if (totalFiles === 0) {
    return emptyResult(baseSha);
  }

  const numstat =
    gitOrNull(["diff", "--no-renames", "--numstat", mergeBase, reviewHead], cwd) ?? "";
  const deletedPaths = deletedInRange(mergeBase, reviewHead, cwd);
  // Exclusion (EXCLUDE_GLOBS → .gitattributes linguist-generated → static noise) runs
  // BEFORE the file-count gate, so a PR dominated by generated/vendored files is
  // reviewed on its few real files instead of being skipped wholesale.
  const generatedPaths = gitattributesGenerated(changedPaths, cwd);
  const { binary, text, dropped } = classifyFiles(
    numstat,
    reviewHead,
    cwd,
    excludeGlobs,
    generatedPaths,
    deletedPaths,
    mergeBase,
  );

  // The file-count limit gates the POST-EXCLUSION reviewed set (opt-in: >0). Non-throwing
  // skip signal: main reads `.error` and posts a skip comment.
  if (maxFiles > 0 && text.length > maxFiles) {
    return {
      ...emptyResult(baseSha),
      total_files: totalFiles,
      max_files: maxFiles,
      error: `PR exceeds file limit: ${text.length} reviewable files (of ${totalFiles} changed) > ${maxFiles} max. Raise MAX_FILES to review it.`,
    };
  }

  // Build the line-primed diff + per-file changed_lines for the text files.
  // Command-substitution in the bash strips trailing newlines, so do the same.
  let diff = "";
  let files: ShapedFile[] = [];
  if (text.length > 0) {
    // -M (rename detection) on the REVIEW diff: a moved file renders as a rename
    // (`rename from`/`rename to` + only its real edits), not a full delete + add.
    // Both sides of a move are in `text` (classification ran --no-renames), so the
    // pathspec covers the pair and detection works. This also keeps our anchorable
    // lines aligned with GitHub's own rename-aware PR diff — a finding on a moved
    // file's unchanged line would otherwise 422 at inline-review time.
    const rawDiff = gitOrNull(["diff", "-M", mergeBase, reviewHead, "--", ...text], cwd) ?? "";
    const shaped = shapeDiff(rawDiff);
    diff = stripTrailingNewlines(shaped.diff);
    files = shaped.files;
  }

  let diffLines = countLines(diff);
  let truncated = false;
  if (maxDiffLines > 0 && diffLines > maxDiffLines) {
    diff = stripTrailingNewlines(truncateAtHunkBoundary(diff, maxDiffLines));
    truncated = true;
    diffLines = countLines(diff);
  }

  return {
    diff,
    files,
    changed_files: text,
    binary_files: binary,
    dropped_files: dropped,
    renames: detectRenames(mergeBase, reviewHead, cwd, new Set(text)),
    total_lines: diffLines,
    total_files: totalFiles,
    truncated,
    base_sha: baseSha,
  };
}

/**
 * Paths the repo marks `linguist-generated` in `.gitattributes` (the signal GitHub's
 * own diff UI uses). One batched `git check-attr` over the changed paths. Degrades to
 * an empty set if check-attr is unavailable or errors — static patterns + EXCLUDE_GLOBS
 * still apply. Only `linguist-generated` suppresses diffs; `linguist-vendored` does not.
 */
function gitattributesGenerated(paths: readonly string[], cwd: string): Set<string> {
  const out = new Set<string>();
  if (paths.length === 0) return out;
  let res: string;
  try {
    // -z makes both input and output NUL-delimited. Git paths may legally
    // contain newlines, so a newline-delimited --stdin would split one path
    // across two records and misclassify it. NUL can never appear in a path.
    res = execFileSync("git", ["check-attr", "-z", "linguist-generated", "--stdin"], {
      cwd,
      input: paths.join("\0"),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return out; // check-attr unavailable / no .gitattributes → skip this layer
  }
  // -z output is a flat NUL-separated stream of <path>\0<attr>\0<value> triples.
  const fields = res.split("\0");
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const path = fields[i];
    // <value> is "set" / "unset" / "unspecified"; only "set" marks generated.
    if (path !== undefined && fields[i + 2] === "set") out.add(path);
  }
  return out;
}

/**
 * Paths DELETED in the diff range (status D under --no-renames, so a move's old
 * side counts too). These have no blob at the review head — blob reads for them
 * must target the merge-base instead.
 */
function deletedInRange(mergeBase: string, reviewHead: string, cwd: string): Set<string> {
  const raw =
    gitOrNull(["diff", "--no-renames", "--name-status", mergeBase, reviewHead], cwd) ?? "";
  const out = new Set<string>();
  for (const line of raw.split("\n")) {
    if (!line.startsWith("D")) continue;
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const path = line.slice(tab + 1);
    if (path !== "") out.add(path);
  }
  return out;
}

/**
 * Renames in the diff range, detected WITH rename detection (`-M`), matching the
 * -M review diff. Filtered to renames whose target survives exclusion, so the
 * prompt manifest never advertises a move into a generated/excluded path.
 */
function detectRenames(
  mergeBase: string,
  reviewHead: string,
  cwd: string,
  kept: ReadonlySet<string>,
): RenamedFile[] {
  const raw = gitOrNull(["diff", "--name-status", "-M", mergeBase, reviewHead], cwd) ?? "";
  const out: RenamedFile[] = [];
  for (const line of raw.split("\n")) {
    if (!line.startsWith("R")) continue;
    const parts = line.split("\t"); // R<score>\t<old>\t<new>
    if (parts.length < 3) continue;
    const from = parts[1];
    const to = parts[2];
    if (from !== undefined && to !== undefined && kept.has(to)) out.push({ from, to });
  }
  return out;
}

/** Strip trailing newlines, reproducing bash `$(...)` command-substitution behavior. */
function stripTrailingNewlines(s: string): string {
  return s.replace(/\n+$/, "");
}
