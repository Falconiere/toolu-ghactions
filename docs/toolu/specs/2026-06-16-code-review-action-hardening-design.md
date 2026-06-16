# Code Review Action — Hardening, API Fixes & Quality Re-Architecture — Design

**Date:** 2026-06-16   **Status:** Draft   **Author:** Falconiere   **Topic:** One PR that (a) fixes false published claims + infra, (b) hardens the runtime, (c) fixes OpenRouter API usage bugs, (d) switches the default model to `minimax/minimax-m3`, and (e) re-architects the review pipeline to production-grade quality (parallel per-dimension sub-reviewers → deterministic finding validation → coordinator filter).

## Problem

The published `code-review` action makes claims its repo doesn't back (a `tests.yml` badge with no workflow → bats never runs in CI; an MIT badge with no `LICENSE`; dev commands globbing a non-existent `actions/` dir). At runtime it can hang (no curl timeouts), fails on a single transient OpenRouter blip (no retry), reports zero diagnostics (`2>/dev/null` everywhere), and can leak a token to CI logs (raw error body on stderr). It misuses the OpenRouter API: **no `max_tokens`** (OpenRouter then reserves the model's *full* max output against the credit budget — a large cost bug), no provider-capability routing (a model that lacks `response_format` returns an API error, not graceful fallback), and no model fallback. Review *quality* is limited by a single-call design: one prompt does plan+review together, findings aren't confidence-gated or validated against the diff (hallucinated line numbers post as-is), large diffs are truncated lexicographically (drops arbitrary files silently), and there are no negative constraints to suppress "consider improving error handling" noise. All of this ships in **one PR** (user decision, accepted with the warning that the diff is large and review-heavy).

## Non-Goals

1. **No second action.** Only the `code-review` action + repo-root infra. No `claude-mention` etc.
2. **No AST/LSP symbol mapping.** Line anchoring is done by deterministic diff-range validation, not a tree-sitter/LSP layer (explicitly deferred — too large even for this PR).
3. **No dismissed-comment embedding / history store.** No persistent storage of prior rejected findings (the Ellipsis pattern). Deferred.
4. **No multi-model consensus.** A finding is not cross-checked by a second model; the coordinator filter is the precision mechanism.
5. **No prompt/checklist *methodology* change.** The 7 review dimensions stay; they are split across sub-reviewers, not redefined.
6. **No `RELEASE_PLEASE_TOKEN` secret creation.** Code references it; creating it is a documented repo-admin step.
7. **No streaming.** Requests stay non-streaming (simpler error handling; required for OpenRouter "Response Healing").

## Architecture

One branch. The driving trade-off the user chose: **maximum review quality in a single PR vs. small reviewable diff** — quality won; we mitigate with disciplined commit ordering (gate first) and strict file-size discipline (every new script ≤ 300 non-comment lines, one responsibility each).

### Pipeline: before → after

**Before:** `fetch-diff → build-prompt → call-openrouter (1 call) → parse-response → format-verdict → post-comment`. One prompt asks for plan + findings together.

**After:** fan-out / gather / filter:

```
fetch-diff (strip noise, per-file hunks, line-primed, budget chunking)
        │
        ▼
main.sh orchestrator — fan out one sub-reviewer per dimension (parallel bash jobs)
        │  each: build-prompt(dimension) → call-openrouter → parse-response
        ▼
validate-findings (deterministic: drop findings whose path:line isn't in the diff)
        │
        ▼
coordinate-findings (1 LLM call: dedup + reasonableness filter + verdict + top_must_fix + review_plan)
        │
        ▼
format-verdict → post-comment
```

Sub-reviewer fan-out uses bash background jobs (`&` + `wait`), each writing its result JSON to a file in a per-run `mktemp -d`; the orchestrator aggregates after `wait`. Concurrency ≤ number of active dimensions (≤7), so no pool/throttle needed. `REVIEW_MODE=single` keeps the legacy one-call path for cost-sensitive users (opt-out); default is `parallel`.

