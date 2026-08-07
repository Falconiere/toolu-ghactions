// review/chunked.ts — drive the model review over one or many diff chunks.
//
// A diff within the per-chunk budget is reviewed in ONE call (today's behavior,
// byte-identical). A diff over budget is split into whole-file packages, each
// reviewed in its own call (the FIRST alone as a prompt-cache warm-up, the rest at
// ≤ CHUNK_CONCURRENCY) and merged — so a large PR no longer overwhelms a single
// structured-output call and abstains. Mechanical (SAST) findings are partitioned
// to the package holding their file; orphans ride with package[0].
//
// A package whose call fails on the output SCHEMA is bisected (review/bisect.ts)
// instead of being written off whole: its surviving halves are real coverage and
// feed mergeResults as leaf results, so only the leaf that truly failed costs its
// files. Every path this module touches is reported through `onCoverage` —
// `reviewed`, `unreviewed` (attempted and failed, incl. the MAX_CHUNKS spill) or
// `pending` (wall clock ran out before it was attempted) — so the coverage ledger
// (review/ledger.ts) can account for the whole diff with no silent skips.
import { splitDiffByFile, packGroups } from "@/git/chunk.js";
import type { FileSegment } from "@/git/chunk.js";
import { groupRelatedSegments } from "@/git/relate.js";
import { countLines } from "@/git/diff.js";
import type { ContextFile, DiffData } from "@/git/diff.js";
import { mapWithConcurrency } from "@/concurrency.js";
import { mergeResults } from "@/llm/merge.js";
import type { ProviderResult } from "@/llm/reviewWithModel.js";
import type { Envelope } from "@/prompt.js";
import type { MechanicalFinding } from "@/mechanical/sarif.js";
import type { Brief } from "@/review/cartographer.js";
import type { CoverageEntry } from "@/review/ledger.js";
import { deadlinePassed, reportCoverage, reviewPackage } from "@/review/bisect.js";
import type { PackageReviewContext } from "@/review/bisect.js";

export { BISECT_MAX_DEPTH } from "@/review/bisect.js";

/** Max model calls in flight at once — an OpenRouter rate-limit guard. */
export const CHUNK_CONCURRENCY = 4;

/** Full-file context attach ceiling (lines). A file bigger than this is skipped —
 *  an oversized prompt stalls the provider past its deadline, which is worse than
 *  reviewing from the diff alone. */
export const MAX_CONTEXT_FILE_LINES = 5000;

/** Inputs for {@link reviewChunked}: the diff, the chunk budget, and test seams. */
export interface ChunkedReviewOptions {
  diff: DiffData;
  /** Per-chunk diff-line budget; ≤ 0 disables chunking (always one call). */
  maxChunkLines: number;
  /** Max chunks (packages); files beyond spill out and are noted. 0 = unlimited.
   *  NOT a model-call count: a package costs 1 call when it succeeds or fails
   *  unbisectably-without-retry, 2 with its one retry, and up to 7 when a schema
   *  failure bisects (1 + 2 halves + 4 quarters, review/bisect.ts) — so the call
   *  ceiling is `maxChunks × 7`, not `maxChunks`. */
  maxChunks: number;
  /** Deterministic SAST findings, partitioned per chunk by file path. */
  mechanical: MechanicalFinding[];
  /** The cartographer's PR brief (Layer 1), or null when it was unavailable —
   *  passed to every envelope build, including bisected halves. */
  brief: Brief | null;
  /** Build the prompt for one chunk's sub-diff + that chunk's mechanical findings. */
  buildEnvelope: (
    subDiff: DiffData,
    mechanical: MechanicalFinding[],
    brief: Brief | null,
  ) => Envelope;
  /** Run one model review of a built envelope (never throws — it abstains). */
  review: (envelope: Envelope) => Promise<ProviderResult>;
  /** Per-path coverage sink, called once per path per outcome — the ledger's input. */
  onCoverage: (path: string, entry: CoverageEntry) => void;
  /** Assign the diff's file segments to packages before packing. Defaults to
   *  {@link groupRelatedSegments} (module-coupled files share a package); the
   *  pipeline overrides it with the Layer 1 brief's hint-based assignment
   *  (src/pipeline/packages.ts), which falls back to the same function. */
  groupSegments?: (segments: FileSegment[]) => FileSegment[][];
  /** Epoch-ms wall deadline (MAX_WALL_MS); once reached, remaining packages are
   *  reported `pending` and left for a resume run instead of being attempted. */
  wallDeadline?: number;
  /** Read a file's full post-change content (git show <head>:<path>), or null when
   *  unreadable (deleted/binary). Powers the oversized-chunk full-file context. */
  readFile?: (path: string) => string | null;
}

