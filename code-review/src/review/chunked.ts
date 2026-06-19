// review/chunked.ts — drive the model review over one or many diff chunks.
//
// A diff within the per-chunk budget is reviewed in ONE call (today's behavior,
// byte-identical). A diff over budget is split into whole-file chunks, each
// reviewed in its own call (≤ CHUNK_CONCURRENCY at once) and merged — so a large
// PR no longer overwhelms a single structured-output call and abstains. Mechanical
// (SAST) findings are partitioned to the chunk holding their file; orphans ride
// with chunk[0]. Files dropped by the MAX_CHUNKS cap are noted in the comment.
import { splitDiffByFile, packChunks } from "@/git/chunk.js";
import type { FileSegment } from "@/git/chunk.js";
import { countLines } from "@/git/diff.js";
import type { DiffData } from "@/git/diff.js";
import { mapWithConcurrency } from "@/concurrency.js";
import { mergeResults } from "@/llm/merge.js";
import type { ProviderResult } from "@/llm/openrouter.js";
import type { Envelope } from "@/prompt.js";
import type { MechanicalFinding } from "@/mechanical/sarif.js";

/** Max model calls in flight at once — an OpenRouter rate-limit guard. */
export const CHUNK_CONCURRENCY = 4;

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
}

/**
 * Review the diff, chunking it when it exceeds the per-chunk budget. Fast path:
 * a within-budget diff (or chunking disabled) is one call on the whole diff. Else
 * split into whole-file chunks, review each in its own call, and merge into one
 * {@link ProviderResult} so everything downstream is unchanged.
 */
export async function reviewChunked(opts: ChunkedReviewOptions): Promise<ProviderResult> {
  const { diff, maxChunkLines, maxChunks, mechanical, buildEnvelope, review } = opts;

  // Fast path: chunking disabled or the whole diff fits — preserve today's behavior.
  if (maxChunkLines <= 0 || countLines(diff.diff) <= maxChunkLines) {
    return review(buildEnvelope(diff, mechanical));
  }

  const { chunks, dropped } = packChunks(splitDiffByFile(diff.diff), maxChunkLines, maxChunks);
  // Degenerate (e.g. nothing parsed) — fall back to the whole diff rather than skip.
  if (chunks.length === 0) return review(buildEnvelope(diff, mechanical));

  const partitions = partitionMechanical(mechanical, chunks);
  const results = await mapWithConcurrency(chunks, CHUNK_CONCURRENCY, (chunk, i) =>
    review(buildEnvelope(chunkDiffData(diff, chunk), partitions[i] ?? [])),
  );

  const merged = mergeResults(results);
  if (dropped.length > 0) {
    merged.other_checks = appendDroppedNotice(merged.other_checks, dropped, maxChunks);
  }
  return merged;
}

/** A sub-DiffData scoped to one chunk: its files + diff, but the GLOBAL file count. */
function chunkDiffData(diff: DiffData, chunk: FileSegment[]): DiffData {
  return {
    ...diff,
    diff: chunk.map((s) => s.diff).join(""),
    changed_files: chunk.map((s) => s.path),
    total_lines: chunk.reduce((n, s) => n + s.lines, 0),
    // total_files stays global so the model knows it is seeing a slice; binary_files,
    // dropped_files, base_sha, and files are inherited (buildPrompt ignores files).
    truncated: false,
  };
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
