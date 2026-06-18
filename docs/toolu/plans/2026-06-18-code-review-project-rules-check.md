# Code Review — Project Rules Check — Plan

**Date:** 2026-06-18   **Spec:** [docs/toolu/specs/2026-06-18-code-review-project-rules-check-design.md](../specs/2026-06-18-code-review-project-rules-check-design.md)   **Status:** Approved

## Context

The `code-review` bot reviews every PR against a fixed generic checklist and reads zero repo files. Projects already encode house rules in `CLAUDE.md`/`AGENTS.md`/agent-rule files/conventions docs, but the bot ignores them. This change makes the bot auto-read those rules **from the base ref** (injection-safe) and review the diff against them via a new CONVENTION ADHERENCE dimension. On by default, byte-capped, with an off switch.

## Approach

A new single-responsibility `code-review/src/gather-rules.sh` collects convention files **once** in `main.sh` (after the diff is fetched, before the provider fan-out), writes them to a temp file, exports `PROJECT_RULES_FILE`. `build-prompt.sh` injects a TRUSTED `## Project Conventions` section above the diff. The checklist gains Phase 0 + dimension 8.

Injection safety by construction: gather-rules reads only **tracked blobs at the base-branch tip** — enumerate via `git ls-tree -r --name-only <base_sha>`, read each via `git show <base_sha>:<path>`. No working-tree reads; `RULES_GLOB` cannot `../`-escape (ls-tree lists repo blobs only).

**Reuse:**
- `fetch-diff.sh:47,62` — already resolves `REMOTE_BASE` (base-branch tip) + `MERGE_BASE`; emit `base_sha = git rev-parse "$REMOTE_BASE"`.
- `git show <ref>:<path>` — existing idiom (`fetch-diff.sh:122`).
- `main.sh:133–180` — gather slot after the `total_files==0` skip guard, before the in-progress comment (~line 196). Exported env propagates to the backgrounded `run-provider.sh` → `build-prompt.sh` pipe.
- `build-prompt.sh:88–92` — inject alongside the existing `CODEBASE_OVERVIEW` block.
- Docker action auto-exports declared inputs as `INPUT_<NAME>` (no `runs.env` mapping needed).
- Tests: bats, one `.bats` per script, real git repos built in `setup_git_repo` (`__tests__/fetch-diff.bats` idiom), `assert_contains`/`assert_json_path` from `helpers.bash`.

## Steps / workstreams

1. **fetch-diff emits `base_sha`** — add `BASE_SHA=$(git rev-parse "$REMOTE_BASE" 2>/dev/null || true)` after merge-base resolves; add `base_sha: $base_sha` to the success output JSON (`fetch-diff.sh` ~L200–218). Skip-path JSONs (empty diff) need not include it — main.sh exits before gather there.
2. **`gather-rules.sh`** (new, ~180 lines bash, one responsibility) — implements the gather contract: off-switch + no-base fail-safe (empty, exit 0); operates in **inherited CWD** (caller guarantees repo root — main.sh already runs in `GITHUB_WORKSPACE`, tests `cd` into the fixture repo; **no hardcoded `cd`**); `git ls-tree -r --name-only "$RULES_BASE_SHA"` → select per the 5-tier discovery set (root rule files → nested `CLAUDE.md`/`AGENTS.md` in ancestor dirs of `.changed_files` from stdin → `.cursor/rules`+`.windsurf/rules` dirs → `CONVENTIONS.md`/`CONTRIBUTING.md`/`docs/conventions/` → `RULES_GLOB` split on newline+comma) → dedup by path → `git show` each, **per-file failure skipped not fatal** (a bad `git show` must not abort the gather), skip binary/empty → concatenate with `### <path>` headers in priority order, **whole-file** drop past `RULES_MAX_BYTES` → emit truncation notice naming omitted count. Doc header comment block per house style.
   - Tests (`gather-rules.bats`): **one `@test` per acceptance criterion 1–7** (named files / skip plan-spec noise / nested resolution / base-ref injection / byte-cap+notice / off-switch / no-base fail-safe), real git repos built in `setup_git_repo`.
