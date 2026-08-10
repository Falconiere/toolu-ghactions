#!/usr/bin/env bats
# mirror-action.bats — exercise scripts/mirror-action.sh against a real local
# bare git remote (no network, no mocks). Source trees are the actual monorepo
# code-review/ and cloudflare-tunnel/.
load helpers

setup() { common_setup; }
teardown() { common_teardown; }

@test "code-review: mirror root has the nested node24 actions + hoisted \$/ rewrite + LICENSE" {
    ACTION=code-review run bash "$SCRIPT" "$WORK"
    [ "$status" -eq 0 ]
    out=$(checkout_mirror)
    [ -f "$out/action.yml" ]
    [ -d "$out/src" ]
    [ -d "$out/prompts" ]
    [ -f "$out/LICENSE" ]
    # Nested node24 actions ride along with their colocated bundles.
    [ -f "$out/run/index.cjs" ]
    [ -f "$out/run/action.yml" ]
    [ -f "$out/sanitize-sarif/index.cjs" ]
    [ -f "$out/sanitize-sarif/action.yml" ]
    grep -qF "using: 'composite'" "$out/action.yml"
    # Hoisted root: the composite's $/code-review/ prefixes must be rewritten to
    # $/ — an unrewritten reference resolves to nothing at the mirror root and
    # breaks every Marketplace consumer at resolution time.
    grep -qF 'uses: $/run' "$out/action.yml"
    grep -qF 'uses: $/sanitize-sarif' "$out/action.yml"
    ! grep -qF '$/code-review/' "$out/action.yml"
}

@test "cloudflare-tunnel: root action.yml resolves scripts (../src dropped); subdirs kept" {
    ACTION=cloudflare-tunnel run bash "$SCRIPT" "$WORK"
    [ "$status" -eq 0 ]
    out=$(checkout_mirror)
    [ -f "$out/action.yml" ]
    [ -d "$out/start" ]
    [ -d "$out/stop" ]
    [ -d "$out/wait" ]
    [ -d "$out/src" ]
    [ -f "$out/src/start.sh" ]
    # Hoisted root: path rewritten so $GITHUB_ACTION_PATH/src resolves at root.
    grep -qF 'GITHUB_ACTION_PATH/src/start.sh' "$out/action.yml"
    ! grep -qF 'GITHUB_ACTION_PATH/../src/start.sh' "$out/action.yml"
    # start/ subdir is unchanged — ../src resolves one level down to root /src.
    grep -qF 'GITHUB_ACTION_PATH/../src/start.sh' "$out/start/action.yml"
}

@test "cloudflare-tunnel: generated root differs from start only in the run-line, keeps name+branding" {
    ACTION=cloudflare-tunnel run bash "$SCRIPT" "$WORK"
    [ "$status" -eq 0 ]
    out=$(checkout_mirror)
    start="$REPO_ROOT/cloudflare-tunnel/start/action.yml"
    # The ONLY differing lines must reference the rewritten start.sh run path —
    # proving the transform is surgical and the (CI-validated) schema is intact.
    run bash -c "diff '$start' '$out/action.yml' | grep -E '^[<>]' | grep -vF 'start.sh' || true"
    [ -z "$output" ]
    grep -qE '^name:' "$out/action.yml"
    grep -qE '^branding:' "$out/action.yml"
}

@test "expo-builder: root action.yml hoisted from build-android with rewritten src paths; subdirs kept" {
    ACTION=expo-builder run bash "$SCRIPT" "$WORK"
    [ "$status" -eq 0 ]
    out=$(checkout_mirror)
    [ -f "$out/action.yml" ]
    [ -d "$out/build-android" ]
    [ -d "$out/deploy-github-release" ]
    [ -f "$out/build-android/src/preflight.sh" ]
    [ -f "$out/deploy-github-release/src/create-release.sh" ]
    # Hoisted root: script paths gain the build-android/ segment.
    grep -qF '}}/build-android/src/preflight.sh' "$out/action.yml"
    ! grep -qF '}}/src/preflight.sh' "$out/action.yml"
    grep -qF '}}/build-android/src/signing.init.gradle' "$out/action.yml"
    # Sub-action action.yml is unchanged — its own src/ resolves in place.
    grep -qF '}}/src/preflight.sh' "$out/build-android/action.yml"
}

@test "expo-builder: generated root differs from build-android only in src paths, keeps name+branding" {
    ACTION=expo-builder run bash "$SCRIPT" "$WORK"
    [ "$status" -eq 0 ]
    out=$(checkout_mirror)
    src="$REPO_ROOT/expo-builder/build-android/action.yml"
    run bash -c "diff '$src' '$out/action.yml' | grep -E '^[<>]' | grep -vF '/src/' || true"
    [ -z "$output" ]
    grep -qE '^name:' "$out/action.yml"
    grep -qE '^branding:' "$out/action.yml"
}

@test "README: monorepo-relative links repointed, generated banner prepended" {
    ACTION=code-review run bash "$SCRIPT" "$WORK"
    [ "$status" -eq 0 ]
    out=$(checkout_mirror)
    ! grep -qF '](../LICENSE)' "$out/README.md"
    ! grep -qF '](../README.md)' "$out/README.md"
    grep -qF '](./LICENSE)' "$out/README.md"
    grep -qF 'https://github.com/Falconiere/toolu-ghactions' "$out/README.md"
    head -n1 "$out/README.md" | grep -qF 'Generated from'
}

@test "tags: release tag and v<major> alias both created at HEAD" {
    ACTION=code-review run bash "$SCRIPT" "$WORK"
    [ "$status" -eq 0 ]
    run git --git-dir="$BARE" tag
    [ "$status" -eq 0 ]
    echo "$output" | grep -qx 'v2.1.0'
    echo "$output" | grep -qx 'v2'
    t=$(git --git-dir="$BARE" rev-list -n1 v2.1.0)
    a=$(git --git-dir="$BARE" rev-list -n1 v2)
    [ "$t" = "$a" ]
}

@test "idempotent: a second sync of the same tag adds no commit and still succeeds" {
    ACTION=code-review run bash "$SCRIPT" "$WORK"
    [ "$status" -eq 0 ]
    h1=$(git --git-dir="$BARE" rev-parse main)
    ACTION=code-review run bash "$SCRIPT" "$WORK"
    [ "$status" -eq 0 ]
    h2=$(git --git-dir="$BARE" rev-parse main)
    [ "$h1" = "$h2" ]
}

@test "fatal when the mirror repo cannot be cloned (no auto-create)" {
    MIRROR_REMOTE="$BATS_TEST_TMPDIR/does-not-exist.git" ACTION=code-review run bash "$SCRIPT" "$WORK"
    [ "$status" -ne 0 ]
    echo "$output" | grep -qF 'clone failed'
}
