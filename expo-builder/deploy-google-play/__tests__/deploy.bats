#!/usr/bin/env bats
# deploy.bats — the edits flow against a curl shim routing real-shaped Play API
# replays on URL substrings (most-specific first; plain /edits LAST). Real
# files, real keypair via play-token.sh; only the network binary is shimmed.

load ../../__tests__/helpers

setup() {
    common_setup
    SCRIPT="$SUITE_ROOT/deploy-google-play/src/deploy.sh"
    FIXTURES="$SUITE_ROOT/deploy-google-play/__tests__/fixtures"

    openssl genrsa -out "$BATS_TEST_TMPDIR/sa.pem" 2048 2>/dev/null
    jq -n --rawfile key "$BATS_TEST_TMPDIR/sa.pem" \
        '{client_email: "ci@project.iam.gserviceaccount.com", private_key: $key}' \
        >"$BATS_TEST_TMPDIR/sa.json"
    SA_B64="$(base64 <"$BATS_TEST_TMPDIR/sa.json" | tr -d '\n')"

    printf 'aab-bytes' >"$BATS_TEST_TMPDIR/app.aab"

    export EXPO_BUILDER_PLAY_SA_B64="$SA_B64"
    export EXPO_BUILDER_PLAY_PACKAGE="com.example.app"
    export EXPO_BUILDER_PLAY_AAB="$BATS_TEST_TMPDIR/app.aab"
    export EXPO_BUILDER_PLAY_TRACK="internal"
    export EXPO_BUILDER_PLAY_STATUS="draft"
    export EXPO_BUILDER_PLAY_HOLD_REVIEW="false"
    export EXPO_BUILDER_PLAY_UPLOAD_TIMEOUT="600"
    export EXPO_BUILDER_PLAY_TOKEN_SCRIPT="$SUITE_ROOT/deploy-google-play/src/play-token.sh"

    happy_shim
}

teardown() { common_teardown; }

# Shim preamble honoring curl's real protocol: the body goes to the -o target,
# ONLY the status code goes to stdout (matches -w '%{http_code}' capture).
SHIM_PREAMBLE='
url=""; out=/dev/stdout; prev=""
for a in "$@"; do
  case "$a" in https://*) url="$a";; esac
  if [ "$prev" = "-o" ]; then out="$a"; fi
  prev="$a"
done'

# One shim body serves BOTH endpoint families in a single deploy.sh run.
# Most-specific URL substrings first; plain /edits (insert) LAST.
happy_shim() {
    make_shim curl "$SHIM_PREAMBLE
case \"\$url\" in
  *oauth2.googleapis.com*)              cat '$FIXTURES/token.json'  >\"\$out\"; printf 200 ;;
  */upload/androidpublisher*/bundles*)  cat '$FIXTURES/bundle.json' >\"\$out\"; printf 200 ;;
  */tracks/*)                           cat '$FIXTURES/track.json'  >\"\$out\"; printf 200 ;;
  *:commit*)                            cat '$FIXTURES/edit.json'   >\"\$out\"; printf 200 ;;
  */edits*)                             cat '$FIXTURES/edit.json'   >\"\$out\"; printf 200 ;;
esac"
}

# Replace ONE routing arm with an error replay, keep the rest happy.
shim_with_error_arm() {
    local match="$1" fixture="$2" code="$3"
    make_shim curl "$SHIM_PREAMBLE
case \"\$url\" in
  $match)                               cat '$FIXTURES/$fixture'    >\"\$out\"; printf $code ;;
  *oauth2.googleapis.com*)              cat '$FIXTURES/token.json'  >\"\$out\"; printf 200 ;;
  */upload/androidpublisher*/bundles*)  cat '$FIXTURES/bundle.json' >\"\$out\"; printf 200 ;;
  */tracks/*)                           cat '$FIXTURES/track.json'  >\"\$out\"; printf 200 ;;
  *:commit*)                            cat '$FIXTURES/edit.json'   >\"\$out\"; printf 200 ;;
  */edits*)                             cat '$FIXTURES/edit.json'   >\"\$out\"; printf 200 ;;
esac"
}

@test "happy path: exact call order, bodies, and outputs" {
    run "$SCRIPT"
    [ "$status" -eq 0 ]

    # Call order: token, insert edit, upload, tracks, commit.
    calls="$SHIM_DIR/curl.calls"
    [ "$(grep -c . "$calls")" -eq 5 ]
    sed -n 1p "$calls" | grep -q 'oauth2.googleapis.com/token'
    sed -n 2p "$calls" | grep -q '/androidpublisher/v3/applications/com.example.app/edits'
    sed -n 3p "$calls" | grep -q '/upload/androidpublisher/v3/applications/com.example.app/edits/edit-7391/bundles'
    sed -n 3p "$calls" | grep -q 'Content-Type: application/octet-stream'
    sed -n 3p "$calls" | grep -q -- '--max-time 600'
    sed -n 4p "$calls" | grep -q '/edits/edit-7391/tracks/internal'
    # versionCode from the upload response flows into the tracks PUT body.
    sed -n 4p "$calls" | grep -qF '"versionCodes":["42"]'
    sed -n 4p "$calls" | grep -qF '"status":"draft"'
    sed -n 5p "$calls" | grep -q '/edits/edit-7391:commit'
    # changesNotSentForReview NOT set when hold-review is false.
    ! sed -n 5p "$calls" | grep -q 'changesNotSentForReview'

    grep -q '^version-code=42$' "$GITHUB_OUTPUT"
    grep -q '^track=internal$' "$GITHUB_OUTPUT"
    [[ "$output" == *"released versionCode 42 to 'internal' as draft"* ]]
}

