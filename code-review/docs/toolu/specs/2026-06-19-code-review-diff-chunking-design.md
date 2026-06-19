# Code Review — Diff Chunking — Design

**Date:** 2026-06-19   **Status:** Approved   **Author:** Falconiere Barbosa   **Topic:** Chunk the diff so the LLM review survives large PRs instead of abstaining

## Problem

On an exceptionally large PR (the ~6000-line dogfood on PR #44) the LLM review returns `error` with `No object generated: could not parse the response` — a single giant diff in one `generateObject` call produces unparseable structured output. This is a diff-size problem, not a model problem (gemini-2.5-flash has ~1M context; the diff fits — the failure is output-cap or the model degrading on a huge structured-output task). Today `MAX_DIFF_LINES` defaults to `0` (unlimited), so big PRs flow whole into one call and fail. The hybrid degrades to SAST-only, but the LLM judgment — the point of the action — is lost on exactly the PRs that most need a reviewer.

## Non-Goals

1. **Token-accurate budgeting.** Chunk by diff **line count**, not a tokenizer. Lines reuse existing plumbing (`countLines`) and are good enough.
2. **Cross-chunk finding detection.** A bug spanning files placed in different chunks will not be seen. Accepted loss (mitigated by path-grouped packing); the user chose full coverage over this.
3. **Synthesized global narrative.** `review_plan` / `other_checks` / `top_must_fix` are merged mechanically, NOT re-synthesized by an extra reduce-phase LLM call.
4. **Changing the normal-PR path.** A PR whose diff is ≤ the chunk budget takes exactly one model call, output byte-identical to today.
5. **Splitting one file's diff across chunks.** Whole-file packing only; a lone file larger than the budget rides as its own (oversized) chunk.
6. **Cross-chunk finding dedup.** Files never repeat across chunks, so no dedup needed.
7. **Per-model dynamic budget** derived from each model's context window. Static line budget for v1.

## Architecture

**Chosen: per-file chunking with a single merged result.** Split the shaped diff into per-file segments, greedily pack whole files (path-sorted) into chunks ≤ a line budget, run one `reviewWithModel` call per chunk (bounded concurrency), and merge the N `ProviderResult`s into one before the existing validate → verdict → recap → render flow. Downstream of `pipeline.ts:184` is untouched: it already consumes one `ProviderResult`, and the recap reads only `findings`.

**The trade-off that drove it:** full coverage vs cost/latency. The user chose never silently dropping files, accepting N× cost and the loss of cross-chunk findings. Truncation (cheaper, single call) was rejected for sacrificing tail coverage.

**Why split the diff string, not `ShapedFile[]`:** `ShapedFile` (`src/git/shape.ts`) carries only `{ path, changed_lines }` — no per-file diff text. The shaped diff is one concatenated string. So chunking splits that string at `diff --git` boundaries. `buildPrompt` (`src/prompt.ts:131`) reads `diff.diff` / `changed_files` / `binary_files` / `dropped_files` / `truncated` / `total_lines` / `total_files` — it never reads `diff.files` — so each chunk needs only a sub-`DiffData`-shaped object, not `ShapedFile`s.

**Fast path:** chunking engages only when `MAX_CHUNK_LINES > 0` AND `countLines(diff.diff) > MAX_CHUNK_LINES`. Otherwise the existing single-call path runs with the full `diff.diff` untouched — guaranteeing zero behavior change (and stable fixtures) for normal PRs.

**Reuse:** `countLines` / `truncateAtHunkBoundary` (`src/git/diff.ts`), `buildPrompt` (`src/prompt.ts`), `reviewWithModel` + `ProviderResult` (`src/llm/openrouter.ts`), `validateFindings` (`src/review/validate.ts`), `gatherMechanical` (`src/mechanical/gather.ts`). `MAX_DIFF_LINES` is unchanged — it remains a hard truncation ceiling applied **before** chunking.

**New modules (size-disciplined, < 300 lines each):**
- `src/git/chunk.ts` — `splitDiffByFile`, `packChunks` (pure; diff-text manipulation, sibling to `diff.ts`/`shape.ts`).
- `src/llm/merge.ts` — `mergeResults` (pure; combines `ProviderResult[]`).

**Pipeline change (`src/pipeline.ts`, replaces lines ~166-184 only):** when chunking engages, partition `mechanical` findings by file path, build one envelope per chunk (only that chunk's diff + its mechanicals), `reviewWithModel` each under bounded concurrency, `mergeResults`. Validate the merged findings once against the global `changedLinesByPath`.

**Mechanical partition + orphans:** each chunk's prompt gets only the mechanicals whose file is in that chunk. A mechanical finding whose file is in NO chunk (dropped-as-noise, binary, dropped by `MAX_CHUNKS`, or a path outside the text diff) is an **orphan** — attach all orphans to `chunk[0]` so they still get LLM triage (they remain in the comment's mechanical summary regardless).

**Partial-failure rendering (verified):** `formatVerdict` (`src/review/verdict.ts:89`) renders `errorDetail` from `result.error` **independently of `verdict`** — so a merged result with `verdict:"changes"` AND `error:"M/N chunks failed"` surfaces both the findings and the degrade notice. Contract: on partial failure set `error` to the failure summary while keeping the surviving verdict. Plan must confirm `render.ts` emits `errorDetail` on a non-error verdict.

**Ordering & determinism:** the bounded-concurrency pool may complete out of order; `mergeResults` MUST concatenate findings in **chunk index order** (path-sorted), never completion order, or fixtures are non-deterministic.

**Dropped-files notice:** do NOT reuse the `truncated` flag (it drives buildPrompt's "[Diff truncated at N lines]" message — misleading for the chunk cap). Emit a distinct notice, e.g. "[N files omitted — chunk limit (MAX_CHUNKS) reached; not reviewed]".

## Interfaces / Schema

```ts
// src/git/chunk.ts

/** One file's slice of the shaped diff. */
export interface FileSegment {
  path: string;   // parsed from the `diff --git a/<path> b/<path>` line (NOT `+++`:
                  // a deleted file's `+++` is `/dev/null`). `--no-renames` guarantees
                  // a == b. Handle git's C-quoted paths (non-ASCII / spaces): unquote.
  diff: string;   // the `diff --git …` block for exactly this file
  lines: number;  // countLines(diff)
}

/** Split a shaped diff into per-file segments at `diff --git ` boundaries.
 *  Invariant: joining all segments reproduces the input exactly (round-trip),
 *  so the single-chunk path is byte-identical to today. */
export function splitDiffByFile(shapedDiff: string): FileSegment[];

/** Result of packing: chunks to review + files dropped by the MAX_CHUNKS cap. */
export interface PackResult {
  chunks: FileSegment[][]; // each chunk's segments, in path-sorted order
  dropped: FileSegment[];  // files beyond maxChunks (0 = unlimited → never dropped)
}

/** Greedily pack whole-file segments (path-sorted to group dir-siblings) into
 *  chunks of ≤ maxLines. A lone file > maxLines becomes its own chunk. When
 *  maxChunks > 0, chunks beyond it spill into `dropped`. */
export function packChunks(
  segments: FileSegment[],
  maxLines: number,
  maxChunks: number,
): PackResult;
```

```ts
// src/llm/merge.ts
import type { ProviderResult } from "@/llm/openrouter.js";

/** Merge per-chunk results into one ProviderResult. Results MUST be passed in
 *  chunk-index order (path-sorted), NOT completion order — output is deterministic.
 *  - findings: concat in chunk order (files never repeat across chunks → no dedup)
 *  - verdict:  "changes" if ANY chunk is "changes"; "approved" iff ALL non-error
 *              chunks are "approved"; if EVERY chunk errored → "error"
 *  - PARTIAL FAILURE: ≥1 chunk succeeded + some errored → keep successes, never
 *    abstain the whole review; surface the failure in `error` ("M/N chunks failed")
 *  - top_must_fix: union, capped; review_plan/other_checks: concatenated
 *  - finishReason: carried from the first errored chunk (diagnostic)
 *  - mergeResults([]) → { verdict:"error", findings:[], error:"no chunks" }
 *    (defensive; the fast path means it is never reached in practice) */
export function mergeResults(results: ProviderResult[]): ProviderResult;
```

**New action inputs** (`action.yml` + `src/inputs.ts` `ActionInputs` + env mapping):

| Input | Default | Meaning |
| --- | --- | --- |
| `MAX_CHUNK_LINES` | `1500` | Per-chunk diff-line budget. Each LLM call gets ≤ this many lines (whole files). `0` = never chunk (single call, legacy). |
| `MAX_CHUNKS` | `0` | Max chunks (= max LLM calls) per review, cost cap. `0` = unlimited. `>0` drops tail files with a notice. |

`MAX_DIFF_LINES` (existing, default `0`): unchanged — hard truncation ceiling applied before chunking.

**Internal constant:** `CHUNK_CONCURRENCY = 4` (`src/pipeline.ts` or `src/llm/`), bounding parallel `reviewWithModel` calls.

**Per-chunk sub-`DiffData`** fed to `buildPrompt`: `diff` = chunk segments joined; `changed_files` = chunk file paths; `total_files` = **global** total (model sees it's a slice — the "(N total)" header may exceed the listed files; acceptable); `binary_files`/`dropped_files` = global; `total_lines` = chunk lines; `truncated` = false (left untouched — the chunk-cap uses a SEPARATE dropped notice, see above); `mechanicalFindings` = only those whose file is in this chunk (+ orphans on `chunk[0]`).

## Acceptance criteria

Tested against real recorded OpenRouter fixtures and real git diffs (NO mocks).

1. **Fast path unchanged.** A real diff with `countLines ≤ MAX_CHUNK_LINES` produces exactly one `reviewWithModel` call and an envelope identical to pre-chunking (no split).
2. **Round-trip identity.** For a real multi-file shaped diff, `splitDiffByFile(d).map(s => s.diff).join("")` reproduces `d` exactly.
3. **Whole-file chunks.** A real diff > `MAX_CHUNK_LINES` packs into ≥2 chunks; no file appears in two chunks; every chunk ≤ `MAX_CHUNK_LINES` except a lone file that alone exceeds it (which is its own chunk).
4. **Path grouping.** `packChunks` emits files in path-sorted order so directory siblings land adjacent.
5. **Verdict reconcile.** `mergeResults`: any chunk `changes` → `changes`; all non-error `approved` → `approved`; all errored → `error`. Findings = concat; `top_must_fix` = capped union.
6. **Partial-failure degrade.** Real fixture, 2 chunks where one returns `verdict:"error"`: the merged review posts the successful chunk's findings, sets `error` to "1/2 chunks failed", and verdict reflects the surviving chunk — it does NOT abstain the whole review.
7. **Cost cap.** With `MAX_CHUNKS=N` and a diff needing >N chunks, exactly N `reviewWithModel` calls fire, tail files land in `dropped`, and the comment carries a "files omitted — chunk limit reached" notice.
8. **Mechanical partition.** Each chunk's `envelope.user` contains mechanical findings only for files in that chunk (verified by inspecting the rendered prompt).
9. **Validation once.** Merged findings are validated a single time against the global `changedLinesByPath`; a finding on a line not in the diff is stripped.
10. **Single oversized file degrades.** A real PR with one file alone > `MAX_CHUNK_LINES` (the original failure shape) packs it into its own chunk; if that chunk errors, the review still posts the other chunks' findings + "M/N chunks failed" — never a hard job failure.
11. **Docs in sync.** `README.md` and `action.yml` document `MAX_CHUNK_LINES` + `MAX_CHUNKS`; `CHANGELOG.md` has an entry. (User-facing config surface changed.)

## Open Questions

1. **`MAX_CHUNK_LINES` default** — 1500 proposed; tune after a dogfood (higher = fewer calls/cost, larger per-call risk). Owner: Falconiere.
2. **`MAX_CHUNKS` default** — `0`=unlimited (house convention, matches `MAX_FILES`/`MAX_DIFF_LINES`) vs a protective non-zero. Runtime caveat: `0` × many chunks × `CHUNK_CONCURRENCY=4` × 180s/call → unbounded wall-clock that can hit the job's `timeout-minutes`. Lean toward a finite default. Owner: Falconiere.
3. **`CHUNK_CONCURRENCY`** — 4 proposed; confirm against OpenRouter rate limits on a real multi-chunk run. Owner: Falconiere.
4. **Confirm `finish_reason`** from a real large-PR dogfood (`length` = output-cap vs parse-fail). Design is robust to both; this validates the lever. Owner: Falconiere.
5. **Lone file > budget** — accept oversized own-chunk (degrade covers a failure) for v1, vs splitting at a hunk boundary. Accept proposed. Owner: Falconiere.