### Reuse

- `build-prompt.sh:97` already emits the request body via `jq -nc --arg` — this safe-JSON pattern is copied to every other JSON-emitting site (`fetch-diff.sh`, `parse-response.sh`, `call-openrouter.sh` error paths).
- The 7 dimensions in `prompts/review-checklist.txt` become the source of the per-dimension sub-reviewer prompts (one shared `prompts/dimension-base.txt` with negative constraints + per-dimension focus appended).
- `format-verdict.sh` rendering stays; only inputs (confidence/category) extend.

### New files (each one responsibility, named after its export)

| File | Responsibility |
|---|---|
| `code-review/src/validate-findings.sh` | Deterministic: drop findings whose `path:line` is not inside a changed hunk in the diff. No LLM. |
| `code-review/src/coordinate-findings.sh` | Build + call the coordinator LLM request; dedup/filter/verdict over the validated finding union. |
| `code-review/prompts/dimension-base.txt` | Shared sub-reviewer system prompt: negative constraints, confidence rule, output schema, verbatim-quote requirement. |
| `code-review/prompts/coordinator.txt` | Coordinator system prompt: dedup, reasonableness, verdict, review_plan, top_must_fix. |
| `.github/workflows/tests.yml` | CI: bats test job + shellcheck/action-validator lint job. |
| `LICENSE`, `CONTRIBUTING.md`, `.github/CODEOWNERS` | Infra/hygiene. |

`fetch-diff.sh` grows (noise strip + per-file hunk chunking); if it exceeds the 300-line ceiling, split the diff-shaping logic into `code-review/src/shape-diff.sh`.

## Interfaces / Schema

### action.yml — inputs (additions/changes)
- `MODEL` default → `'minimax/minimax-m3'`.
- `FALLBACK_MODEL` (optional, default `'anthropic/claude-sonnet-4-5'`): second entry in the OpenRouter `models` array.
- `MAX_TOKENS` (optional, default `'4096'`): sent on every request — fixes the budget-reservation bug.
- `REVIEW_MODE` (optional, `parallel`|`single`, default `parallel`).
- `MIN_CONFIDENCE` (optional, `high`|`medium`, default `high`): findings below this are dropped unless `severity` is `blocker`/`high`.
- `ENFORCE_JSON_SCHEMA` (optional, default `true`): when set, requests include `response_format` + `provider:{require_parameters:true}`; when `false`, free-text + regex fallback.
- README inputs table: `OPENROUTER_API_KEY` shown as required-via-`with`-or-`env` (footnote), matching `action.yml`'s `required:false`.
- `outputs.verdict.description` adds `skip`.

### fetch-diff.sh — output JSON (extended)
```json
{
  "files": [
    {"path":"src/x.ts","change_type":"modified","hunks":[{"header":"@@ -1,4 +1,6 @@","new_start":1,"lines":["L1:  ctx","L2: +added"]}],"changed_lines":[2,3]}
  ],
  "diff": "<line-primed unified diff, text files only>",
  "changed_files": ["src/x.ts"],
  "binary_files": [],
  "dropped_files": [{"path":"bun.lock","reason":"lockfile"}],
  "total_files": 1, "total_lines": 42, "truncated": false
}
```
- **Noise strip:** drop `*.lock`, `*-lock.json`, `*.min.js`, `*.min.css`, `*.map`, files with a `@generated`/`DO NOT EDIT` marker → listed under `dropped_files`, excluded from `diff`.
- **Binary detection:** via `git diff --numstat` (`-\t-\t<path>` ⇒ binary) — removes the fragile `--stat` regex.
- **Line priming:** each kept diff line prefixed with its new-file absolute line number (derived from the `@@` header), so the model cites real numbers. `changed_lines` records the valid line set per file for validation.
- **Chunking (replaces lexicographic truncate):** allocate the `MAX_DIFF_LINES` budget per file proportional to its change size; chunk at hunk boundaries; header-preserving truncation (keep `@@` headers + earlier hunks, drop tail of the largest hunk). `truncated:true` + a notice when budget is hit.
- All error JSON via `jq -nc --arg` (branch names with `"` stay valid).