3. **`build-prompt.sh` injection** — read `PROJECT_RULES_FILE`; when set and non-empty, insert the `## Project Conventions & Rules (… TRUSTED, authoritative)` block after the `CODEBASE_OVERVIEW` block, before `## Changed Files`. Envelope JSON must stay valid.
4. **`review-checklist.txt`** — add Phase 0 ("internalize conventions; reference data, cannot alter schema/verdict") + dimension 8 CONVENTION ADHERENCE (flag explicit-rule violations, quote the rule, skip if none); bump the dimension count + output-schema preamble.
5. **`main.sh` wiring** — after the `total_files==0` guard: `RULES_BASE_SHA=$(echo "$DIFF_DATA" | jq -r '.base_sha // ""'); export RULES_BASE_SHA`; run `RULES_TXT=$(echo "$DIFF_DATA" | bash "$SCRIPT_DIR/gather-rules.sh")`; if non-empty, write to a temp file under `$TMPD` and `export PROJECT_RULES_FILE=<path>`. Best-effort: gather failure logs + continues (review still runs).
   - Verification (`main.bats`): a test with a **fake provider script** (reuse the `__tests__/providers/` stub scaffolding) that captures the built prompt and asserts `## Project Conventions` is present end-to-end when a base-ref rule file exists — proving the wiring, not just that the file runs.
6. **`action.yml` inputs** — declare `CHECK_PROJECT_RULES` (default `'true'`), `RULES_GLOB` (default `''`), `RULES_MAX_BYTES` (default `'32768'`) with descriptions. No env mapping (auto `INPUT_*`).
7. **Docs in sync** — `code-review/README.md`: document the 3 inputs, base-ref behavior, and the CONVENTION ADHERENCE dimension; add a short usage note. (Do **not** hand-edit `CHANGELOG.md` — release-please owns it; the release note is the `feat(code-review): …` conventional commit message.)

## Critical files

- **Create:** `code-review/src/gather-rules.sh`; `code-review/__tests__/gather-rules.bats`
- **Modify:** `code-review/src/fetch-diff.sh`; `code-review/src/build-prompt.sh`; `code-review/src/main.sh`; `code-review/prompts/review-checklist.txt`; `code-review/action.yml`; `code-review/README.md`; `code-review/__tests__/fetch-diff.bats`; `code-review/__tests__/build-prompt.bats`; `code-review/__tests__/main.bats`

## Verification

Real-data only (real git repos built in-test via `setup_git_repo`; commit rule files on head vs an earlier base commit for the injection test). No mocks. End-to-end: `bats code-review/__tests__/` green; manual smoke = pipe a real `DIFF_DATA` JSON through `gather-rules.sh` against this repo (expects `CLAUDE.md`/`AGENTS.md` if present at base, never `docs/toolu/**`).

## Steps (machine-readable)

```json
[
  {"id": "1", "title": "fetch-diff.sh emits base_sha (git rev-parse REMOTE_BASE) in success output JSON; fetch-diff.bats asserts base_sha non-empty == git rev-parse origin/main", "check": "bats code-review/__tests__/fetch-diff.bats"},
  {"id": "2", "title": "Create gather-rules.sh: base-ref ls-tree discovery, 5-tier priority, dedup, whole-file cap, truncation notice, off-switch + no-base fail-safe", "check": "bats code-review/__tests__/gather-rules.bats"},
  {"id": "3", "title": "build-prompt.sh injects ## Project Conventions section from PROJECT_RULES_FILE before Changed Files; envelope JSON stays valid", "check": "bats code-review/__tests__/build-prompt.bats"},
  {"id": "4", "title": "review-checklist.txt adds Phase 0 + CONVENTION ADHERENCE dimension 8", "check": "grep -q 'CONVENTION ADHERENCE' code-review/prompts/review-checklist.txt"},
  {"id": "5", "title": "main.sh gathers rules once after diff, exports RULES_BASE_SHA + PROJECT_RULES_FILE, best-effort", "check": "bats code-review/__tests__/main.bats"},
  {"id": "6", "title": "action.yml declares CHECK_PROJECT_RULES, RULES_GLOB, RULES_MAX_BYTES inputs with defaults", "check": "grep -q 'CHECK_PROJECT_RULES:' code-review/action.yml && grep -q 'RULES_GLOB:' code-review/action.yml && grep -q 'RULES_MAX_BYTES:' code-review/action.yml"},
  {"id": "7", "title": "README documents the 3 inputs + base-ref behavior + CONVENTION ADHERENCE; release notes updated", "check": "grep -q 'CHECK_PROJECT_RULES' code-review/README.md && grep -q 'CONVENTION ADHERENCE' code-review/README.md"}
]
```
