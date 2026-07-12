# expo-builder P2: deploy-google-play — Plan

**Date:** 2026-07-12   **Status:** Approved   **Spec:** docs/toolu/specs/2026-07-11-expo-builder-p2-google-play-design.md   **Topic:** Implement the native (bash/openssl/curl) Google Play AAB deploy sub-action.

## Context

P1 shipped (v6.1.0) with build-android + deploy-github-release; the approved P2 spec adds `expo-builder/deploy-google-play`: service-account JWT bearer auth minted with openssl, then the Android Publisher v3 edits flow (insert → upload bundle → tracks.update → commit) in plain curl. No third-party actions, no fastlane.

## Approach

Mirror the P1 sub-action pattern exactly. Reuse (paths verified in P1):

- `expo-builder/__tests__/helpers.bash` — `common_setup`, `make_shim`/`shim_calls` (curl gets the PATH-shim treatment gh/npx got), GITHUB_OUTPUT/RUNNER_TEMP plumbing.
- P1 script conventions: `set -euo pipefail`, quoted expansions, distinct named `::error::`s, BSD/macOS-safe (base64url via `openssl base64 -A | tr '+/' '-_' | tr -d '='`; the P1 base64 decode-flag probe for input decoding; no GNU-only flags).
- CI shapes in `.github/workflows/tests.yml` (expo-test / expo-lint jobs) and the `HAS_PUSH_TOKEN`-style secret gate from `release.yml` for the integration job.
- Mirror publishing needs NO change: `layout_expo_builder()` copies the whole suite tree (mirror-action.bats already proves subdir inclusion).

Script split (spec-pinned): `play-token.sh` (SA JSON → RS256 JWT → OAuth token on stdout) and `deploy.sh` (validation → token capture + `::add-mask::` → edits flow → outputs), both invoked inside ONE composite step so secrets never cross a step boundary.

Real-data testing: JWT tests use a REAL `openssl genrsa` keypair and VERIFY the signature; API tests replay real-shaped androidpublisher/oauth JSON through the curl shim; the live path is the secret-gated integration job.

## Steps (machine-readable)