@test "changes-not-sent-for-review=true adds the commit query param" {
    EXPO_BUILDER_PLAY_HOLD_REVIEW="true" run "$SCRIPT"
    [ "$status" -eq 0 ]
    grep -q ':commit?changesNotSentForReview=true' "$SHIM_DIR/curl.calls"
}

@test "token is masked before the first API call" {
    run "$SCRIPT"
    [ "$status" -eq 0 ]
    # ::add-mask:: emitted, and no output line leaks the raw token unmasked
    # anywhere other than the mask command itself.
    [[ "$output" == *"::add-mask::ya29.test-access-token-value"* ]]
    [ "$(printf '%s\n' "$output" | grep -c 'ya29.test-access-token-value')" -eq 1 ]
    ! grep -q 'ya29' "$GITHUB_ENV"
    ! grep -q 'ya29' "$GITHUB_OUTPUT"
}

@test "validation failures make zero network calls" {
    for case_env in \
        "EXPO_BUILDER_PLAY_SA_B64=%%%bad%%%" \
        "EXPO_BUILDER_PLAY_PACKAGE=" \
        "EXPO_BUILDER_PLAY_AAB=$BATS_TEST_TMPDIR/missing.aab" \
        "EXPO_BUILDER_PLAY_TRACK=" \
        "EXPO_BUILDER_PLAY_STATUS=inProgress" \
        "EXPO_BUILDER_PLAY_UPLOAD_TIMEOUT=zero"; do
        rm -f "$SHIM_DIR/curl.calls"
        run env "$case_env" "$SCRIPT"
        [ "$status" -eq 1 ]
        [[ "$output" == *"::error::"* ]]
        [ ! -f "$SHIM_DIR/curl.calls" ]
    done
}

@test "AAB path containing spaces uploads fine (quoted @file argument)" {
    mkdir -p "$BATS_TEST_TMPDIR/out dir"
    printf 'aab-bytes' >"$BATS_TEST_TMPDIR/out dir/app release.aab"
    EXPO_BUILDER_PLAY_AAB="$BATS_TEST_TMPDIR/out dir/app release.aab" run "$SCRIPT"
    [ "$status" -eq 0 ]
    grep -qF "@$BATS_TEST_TMPDIR/out dir/app release.aab" "$SHIM_DIR/curl.calls"
    grep -q '^version-code=42$' "$GITHUB_OUTPUT"
}

@test "track with unsafe characters is rejected before any network call" {
    EXPO_BUILDER_PLAY_TRACK='internal","x":"y' run "$SCRIPT"
    [ "$status" -eq 1 ]
    [[ "$output" == *"::error::invalid track"* ]]
    [ ! -f "$SHIM_DIR/curl.calls" ]
}

@test "invalid release-status names the enum" {
    EXPO_BUILDER_PLAY_STATUS="inProgress" run "$SCRIPT"
    [ "$status" -eq 1 ]
    [[ "$output" == *"invalid release-status 'inProgress' (expected completed | draft)"* ]]
}

@test "OAuth 401 aborts before any androidpublisher call" {
    shim_with_error_arm '*oauth2.googleapis.com*' token-401.json 401
    run "$SCRIPT"
    [ "$status" -eq 1 ]
    [[ "$output" == *"token exchange failed (HTTP 401)"* ]]
    ! grep -q 'androidpublisher' "$SHIM_DIR/curl.calls"
}

@test "404 applicationNotFound carries the manual-first-upload hint" {
    shim_with_error_arm '*/edits*' error-app-not-found.json 404
    run "$SCRIPT"
    [ "$status" -eq 1 ]
    [[ "$output" == *"insert edit failed (HTTP 404)"* ]]
    [[ "$output" == *"uploaded manually in Play Console"* ]]
}

@test "commit 400 review-state surfaces Google's message + draft hint" {
    shim_with_error_arm '*:commit*' error-commit-review.json 400
    run "$SCRIPT"
    [ "$status" -eq 1 ]
    [[ "$output" == *"commit edit failed (HTTP 400)"* ]]
    [[ "$output" == *"changesNotSentForReview"* ]]
    [[ "$output" == *"release-status: draft"* ]]
}

@test "commit 400 expired-edit carries the re-run hint" {
    shim_with_error_arm '*:commit*' error-edit-expired.json 400
    run "$SCRIPT"
    [ "$status" -eq 1 ]
    [[ "$output" == *"edit expired or was superseded mid-deploy"* ]]
}

@test "upload transport timeout (curl exit 28) reported distinct from HTTP errors" {
    make_shim curl "$SHIM_PREAMBLE
case \"\$url\" in
  *oauth2.googleapis.com*) cat '$FIXTURES/token.json' >\"\$out\"; printf 200 ;;
  */upload/*)              exit 28 ;;
  */edits*)                cat '$FIXTURES/edit.json'  >\"\$out\"; printf 200 ;;
esac"
    run "$SCRIPT"
    [ "$status" -eq 1 ]
    [[ "$output" == *"bundle upload transport failure (curl exit 28 — timed out)"* ]]
    [[ "$output" != *"HTTP"* ]]
}
