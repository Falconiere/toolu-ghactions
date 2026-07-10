#!/usr/bin/env bats
# create-release.bats — glob/tag/checksum logic against real files; gh is a
# recording PATH shim (the real gh round-trip is expo-integration.yml job3).

load ../../__tests__/helpers

setup() {
    common_setup
    SCRIPT="$SUITE_ROOT/deploy-github-release/src/create-release.sh"
    export GH_REPO="owner/repo"
    # Default shim: tag does not exist; create echoes the release URL.
    make_shim gh '
case "$1 $2" in
  "release view") exit 1 ;;
  "release create") echo "https://github.com/owner/repo/releases/tag/$3" ;;
  "release upload") exit 0 ;;
  *) exit 1 ;;
esac'
    DIST="$BATS_TEST_TMPDIR/dist"
    mkdir -p "$DIST"
    printf 'apk-bytes' >"$DIST/app one.apk"
    printf 'aab-bytes' >"$DIST/app.aab"
}

teardown() { common_teardown; }

@test "fails when neither tag nor app-version is given" {
    EXPO_BUILDER_FILES="$DIST/app.aab" run "$SCRIPT"
    [ "$status" -eq 1 ]
    [[ "$output" == *"::error::neither 'tag' nor 'app-version'"* ]]
    [ ! -f "$SHIM_DIR/gh.calls" ]
}

@test "derives tag v<app-version> and creates the release" {
    EXPO_BUILDER_FILES="$DIST/app.aab" EXPO_BUILDER_APP_VERSION="1.2.3" run "$SCRIPT"
    [ "$status" -eq 0 ]
    grep -q '^release create v1.2.3 ' "$SHIM_DIR/gh.calls"
    grep -q '^release-url=https://github.com/owner/repo/releases/tag/v1.2.3$' "$GITHUB_OUTPUT"
}

@test "glob matching nothing fails naming the pattern" {
    EXPO_BUILDER_FILES="$DIST/*.ipa" EXPO_BUILDER_TAG="v1" run "$SCRIPT"
    [ "$status" -eq 1 ]
    [[ "$output" == *"::error::files pattern matched nothing: '$DIST/*.ipa'"* ]]
}

@test "newline-separated globs support filenames with spaces" {
    EXPO_BUILDER_FILES="$DIST/app one.apk
$DIST/*.aab" EXPO_BUILDER_TAG="v9" run "$SCRIPT"
    [ "$status" -eq 0 ]
    upload="$(grep '^release upload v9 ' "$SHIM_DIR/gh.calls")"
    [[ "$upload" == *"app one.apk"* ]]
    [[ "$upload" == *"app.aab"* ]]
    grep -q '^app one.apk$' "$GITHUB_OUTPUT"
}

@test "sha256sums.txt is generated with real hashes and uploaded" {
    EXPO_BUILDER_FILES="$DIST/app.aab" EXPO_BUILDER_TAG="v9" run "$SCRIPT"
    [ "$status" -eq 0 ]
    sums="$RUNNER_TEMP/sha256sums.txt"
    [ -f "$sums" ]
    if command -v sha256sum >/dev/null 2>&1; then
        want="$(sha256sum "$DIST/app.aab" | awk '{print $1}')"
    else
        want="$(shasum -a 256 "$DIST/app.aab" | awk '{print $1}')"
    fi
    grep -q "^$want  app.aab$" "$sums"
    [[ "$(grep '^release upload v9 ' "$SHIM_DIR/gh.calls")" == *"sha256sums.txt"* ]]
    grep -q '^sha256sums.txt$' "$GITHUB_OUTPUT"
}

@test "generate-checksums=false skips the sums asset" {
    EXPO_BUILDER_FILES="$DIST/app.aab" EXPO_BUILDER_TAG="v9" \
        EXPO_BUILDER_CHECKSUMS="false" run "$SCRIPT"
    [ "$status" -eq 0 ]
    [ ! -f "$RUNNER_TEMP/sha256sums.txt" ]
}

@test "existing tag with overwrite=false fails" {
    make_shim gh '
case "$1 $2" in
  "release view") echo "https://github.com/owner/repo/releases/tag/v9" ;;
  *) exit 0 ;;
esac'
    EXPO_BUILDER_FILES="$DIST/app.aab" EXPO_BUILDER_TAG="v9" run "$SCRIPT"
    [ "$status" -eq 1 ]
    [[ "$output" == *"::error::tag or release 'v9' already exists"* ]]
}

@test "existing tag with overwrite=true skips create and uploads with --clobber" {
    make_shim gh '
case "$1 $2" in
  "release view") echo "https://github.com/owner/repo/releases/tag/v9" ;;
  "release upload") exit 0 ;;
  *) exit 1 ;;
esac'
    EXPO_BUILDER_FILES="$DIST/app.aab" EXPO_BUILDER_TAG="v9" \
        EXPO_BUILDER_OVERWRITE="true" run "$SCRIPT"
    [ "$status" -eq 0 ]
    ! grep -q '^release create ' "$SHIM_DIR/gh.calls"
    [[ "$(grep '^release upload v9 ' "$SHIM_DIR/gh.calls")" == *"--clobber"* ]]
}

@test "asset named like the heredoc delimiter cannot truncate uploaded-assets" {
    printf 'x' >"$DIST/EXPO_BUILDER_EOF"
    EXPO_BUILDER_FILES="$DIST/EXPO_BUILDER_EOF
$DIST/app.aab" EXPO_BUILDER_TAG="v9" run "$SCRIPT"
    [ "$status" -eq 0 ]
    delim="$(sed -n 's/^uploaded-assets<<//p' "$GITHUB_OUTPUT")"
    [ -n "$delim" ]
    [ "$delim" != "EXPO_BUILDER_EOF" ]
    # Terminator present and both assets listed inside the block.
    grep -qx "$delim" "$GITHUB_OUTPUT"
    grep -qx 'EXPO_BUILDER_EOF' "$GITHUB_OUTPUT"
    grep -qx 'app.aab' "$GITHUB_OUTPUT"
}

@test "draft and prerelease flags reach gh release create" {
    EXPO_BUILDER_FILES="$DIST/app.aab" EXPO_BUILDER_TAG="v9" \
        EXPO_BUILDER_DRAFT="true" EXPO_BUILDER_PRERELEASE="true" run "$SCRIPT"
    [ "$status" -eq 0 ]
    create="$(grep '^release create v9 ' "$SHIM_DIR/gh.calls")"
    [[ "$create" == *"--draft"* ]]
    [[ "$create" == *"--prerelease"* ]]
}
