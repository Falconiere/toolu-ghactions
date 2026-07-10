# expo-builder

Build and ship Expo Android apps in CI **without an Expo/EAS account** — no
`eas-cli`, no `EXPO_TOKEN`, no login. The suite drives `npx expo prebuild`
(Continuous Native Generation — the template comes from npm, not Expo's
servers) into a plain Gradle build, injecting release signing through a Gradle
init script that never touches generated native files.

Two composite sub-actions, consumed independently:

| Sub-action | What it does |
|---|---|
| [`build-android`](#build-android) | `expo prebuild` → Gradle → signed APK/AAB, with keystore injection and atomic `both` builds. |
| [`deploy-github-release`](#deploy-github-release) | Publish the binaries to a GitHub Release with `sha256sums.txt`, tag defaulting to `v<app-version>`. |

Runs on Linux runners (`ubuntu-latest`); scripts are additionally unit-tested
on macOS. Windows is unsupported. Requires dependencies installed
(`npm install` or equivalent) before invoking — the action fails fast if
`node_modules/` is missing. Expo SDK 52+; tested against SDK 57.

## Quick start (build → release)

```yaml
name: android-release
on:
  push:
    tags: ['v*']

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v5
      - run: npm ci
      - uses: falconiere/toolu-ghactions/expo-builder/build-android@v6
        id: build
        with:
          format: both
          keystore-base64: ${{ secrets.ANDROID_KEYSTORE_BASE64 }}
          keystore-password: ${{ secrets.ANDROID_KEYSTORE_PASSWORD }}
          key-alias: ${{ secrets.ANDROID_KEY_ALIAS }}
          key-password: ${{ secrets.ANDROID_KEY_PASSWORD }}
      - uses: falconiere/toolu-ghactions/expo-builder/deploy-github-release@v6
        with:
          app-version: ${{ steps.build.outputs.app-version }}
          files: |
            ${{ steps.build.outputs.apk-path }}
            ${{ steps.build.outputs.aab-path }}
```

No Expo secrets anywhere — the four `ANDROID_*` secrets are your own keystore
(`keytool -genkeypair …`, then `base64 -w0 release.keystore`).

## build-android

`expo prebuild` runs only when needed (`auto` skips it when `android/`
already exists, so bare projects work unchanged), signing is injected via a
Gradle **init script** after prebuild (prebuild regenerates native files, so
nothing under `android/` is ever patched), and `format: both` is one atomic
Gradle invocation — either every artifact builds or the step fails with no
outputs.

### Inputs

| Input | Default | Description |
|---|---|---|
| `working-directory` | `.` | App root (monorepo support). |
| `format` | `apk` | `apk` \| `aab` \| `both` (atomic). |
| `prebuild` | `auto` | `auto` (skip when `android/` exists) \| `always` \| `never`. |
| `prebuild-args` | — | Extra args appended to `npx expo prebuild`. |
| `node-version` | `20` | Node for `actions/setup-node`. |
| `java-version` | `17` | JDK (temurin) for `actions/setup-java`. |
| `gradle-cache` | `true` | Gradle caching via `gradle/actions/setup-gradle`. |
| `require-signing` | `false` | `true`: absent keystore inputs fail instead of debug fallback. |
| `keystore-base64` | — | Release keystore, base64. **All four keystore inputs together or none** — 1–3 of 4 is an error naming the missing ones; none falls back to the debug keystore with a warning. |
| `keystore-password` | — | Keystore password. |
| `key-alias` | — | Key alias. |
| `key-password` | — | Key password. |

### Outputs

| Output | Description |
|---|---|
| `apk-path` | Absolute APK path (empty when `format: aab`). |
| `aab-path` | Absolute AAB path (empty when `format: apk`). |
| `app-version` | Version resolved via `npx expo config --json --type public` — works with `app.json` and `app.config.js/ts`. |

### Failure modes

Distinct `::error::` annotations for: missing `node_modules/`, not an Expo app
(no `app.json`/`app.config.*`), no Android SDK on the runner (self-hosted),
partial keystore inputs, invalid `format`/`prebuild` values, `prebuild: never`
without `android/`, and a configured keystore that signing never applied
(marker-file check — no silently wrong-signed binaries).

## deploy-github-release

### Inputs

| Input | Default | Description |
|---|---|---|
| `files` | *(required)* | **Newline-separated** glob patterns, one per line; spaces within a line are literal. A pattern matching nothing fails, naming the pattern. |
| `tag` | `v<app-version>` | Release tag; one of `tag`/`app-version` required. |
| `app-version` | — | Pipe from `build-android`'s `app-version` output. |
| `release-name` | tag | Release title. |
| `draft` | `false` | Create as draft. |
| `prerelease` | `false` | Mark prerelease. |
| `overwrite` | `false` | Existing tag/release: `false` fails; `true` keeps the release and re-uploads assets with `--clobber`. |
| `generate-checksums` | `true` | Upload `sha256sums.txt` covering all assets. |
| `token` | `github.token` | Token with `contents: write`. |

### Outputs

| Output | Description |
|---|---|
| `release-url` | URL of the release. |
| `uploaded-assets` | Newline-separated uploaded asset names. |

## Why no EAS?

`eas build --local` refuses to run without an Expo account
([expo/eas-cli#1606](https://github.com/expo/eas-cli/issues/1606), closed
"not planned"), and every "Expo CI/CD" Marketplace action shells out to
`eas-cli`. This suite bypasses it entirely: prebuild's template comes from the
public npm registry and the rest is stock Android tooling. The action exports
`EXPO_NO_TELEMETRY=1` for clean-room builds.

## Testing

Unit: `bats expo-builder/build-android/__tests__/*.bats expo-builder/deploy-github-release/__tests__/*.bats`
(real files/dirs, real keytool keystore; network binaries shimmed).
End-to-end: [`expo-integration.yml`](../.github/workflows/expo-integration.yml)
builds a real `create-expo-app@4.0.0` (SDK 57) fixture with a real keystore and
round-trips a real GitHub Release — with zero Expo credentials in the job.
