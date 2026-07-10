#!/usr/bin/env bats
# setup-signing.bats — all-four-or-none keystore contract, debug fallback,
# require-signing, and a REAL keytool-generated keystore decode roundtrip.

load ../../__tests__/helpers

setup() {
    common_setup
    SCRIPT="$SUITE_ROOT/build-android/src/setup-signing.sh"
}

teardown() { common_teardown; }

@test "no keystore inputs falls back to debug keystore with warning" {
    run "$SCRIPT"
    [ "$status" -eq 0 ]
    [[ "$output" == *"::warning::no keystore inputs"* ]]
    [[ "$output" == *"debug-keystore fallback"* ]]
    ! grep -q 'EXPO_BUILDER_KEYSTORE_PATH' "$GITHUB_ENV"
}

@test "require-signing=true with no keystore inputs is an error" {
    EXPO_BUILDER_REQUIRE_SIGNING="true" run "$SCRIPT"
    [ "$status" -eq 1 ]
    [[ "$output" == *"::error::require-signing is true but no keystore inputs"* ]]
}

@test "partial keystore inputs (2 of 4) fail naming the missing ones" {
    EXPO_BUILDER_INPUT_KEYSTORE_BASE64="Zm9v" \
        EXPO_BUILDER_INPUT_KEYSTORE_PASSWORD="pw" run "$SCRIPT"
    [ "$status" -eq 1 ]
    [[ "$output" == *"::error::incomplete keystore inputs"* ]]
    [[ "$output" == *"key-alias"* ]]
    [[ "$output" == *"key-password"* ]]
    [[ "$output" != *"keystore-base64"* ]]
}

@test "invalid base64 fails with decode error" {
    EXPO_BUILDER_INPUT_KEYSTORE_BASE64="%%%not-base64%%%" \
        EXPO_BUILDER_INPUT_KEYSTORE_PASSWORD="pw" \
        EXPO_BUILDER_INPUT_KEY_ALIAS="release" \
        EXPO_BUILDER_INPUT_KEY_PASSWORD="pw" run "$SCRIPT"
    [ "$status" -eq 1 ]
    [[ "$output" == *"::error::keystore-base64 did not decode"* ]]
}

@test "real keytool keystore roundtrips into RUNNER_TEMP and GITHUB_ENV" {
    command -v keytool >/dev/null || skip "keytool (JDK) not available locally — always present in CI"
    keytool -genkeypair -v -keystore "$BATS_TEST_TMPDIR/release.keystore" \
        -storepass password1 -keypass password1 -alias release \
        -keyalg RSA -keysize 2048 -validity 1 -dname "CN=expo-builder-test" >/dev/null 2>&1
    b64="$(base64 <"$BATS_TEST_TMPDIR/release.keystore" | tr -d '\n')"

    EXPO_BUILDER_INPUT_KEYSTORE_BASE64="$b64" \
        EXPO_BUILDER_INPUT_KEYSTORE_PASSWORD="password1" \
        EXPO_BUILDER_INPUT_KEY_ALIAS="release" \
        EXPO_BUILDER_INPUT_KEY_PASSWORD="password1" run "$SCRIPT"
    [ "$status" -eq 0 ]

    path="$(sed -n 's/^EXPO_BUILDER_KEYSTORE_PATH=//p' "$GITHUB_ENV")"
    [[ "$path" == "$RUNNER_TEMP"/expo-builder.*/release.keystore ]]
    [ -s "$path" ]
    cmp -s "$path" "$BATS_TEST_TMPDIR/release.keystore"
    # Secrets must NOT persist in job-wide GITHUB_ENV — the Build step gets
    # them step-scoped from the action inputs.
    ! grep -q 'password1' "$GITHUB_ENV"
    ! grep -q 'EXPO_BUILDER_KEYSTORE_PASSWORD' "$GITHUB_ENV"
    ! grep -q 'EXPO_BUILDER_KEY_PASSWORD' "$GITHUB_ENV"
}