/**
 * Review the diff, chunking it when it exceeds the per-chunk budget. Fast path:
 * a within-budget diff (or chunking disabled) is one call on the whole diff. Else
 * split into whole-file packages — grouping module-coupled files (parent + `#[path]`
 * child) into the SAME package — review each in its own call (warm-up first, then
 * ≤ CHUNK_CONCURRENCY at a time), retry or bisect the ones that failed, and merge
 * into one {@link ProviderResult} so everything downstream is unchanged. A package
 * whose single file overflows the budget carries the file's FULL content as
 * read-only context, so the model never judges a construct (multi-line raw string,
 * long function) from a truncated view.
 */
export async function reviewChunked(opts: ChunkedReviewOptions): Promise<ProviderResult> {
  const { diff, maxChunkLines, maxChunks, mechanical } = opts;

  // Fast path: chunking disabled or the whole diff fits — preserve today's behavior.
  if (maxChunkLines <= 0 || countLines(diff.diff) <= maxChunkLines) return reviewWhole(opts);

  const groups = (opts.groupSegments ?? groupRelatedSegments)(splitDiffByFile(diff.diff));
  const { chunks, dropped } = packGroups(groups, maxChunkLines, maxChunks);
  // Degenerate (e.g. nothing parsed) — fall back to the whole diff rather than skip.
  if (chunks.length === 0) return reviewWhole(opts);

  const partitions = partitionMechanical(mechanical, chunks);
  const ctx = packageContext(opts);
  const runPackage = async (i: number): Promise<ProviderResult[]> => {
    const chunk = chunks[i] ?? [];
    // The wall clock is read before EVERY package: once it is past, the rest of the
    // run is ledgered pending (resumable) and costs zero calls.
    if (deadlinePassed(opts.wallDeadline)) {
      reportCoverage(opts.onCoverage, chunk, { status: "pending" });
      return [];
    }
    return reviewPackage(ctx, chunk, partitions[i] ?? [], 0);
  };

  // Warm-up: the first package is issued ALONE so its shared prompt prefix is in the
  // provider's cache before the rest fan out. Best-effort — correctness never depends
  // on the cache, only the call ORDER changes. A SINGLE-package run takes this same
  // path and costs nothing extra: chunks[0] always exists (the empty case returned at
  // the guard above), and the fan-out below is over an empty index list — one call, no
  // concurrency.
  const first = await runPackage(0);
  const rest = await mapWithConcurrency(
    chunks.map((_chunk, i) => i).slice(1),
    CHUNK_CONCURRENCY,
    (i) => runPackage(i),
  );

  // Spilled files were never attempted: loud per-path (ledger) AND in the comment.
  reportCoverage(opts.onCoverage, dropped, { status: "unreviewed", reason: "chunk-limit" });
  const merged = mergeResults([first, ...rest]);
  if (dropped.length > 0) {
    merged.other_checks = appendDroppedNotice(merged.other_checks, dropped, maxChunks);
  }
  return merged;
}

/** The whole diff in ONE call: the fast path and the degenerate fallback. Never
 *  bisected, never merged — byte-identical to the un-chunked review, including the
 *  absence of a retry. Its paths are ledgered from the single result. */