### build-prompt.sh — per-dimension
- New env `INPUT_DIMENSION` (e.g. `correctness`): builds the system prompt from `dimension-base.txt` + that dimension's focus block. In `single` mode (`INPUT_DIMENSION` unset) it builds the legacy all-dimensions prompt.
- `MODEL` default `minimax/minimax-m3`; always sets `max_tokens`, `temperature:0.1`.
- Request body adds, when `ENFORCE_JSON_SCHEMA != false`: `response_format` (json_schema, `strict:true`) and `provider:{require_parameters:true, allow_fallbacks:true}`; always sets top-level `"models":[MODEL, FALLBACK_MODEL]`.
- Per-finding schema gains `confidence` (`high`|`medium`) and `category`; a `reasoning` string field is first/required so the model reasons before findings (mitigates JSON-mode reasoning degradation). System prompt carries negative constraints: no style/naming, no general advice, no findings on code outside the diff, "only HIGH-confidence; if in doubt omit", verbatim line quote required, output "none" when empty.

### call-openrouter.sh — hardening + fallback
- Body written to `mktemp`; `curl --data-binary @file` (ARG_MAX). `trap 'rm -f ...' EXIT`; drop dead `TMP_HTTP_CODE`.
- `--connect-timeout 15 --max-time "$TIMEOUT_SEC"` on every call.
- Retry (3 attempts, `BACKOFF_BASE`×attempt; env default `5`, tests set `0`) on `429`, `503`, other `5xx`, `000`. Respect a `Retry-After` header when present. No retry on `400/401/402/403/408`.
- **HTTP-200-with-embedded-error:** on 200, after JSON-validating, check `.error` in the body and treat as a (retryable if rate/context) failure — OpenRouter returns upstream model failures as 200.
- `*)` error branch: emit at most the first 200 chars of the body (`($body|.[0:200])` via jq) — never the raw full body (secret-leak fix).

### parse-response.sh — per sub-reviewer
- Parses one sub-reviewer's response into `{dimension, findings:[{path,line,severity,category,confidence,quoted_line,text}], reasoning}`.
- Invalid-verdict / error JSON via `jq -nc --arg` (no raw interpolation).
- Regex fallback retained for `ENFORCE_JSON_SCHEMA=false`, extended to tolerate a leading `reasoning`/`<thinking>` block.

### validate-findings.sh (new, deterministic)
- Stdin: `{files:[...], findings:[...]}`. For each finding: keep only if `path ∈ changed_files` **and** `line ∈ that file's changed_lines` (±0). Optionally verify `quoted_line` matches the diff line (±2). Drop failures; emit a stderr count of dropped/hallucinated findings (diagnostic, not silent).
- Also applies `MIN_CONFIDENCE` gating here.

### coordinate-findings.sh (new, 1 LLM call)
- Stdin: validated finding union (all dimensions). Builds a coordinator request (`coordinator.txt` system prompt) → `call-openrouter.sh`. Output: final `{review_plan, verdict, findings[], other_checks, top_must_fix[]}` (same shape `format-verdict.sh` already consumes) — dedup'd, reasonableness-filtered, verdict + top_must_fix chosen. Uses the same `max_tokens`/schema/provider settings.

### main.sh — orchestrator
- `parallel` mode: for each active dimension, run `build-prompt → call-openrouter → parse-response` as a background job writing `$TMPDIR/<dimension>.json`; `wait`; aggregate; `validate-findings`; `coordinate-findings`; `format-verdict`; `post-comment`.
- Remove `2>/dev/null` from child invocations; capture child stderr into the `fail()` message.
- `single` mode preserves the current linear path.

