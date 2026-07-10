# expo-builder P1: build-android + deploy-github-release — Plan

**Date:** 2026-07-10   **Status:** Approved   **Spec:** docs/toolu/specs/2026-07-10-expo-builder-p1-android-design.md   **Topic:** Implement the account-free Expo Android build + GitHub Releases deploy composite-action suite.

## Context

No Marketplace action builds Expo apps without an EAS account; even `eas build --local` demands login. The approved spec defines a two-sub-action composite suite (`expo-builder/build-android`, `expo-builder/deploy-github-release`) driving `expo prebuild` → Gradle with init-script signing injection. This plan turns that spec into ordered, checkable steps.

## Approach

Composite shell suite mirroring `cloudflare-tunnel/` (sub-action dirs, `src/*.sh`, bats). Reuse:

- CI shapes from `.github/workflows/tests.yml` — bats matrix job (`tunnel-test`, lines 58–76), shellcheck + `npx --yes @action-validator/cli` job (`tunnel-lint`, 78–90).
- Mirror publishing via existing `scripts/mirror-action.sh` — new matrix entry in `.github/workflows/release.yml` (`mirror` job, 124–131); release-please config is simple-mode, needs no change.
- Setup actions pinned by major tag (repo convention): `actions/setup-node@v6`, `actions/setup-java@v5` (temurin), `gradle/actions/setup-gradle@v6` (conditional on `gradle-cache` input; composite steps support `if:`).
- Integration fixture: `npx create-expo-app@4.0.0` (Expo SDK 57) + explicit `npm install`, throwaway keystore via `keytool` — real data, no mocks.
- bats helpers: shared `expo-builder/__tests__/helpers.bash` (suite-level, loaded by all sub-action .bats), modeled on `scripts/__tests__/helpers.bash` and `cloudflare-tunnel` conventions.

