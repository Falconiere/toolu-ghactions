# expo-builder P1: build-android + GitHub Releases deploy — Design

**Date:** 2026-07-10   **Status:** Approved   **Author:** Falconiere Barbosa   **Topic:** Composite-action suite that builds signed Android binaries from Expo apps and publishes them to GitHub Releases — zero Expo/EAS account.

## Problem

Building an Expo app for Android in CI today effectively requires an Expo account: the official `expo/expo-github-action` and every Marketplace "Expo CI/CD" action shell out to `eas-cli`, and even `eas build --local` refuses to run without login (expo/eas-cli#1606, closed "not planned"). Teams that don't want a third-party build service — or can't use one — are left assembling prebuild + Gradle + signing by hand from blog posts. No canonical account-free action exists.

## Non-Goals

1. iOS builds, TestFlight/App Store upload (P3).
2. Google Play upload (P2).
3. OTA updates / `expo export` / expo-updates servers (P4).
4. Any use of `eas-cli` — banned; it requires an account.
5. Dependency installation — consumer installs `node_modules` (npm/yarn/pnpm/bun their choice) before invoking the action. Action fails fast with a clear error if missing.
6. Version/versionCode management — `app.json` / Gradle stay the source of truth; no auto-bump.
7. Debug/dev-client/Expo Go builds — release builds only (debug *signing* fallback is in scope, debug *build type* is not).
8. Expo SDK ≤51 support — SDK 52+ assumed (JDK 17 era); latest stable tested (SDK 57 at authoring, 2026-07).
9. Windows runners — `build-android` supports Linux runners (documented target: `ubuntu-latest`); scripts are additionally unit-tested on macOS per repo convention. No Windows support in P1.
10. No top-level `expo-builder/action.yml` wrapper — sub-actions are consumed individually, same as `cloudflare-tunnel/` (intentional).

## Architecture

A new top-level action family `expo-builder/` with two composite sub-actions, mirroring the `cloudflare-tunnel/` suite pattern (sub-action dirs, shell in `src/`, bats tests in `__tests__/`):

- **`expo-builder/build-android`** — steps: official setup actions (`actions/setup-node`, `actions/setup-java` temurin, `gradle/actions/setup-gradle` for caching; all pinned by major tag per repo convention) then small single-responsibility shell scripts (all `set -euo pipefail`, all variable expansions quoted — shellcheck-enforced):
  1. `preflight.sh` — verify, with distinct `::error::` annotations and exit 1: `node_modules/` present ("install dependencies before this action"), an Expo app config present (`app.json` or `app.config.{js,ts,cjs,mjs}` — else "not an Expo app"), and Android SDK available (`ANDROID_HOME`/`ANDROID_SDK_ROOT` set — else "runner has no Android SDK"; covers self-hosted runners). Exports `EXPO_NO_TELEMETRY=1`.
  2. `prebuild.sh` — run `npx expo prebuild --platform android` only when needed (see `prebuild` input); bare projects with `android/` skip it. Prebuild output streams through unmodified; non-zero exit propagates.
  3. `setup-signing.sh` — decode base64 keystore into `mktemp -d "$RUNNER_TEMP/expo-builder.XXXXXX"` (never into the checkout), export `EXPO_BUILDER_KEYSTORE_*` env. Input validation: all four keystore inputs, or none. 1–3 of 4 provided → `::error::` naming the missing inputs, exit 1. All four absent → debug-keystore fallback with a `::warning::` annotation — unless `require-signing: true`, which turns absence into an error.
  4. `signing.init.gradle` — **static Gradle init script** (applied via `gradlew -I`) that injects `signingConfigs.release` from env into any `com.android.application` project. Chosen over patching `build.gradle` because prebuild regenerates native files — an init script never touches generated output and works identically on bare projects. When it applies signing it writes a marker file (`$RUNNER_TEMP/expo-builder-signing-applied`); `build.sh` fails if release-keystore env is set but the marker is absent after the build — no silent unsigned/debug-signed binaries.
  5. `build.sh` — single Gradle invocation with the task list derived from `format` (`assembleRelease`, `bundleRelease`, or both). One invocation makes `format: both` atomic: if either task fails, the step fails and **no outputs are set** — there is no partial-success output state.
  6. `resolve-outputs.sh` — locate APK/AAB under `android/app/build/outputs/`, resolve app version via `npx expo config --json --type public` (canonical resolver — handles `app.json` and `app.config.js/ts` uniformly, field `.version`), set step outputs.
- **`expo-builder/deploy-github-release`** — one script `create-release.sh`: create the release via `gh` if the tag doesn't exist; if the tag/release already exists, **fail by default** — `overwrite: true` keeps the release and re-uploads assets with `--clobber`. Generates `sha256sums.txt`, uploads assets. Value over raw `softprops/action-gh-release`: defaults tag/name from the build action's `app-version` output and always ships checksums.

**Driving trade-off:** transparency/maintainability over programmability. The work is sequencing standard toolchain commands; composite shell + official setup actions beats a bundled TS/node20 action (no `dist/` sync, no reimplementing toolchain setup). Rejected alternatives recorded in the brainstorm memory (`expo-builder-design-decision`).

**Reuse:** `cloudflare-tunnel/` layout + bats conventions, `scripts/__tests__/` shell test helpers, `scripts/mirror-action.sh` + `release.yml` mirror publishing, `action-validator` CI check.

**Size discipline:** each shell script one responsibility, well under repo ceilings; `action.yml` files stay declarative.

## Interfaces / Schema

### `expo-builder/build-android/action.yml`

```yaml
inputs:
  working-directory: { default: "." }          # app root (monorepo support)
  format:            { default: "apk" }        # apk | aab | both
  prebuild:          { default: "auto" }       # auto (skip if android/ exists) | always | never
  prebuild-args:     { default: "" }           # extra args appended to expo prebuild
  node-version:      { default: "20" }
  java-version:      { default: "17" }
  gradle-cache:      { default: "true" }       # wire gradle/actions/setup-gradle caching
  require-signing:   { default: "false" }      # true: absent keystore = error, no debug fallback
  keystore-base64:   { required: false }       # secrets; all four together or none —
  keystore-password: { required: false }       # 1-3 of 4 = hard error naming missing ones;
  key-alias:         { required: false }       # none = debug-keystore fallback + ::warning::
  key-password:      { required: false }       #        (or error when require-signing)
outputs:
  apk-path:    # absolute path; empty if format=aab
  aab-path:    # absolute path; empty if format=apk
  app-version: # resolved via `npx expo config --json --type public` → .version
```

Outputs are set only on full build success (`format: both` is atomic — see Architecture). Version resolution: `expo config` resolved output only; raw `app.json` is never read for the version (avoids `app.config.js/ts` mismatches).

Signing env contract (consumed only by `signing.init.gradle`): `EXPO_BUILDER_KEYSTORE_PATH`, `EXPO_BUILDER_KEYSTORE_PASSWORD`, `EXPO_BUILDER_KEY_ALIAS`, `EXPO_BUILDER_KEY_PASSWORD`. Keystore is decoded under `$RUNNER_TEMP`, never into the checkout.

### `expo-builder/deploy-github-release/action.yml`

```yaml
inputs:
  files:        { required: true }             # NEWLINE-separated glob patterns, one per line;
                                               # spaces within a line are literal (filenames with
                                               # spaces supported). Example:
                                               #   files: |
                                               #     ${{ steps.build.outputs.apk-path }}
                                               #     dist/*.aab
  tag:          { required: false }            # default: v<app-version> (requires app-version)
  app-version:  { required: false }            # pipe from build-android output
  release-name: { required: false }            # default: tag
  draft:        { default: "false" }
  prerelease:   { default: "false" }
  overwrite:    { default: "false" }           # existing tag/release: false = ::error:: + exit 1;
                                               # true = keep release, re-upload assets --clobber
  generate-checksums: { default: "true" }      # sha256sums.txt asset
  token:        { default: "${{ github.token }}" }
outputs:
  release-url:
  uploaded-assets:  # newline-separated asset names
```

Fails with `::error::` when: neither `tag` nor `app-version` given; any glob line matches nothing (names the offending pattern); tag exists and `overwrite` is false.

### File layout

```
expo-builder/
  README.md
  build-android/{action.yml, src/{preflight.sh, prebuild.sh, setup-signing.sh,
                signing.init.gradle, build.sh, resolve-outputs.sh}, __tests__/*.bats}
  deploy-github-release/{action.yml, src/create-release.sh, __tests__/*.bats}
```

## Acceptance criteria

Integration fixture = a **real Expo app** generated in-workflow by `create-expo-app` (pinned template version) followed by an explicit `npm install`, real throwaway keystore generated with `keytool` in-workflow. Integration runs on `ubuntu-latest` (P1's documented build platform); bats unit tests run Linux + macOS. No mocks anywhere.

- **AC-1:** On ubuntu-latest, fresh `create-expo-app` fixture + action with `format: apk` and a keytool-generated keystore → APK exists at `apk-path` output and `apksigner verify` passes against it.
- **AC-2:** Same fixture with `format: aab` → `.aab` exists at `aab-path` and contains `BundleConfig.pb` (zip listing check).
- **AC-3:** No keystore inputs → build succeeds, APK is debug-signed (`apksigner verify --print-certs` shows the Android debug CN), and a `::warning::` annotation is emitted.
- **AC-4:** Project where `npx expo prebuild` was already run (bare `android/` present) + `prebuild: auto` → logs show the prebuild-skipped message and the build still produces an APK.
- **AC-5:** The integration job asserts account-freeness with an explicit step — `[[ -z "${EXPO_TOKEN:-}" ]] && [[ ! -f ~/.expo/state.json ]]` — before building; the whole build passes with no Expo credentials in the job.
- **AC-6:** `deploy-github-release` with the AC-1 APK on a disposable tag in this repo → release exists with the APK and `sha256sums.txt` whose hash matches the APK; re-running the same tag with `overwrite: false` fails; job cleans up the tag/release afterwards.
- **AC-7:** All shell scripts pass shellcheck (which enforces the quoting contract) and bats unit tests on both Linux and macOS runners, matching `tests.yml` conventions. Bats coverage must include: partial keystore input error (2 of 4), prebuild skip logic, debug-signing fallback + `require-signing`, glob-matches-nothing failure, and a `working-directory` containing spaces.
- **AC-8:** Both `action.yml` files pass `action-validator` in CI.
- **AC-9:** Docs in sync — root `README.md` gains a section for the suite linking to `expo-builder/README.md`; `expo-builder/README.md` documents every input/output plus a copy-paste build→release workflow example; `release.yml` mirror publishing covers `expo-builder/`.

## Open Questions

- ~~**OQ-1**~~ Resolved 2026-07-10: public mirror repo created at https://github.com/Falconiere/toolu-expo-builder (user-confirmed public visibility). `RELEASE_TOOLU_ACTIONS_TOKEN` scope reuse assumed — same owner PAT that pushes the existing mirrors.
- ~~**OQ-2**~~ Resolved 2026-07-10 (plan phase): integration fixture pinned to `create-expo-app@4.0.0` (Expo SDK 57, `expo@57.0.4` current stable per npm).
- ~~**OQ-3**~~ Resolved 2026-07-10: repo convention is major-version tags (`actions/checkout@v5`, `oven-sh/setup-bun@v2`) — setup actions referenced by major tag, not SHA.
