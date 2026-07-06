// review/chunked.ts — drive the model review over one or many diff chunks.
//
// A diff within the per-chunk budget is reviewed in ONE call (today's behavior,
// byte-identical). A diff over budget is split into whole-file chunks, each
// reviewed in its own call (≤ CHUNK_CONCURRENCY at once) and merged — so a large
// PR no longer overwhelms a single structured-output call and abstains. Mechanical
// (SAST) findings are partitioned to the chunk holding their file; orphans ride
// with chunk[0]. Files dropped by the MAX_CHUNKS cap are noted in the comment.
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
  /** Max chunks (= model calls); files beyond spill out and are noted. 0 = unlimited. */
  maxChunks: number;
  /** Deterministic SAST findings, partitioned per chunk by file path. */
  mechanical: MechanicalFinding[];
  /** Build the prompt for one chunk's sub-diff + that chunk's mechanical findings. */
  buildEnvelope: (subDiff: DiffData, mechanical: MechanicalFinding[]) => Envelope;
  /** Run one model review of a built envelope (never throws — it abstains). */
  review: (envelope: Envelope) => Promise<ProviderResult>;
  /** Read a file's full post-change content (git show <head>:<path>), or null when
   *  unreadable (deleted/binary). Powers the oversized-chunk full-file context. */
  readFile?: (path: string) => string | null;
}

/**
 * Review the diff, chunking it when it exceeds the per-chunk budget. Fast path:
 * a within-budget diff (or chunking disabled) is one call on the whole diff. Else
 * split into whole-file chunks — grouping module-coupled files (parent + `#[path]`
 * child) into the SAME chunk — review each in its own call, retry any chunk whose
 * call abstained, and merge into one {@link ProviderResult} so everything
 * downstream is unchanged. A chunk whose single file overflows the budget carries
 * the file's FULL content as read-only context, so the model never judges a
 * construct (multi-line raw string, long function) from a truncated view.
 */
export async function reviewChunked(opts: ChunkedReviewOptions): Promise<ProviderResult> {
  const { diff, maxChunkLines, maxChunks, mechanical, buildEnvelope, review } = opts;

  // Fast path: chunking disabled or the whole diff fits — preserve today's behavior.
  if (maxChunkLines <= 0 || countLines(diff.diff) <= maxChunkLines) {
    return review(buildEnvelope(diff, mechanical));
  }

  const groups = groupRelatedSegments(splitDiffByFile(diff.diff));
  const { chunks, dropped } = packGroups(groups, maxChunkLines, maxChunks);
  // Degenerate (e.g. nothing parsed) — fall back to the whole diff rather than skip.
  if (chunks.length === 0) return review(buildEnvelope(diff, mechanical));

  const partitions = partitionMechanical(mechanical, chunks);
  const envelopeFor = (i: number): Envelope => {
    const chunk = chunks[i] ?? [];
    return buildEnvelope(
      chunkDiffData(diff, chunk, maxChunkLines, opts.readFile),
      partitions[i] ?? [],
    );
  };
  const results = await mapWithConcurrency(chunks, CHUNK_CONCURRENCY, (_chunk, i) =>
    review(envelopeFor(i)),
  );

  // Retry each abstained chunk ONCE with a fresh call: the dominant abstain cause
  // (structured output not matching the schema) is provider-side nondeterminism, so
  // a clean retry usually lands. Chunks that fail again stay "error" and merge marks
  // the review partial — never a confident verdict over unreviewed files.
  const failed = results.flatMap((r, i) => (r.verdict === "error" ? [i] : []));
  if (failed.length > 0) {
    const retried = await mapWithConcurrency(failed, CHUNK_CONCURRENCY, (i) =>
      review(envelopeFor(i)),
    );
    retried.forEach((r, k) => {
      const i = failed[k];
      if (i !== undefined && r.verdict !== "error") results[i] = r;
    });
  }

  const merged = mergeResults(results);
  if (dropped.length > 0) {
    merged.other_checks = appendDroppedNotice(merged.other_checks, dropped, maxChunks);
  }
  return merged;
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
