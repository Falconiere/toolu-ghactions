// diff.ts — resolve the merge-base, compute the git diff, classify changed
// files (binary / noise / text), line-prime the text diff, and optionally
// truncate at a hunk boundary. Port of fetch-diff.sh, driving `git` via
// execFileSync (not simple-git) so argv and exit-code handling match the bash.
import { execFileSync } from "node:child_process";
import { errorMessage } from "../errors.js";
import { unquoteGitPath } from "./path.js";
import { shapeDiff, type ShapedFile } from "./shape.js";
import { noiseReason, LARGE_FILE_BYTES } from "./noise.js";
import { anyGlobMatches } from "./globs.js";
import { batchRead, type BlobSpec } from "./batchRead.js";

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
  /** The trusted PR base `.gitattributes` were read from, set only when the PR
   *  edits a `.gitattributes` (see fetchDiff); distill.ts reads them the same way. */
  attr_source?: string;
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
  /** The trusted PR base sha, when `baseBranch` is not it (the incremental
   *  since-diff passes a reviewed PR commit as its base). Defaults to the base tip. */
  trustedBase?: string;
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

/**
 * Force RAW (unescaped) non-ASCII bytes in every path git prints. Under git's
 * default `core.quotepath=true` a path with any non-ASCII byte comes back
 * C-quoted (`"\346\227\245..."`), which then (a) fails as a pathspec when it is
 * fed back to `git diff -- <path>`, (b) fails as `git show <ref>:<path>`, and
 * (c) can never compare equal to a path read from a `-z` producer such as
 * pipeline/git.ts's `treeDiffPaths` — the incremental scope would silently
 * classify the file as unchanged. Paths containing `"`, `\`, or a control
 * character (a newline included) stay C-quoted even here, which is what keeps
 * one-path-per-line splitting safe; every producer in this repo therefore uses
 * this same flag so all of them agree byte-for-byte.
 */
const QUOTEPATH_OFF = ["-c", "core.quotepath=false"];

/**
 * Turn OFF git's pathspec pattern language. Changed paths are handed back to
 * `git diff … -- <path1> <path2> …`, and `--` only stops git reading them as
 * OPTIONS — it still reads them as PATHSPECS, i.e. git's own glob language, so
 * a path was matched as a PATTERN, not literally. Verified on git 2.54:
 *   - a file named `:(exclude)*` excludes the whole tree and git exits **0**
 *     with an EMPTY diff — one hostile filename silently disables the review
 *     and the job still goes green; `:(nosuchmagic)foo` exits 128;
 *   - `a?.ts` OVER-matches, dragging files back in (a `go.sum` already dropped
 *     as a lockfile reappeared in the patch); `:foo` UNDER-matches to nothing.
 * It is a git MAIN option, so it precedes the subcommand; every subcommand here
 * accepts it (rev-parse, merge-base, remote get-url, diff).
 *
 * EXCLUDE_GLOBS is NOT affected: it is matched in TypeScript by `anyGlobMatches`
 * (git/globs.ts) before any pathspec is built, never as an `:(exclude)` pathspec,
 * so intentional glob exclusion keeps full pattern semantics. Nor is
 * `check-attr --stdin`, whose input git does not treat as a pathspec at all.
 */
const LITERAL_PATHSPECS = ["--literal-pathspecs"];

/** Keep the `a/`/`b/` header prefixes every path parser here strips, whatever the
 *  runner's git config says (`diff.noprefix` turned `b/x.ts` into `x.ts`). */
const DIFF_PREFIXES_ON = ["-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false"];

/** Global options prepended to EVERY git invocation in this module. */
const GIT_GLOBAL_OPTIONS = [...LITERAL_PATHSPECS, ...QUOTEPATH_OFF, ...DIFF_PREFIXES_ON];

/**
 * The global option that reads `.gitattributes` from `attrSource` (a trusted
 * tree-ish) instead of the checked-out tree — none when no source is set. Git
 * < 2.41 rejects the option, so a caller that sets a source fails closed there.
 */
export function attrSourceArgs(attrSource: string | undefined): string[] {
  return attrSource === undefined ? [] : [`--attr-source=${attrSource}`];
}

