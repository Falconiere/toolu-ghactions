#!/usr/bin/env bash
# helpers.bash — bats setup for scripts/ tests.
#
# Real-data principle: mirror-action.sh is exercised against a REAL local bare
# git repo (no network, no mocks). MIRROR_REMOTE points the script at the bare
# repo instead of github.com; the layout transforms run against the ACTUAL
# monorepo code-review/ and cloudflare-tunnel/ source trees.
common_setup() {
    BATS_TEST_TMPDIR="${BATS_TEST_TMPDIR:-$(mktemp -d)}"
    export BATS_TEST_TMPDIR
    REPO_ROOT="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
    export REPO_ROOT
    export SCRIPT="$REPO_ROOT/scripts/mirror-action.sh"

    BARE="$BATS_TEST_TMPDIR/mirror.git"
    export BARE
    git init --quiet --bare -b main "$BARE"

    export WORK="$BATS_TEST_TMPDIR/work"
    export MIRROR_REMOTE="$BARE"
    export MIRROR_REPO="Falconiere/toolu-test"
    export MIRROR_TOKEN="dummy-token"
    export SOURCE_REPO="Falconiere/toolu-ghactions"
    export SOURCE_SHA="deadbeefcafe"
    export TAG="v2.1.0"
    export MAJOR="2"
    export IMAGE_BASE="ghcr.io/falconiere/toolu-ghactions/code-review"

    # Deterministic committer identity (the script also sets repo-local config).
    export GIT_AUTHOR_NAME="test"      GIT_AUTHOR_EMAIL="test@example.com"
    export GIT_COMMITTER_NAME="test"   GIT_COMMITTER_EMAIL="test@example.com"
}

common_teardown() { :; }

# Clone the bare mirror into a fresh dir and echo its path (for assertions).
checkout_mirror() {
    local out
    out="$(mktemp -u "$BATS_TEST_TMPDIR/checkout.XXXXXX")"
    git clone --quiet "$BARE" "$out"
    printf '%s\n' "$out"
}