**Layout note (deliberate divergence):** `cloudflare-tunnel/` keeps suite-level `src/` + `__tests__/`; expo-builder uses **per-sub-action** `src/` + `__tests__/` because the two sub-actions share no scripts (tunnel's start/stop/wait share state helpers). Only `helpers.bash` is suite-level. Don't copy tunnel's layout blindly.

All scripts `set -euo pipefail`, quoted expansions (shellcheck-enforced), and **BSD/macOS-compatible** — the bats matrix runs on macOS too (AC-7): `base64 -d` vs `-D`, `mktemp` template requirements, no GNU-only flags (`sed -i ''`, `grep -P`, `readlink -f`). `signing.init.gradle` is Groovy — covered by integration + action wiring, not shellcheck.

## Steps (machine-readable)

```json
[
  {
    "id": "build-action-yml",
    "title": "Scaffold expo-builder/build-android/action.yml — composite wiring setup-node@v6/setup-java@v5/setup-gradle@v6 + script steps, full input/output contract from spec",
    "check": "npx --yes @action-validator/cli expo-builder/build-android/action.yml",
    "ac_refs": ["AC-8"]
  },
  {
    "id": "preflight-sh",
    "title": "preflight.sh: distinct ::error:: for missing node_modules / no Expo app config / no Android SDK; exports EXPO_NO_TELEMETRY=1. Bats: all three failure paths + pass path + working-directory with spaces",
    "check": "bats expo-builder/build-android/__tests__/preflight.bats",
    "ac_refs": ["AC-7"],
    "depends_on": ["build-action-yml"]
  },
  {
    "id": "signing-sh",
    "title": "setup-signing.sh + signing.init.gradle: all-four-or-none validation (1-3 given = ::error:: naming missing), debug fallback + ::warning::, require-signing, decode to mktemp under RUNNER_TEMP, marker-file contract. Bats: partial-input error, fallback, require-signing error, real keytool-generated keystore decode roundtrip",
    "check": "bats expo-builder/build-android/__tests__/setup-signing.bats",
    "ac_refs": ["AC-3", "AC-7"],
    "depends_on": ["build-action-yml"]
  },
  {
    "id": "prebuild-sh",
    "title": "prebuild.sh: auto|always|never logic (auto skips when android/ exists, logs skip message), streams expo output unmodified. Bats: mode matrix against real dirs with/without android/",
    "check": "bats expo-builder/build-android/__tests__/prebuild.bats",
    "ac_refs": ["AC-4", "AC-7"],
    "depends_on": ["build-action-yml"]
  },
  {
    "id": "build-sh",
    "title": "build.sh: derive single Gradle invocation from format (assembleRelease/bundleRelease/both — atomic), apply -I signing.init.gradle, fail if keystore env set but signing marker absent. Bats: task derivation, invalid format error, marker enforcement",
    "check": "bats expo-builder/build-android/__tests__/build.bats",
    "ac_refs": ["AC-7"],
    "depends_on": ["signing-sh"]
  },
  {
    "id": "resolve-outputs-sh",
    "title": "resolve-outputs.sh: locate APK/AAB under android/app/build/outputs/, app-version via npx expo config --json --type public, write GITHUB_OUTPUT. Bats: real gradle output tree layout, captured real expo-config JSON fixture, missing-artifact error",
    "check": "bats expo-builder/build-android/__tests__/resolve-outputs.bats",
    "ac_refs": ["AC-7"],
    "depends_on": ["build-sh"]
  },
  {
    "id": "deploy-action",
    "title": "deploy-github-release: action.yml + create-release.sh — newline-glob parsing (spaces literal), tag/app-version resolution, tag-exists fail vs overwrite --clobber, sha256sums.txt, outputs. Bats: glob no-match names pattern, newline parsing incl. spaces, checksum over real files, missing tag+app-version error",
    "check": "npx --yes @action-validator/cli expo-builder/deploy-github-release/action.yml && bats expo-builder/deploy-github-release/__tests__/create-release.bats",
    "ac_refs": ["AC-6", "AC-8"]
  },
  {
    "id": "wire-tests-yml",
    "title": "tests.yml: add expo-test bats matrix job (ubuntu+macos, mirroring tunnel-test) and expo-lint job (shellcheck expo-builder/*/src/*.sh + action-validator both action.yml)",
    "check": "grep -q 'expo-builder' .github/workflows/tests.yml",
    "ac_refs": ["AC-7", "AC-8"],
    "depends_on": ["preflight-sh", "signing-sh", "prebuild-sh", "build-sh", "resolve-outputs-sh", "deploy-action"]
  },
  {
    "id": "integration-workflow",
    "title": ".github/workflows/expo-integration.yml: job1 signed format=both build on create-expo-app@4.0.0 fixture (explicit npm install) with keytool keystore + explicit no-credentials assertion + apksigner verify + AAB zip check (AC-1/2/5); job2 manual-prebuild fixture, no keystore, prebuild:auto → skip log + debug CN (AC-3/4); job3 `permissions: contents: write`, deploy APK to disposable tag, verify checksum, overwrite:false re-run fails, cleanup release+tag in `if: always()` step (AC-6)",
    "check": "f=.github/workflows/expo-integration.yml; grep -qF 'create-expo-app@4.0.0' $f && grep -qF 'npm install' $f && grep -qF 'keytool' $f && grep -qF 'verify --print-certs' $f && grep -qF 'BundleConfig.pb' $f && grep -qF 'contents: write' $f && grep -qF 'if: always()' $f",
    "ac_refs": ["AC-1", "AC-2", "AC-3", "AC-4", "AC-5", "AC-6"],
    "depends_on": ["wire-tests-yml"]
  },
  {
    "id": "docs-sync",
    "title": "expo-builder/README.md (every input/output + copy-paste build→release example) + root README.md section linking it",
    "check": "for i in working-directory format prebuild prebuild-args node-version java-version gradle-cache require-signing keystore-base64 keystore-password key-alias key-password apk-path aab-path app-version files tag release-name draft prerelease overwrite generate-checksums token release-url uploaded-assets; do grep -q -- \"$i\" expo-builder/README.md || { echo \"missing: $i\"; exit 1; }; done && grep -q 'jobs:' expo-builder/README.md && grep -q 'expo-builder/README.md' README.md",
    "ac_refs": ["AC-9"],
    "depends_on": ["integration-workflow"]
  },
  {
    "id": "mirror-script",
    "title": "scripts/mirror-action.sh: add layout_expo_builder() (suite tree → mirror root, same shape as layout_cloudflare_tunnel) + expo-builder case arm; extend scripts/__tests__/mirror-action.bats with an expo-builder layout case (real temp git repos, matching existing tests)",
    "check": "bats scripts/__tests__/mirror-action.bats",
    "ac_refs": ["AC-9"],
    "depends_on": ["docs-sync"]
  },
  {
    "id": "release-wiring",
    "title": "release.yml mirror matrix: add {action: expo-builder, mirror_repo: Falconiere/toolu-expo-builder}",
    "check": "grep -q 'toolu-expo-builder' .github/workflows/release.yml",
    "ac_refs": ["AC-9"],
    "depends_on": ["mirror-script"]
  },
  {
    "id": "full-gate",
    "title": "Full local gate: shellcheck all suite scripts, all bats, both action-validators",
    "check": "shellcheck --severity=warning expo-builder/build-android/src/*.sh expo-builder/deploy-github-release/src/*.sh && bats expo-builder/build-android/__tests__/*.bats expo-builder/deploy-github-release/__tests__/*.bats && npx --yes @action-validator/cli expo-builder/build-android/action.yml && npx --yes @action-validator/cli expo-builder/deploy-github-release/action.yml",
    "ac_refs": ["AC-7", "AC-8"],
    "depends_on": ["release-wiring"]
  }
]
```

## Critical files

Create:
- `expo-builder/build-android/action.yml`
- `expo-builder/build-android/src/{preflight.sh, prebuild.sh, setup-signing.sh, signing.init.gradle, build.sh, resolve-outputs.sh}`
- `expo-builder/build-android/__tests__/{preflight, setup-signing, prebuild, build, resolve-outputs}.bats`
- `expo-builder/__tests__/helpers.bash` (shared bats helpers, suite-level)
- `expo-builder/deploy-github-release/action.yml`
- `expo-builder/deploy-github-release/src/create-release.sh`
- `expo-builder/deploy-github-release/__tests__/create-release.bats`
- `expo-builder/README.md`
- `.github/workflows/expo-integration.yml`

Modify:
- `.github/workflows/tests.yml` (expo-test + expo-lint jobs)
- `.github/workflows/release.yml` (mirror matrix entry)
- `scripts/mirror-action.sh` (`layout_expo_builder()` + case arm) and `scripts/__tests__/mirror-action.bats`
- `README.md` (suite section)

## Verification

1. Local: `full-gate` check command exits 0 (bats via `brew install bats-core` if absent).
2. Push branch → `gh run watch`: `tests.yml` all jobs green (including new expo-test Linux+macOS, expo-lint).
3. `expo-integration.yml` green end-to-end on a real SDK 57 app: signed APK passes `apksigner verify`, AAB contains `BundleConfig.pb`, debug-fallback CN check, prebuild-skip log, release round-trip with checksum match and overwrite-negative — AC-1…AC-6 proven on real data, zero Expo credentials in any job.
4. Docs: README example is copy-paste runnable against `@v6` refs post-release (mirrors OQ-1 — first release blocked on mirror repo creation, not on this work).

## Deviations

- 2026-07-10 `integration-workflow` check: greps switched to `-F` fixed strings — the original `grep -q 'if: always()'` breaks under ugrep-shimmed local grep (ERE `()` = empty subexpression), and the apksigner assertion uses a variable (`"$apksigner" verify --print-certs`), so the literal anchor is now `verify --print-certs`. Assertion intent unchanged.

## Notes for execution

- bats fixtures: real dirs/files under `$BATS_TMPDIR`; the real keystore is generated with `keytool` (skip that single test with a clear message if no JDK locally — CI always has it).
- Scripts read inputs via env vars set in `action.yml` steps (`INPUT_*`-style naming like cloudflare-tunnel), keeping them bats-testable without a runner. Working-directory contract: `action.yml` exports `EXPO_BUILDER_WORKING_DIR` from the input; every script `cd`s there first — `npx expo config`/`expo prebuild` therefore always run in the app root.
- `signing.init.gradle` path: `action.yml` passes the **absolute** path via `${{ github.action_path }}/src/signing.init.gradle` in env; `build.sh` never computes relative paths.
- `build.bats` does not run real Gradle: `build.sh` supports `EXPO_BUILDER_DRY_RUN=1` printing the exact gradle invocation it would exec — bats asserts the derived command (real script, real logic); real Gradle execution is proven by the integration workflow (AC-1/AC-2).
- `resolve-outputs.bats` version fixture: a checked-in JSON captured from a real `npx expo config --json --type public` run on the SDK 57 fixture (name it `expo-config.sdk57.json`).
- `create-release.bats` covers parsing/validation/glob/checksum logic without network via a PATH-shim `gh` recording invocations; the real `gh` round-trip is integration job3.
- Verified 2026-07-10: `@action-validator/cli` does NOT check referenced script files' existence — `build-action-yml` step can land before scripts exist.
- Integration job3 needs `permissions: contents: write` and cleanup in `if: always()` step (also encoded in the step title/check).