/** Run `git` and return stdout, or null when git exits non-zero (the `|| true` idiom). */
function gitOrNull(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", [...GIT_GLOBAL_OPTIONS, ...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/**
 * Run `git` and return stdout, THROWING DiffResolutionError when git fails.
 *
 * For the calls whose stdout IS the review (the numstat path list and the review
 * diff). `gitOrNull`'s `|| true` idiom is right for probes (`rev-parse --verify`
 * answers "no" via exit code) and wrong here, where a failure flattened to `""` is
 * indistinguishable from "this PR changed nothing": the pipeline short-circuits on
 * `total_files === 0` and APPROVES, the ledger marks every file `unreviewed (not-attempted)`, and with
 * the default `FAIL_ON: changes` the job still exits green having reviewed
 * nothing. Real failures that reach this call are the 1 GiB `maxBuffer`
 * (ENOBUFS on a huge PR) and E2BIG once the pathspec argv exceeds the kernel
 * limit. main.ts's top-level guard turns the throw into verdict=error, a posted
 * error comment and a red job.
 */
function gitOrThrow(args: string[], cwd: string, baseBranch: string): string {
  try {
    return execFileSync("git", [...GIT_GLOBAL_OPTIONS, ...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 1024,
    });
  } catch (err) {
    // execFileSync folds git's stderr into the message; keep its last line, the
    // actual `fatal:`/`error:` cause, rather than the echoed command line.
    const detail =
      errorMessage(err)
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .pop() ?? "git exited non-zero";
    throw new DiffResolutionError(
      `Cannot read the review diff: ${detail}. This is a git FAILURE, not an empty diff — the review was not performed.`,
      baseBranch,
    );
  }
}

/** {@link gitOrThrow} with `.gitattributes` read from `attrSource` when set, its
 *  failure then naming the git version `--attr-source` needs. */
