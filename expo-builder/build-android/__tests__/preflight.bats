#!/usr/bin/env bats
# preflight.bats — preflight.sh validates the app dir + runner with distinct errors.

load ../../__tests__/helpers

setup() {
    common_setup
    SCRIPT="$SUITE_ROOT/build-android/src/preflight.sh"
}

teardown() { common_teardown; }

@test "fails when working-directory does not exist" {
    EXPO_BUILDER_WORKING_DIR="$BATS_TEST_TMPDIR/nope" run "$SCRIPT"
    [ "$status" -eq 1 ]
    [[ "$output" == *"::error::"*"does not exist"* ]]
}

@test "fails without node_modules with install-dependencies error" {
    dir="$(make_app_dir)"
    rm -rf "$dir/node_modules"
    EXPO_BUILDER_WORKING_DIR="$dir" run "$SCRIPT"
    [ "$status" -eq 1 ]
    [[ "$output" == *"::error::node_modules not found"* ]]
    [[ "$output" == *"install dependencies"* ]]
}

@test "fails without any Expo app config with not-an-Expo-app error" {
    dir="$(make_app_dir)"
    rm -f "$dir/app.json"
    EXPO_BUILDER_WORKING_DIR="$dir" run "$SCRIPT"
    [ "$status" -eq 1 ]
    [[ "$output" == *"::error::"*"not an Expo app"* ]]
}

@test "accepts app.config.ts instead of app.json" {
    dir="$(make_app_dir)"
    rm -f "$dir/app.json"
    printf 'export default { version: "1.2.3" };\n' >"$dir/app.config.ts"
    EXPO_BUILDER_WORKING_DIR="$dir" run "$SCRIPT"
    [ "$status" -eq 0 ]
}

@test "fails without an Android SDK with no-Android-SDK error" {
    dir="$(make_app_dir)"
    unset ANDROID_HOME ANDROID_SDK_ROOT
    EXPO_BUILDER_WORKING_DIR="$dir" run "$SCRIPT"
    [ "$status" -eq 1 ]
    [[ "$output" == *"::error::runner has no Android SDK"* ]]
}

@test "passes and persists EXPO_NO_TELEMETRY=1 to GITHUB_ENV" {
    dir="$(make_app_dir)"
    EXPO_BUILDER_WORKING_DIR="$dir" run "$SCRIPT"
    [ "$status" -eq 0 ]
    [[ "$output" == *"preflight ok"* ]]
    grep -q '^EXPO_NO_TELEMETRY=1$' "$GITHUB_ENV"
}

@test "handles a working-directory containing spaces" {
    dir="$(make_app_dir "app with spaces")"
    EXPO_BUILDER_WORKING_DIR="$dir" run "$SCRIPT"
    [ "$status" -eq 0 ]
}
