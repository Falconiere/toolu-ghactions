#!/usr/bin/env bats
# build.bats — task derivation via EXPO_BUILDER_DRY_RUN (real script, real
# logic; real Gradle runs in expo-integration.yml) + signing-marker enforcement
# using a real executable gradlew stand-in.

load ../../__tests__/helpers

setup() {
    common_setup
    SCRIPT="$SUITE_ROOT/build-android/src/build.sh"
    INIT="$SUITE_ROOT/build-android/src/signing.init.gradle"
    APP="$(make_app_dir)"
    mkdir -p "$APP/android"
}

teardown() { common_teardown; }

dry() {
    EXPO_BUILDER_WORKING_DIR="$APP" EXPO_BUILDER_FORMAT="$1" \
        EXPO_BUILDER_INIT_SCRIPT="$INIT" EXPO_BUILDER_DRY_RUN=1 run "$SCRIPT"
}

@test "invalid format fails with named error" {
    dry flatpak
    [ "$status" -eq 1 ]
    [[ "$output" == *"::error::invalid format 'flatpak'"* ]]
}

@test "format=apk derives assembleRelease only" {
    dry apk
    [ "$status" -eq 0 ]
    [[ "$output" == "./gradlew -I $INIT assembleRelease" ]]
}

@test "format=aab derives bundleRelease only" {
    dry aab
    [ "$status" -eq 0 ]
    [[ "$output" == "./gradlew -I $INIT bundleRelease" ]]
}

@test "format=both derives one atomic invocation with both tasks" {
    dry both
    [ "$status" -eq 0 ]
    [[ "$output" == "./gradlew -I $INIT assembleRelease bundleRelease" ]]
}

@test "missing android/ fails with prebuild hint" {
    rm -rf "$APP/android"
    dry apk
    [ "$status" -eq 1 ]
    [[ "$output" == *"::error::no android/ directory"* ]]
}

@test "fails when keystore env is set but signing marker never appears" {
    printf '#!/usr/bin/env bash\nexit 0\n' >"$APP/android/gradlew"
    chmod +x "$APP/android/gradlew"
    EXPO_BUILDER_WORKING_DIR="$APP" EXPO_BUILDER_FORMAT="apk" \
        EXPO_BUILDER_INIT_SCRIPT="$INIT" \
        EXPO_BUILDER_KEYSTORE_PATH="$RUNNER_TEMP/some.keystore" run "$SCRIPT"
    [ "$status" -eq 1 ]
    [[ "$output" == *"::error::release keystore was configured but signing.init.gradle never applied it"* ]]
}

@test "succeeds when the build writes the signing marker" {
    printf '#!/usr/bin/env bash\ntouch "%s/expo-builder-signing-applied"\n' "$RUNNER_TEMP" >"$APP/android/gradlew"
    chmod +x "$APP/android/gradlew"
    EXPO_BUILDER_WORKING_DIR="$APP" EXPO_BUILDER_FORMAT="apk" \
        EXPO_BUILDER_INIT_SCRIPT="$INIT" \
        EXPO_BUILDER_KEYSTORE_PATH="$RUNNER_TEMP/some.keystore" run "$SCRIPT"
    [ "$status" -eq 0 ]
}

@test "without keystore env no marker is required" {
    printf '#!/usr/bin/env bash\nexit 0\n' >"$APP/android/gradlew"
    chmod +x "$APP/android/gradlew"
    EXPO_BUILDER_WORKING_DIR="$APP" EXPO_BUILDER_FORMAT="apk" \
        EXPO_BUILDER_INIT_SCRIPT="$INIT" run "$SCRIPT"
    [ "$status" -eq 0 ]
}