```json
[
  {
    "id": "play-action-yml",
    "title": "Scaffold expo-builder/deploy-google-play/action.yml — composite, single bash step, EXPO_BUILDER_PLAY_* env mapping for all 7 inputs, outputs version-code/track wired from the step",
    "check": "npx --yes @action-validator/cli expo-builder/deploy-google-play/action.yml",
    "ac_refs": ["AC-7"]
  },
  {
    "id": "play-token-sh",
    "title": "src/play-token.sh: decode base64 SA JSON (P1 flag probe), jq -r client_email/private_key, key file via mktemp under RUNNER_TEMP chmod 600 + EXIT trap, RS256 JWT (iss/scope/aud, exp=iat+3600, base64url via openssl+tr), token exchange at oauth2.googleapis.com, token to stdout, ::error:: on bad key/HTTP failure. Bats: REAL openssl genrsa fixture -> JWT signature VERIFIES via openssl dgst -verify + claims assertions; temp key gone after exit; OAuth-401 replay exits non-zero; token printed to stdout only",
    "check": "bats expo-builder/deploy-google-play/__tests__/play-token.bats",
    "ac_refs": ["AC-1", "AC-3"],
    "depends_on": ["play-action-yml"]
  },
  {
    "id": "deploy-sh",
    "title": "src/deploy.sh: validate ALL inputs BEFORE network — base64/JSON/client_email+private_key, aab exists, release-status in {completed,draft}, package-name non-empty, track non-empty, upload-timeout positive int; changes-not-sent-for-review: exactly 'true' adds the commit query param, any other value treated as false (passthrough, documented). Token capture + immediate ::add-mask::; edits flow insert->upload(/upload/ path, octet-stream, --max-time ONLY here)->tracks PUT(versionCode from upload response, status)->commit; curl exit codes 28/35/52 surfaced distinct from HTTP>=400 (Google message verbatim + applicationNotFound/draft-status/expired-edit hints); GITHUB_OUTPUT version-code+track. Bats: zero-curl validation failures, happy-path exact call order + body assertions, 404 hint, commit-400 variants, curl-28 transport error, add-mask before first API call, GITHUB_ENV untouched, no key/token in output",
    "check": "bats expo-builder/deploy-google-play/__tests__/deploy.bats",
    "ac_refs": ["AC-2", "AC-3", "AC-4", "AC-5"],
    "depends_on": ["play-token-sh"]
  },
  {
    "id": "wire-tests-yml",
    "title": "tests.yml: expo-test bats line appends expo-builder/deploy-google-play/__tests__/*.bats; expo-lint shellcheck appends expo-builder/deploy-google-play/src/*.sh and gains an action-validator (deploy-google-play) step",
    "check": "grep -qF 'expo-builder/deploy-google-play/__tests__/*.bats' .github/workflows/tests.yml && grep -qF 'expo-builder/deploy-google-play/src/*.sh' .github/workflows/tests.yml && grep -qF 'expo-builder/deploy-google-play/action.yml' .github/workflows/tests.yml",
    "ac_refs": ["AC-7"],
    "depends_on": ["deploy-sh"]
  },
  {
    "id": "integration-play",
    "title": "expo-integration.yml: MODIFIES the existing P1 build-signed job — add an actions/upload-artifact@v7 step for the AAB (additive only; APK artifact + all assertions untouched). New play-deploy job (needs build-signed) gated HAS_PLAY_SECRETS on PLAY_SERVICE_ACCOUNT_JSON_B64+PLAY_PACKAGE_NAME (release.yml HAS_PUSH_TOKEN pattern) — present: download AAB, run deploy-google-play with track internal + release-status draft; absent: single ::notice:: + clean skip",
    "check": "f=.github/workflows/expo-integration.yml; grep -qF 'PLAY_SERVICE_ACCOUNT_JSON_B64' $f && grep -qF 'deploy-google-play' $f && grep -qF 'release-status' $f && grep -qF 'HAS_PLAY_SECRETS' $f",
    "ac_refs": ["AC-6"],
    "depends_on": ["deploy-sh"]
  },
  {
    "id": "docs-sync",
    "title": "expo-builder/README.md deploy-google-play section: inputs/outputs tables, Play prerequisites (SA linking + app permissions + manual first upload), draft-until-reviewed caveat, TRACK-REPLACEMENT semantics prominent, upload-timeout guidance, build->Play example; root README sub-action list gains deploy-google-play",
    "check": "for i in service-account-json-base64 package-name aab-path track release-status changes-not-sent-for-review upload-timeout version-code; do grep -q -- \"$i\" expo-builder/README.md || { echo \"missing: $i\"; exit 1; }; done && grep -qi 'replaces' expo-builder/README.md && grep -qF 'expo-builder/deploy-google-play@' expo-builder/README.md && grep -qF 'deploy-google-play' README.md",
    "ac_refs": ["AC-8"],
    "depends_on": ["integration-play"]
  },
  {
    "id": "full-gate",
    "title": "Full local gate: shellcheck every suite script, all suite bats, action-validator on all three expo-builder action.yml",
    "check": "shellcheck --severity=warning expo-builder/build-android/src/*.sh expo-builder/deploy-github-release/src/*.sh expo-builder/deploy-google-play/src/*.sh && bats expo-builder/build-android/__tests__/*.bats expo-builder/deploy-github-release/__tests__/*.bats expo-builder/deploy-google-play/__tests__/*.bats && npx --yes @action-validator/cli expo-builder/build-android/action.yml && npx --yes @action-validator/cli expo-builder/deploy-github-release/action.yml && npx --yes @action-validator/cli expo-builder/deploy-google-play/action.yml",
    "ac_refs": ["AC-7"],
    "depends_on": ["wire-tests-yml", "docs-sync"]
  }
]
```

## Critical files

Create:
- `expo-builder/deploy-google-play/action.yml`
- `expo-builder/deploy-google-play/src/{play-token.sh, deploy.sh}`
- `expo-builder/deploy-google-play/__tests__/{play-token, deploy}.bats`

Modify:
- `.github/workflows/tests.yml` (expo-test/expo-lint additions)
- `.github/workflows/expo-integration.yml` (AAB artifact + gated play-deploy job)
- `expo-builder/README.md`, `README.md`

