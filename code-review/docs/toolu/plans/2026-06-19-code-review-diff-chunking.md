# Code Review — Diff Chunking — Plan

**Date:** 2026-06-19   **Status:** Approved   **Spec:** docs/toolu/specs/2026-06-19-code-review-diff-chunking-design.md   **Topic:** Chunk large diffs into per-call slices, merge results, so the LLM review survives big PRs

## Context

On a very large PR the single `generateObject` call returns unparseable output → `verdict:"error"`, losing LLM judgment exactly where it matters. Fix: split the shaped diff per file, pack whole files into line-bounded chunks, review each chunk in its own call (bounded concurrency), and merge into one `ProviderResult` before the existing validate → verdict → recap → render flow. Normal PRs (diff ≤ budget) keep the current single-call path, byte-identical.

## Approach

Two pure new modules + one pure helper + a surgical pipeline rewire. Reuse: `countLines`/`truncateAtHunkBoundary` (`src/git/diff.ts`), `buildPrompt` (`src/prompt.ts`), `reviewWithModel`+`ProviderResult` (`src/llm/openrouter.ts`), `validateFindings` (`src/review/validate.ts`), `gatherMechanical` (`src/mechanical/gather.ts`), `formatVerdict` (`src/review/verdict.ts` — renders `errorDetail` independent of verdict, so partial-failure notices survive). Chunking engages only when `MAX_CHUNK_LINES > 0 && countLines(diff.diff) > MAX_CHUNK_LINES`; else the existing path runs untouched. Tests: real git diffs + recorded OpenRouter responses via injected `fetch`, NO mocks.

## Steps / workstreams