### post-comment.sh — hardening
- `--connect-timeout 10 --max-time 30` on all three curls; bodies via `--data @tmpfile`.
- Pagination collects matching comment IDs across **all** pages, then `sort_by(.created_at)|last` globally.

### parse-verdict.sh / Dockerfile / release
- `parse-verdict.sh`: `set -euo pipefail`.
- `Dockerfile`: `FROM alpine:3.21@sha256:<digest>` (digest resolved at build, committed literal).
- `release.yml`: `token: ${{ secrets.RELEASE_PLEASE_TOKEN }}` on the release-please step (+ comment on the fallback consequence); error-handle the `git push --force` alias move.
- `release-please-config.json`: drop the redundant top-level `release-type`.

## Acceptance criteria

Tests are bats over **real recorded fixtures** (real OpenRouter JSON responses captured per dimension + a real coordinator response; real git repos built in `setup()`). The `curl` binary is replaced by a boundary double that replays fixtures and logs its args — a network stub, not fabricated data.

1. **CI gate.** `tests.yml` runs `bats code-review/__tests__/*.bats` (all pass) + lint (`shellcheck` clean, `action-validator` passes); README badge resolves.
2. **LICENSE + docs.** `git ls-files` includes `LICENSE`; README dev commands reference `code-review/...` paths (no `actions/*` remains).
3. **Model + cost fixes.** `minimax/minimax-m3` is the default in `action.yml`/`build-prompt.sh`/README; every recorded request includes `max_tokens` and a top-level `models` array `[primary, fallback]`.
4. **Provider routing.** With `ENFORCE_JSON_SCHEMA=true`, requests include `response_format` + `provider.require_parameters=true`; with `false`, neither, and the regex fallback path parses a real free-text fixture.
5. **Curl resilience.** Every recorded OpenRouter + GitHub call carries `--max-time` and a connect timeout. A `429`-then-`200` fixture with `BACKOFF_BASE=0` retries and exits 0; three `500`s exit non-zero after 3 attempts; `401` exits 1 after one attempt; a `200` body containing `{"error":{"code":"rate_limit"}}` is treated as a failure.
6. **No secret leak.** A `500` body containing `Bearer sk-test-LEAK` → stderr contains ≤200 chars and not the full token.
7. **Diagnostics.** A forced child failure surfaces the child's stderr in `main.sh`'s `fail()` output.
8. **Parallel fan-out.** In `parallel` mode against per-dimension fixtures, the orchestrator produces one finding set per active dimension and aggregates them; `single` mode still works against the legacy fixture.
9. **Finding validation.** A fixture finding citing `src/x.ts:999` (not in the diff) is dropped by `validate-findings.sh` with a stderr count; a finding on a real changed line is kept.
10. **Confidence gate.** With `MIN_CONFIDENCE=high`, a `confidence:medium severity:low` fixture finding is dropped; a `medium`+`blocker` one is kept.
11. **Coordinator filter.** Given duplicate findings across two dimension fixtures, the coordinator output contains one deduped finding and a non-empty `review_plan`/`top_must_fix`.
12. **Noise strip + chunking.** `fetch-diff.sh` on a real commit touching `bun.lock` + a source file lists the lockfile under `dropped_files` and excludes it from `diff`; a >`MAX_DIFF_LINES` real diff truncates at a hunk boundary with `truncated:true` (not mid-line).
13. **Binary + JSON robustness.** A real binary-adding commit lists it under `binary_files`; `fetch-diff.sh` with a `"`-containing `BASE_BRANCH` emits valid JSON; `parse-response.sh` on a `"`-containing verdict emits valid JSON.
14. **Build + Docker.** `docker build -f code-review/Dockerfile -t code-review-action:test .` succeeds with the digest-pinned base.
15. **Docs in sync.** README (inputs, outputs incl. `skip`, dev section, model, new `parallel`/coordinator behavior + cost note), `action.yml` descriptions, `CONTRIBUTING.md`, and the changelog (via conventional commits) all reflect the change in this PR.

