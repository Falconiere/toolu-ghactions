# expo-builder P2: deploy-google-play — Design

**Date:** 2026-07-11   **Status:** Approved   **Author:** Falconiere Barbosa   **Topic:** Composite sub-action that uploads a built AAB to a Google Play track via the Android Publisher API v3 with a service account — no fastlane, no third-party actions, no Expo account.

## Problem

P1 ships signed AABs to GitHub Releases, but the destination most Android apps need is Google Play. The existing paths there are fastlane (Ruby toolchain) or a third-party community action — the suite so far uses only official actions plus its own bats-tested shell, and adding a third-party trust dependency for what is a four-call REST flow (insert edit → upload bundle → assign track → commit) breaks that posture (user-confirmed: native implementation).

## Non-Goals

1. Store metadata: listings, screenshots, release notes (any locale).
2. Staged rollout — `userFraction`, `inProgress`/`halted` statuses (user-confirmed out; `draft`/`completed` only).
3. Custom-track discovery (`edits.tracks.list`) — `track` is passed through verbatim; consumers using custom closed tracks supply Play's generated track id themselves.
4. APK upload — AAB only (Play requires AAB for new apps since 2021).
5. First-time app registration — the Play API cannot create a package; the very first AAB must be uploaded manually in Play Console (documented prerequisite, actionable error hint on `applicationNotFound`).
6. Expansion files, in-app-update priority, country targeting, form-factor track validation (`wear:production` etc. pass through as strings).
7. Multi-version track composition and rollback: `tracks.update` REPLACES the track's active releases — after this action runs, the track serves ONLY the uploaded versionCode; prior versions are removed from it. Intentional for P2's single-release scope (documented prominently in the README).
8. Retry logic — any network/API failure fails the step; re-run the workflow.
9. iOS/TestFlight (P3), OTA (P4).

## Architecture

New sub-action `expo-builder/deploy-google-play/` mirroring the suite pattern (composite, `src/*.sh`, per-sub-action `__tests__/`, shared `expo-builder/__tests__/helpers.bash`). Two single-responsibility scripts, ONE composite step. The split isolates token minting (testable standalone with REAL JWT crypto verification) from API orchestration (testable with a shimmed curl); the single step guarantees the private key and token never appear in `GITHUB_ENV`, `GITHUB_OUTPUT`, or a step boundary:

