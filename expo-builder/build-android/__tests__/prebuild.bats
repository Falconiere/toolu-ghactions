#!/usr/bin/env bats
# prebuild.bats — prebuild.sh mode matrix (auto | always | never) against real
# directories; npx is a recording shim (real expo runs in expo-integration.yml).

load ../../__tests__/helpers

setup() {
    common_setup
    SCRIPT="$SUITE_ROOT/build-android/src/prebuild.sh"
    APP="$(make_app_dir)"
    make_shim npx
}

teardown() { common_teardown; }

@test "invalid mode fails with named error" {
    EXPO_BUILDER_WORKING_DIR="$APP" EXPO_BUILDER_PREBUILD="sometimes" run "$SCRIPT"
    [ "$status" -eq 1 ]
    [[ "$output" == *"::error::invalid prebuild mode 'sometimes'"* ]]
}

@test "auto skips with message when android/ exists and does not call expo" {
    mkdir -p "$APP/android"
    EXPO_BUILDER_WORKING_DIR="$APP" EXPO_BUILDER_PREBUILD="auto" run "$SCRIPT"
    [ "$status" -eq 0 ]
    [[ "$output" == *"skipping prebuild (android/ already exists)"* ]]
    [ ! -f "$SHIM_DIR/npx.calls" ]
}

@test "auto runs expo prebuild --platform android when android/ is absent" {
    EXPO_BUILDER_WORKING_DIR="$APP" EXPO_BUILDER_PREBUILD="auto" run "$SCRIPT"
    [ "$status" -eq 0 ]
    [[ "$(shim_calls npx)" == "expo prebuild --platform android" ]]
}

@test "always runs prebuild even when android/ exists" {
    mkdir -p "$APP/android"
    EXPO_BUILDER_WORKING_DIR="$APP" EXPO_BUILDER_PREBUILD="always" run "$SCRIPT"
    [ "$status" -eq 0 ]
    [[ "$(shim_calls npx)" == "expo prebuild --platform android" ]]
}

@test "never with android/ present skips with message" {
    mkdir -p "$APP/android"
    EXPO_BUILDER_WORKING_DIR="$APP" EXPO_BUILDER_PREBUILD="never" run "$SCRIPT"
    [ "$status" -eq 0 ]
    [[ "$output" == *"skipping prebuild (mode: never)"* ]]
    [ ! -f "$SHIM_DIR/npx.calls" ]
}

@test "never without android/ fails with nothing-to-build error" {
    EXPO_BUILDER_WORKING_DIR="$APP" EXPO_BUILDER_PREBUILD="never" run "$SCRIPT"
    [ "$status" -eq 1 ]
    [[ "$output" == *"::error::prebuild is 'never'"* ]]
}

@test "prebuild-args are appended to the expo invocation" {
    EXPO_BUILDER_WORKING_DIR="$APP" EXPO_BUILDER_PREBUILD="always" \
        EXPO_BUILDER_PREBUILD_ARGS="--clean --template ./tpl.tgz" run "$SCRIPT"
    [ "$status" -eq 0 ]
    [[ "$(shim_calls npx)" == "expo prebuild --platform android --clean --template ./tpl.tgz" ]]
}

@test "prebuild failure propagates non-zero exit" {
    make_shim npx 'exit 7'
    EXPO_BUILDER_WORKING_DIR="$APP" EXPO_BUILDER_PREBUILD="always" run "$SCRIPT"
    [ "$status" -eq 7 ]
}
