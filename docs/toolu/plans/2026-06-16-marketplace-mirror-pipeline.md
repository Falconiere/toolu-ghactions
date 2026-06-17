# Marketplace Mirror Pipeline — Implementation Plan

**Date:** 2026-06-16   **Spec:** [2026-06-16-marketplace-mirror-pipeline-design.md](../specs/2026-06-16-marketplace-mirror-pipeline-design.md)   **Branch:** readme

## Context

Neither monorepo action is discoverable on the GitHub Marketplace (Marketplace lists one root-`action.yml` action per repo; subdir actions never qualify). On each release, auto-mirror each action to its own standalone repo that carries a root `action.yml`, so each mirror can be listed — while all development stays in the monorepo.

## Approach

A release-triggered `mirror` job runs a shared build-and-sync script per action. The script lays down a freshly-computed file tree in a clone of the mirror repo, commits on top of the mirror's main (fast-forward), tags the release, and force-moves the floating `v<major>` alias. code-review is a trivial copy (Docker action, reuses the monorepo GHCR image); cloudflare-tunnel hoists `start/action.yml` to the mirror root with a `$GITHUB_ACTION_PATH/../src` → `…/src` rewrite while keeping the `start|stop|wait` subdirs.

Reuses existing patterns: the `version` job outputs (`tag`,`major`) and `!cancelled() && needs.*.result=='success'` gate in `.github/workflows/release.yml`; the `git tag -f vN <tag>; push --force` alias move from the `move-major-alias` job (lines 134–165); the `scripts/` shell-helper convention (`parse-verdict.sh`) with bats tests in `scripts/__tests__/` (the home `parse-verdict.sh`'s header already names).

## Critical files

- **create** `scripts/mirror-action.sh` — build-and-sync, both actions.
- **create** `scripts/__tests__/helpers.bash` — bats helpers (bare-remote fixture).
- **create** `scripts/__tests__/mirror-action.bats` — real-data tests.
- **modify** `.github/workflows/release.yml` — add the `mirror` job.
- **delete** `action.yml` — stale v1 dup of `code-review/action.yml`.
- **modify** `README.md` — "Marketplace" note; add `scripts/__tests__/*.bats` to the Development test command.

## Approach detail — `scripts/mirror-action.sh`

Header-comment contract (per house convention). One responsibility per function; keep it legible:
- `layout_code_review` — copy `code-review/{action.yml,Dockerfile,src,prompts,__tests__,README.md}` to mirror root; rewrite `action.yml` `image:` → `docker://${IMAGE_BASE}:v${MAJOR}`.
- `layout_cloudflare_tunnel` — copy `cloudflare-tunnel/{start,stop,wait,src,__tests__,README.md}`; generate root `action.yml` = `start/action.yml` with `sed 's#$GITHUB_ACTION_PATH/../src#$GITHUB_ACTION_PATH/src#'`.
- `rewrite_readmes` — copy repo-root `LICENSE` to mirror root; rewrite every `](../LICENSE)` → `](./LICENSE)` and `](../README.md)` → `](https://github.com/${SOURCE_REPO})`; prepend a one-line "generated from the monorepo" banner to the mirror README.
- `git_sync` — clone `MIRROR_REPO` (token auth; clone failure = fatal, no auto-create), wipe tracked files, lay down tree, commit on existing main with `source-sha:` trailer (skip if unchanged), create `${TAG}` only if absent (immutable), force-move `v${MAJOR}`, push main + new tag + alias.

## Verification

- `shellcheck --severity=warning scripts/mirror-action.sh` clean.
- `bats scripts/__tests__/mirror-action.bats` green — drives the script against a **real local bare git remote** in `$BATS_TEST_TMPDIR` (no network, no mocks), covering acceptance criteria 1–5, 7, 9.
- AC9 is verified hermetically by surgical diff: the generated cloudflare-tunnel root `action.yml` differs from `start/action.yml` only in the rewritten `run:` line (so the schema, already CI-validated, is preserved) and still carries `name`/`branding`. `npx @action-validator/cli` (needs network) stays the documented Development/CI validation, not a bats dependency.
- Manual end-to-end deferred to first real release (needs `MIRROR_TOKEN` + repos — see Human prerequisites).

## Human prerequisites (out of code scope — cannot be automated)

1. Resolve spec **O1**: confirm the GHCR package `toolu-ghactions/code-review` is **public** (Package settings → visibility). Blocks code-review mirror from working for end users.
2. Create two empty **public** repos: `Falconiere/toolu-code-review`, `Falconiere/toolu-cloudflare-tunnel`.
3. No new secret — the mirror job reuses **`RELEASE_PLEASE_TOKEN`**; confirm its `repo`/`public_repo` scope covers pushing to the new public mirror repos.
4. One-time per mirror: accept the Marketplace Developer Agreement; draft a release with "Publish this Action to the GitHub Marketplace" checked (2FA).

## Deviations

- **`MIRROR_REMOTE` test seam** — `mirror-action.sh` accepts an optional `MIRROR_REMOTE` (full git URL), defaulting to the token https URL from `MIRROR_REPO`. Lets the bats suite point at a local bare repo for real-git, no-network testing. Not in the spec env list.
- **Mirror job reuses `RELEASE_PLEASE_TOKEN` + skips when absent** — job-level `env: HAS_PUSH_TOKEN: ${{ secrets.RELEASE_PLEASE_TOKEN != '' }}` gates the sync step (script reads it as `MIRROR_TOKEN`), so releases stay green until the mirror repos exist (human prereq). No new secret.
- **Signing neutralized in the mirror clone** — the script sets repo-local `commit.gpgsign`/`tag.gpgSign`/`tag.forceSignAnnotated` to false; contributors with global tag-signing on (and keyless CI) would otherwise fail `git tag`.
- **CI wiring** — `.github/workflows/tests.yml` `test` job now also runs `scripts/__tests__/*.bats` (S5-adjacent; the new tests must gate in CI).
- **Test count** — badges + Development comment bumped 108→119 (the 108 was already stale; +7 mirror tests).

## Steps (machine-readable)

```json
[
  {"id": "S1", "title": "Create scripts/mirror-action.sh (build-and-sync; layout_code_review, layout_cloudflare_tunnel, rewrite_readmes, git_sync) with header contract", "check": "test -f scripts/mirror-action.sh && shellcheck --severity=warning scripts/mirror-action.sh"},
  {"id": "S2", "title": "Create scripts/__tests__/helpers.bash + mirror-action.bats: real local bare-remote tests (no network) for acceptance 1-5,7,9 — tree layout, image rewrite, ../src->src rewrite, tag+alias, README ../-link rewrite, mirror-README generated banner, idempotent re-run, and AC9 as a surgical-diff assert (generated root differs from start/action.yml ONLY in the rewritten run-line, name+branding keys retained)", "check": "bats scripts/__tests__/mirror-action.bats"},
  {"id": "S3", "title": "Add `mirror` job to .github/workflows/release.yml: matrix [code-review, cloudflare-tunnel], needs:[version, publish-image], gated; invokes scripts/mirror-action.sh with ACTION/TAG/MAJOR/MIRROR_REPO/MIRROR_TOKEN/SOURCE_REPO/SOURCE_SHA/IMAGE_BASE", "check": "grep -qE '^  mirror:' .github/workflows/release.yml && grep -q 'needs: \\[version, publish-image\\]' .github/workflows/release.yml"},
  {"id": "S4", "title": "Delete the stale monorepo root action.yml", "check": "test ! -e action.yml"},
  {"id": "S5", "title": "Docs in sync: add a 'Marketplace' note to README.md (mirrors exist for discoverability; monorepo paths stay canonical) and add scripts/__tests__/*.bats to the Development bats command", "check": "grep -qi 'Marketplace' README.md && grep -q 'scripts/__tests__' README.md"},
  {"id": "S6", "title": "Run the full local gate: all bats suites + shellcheck across src + scripts", "check": "bats code-review/__tests__/*.bats cloudflare-tunnel/__tests__/*.bats scripts/__tests__/*.bats && shellcheck --severity=warning code-review/src/*.sh cloudflare-tunnel/src/*.sh scripts/*.sh"}
]
```
