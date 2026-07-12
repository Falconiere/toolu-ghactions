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
| [`deploy-google-play`](#deploy-google-play) | Upload the AAB to a Google Play track via a service account — native Publisher API v3, no fastlane. |

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

## deploy-google-play

Uploads the AAB to a Google Play track with a **service account** — native
Android Publisher API v3 (OAuth2 JWT bearer minted with openssl, four REST
calls via curl). No fastlane, no third-party actions.

> **Track replacement:** assigning the release **replaces** the track's active
> releases — after this action runs, the track serves ONLY the uploaded
> versionCode. Prior versions are removed from that track. Multi-version
> tracks and staged rollout are out of scope.

### Prerequisites (Play Console, one-time)

1. Create a service account in Google Cloud and download its JSON key.
2. Link it in **Play Console → Setup → API access** and grant it release
   permission for your app (testing tracks and/or production).
3. **Upload the very first AAB for the package manually** in Play Console —
   the API cannot register a new app (`applicationNotFound` otherwise).
4. Apps that have never passed Play review must deploy with
   `release-status: draft` until reviewed once.
5. Store the key as a base64 secret: `base64 -w0 service-account.json`.

```yaml
- uses: falconiere/toolu-ghactions/expo-builder/deploy-google-play@v6
  with:
    service-account-json-base64: ${{ secrets.PLAY_SERVICE_ACCOUNT_JSON_B64 }}
    package-name: com.example.app
    aab-path: ${{ steps.build.outputs.aab-path }}
    track: internal
    release-status: draft
```

### Inputs

| Input | Default | Description |
|---|---|---|
| `service-account-json-base64` | *(required)* | Base64 of the service-account key JSON (base64 keeps the embedded PEM's newlines intact through env). |
| `package-name` | *(required)* | Application id — must already exist in Play Console. |
| `aab-path` | *(required)* | Pipe from `build-android`'s `aab-path` output. |
| `track` | `internal` | `internal` \| `alpha` \| `beta` \| `production`, a custom closed-track id, or a form-factor track (`wear:production`). Passed verbatim. |
| `release-status` | `completed` | `completed` \| `draft`. Never-reviewed apps must use `draft`. |
| `changes-not-sent-for-review` | `false` | `true`: commit with `changesNotSentForReview=true` — hold the change from review submission (pairs with draft releases on not-yet-reviewed apps). |
| `upload-timeout` | `600` | Seconds (`curl --max-time`) for the bundle upload only. Typical AABs upload in seconds; raise for 100MB+ artifacts or slow runners. |

### Outputs

| Output | Description |
|---|---|
| `version-code` | `versionCode` of the uploaded bundle (Play API response). |
| `track` | Track the release landed on. |

### Failure modes

Distinct `::error::` annotations for: invalid base64/key JSON, missing AAB,
invalid `release-status`, empty `track`/`package-name`, non-integer
`upload-timeout`, token exchange failures (Google's message verbatim), curl
transport failures (exit code + meaning, e.g. 28 = timed out) distinct from
HTTP errors, `applicationNotFound` (with the manual-first-upload hint), and
commit rejections (review-state and expired-edit hints). Secrets never touch
job-wide env: the key exists only as a 0600 temp file removed on exit, and the
token is `::add-mask::`ed the moment it is minted.

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