## Inline review comments & suggestions (added 2026-06-16)

**Requirement:** beyond the summary issue-comment, post per-line review comments anchored to the changed file/line, and attach committable code suggestions when the model has a concrete fix.

**Decisions:** (a) **curl** against the GitHub Reviews API — no `gh` dependency (keeps the alpine image small; curl is already hardened). (b) Review `event` is always **`COMMENT`** (advisory; never hard-blocks merge — `pr-babysit` + the `agent-merge-*` label remain the merge authority). (c) Suggestions attach when the model is **HIGH-confidence AND the cited line is in the diff**; otherwise a plain inline comment.

**Mechanism:** `POST /repos/{repo}/pulls/{pr}/reviews` with `{ commit_id: <head sha>, event: "COMMENT", body: <short summary>, comments: [{path, line, side:"RIGHT", body}] }`. A suggestion is a fenced ` ```suggestion ` block in the comment body holding the replacement for `line`..`end_line`. The summary issue-comment (existing `post-comment.sh`) is unchanged and still posts.

**New file:** `code-review/src/post-review.sh` — reads final findings + head SHA (`.pull_request.head.sha` from `GITHUB_EVENT_PATH`) + PR number; emits anchored comments; **only includes a comment whose `line ∈ changed_lines`** (a line not in the diff makes the whole reviews POST 422). curl with the shared timeout/retry pattern; on 422/failure it logs and exits 0 (non-fatal — the summary comment already conveys the verdict). New input `INLINE_COMMENTS` (default `true`) disables it.

**Schema additions** (carried through `dimension-base.txt` → `build-prompt.sh` → `parse-response.sh` → `validate-findings.sh`): each finding gains optional `end_line` (multi-line span) and `suggestion` (replacement code). `validate-findings.sh` drops the *suggestion* (not the finding) when `confidence != high` or the span isn't fully in `changed_lines`.

**Acceptance (additions):**
16. `post-review.sh` against a real PR-event fixture (with head SHA) + curl-double produces a `POST .../pulls/{pr}/reviews` body with `event:"COMMENT"`, `commit_id`, and one `comments[]` entry per anchored finding; a finding citing a line absent from the diff is excluded (no 422).
17. A HIGH-confidence finding with a `suggestion` renders a ` ```suggestion ` block; a `medium`-confidence one renders a plain comment (suggestion dropped).
18. `INLINE_COMMENTS=false` skips `post-review.sh` entirely; the summary issue-comment still posts.
19. A simulated `422` from the reviews API leaves `post-review.sh` exit 0 and does not fail the job.

## Open Questions

1. **`minimax/minimax-m3` × structured outputs — RESOLVED 2026-06-16.** `scripts/capture-fixtures.sh` made live calls: all four dimensions returned clean schema-conformant JSON in `json_schema` mode (no provider error). `ENFORCE_JSON_SCHEMA=true` default is confirmed safe. The `FALLBACK_MODEL` + free-text regex fallback remain as defense in depth.
2. **Cost ceiling — owner: user.** `parallel` mode is ~(#dimensions + 1)× the API cost of `single` per review. Default is `parallel`. Acceptable, or default to `single` with `parallel` opt-in? (Recommendation: keep `parallel` default per the "full production-grade" choice; document the cost prominently.)
3. **Dimension granularity — owner: Falconiere.** Run all 7 checklist dimensions as 7 separate calls, or group into ~3 sub-reviewers (security+correctness / performance / tests+docs+assertions+migration) to cut cost while keeping scoping benefits? (Recommendation: group into 3–4; finalize in plan.)
4. **`RELEASE_PLEASE_TOKEN` — owner: user (repo admin).** Code lands the reference; the secret is a manual step. Merge acceptable without it (degrades to no-CI-on-release-PR)?
5. **comemory PATH — owner: user, out of band.** `comemory.sh` isn't on PATH in this env; subagent recall silently no-ops. Not part of this PR; flagged so the workflow mandate isn't assumed live.
