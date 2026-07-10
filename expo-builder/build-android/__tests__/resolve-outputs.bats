#!/usr/bin/env bats
# resolve-outputs.bats — artifact lookup against a real Gradle output tree and
# version resolution from fixtures/expo-config.sdk57.json (captured from a real
# `npx expo config --json --type public` run on the SDK 57 fixture app).

load ../../__tests__/helpers

setup() {
    common_setup
    SCRIPT="$SUITE_ROOT/build-android/src/resolve-outputs.sh"
    FIXTURE="$SUITE_ROOT/build-android/__tests__/fixtures/expo-config.sdk57.json"
    APP="$(make_app_dir)"
    make_shim npx "cat '$FIXTURE'"
}

teardown() { common_teardown; }

make_artifacts() {
    mkdir -p "$APP/android/app/build/outputs/apk/release" \
        "$APP/android/app/build/outputs/bundle/release"
    printf 'apk-bytes' >"$APP/android/app/build/outputs/apk/release/app-release.apk"
    printf 'aab-bytes' >"$APP/android/app/build/outputs/bundle/release/app-release.aab"
}

@test "invalid format fails with named error" {
    EXPO_BUILDER_WORKING_DIR="$APP" EXPO_BUILDER_FORMAT="deb" run "$SCRIPT"
    [ "$status" -eq 1 ]
    [[ "$output" == *"::error::invalid format 'deb'"* ]]
}

@test "missing APK fails naming the artifact" {
    EXPO_BUILDER_WORKING_DIR="$APP" EXPO_BUILDER_FORMAT="apk" run "$SCRIPT"
    [ "$status" -eq 1 ]
    [[ "$output" == *"no .apk found"* ]]
}

@test "format=apk resolves absolute apk-path and real-capture app-version" {
    make_artifacts
    EXPO_BUILDER_WORKING_DIR="$APP" EXPO_BUILDER_FORMAT="apk" run "$SCRIPT"
    [ "$status" -eq 0 ]
    apk="$(sed -n 's/^apk-path=//p' "$GITHUB_OUTPUT")"
    [[ "$apk" == /*"/android/app/build/outputs/apk/release/app-release.apk" ]]
    [ -f "$apk" ]
    [ "$(sed -n 's/^aab-path=//p' "$GITHUB_OUTPUT")" = "" ]
    grep -q '^app-version=1.0.0$' "$GITHUB_OUTPUT"
    [[ "$(shim_calls npx)" == "expo config --json --type public" ]]
}

@test "format=both resolves both artifact paths" {
    make_artifacts
    EXPO_BUILDER_WORKING_DIR="$APP" EXPO_BUILDER_FORMAT="both" run "$SCRIPT"
    [ "$status" -eq 0 ]
    grep -q '^apk-path=/.*app-release.apk$' "$GITHUB_OUTPUT"
    grep -q '^aab-path=/.*app-release.aab$' "$GITHUB_OUTPUT"
}

@test "config without a version fails with resolution error" {
    make_artifacts
    make_shim npx 'echo "{}"'
    EXPO_BUILDER_WORKING_DIR="$APP" EXPO_BUILDER_FORMAT="apk" run "$SCRIPT"
    [ "$status" -eq 1 ]
    [[ "$output" == *"::error::could not resolve app version"* ]]
}