function gitAttrOrThrow(
  args: string[],
  attrSource: string | undefined,
  cwd: string,
  baseBranch: string,
): string {
  try {
    return gitOrThrow([...attrSourceArgs(attrSource), ...args], cwd, baseBranch);
  } catch (err) {
    if (attrSource === undefined) throw err;
    throw new DiffResolutionError(
      `${errorMessage(err)} Reviewing a PR that changes .gitattributes needs git ≥ 2.41 (--attr-source).`,
      baseBranch,
    );
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
 * A full git object id used as a ref: 40 hex (sha1) or 64 hex (sha256 repos,
 * which git supports and this action can be checked out into). Same shape
 * pipeline/git.ts's `recoverReviewedCommit` guards on, so the two modules agree
 * on what counts as a bare commit SHA rather than a branch name.
 */
const LOCAL_OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

/**
 * Resolve the base branch to a verifiable ref (`origin/<base>`, fetched if
 * missing, then falling back to a local `<base>`), returning that ref. Throws
 * DiffResolutionError when neither resolves — the bash `exit 1` path.
 *
 * A base that is already a locally-present commit SHA short-circuits: see
 * {@link LOCAL_OBJECT_ID}.
 */
function resolveRemoteBase(baseBranch: string, cwd: string): string {
  // An INCREMENTAL scope passes the previously reviewed commit SHA as the base
  // (pipeline/git.ts's `sinceChangedLines`), one line after proving it resolves
  // locally. `origin/<40-hex-sha>` can never exist, so without this the code
  // always fell through to `git fetch origin <sha> --depth=1` on EVERY
  // pull_request push with review memory on — a round trip that can only be
  // wasted, with no timeout (unlike `recoverReviewedCommit`'s 10 s), and
  // `--depth=1` grafts a shallow boundary into a previously full clone mid-run.
  // Matching only an exact object-id form keeps the "prefer a fresh
  // `origin/<branch>` over a stale local `<branch>`" behaviour for real names.
  if (LOCAL_OBJECT_ID.test(baseBranch) && refExists(`${baseBranch}^{commit}`, cwd)) {
    return baseBranch;
  }

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

/** One parsed `git diff --numstat` row: added/removed counts (or "-"/"-" for binary) + path. */
interface NumstatRow {
  added: string;
  removed: string;
  path: string;
}

/**
 * Parse `git diff --numstat` output into rows, in encounter order. Columns are
 * added\tremoved\tpath; split on the first two tabs only, so a rename arrow
 * carrying a tab leaves the path remainder intact.
 */
function parseNumstat(numstat: string): NumstatRow[] {
  const rows: NumstatRow[] = [];
  for (const row of numstat.split("\n")) {
    if (row === "") continue;
    const firstTab = row.indexOf("\t");
    if (firstTab === -1) continue;
    const rest = row.slice(firstTab + 1);
    const secondTab = rest.indexOf("\t");
    if (secondTab === -1) continue;
    const added = row.slice(0, firstTab);
    const removed = rest.slice(0, secondTab);
    const path = unquoteGitPath(rest.slice(secondTab + 1));
    if (path === "") continue;
    rows.push({ added, removed, path });
  }
  return rows;
}

/**
 * Classify each changed file from its parsed `git diff --numstat` rows: binary
 * files show the sentinel "-\t-\t<path>"; non-binary files run through
 * noiseReason() and are either dropped (with a reason) or kept as text files.
 * Returns the three buckets in numstat (encounter) order, matching the bash
 * while-loop.
 *
 * Blob reads for noiseReason's content rules are batched: one pre-pass collects
 * every candidate path (non-binary, not already dropped by EXCLUDE_GLOBS or
 * .gitattributes) and reads all of them via `batchRead` — one `cat-file
 * --batch-check` spawn for sizes, plus one `cat-file --batch` spawn per
 * byte-budget group (each bounded to MAX_BLOB_READ_BYTES per blob) for content —
 * instead of a `git show`/`cat-file -s` PER FILE.
 */
function classifyFiles(
  rows: readonly NumstatRow[],
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

  const specs: BlobSpec[] = [];
  for (const { added, removed, path } of rows) {
    if (added === "-" && removed === "-") continue; // binary — never blob-read
    if (excludeGlobs.length > 0 && anyGlobMatches(excludeGlobs, path)) continue;
    if (generatedPaths.has(path)) continue;
    specs.push({ ref: refFor(path), path });
  }
  // Size cutoff applied BEFORE content is fetched: a blob over LARGE_FILE_BYTES
  // classifies "large-file" on size alone, so its content is never read.
  const blobs = batchRead(specs, cwd, { sizeCutoff: LARGE_FILE_BYTES });
  const readBlob = (path: string): string | null => blobs.get(path)?.content ?? null;
  const blobSize = (path: string): number => blobs.get(path)?.size ?? 0;

  for (const { added, removed, path } of rows) {
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
 *
 * Can return MORE than `max` lines: when the budget runs out inside the final
 * hunk there is no next boundary to cut at, so the input comes back intact. The
 * caller then applies {@link hardCutLines}.
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
 * Keep exactly the first `max` lines. The fallback when
 * {@link truncateAtHunkBoundary} could not honour MAX_DIFF_LINES because the
 * budget ran out inside a single (or the last) hunk — mid-hunk cutting is
 * better than no cap at all, and it is what makes `truncated: true` and
 * `total_lines` tell the truth.
 */
function hardCutLines(diff: string, max: number): string {
  return diff.split("\n").slice(0, max).join("\n");
}

/**
 * Resolve base/merge-base, build and classify the diff, line-prime the text
 * files, and optionally apply the MAX_FILES skip or MAX_DIFF_LINES truncation.
 * Returns a DiffData. On a MAX_FILES skip the result carries `error` (a signal,
 * NOT a throw). Throws DiffResolutionError when the base/merge-base cannot be
 * resolved (fetch-diff.sh's two `exit 1` paths) AND when the review diff itself
 * fails to read — the latter must never be reported as an empty review.
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
  // --no-renames on the CLASSIFICATION diffs (numstat/name-status): rename
  // detection would emit an "old => new" arrow path that breaks path handling,
  // while --no-renames lists BOTH real sides of a move. The final REVIEW diff
  // below runs WITH -M so a move renders as a rename, not delete+add.
  //
  // ONE `--numstat` pass is the single source of both the changed-path list and
  // the classification input. Verified against git 2.54 that `--numstat` and
  // `--name-only` list the same paths in the same order — over binaries
  // (`-\t-`), gitlinks, mode-only changes, deletions, empty↔non-empty
  // transitions, spaces, non-ASCII under core.quotepath=false, and C-quoted
  // names holding a tab or a newline — so the separate full-range `--name-only`
  // walk that ran here before was pure duplicate work.
  //
  // gitOrThrow: a failed numstat flattened to "" would read as "no changes" and approve.
  const numstatArgs = ["diff", "--no-renames", "--numstat", mergeBase, reviewHead];
  let rows = parseNumstat(gitOrThrow(numstatArgs, cwd, baseBranch));
  const changedPaths = rows.map((row) => row.path);
  const totalFiles = changedPaths.length;

  if (totalFiles === 0) {
    return emptyResult(baseSha);
  }

  // Attributes can differ from the base only where the PR edits a `.gitattributes`;
  // then read them from the trusted PR base, never the PR's own tree, or one line
  // of `* linguist-generated` / `* -diff` drops every file from review.
  const prPaths =
    opts.trustedBase === undefined
      ? changedPaths
      : gitOrThrow(
          ["diff", "--no-renames", "--name-only", `${opts.trustedBase}...${reviewHead}`],
          cwd,
          baseBranch,
        )
          .split("\n")
          .map(unquoteGitPath);
  const attrSource = prPaths.some((p) => p === ".gitattributes" || p.endsWith("/.gitattributes"))
    ? (opts.trustedBase ?? baseSha)
    : undefined;
  // Only the binary (`-diff`) column can change; the path list cannot.
  if (attrSource !== undefined) {
    rows = parseNumstat(gitAttrOrThrow(numstatArgs, attrSource, cwd, baseBranch));
  }

  const deletedPaths = deletedInRange(mergeBase, reviewHead, cwd);
  // Exclusion (EXCLUDE_GLOBS → .gitattributes linguist-generated → static noise) runs
  // BEFORE the file-count gate, so a PR dominated by generated/vendored files is
  // reviewed on its few real files instead of being skipped wholesale.
  const generatedPaths = gitattributesGenerated(changedPaths, cwd, attrSource);
  const { binary, text, dropped } = classifyFiles(
    rows,
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
    //
    // gitOrThrow, NOT gitOrNull: this is the one call whose stdout IS the
    // review, so a git failure must never flatten to "" and read as "the PR
    // changed nothing" (see gitOrThrow). A genuinely empty diff still returns ""
    // here — `git diff` exits 0 with no output when nothing differs.
    const rawDiff = gitAttrOrThrow(
      ["diff", "-M", mergeBase, reviewHead, "--", ...text],
      attrSource,
      cwd,
      baseBranch,
    );
    const shaped = shapeDiff(rawDiff);
    diff = stripTrailingNewlines(shaped.diff);
    files = shaped.files;
  }

  let diffLines = countLines(diff);
  let truncated = false;
  if (maxDiffLines > 0 && diffLines > maxDiffLines) {
    const atBoundary = stripTrailingNewlines(truncateAtHunkBoundary(diff, maxDiffLines));
    // The hunk-boundary pass can only cut at the NEXT `diff --git `/`@@ ` line.
    // When the budget runs out inside the last — or only — hunk, no such
    // boundary ever arrives, `stop` stays false and the WHOLE diff comes back.
    // Hard-cut in that case, or MAX_DIFF_LINES is not a limit at all and
    // `truncated` (which prompt.ts turns into "[Diff truncated at N lines; some
    // hunks omitted]") lies about work that was never done.
    diff =
      countLines(atBoundary) > maxDiffLines ? hardCutLines(atBoundary, maxDiffLines) : atBoundary;
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
    ...(attrSource === undefined ? {} : { attr_source: attrSource }),
  };
}

/**
 * Paths the repo marks `linguist-generated` in `.gitattributes` (the signal GitHub's
 * own diff UI uses). One batched `git check-attr` over the changed paths, reading
 * attributes from `attrSource` when set (see fetchDiff). Degrades to an empty set if
 * check-attr is unavailable or errors — static patterns + EXCLUDE_GLOBS still apply.
 * Only `linguist-generated` suppresses diffs; `linguist-vendored` does not.
 */
function gitattributesGenerated(
  paths: readonly string[],
  cwd: string,
  attrSource: string | undefined,
): Set<string> {
  const out = new Set<string>();
  if (paths.length === 0) return out;
  let res: string;
  try {
    // -z makes both input and output NUL-delimited. Git paths may legally
    // contain newlines, so a newline-delimited --stdin would split one path
    // across two records and misclassify it. NUL can never appear in a path.
    res = execFileSync(
      "git",
      [...attrSourceArgs(attrSource), "check-attr", "-z", "linguist-generated", "--stdin"],
      { cwd, input: paths.join("\0"), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
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
    const path = unquoteGitPath(line.slice(tab + 1));
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
    if (from === undefined || to === undefined) continue;
    const rename = { from: unquoteGitPath(from), to: unquoteGitPath(to) };
    if (kept.has(rename.to)) out.push(rename);
  }
  return out;
}

/** Strip trailing newlines, reproducing bash `$(...)` command-substitution behavior. */
function stripTrailingNewlines(s: string): string {
  return s.replace(/\n+$/, "");
}