async function reviewWhole(opts: ChunkedReviewOptions): Promise<ProviderResult> {
  const paths = opts.diff.changed_files;
  if (deadlinePassed(opts.wallDeadline)) {
    for (const path of paths) opts.onCoverage(path, { status: "pending" });
    return mergeResults([]);
  }
  const result = await opts.review(opts.buildEnvelope(opts.diff, opts.mechanical, opts.brief));
  const status = result.verdict === "error" ? "unreviewed" : "reviewed";
  for (const path of paths) opts.onCoverage(path, { status });
  return result;
}

/** Bind the per-package seams (envelope build over a sub-diff, review call, coverage
 *  sink, deadline) that review/bisect.ts drives for a package and each of its halves. */
function packageContext(opts: ChunkedReviewOptions): PackageReviewContext {
  return {
    buildEnvelope: (segments, mech) =>
      opts.buildEnvelope(
        chunkDiffData(opts.diff, segments, opts.maxChunkLines, opts.readFile),
        mech,
        opts.brief,
      ),
    review: opts.review,
    onCoverage: opts.onCoverage,
    wallDeadline: opts.wallDeadline,
  };
}

/** A sub-DiffData scoped to one chunk: its files + diff, but the GLOBAL file count. */
function chunkDiffData(
  diff: DiffData,
  chunk: FileSegment[],
  maxChunkLines: number,
  readFile: ((path: string) => string | null) | undefined,
): DiffData {
  const totalLines = chunk.reduce((n, s) => n + s.lines, 0);
  const sub: DiffData = {
    ...diff,
    diff: chunk.map((s) => s.diff).join(""),
    changed_files: chunk.map((s) => s.path),
    total_lines: totalLines,
    // total_files stays global so the model knows it is seeing a slice; binary_files,
    // dropped_files, base_sha, and files are inherited (buildPrompt ignores files).
    truncated: false,
  };
  // Oversized chunk (a group too big to share a chunk rode alone): the diff alone
  // may cut through a construct, so attach each file's full post-change content.
  if (totalLines > maxChunkLines && readFile !== undefined) {
    const context = contextFilesFor(chunk, readFile);
    if (context.length > 0) sub.context_files = context;
  }
  return sub;
}

/** Full post-change content for a chunk's files: unreadable (deleted/binary) or
 *  over-ceiling files are skipped with a log line, never attached truncated. */
function contextFilesFor(
  chunk: FileSegment[],
  readFile: (path: string) => string | null,
): ContextFile[] {
  const out: ContextFile[] = [];
  for (const seg of chunk) {
    if (seg.path === "") continue;
    const content = readFile(seg.path);
    if (content === null) continue;
    if (countLines(content) > MAX_CONTEXT_FILE_LINES) {
      process.stderr.write(
        `  Note: ${seg.path} exceeds ${MAX_CONTEXT_FILE_LINES} lines; ` +
          "reviewing from the diff without full-file context\n",
      );
      continue;
    }
    out.push({ path: seg.path, content });
  }
  return out;
}

/** Map each mechanical finding to its file's chunk; orphans (no chunk) go to chunk[0]. */
function partitionMechanical(
  mechanical: MechanicalFinding[],
  chunks: FileSegment[][],
): MechanicalFinding[][] {
  const chunkOf = new Map<string, number>();
  chunks.forEach((chunk, i) => {
    for (const seg of chunk) chunkOf.set(seg.path, i);
  });
  const partitions: MechanicalFinding[][] = chunks.map(() => []);
  for (const finding of mechanical) {
    partitions[chunkOf.get(finding.path) ?? 0]?.push(finding);
  }
  return partitions;
}

/** Append a "files not reviewed (chunk limit reached)" note to the other-checks blurb. */
function appendDroppedNotice(
  otherChecks: string | undefined,
  dropped: FileSegment[],
  maxChunks: number,
): string {
  const names = dropped.map((s) => s.path).filter((p) => p !== "");
  const list = names.length > 0 ? `: ${names.join(", ")}` : "";
  const notice = `⚠️ ${dropped.length} file(s) were not reviewed — chunk limit (MAX_CHUNKS=${maxChunks}) reached${list}.`;
  return otherChecks !== undefined && otherChecks !== "" ? `${otherChecks}\n\n${notice}` : notice;
}
