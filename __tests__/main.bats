#!/usr/bin/env bash
# main.bats — end-to-end tests for main.sh orchestration

load helpers

@test "main: fails when OPENROUTER_API_KEY is unset" {
    unset OPENROUTER_API_KEY
    export GITHUB_TOKEN="ghp_test"

    run bash "$SRC_DIR/main.sh"
    [ "$status" -ne 0 ]
}

@test "main: fails when GITHUB_TOKEN is unset" {
    export OPENROUTER_API_KEY="sk-or-test"
    unset GITHUB_TOKEN

    run bash "$SRC_DIR/main.sh"
    [ "$status" -ne 0 ]
}

@test "main: handles fetch-diff failure gracefully" {
    export OPENROUTER_API_KEY="sk-or-test"
    export GITHUB_TOKEN="ghp_test"
    # Point to a nonexistent git repo to force fetch-diff failure.
    tmpdir=$(mktemp -d)
    cd "$tmpdir"

    run bash "$SRC_DIR/main.sh"
    [ "$status" -ne 0 ]

    cd - > /dev/null
    rm -rf "$tmpdir"
}