1. `src/play-token.sh` — mints an OAuth2 access token from the service-account JSON: extracts `client_email`/`private_key` with `jq -r` (raw output — without `-r` the PEM's `\n` escapes stay literal and openssl rejects the key), builds the JWT (header `{"alg":"RS256","typ":"JWT"}`; claims `iss`=client_email, `scope`=`https://www.googleapis.com/auth/androidpublisher`, `aud`=`https://oauth2.googleapis.com/token`, `exp`=`iat`+3600), signs with `openssl dgst -sha256 -sign` (base64url, BSD-safe), exchanges at `https://oauth2.googleapis.com/token` (`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`), prints the token to stdout. The private key is written only to `mktemp` under `RUNNER_TEMP`, `chmod 600`, removed by an EXIT trap.
2. `src/deploy.sh` — orchestrates: validates inputs, captures `token="$(play-token.sh)"` (in-process; immediately `::add-mask::`ed; under `set -euo pipefail` a non-zero exit from play-token.sh — bad key, OAuth 401/403, timeout — aborts deploy.sh immediately with the token script's `::error::` already emitted), then the v3 edits flow against `https://androidpublisher.googleapis.com`:
   - `POST /androidpublisher/v3/applications/{pkg}/edits` → `editId`
   - `POST /upload/androidpublisher/v3/applications/{pkg}/edits/{editId}/bundles` (`Content-Type: application/octet-stream`, raw AAB bytes, generous `--max-time`) → `versionCode`
   - `PUT /androidpublisher/v3/applications/{pkg}/edits/{editId}/tracks/{track}` with `{"track": t, "releases": [{"versionCodes": ["<vc>"], "status": s}]}`
   - `POST .../edits/{editId}:commit` (optional `changesNotSentForReview=true`)
   Every curl distinguishes transport failures from API errors: a non-zero curl exit is surfaced as `::error::` naming the curl exit code and its meaning (28 = timeout, 35 = TLS, 52 = empty reply); an HTTP ≥400 surfaces Google's error message verbatim inside a distinct `::error::` with targeted hints (`applicationNotFound` → "first AAB must be uploaded manually in Play Console + check the service account's app access"; commit 400 mentioning review state → "apps not yet reviewed must use release-status: draft"; commit 400 mentioning an expired/invalid edit → "the Play edit expired or was superseded mid-deploy — re-run the workflow"). No retries (non-goal 8).

**Driving trade-off:** owning ~2 small scripts vs depending on `r0adkll/upload-google-play` (community action; currently carrying Node-runtime-migration friction, GH issue #256). Consistency, supply-chain posture, and bats-testability win; the flow is four documented REST calls. Rejected: fastlane supply (Ruby toolchain for one endpoint family).

**Reuse:** suite helpers (`expo-builder/__tests__/helpers.bash` — `make_shim`, GITHUB_OUTPUT/RUNNER_TEMP plumbing), P1 conventions (all-inputs validation with named `::error::`, `set -euo pipefail`, quoted expansions, BSD/macOS-safe: no GNU-only flags, `base64` via the P1 flag probe or `openssl base64`), `tests.yml` expo jobs, `expo-integration.yml`, mirror already syncs the whole `expo-builder/` tree (no `mirror-action.sh` change — verify via existing bats).

## Interfaces / Schema

### `expo-builder/deploy-google-play/action.yml`

```yaml
inputs:
  service-account-json-base64: { required: true } # base64 of the Play service-account key JSON (secret).
                                                  # Base64 like P1's keystore-base64: raw multi-line JSON
                                                  # through env risks CRLF/newline mangling of the PEM.
  package-name:         { required: true }   # e.g. com.example.app — must already exist in Play Console
  aab-path:             { required: true }   # pipe from build-android's aab-path output
  track:                { default: "internal" }  # internal | alpha | beta | production | custom/formfactor ids (verbatim)
  release-status:       { default: "completed" } # completed | draft (apps never yet reviewed MUST use draft)
  changes-not-sent-for-review: { default: "false" } # true: commit with changesNotSentForReview=true — hold the
                                                    # change from Play review submission (pairs with draft
                                                    # releases on not-yet-reviewed apps; harmless otherwise)
  upload-timeout:       { default: "600" }   # seconds, curl --max-time for the bundle upload ONLY (typical
                                             # AABs take seconds; raise for 100MB+ artifacts / slow runners)
outputs:
  version-code:  # from the Bundle upload response
  track:         # the track released to (echo of input, post-success)
```

Single composite step, `shell: bash`, env `EXPO_BUILDER_PLAY_*` mapping each input; runs `deploy.sh`.

### Validation contract (all before any network call)

- `service-account-json-base64` decodes (P1's base64 flag probe) AND parses as JSON AND `jq -r` yields non-empty `client_email` + `private_key` → else `::error::service-account-json-base64 is not a valid service-account key (bad base64/JSON or missing client_email/private_key)`.
- `aab-path` exists and non-empty file → else `::error::no AAB at '<path>' — pipe build-android's aab-path output`.
- `release-status` ∈ {completed, draft} → else `::error::invalid release-status '<s>' (expected completed | draft)`.
- `package-name` non-empty; `upload-timeout` positive integer.

### Secrets handling

Token and private key exist only inside the single step's process tree: key file in `RUNNER_TEMP` (0600, EXIT-trap removed), token in a shell variable masked via `::add-mask::` the moment it is minted. Nothing is written to `GITHUB_ENV`/`GITHUB_OUTPUT` except the non-secret outputs above (P1 review precedent).

## Acceptance criteria

Unit tests use REAL crypto and REAL-shaped recorded responses; only the network binary (`curl`) is PATH-shimmed (suite precedent: gh/npx shims; real HTTP proven by the gated integration job).

- **AC-1:** `play-token.sh` with a service-account JSON fixture built around a REAL `openssl genrsa` key produces a JWT whose RS256 signature VERIFIES against the extracted public key (`openssl dgst -verify`), with claims `iss`/`scope`/`aud` exact and `exp - iat == 3600`; the key temp file is gone after exit and the token is printed to stdout only.
- **AC-2:** `deploy.sh` happy path against a curl shim replaying real-shaped androidpublisher JSON: calls occur in exact order insert-edit → bundle upload (URL contains `/upload/androidpublisher/v3/` and `Content-Type: application/octet-stream`) → `tracks/{track}` PUT whose body carries the versionCode from the upload response and the requested status → `:commit`; `GITHUB_OUTPUT` gains `version-code` and `track`.
- **AC-3:** Validation failures (bad base64/JSON, missing AAB file, bad release-status) exit 1 with their named `::error::` and the curl shim records ZERO invocations; a replayed OAuth 401 makes `play-token.sh` exit non-zero and `deploy.sh` abort before any androidpublisher call.
- **AC-4:** Error surfacing: a replayed 404 `applicationNotFound` produces the manual-first-upload + service-account-access hint; a replayed commit 400 surfaces Google's message verbatim (expired-edit variant carries the re-run hint); a curl transport failure (shim exits 28) is reported as a timeout, distinct from HTTP errors.
- **AC-5:** Secret hygiene: bats asserts `::add-mask::` is emitted for the token before any API curl, `GITHUB_ENV` stays untouched, and no output line contains the private key or token value.
- **AC-6:** Secret-gated integration job in `expo-integration.yml`: with `PLAY_SERVICE_ACCOUNT_JSON_B64` + `PLAY_PACKAGE_NAME` secrets present it uploads the signed-build job's AAB to the `internal` track as `draft` for real; absent secrets → single `::notice::` and clean skip (job green either way, mirroring the release.yml `HAS_PUSH_TOKEN` pattern).
- **AC-7:** `action.yml` passes `action-validator`; scripts pass `shellcheck --severity=warning`; bats green on ubuntu + macos. `tests.yml` gains the explicit new paths: expo-test bats line appends `expo-builder/deploy-google-play/__tests__/*.bats`, expo-lint shellcheck appends `expo-builder/deploy-google-play/src/*.sh` plus an action-validator step for the new `action.yml` (jq already installed in both matrix legs).
- **AC-8:** Docs in sync — `expo-builder/README.md` gains a deploy-google-play section (all inputs/outputs; Play prerequisites: service-account linking + app permissions + manual first upload; draft-until-reviewed caveat; **track-replacement semantics** — the track ends up serving only the uploaded version; upload-timeout guidance; build→Play example); root `README.md` sub-action list updated.

## Open Questions

- **OQ-1:** Real Play credentials for AC-6's live path (a registered package + linked service account) — owner: Falconiere; the job skips cleanly until the secrets exist, so this blocks nothing.