## Verification

1. Local: `full-gate` check exits 0.
2. Push branch → `tests.yml` green incl. new bats on both OSes; `expo-integration.yml` green with play-deploy SKIPPING cleanly (no secrets in repo yet — OQ-1).
3. When Falconiere adds `PLAY_SERVICE_ACCOUNT_JSON_B64`/`PLAY_PACKAGE_NAME`: dispatch expo-integration → real draft upload to internal track proves AC-6's live path. Success criteria: play-deploy job green, step summary/log contains `version-code=<int>` and the released-to-track log line, zero `::error::` annotations. Expected failure signatures if prerequisites missing: `applicationNotFound` (package never manually uploaded / SA lacks app access — fix in Play Console), commit 400 review-state message (app not yet reviewed — keep `release-status: draft`).

## Notes for execution

- curl shim replay fixtures: JSON shapes straight from the researched API docs — token `{access_token, expires_in, token_type}`, AppEdit `{id, expiryTimeSeconds}`, Bundle `{versionCode, sha1, sha256}`, Track echo, plus error bodies (404 applicationNotFound, 400 commit variants). Checked in under `__tests__/fixtures/`.
- **curl shim router (the happy-path shim body — one shim handles BOTH endpoint families in a single deploy.sh run).** The shim scans its args for the URL, routes on substrings, prints the fixture followed by the HTTP code (matching deploy.sh's `-w '%{http_code}'` capture); error tests swap individual arms:

  ```bash
  make_shim curl '
  url=""; for a in "$@"; do case "$a" in https://*) url="$a";; esac; done
  case "$url" in
    *oauth2.googleapis.com*)  cat "$FIXTURES/token.json";        printf 200 ;;
    */upload/androidpublisher*/bundles*) cat "$FIXTURES/bundle.json"; printf 200 ;;
    */tracks/*)               cat "$FIXTURES/track.json";        printf 200 ;;
    *:commit*)                cat "$FIXTURES/edit.json";         printf 200 ;;
    */edits*)                 cat "$FIXTURES/edit.json";         printf 200 ;;  # insert — LAST: substring of the others
  esac'
  ```

  Order matters: match the most specific substrings first (`/upload/`, `/tracks/`, `:commit`) and plain `/edits` last. The versionCode flows naturally: deploy.sh parses `bundle.json`'s `versionCode` from the upload response body and embeds it in the tracks PUT `-d` body; the bats assertion greps the recorded tracks invocation (`shim_calls curl`) for `\"versionCodes\": [\"<fixture vc>\"]`.
- play-token.bats uses the same shim mechanism with only the oauth arm (plus a 401-body variant returning `printf 401`).
- **upload-timeout mapping:** `action.yml` maps input → `EXPO_BUILDER_PLAY_UPLOAD_TIMEOUT`; `deploy.sh` validates it as a positive integer during preflight and passes `--max-time "$EXPO_BUILDER_PLAY_UPLOAD_TIMEOUT"` on the bundle-upload curl ONLY — insert/tracks/commit use curl defaults (small JSON round-trips).
- **tests.yml must use the `*.bats` glob form verbatim** (matches the existing expo-test line style) — the wire-tests-yml check greps for that exact literal.
- JWT verify in bats: split the JWT on dots, reconstruct `header.payload`, `openssl dgst -sha256 -verify pub.pem -signature sig.bin` after base64url-decoding the signature; claims parsed with jq from the decoded payload.
- base64url encode (BSD-safe): `openssl base64 -A | tr '+/' '-_' | tr -d '='`; decode input JSON with the P1 flag-probe pattern.
- `deploy.sh` HTTP handling: `curl -sS -w '%{http_code}' -o "$body_file"` per call; transport failure = curl non-zero exit (report exit code meaning), API failure = http_code >= 400 (report body verbatim + hint).
- Version codes in tracks.update: ONLY the uploaded versionCode (spec non-goal 7 — REPLACE semantics documented).
- Integration job needs no new permissions (no GitHub writes); keep `if: always()` OUT — normal failure propagation.