1. **`src/git/chunk.ts`** — `FileSegment`, `splitDiffByFile` (split at `diff --git`, path parsed from the `diff --git a/… b/…` line — handles `/dev/null` deletions + C-quoted paths; round-trip: `segments.map(s=>s.diff).join("")===input`), `PackResult`, `packChunks` (path-sorted whole-file greedy pack ≤ `maxLines`; lone file > budget = own chunk; spill > `maxChunks` into `dropped`). Doc line per export. Tests in `src/git/__tests__/chunk.test.ts` with a real multi-file diff fixture: round-trip identity, deletion/`dev/null` path, whole-file (no file in two chunks), path grouping, oversized lone file, `maxChunks` spill. Size: keep < 300 lines.
2. **`src/llm/merge.ts`** — `mergeResults(results: ProviderResult[])`: concat findings in **input (chunk-index) order**; verdict any-`changes`→changes / all-non-error-`approved`→approved / all-error→error; partial failure keeps successes + sets `error:"M/N chunks failed"` (carries first error's `finishReason`); `top_must_fix` capped union; `review_plan`/`other_checks` concat; `mergeResults([])`→error result. Doc line. Tests `src/llm/__tests__/merge.test.ts`: verdict matrix, order, partial-failure, empty.
3. **`src/concurrency.ts`** — `mapWithConcurrency<T,R>(items, limit, fn)`: runs ≤ `limit` in flight, **returns results in input order** regardless of completion. Doc line. Test `src/__tests__/concurrency.test.ts`: order preserved under staggered async resolution; concurrency cap respected.
4. **Inputs + `action.yml`** — add `MAX_CHUNK_LINES` (default `1500`) and `MAX_CHUNKS` (default `20`, protective — see open Q) to `ActionInputs` (`maxChunkLines`, `maxChunks` via `intInput`), `action.yml` inputs (with descriptions) + the `env:` `INPUT_MAX_CHUNK_LINES`/`INPUT_MAX_CHUNKS` mapping. Refresh the stale MAX_DIFF_LINES note at `inputs.ts:86-87` to point at chunking.
5. **`src/pipeline.ts` rewire** (replace ~166-184 only) — guard fast path; else: `splitDiffByFile(diff.diff)` → `packChunks` → partition `mechanical` by file path (orphans → `chunk[0]`) → build a sub-`DiffData` + envelope per chunk → `mapWithConcurrency(chunks, CHUNK_CONCURRENCY=4, reviewWithModel)` → `mergeResults` → validate merged findings ONCE vs global `changedLinesByPath`. Emit a distinct dropped-files notice (NOT the `truncated` flag) when `dropped.length>0`. Integration tests `src/__tests__/pipeline.chunking.test.ts` with recorded OpenRouter fixtures: fast path = 1 call/identical envelope; multi-chunk (≥2 calls, findings merged); partial failure (1 chunk error → successes posted + "1/2 chunks failed"); mechanical partition (chunk prompt holds only its files' mechanicals); single-file-over-budget degrades; `MAX_CHUNKS` spill notice. Confirm `render.ts` surfaces `errorDetail` on a non-error verdict (add assertion if missing).
6. **Docs sync** — `README.md` (document `MAX_CHUNK_LINES` + `MAX_CHUNKS`, large-PR behavior), `CHANGELOG.md` entry. `action.yml` descriptions land in step 4.
7. **dist + full gate** — `bun run build` (esbuild → `dist/`), verify committed dist in sync, run the full quality gate green.

## Critical files

- Create: `code-review/src/git/chunk.ts`, `code-review/src/llm/merge.ts`, `code-review/src/concurrency.ts`, tests `code-review/src/git/__tests__/chunk.test.ts`, `code-review/src/llm/__tests__/merge.test.ts`, `code-review/src/__tests__/concurrency.test.ts`, `code-review/src/__tests__/pipeline.chunking.test.ts`.
- Modify: `code-review/src/pipeline.ts`, `code-review/src/inputs.ts`, `code-review/action.yml`, `code-review/README.md`, `code-review/CHANGELOG.md`, `code-review/dist/*`.

## Verification

Per-step `check` below (exit 0 = green). End-to-end: full gate `cd code-review && bun run check` (typecheck + lint + fmt + all tests) + `bun run build` with `dist/` in sync. Real-data path exercised by `pipeline.chunking.test.ts` driving a real multi-file diff through recorded OpenRouter responses.

## Steps (machine-readable)

```json
[
  {"id": "1-chunk-module", "title": "src/git/chunk.ts split+pack + tests (real diff fixture)", "check": "cd code-review && bun run test src/git/__tests__/chunk.test.ts && bun run typecheck"},
  {"id": "2-merge-module", "title": "src/llm/merge.ts mergeResults + tests (verdict matrix, order, partial-fail, empty)", "check": "cd code-review && bun run test src/llm/__tests__/merge.test.ts && bun run typecheck"},
  {"id": "3-concurrency", "title": "src/concurrency.ts order-preserving bounded map + test", "check": "cd code-review && bun run test src/__tests__/concurrency.test.ts && bun run typecheck"},
  {"id": "4-inputs-action", "title": "MAX_CHUNK_LINES/MAX_CHUNKS in inputs.ts + action.yml inputs/env", "check": "cd code-review && grep -q 'INPUT_MAX_CHUNK_LINES' action.yml && grep -q 'INPUT_MAX_CHUNKS' action.yml && bun run typecheck"},
  {"id": "5-pipeline-wire", "title": "pipeline.ts chunk loop (partition+orphans, bounded review, merge, dropped notice, validate once) + integration fixtures", "check": "cd code-review && bun run test && bun run typecheck"},
  {"id": "6-docs", "title": "README + action.yml document MAX_CHUNK_LINES/MAX_CHUNKS", "check": "cd code-review && grep -q 'MAX_CHUNK_LINES' README.md && grep -q 'MAX_CHUNK_LINES' action.yml"},
  {"id": "7-dist-gate", "title": "rebuild dist (reproducible), full quality gate green", "check": "cd code-review && bun run build && shasum dist/index.cjs > /tmp/dist-h1 && bun run build && shasum -c /tmp/dist-h1 && bun run check"}
]
```

## Deviations

- **Step 5 test location.** The chunking integration tests were appended to the existing `src/__tests__/pipeline.test.ts` (new `describe("runReview — chunked large diff")`) instead of a separate `pipeline.chunking.test.ts`, to reuse its proven `fakeOctokit`/`baseInputs`/`prContext`/`replayFetch` harness (avoids duplicating a fragile typed Octokit cast). Pure-logic tests live in the new `src/review/__tests__/chunked.test.ts`. Net coverage matches the plan.
- **Dropped-files notice surface.** No comment renderer exists for skipped files, so the `MAX_CHUNKS` notice is appended to the merged result's `other_checks` (renders as "Other checks") rather than a new field/section — lowest churn. `render.ts` already surfaces `errorDetail` independent of verdict (verified), so no render change was needed for partial-failure.
- **Extracted `reviewChunked`.** The chunk loop lives in `src/review/chunked.ts` (not inline in `pipeline.ts`) to keep the pipeline lean and the loop unit-testable; `pipeline.ts` calls it with `buildEnvelope`/`review` callbacks.
- **dist sync (step 7).** The plan's `git diff --exit-code -- dist` check required the rebuilt `dist/index.cjs` to be committed, which the no-commit-without-asking rule forbids mid-execution. Replaced with a reproducible-build check (build twice → identical sha) + full gate. The rebuilt `dist/index.cjs` is staged-but-uncommitted; it MUST be committed alongside the source change, and CI's own dist-sync gate enforces that at PR time.
- **No CHANGELOG hand-edit.** There is no `code-review/CHANGELOG.md`; the repo-root `CHANGELOG.md` is generated by release automation from conventional commits — editing it by hand would be overwritten. Docs sync = README + `action.yml` input descriptions; the changelog entry comes from the commit message at release. Step 6 check updated to README + action.yml.

## Open question carried from spec (owner: Falconiere)

`MAX_CHUNKS` default is set to **20** in this plan (protective: ~20 chunks ÷ concurrency 4 × 180s ≈ 15min worst case, under typical `timeout-minutes`; avoids the unbounded-runtime/stuck-review class). House convention elsewhere is `0`=unlimited — revisit after the first dogfood. `MAX_CHUNK_LINES=1500` likewise tunable.
