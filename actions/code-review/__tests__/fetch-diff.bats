#!/usr/bin/env bash
# fetch-diff.bats — tests for fetch-diff.sh

load helpers

# Helper: create a temp git repo with an initial commit.
setup_git_repo() {
    TMPDIR=$(mktemp -d)
    cd "$TMPDIR"
    git init --initial-branch=main --quiet
    git config user.email "test@test.com"
    git config user.name "Test"
    echo "initial" > README.md
    git add README.md
    git commit -m "initial commit" --quiet
}

teardown_git_repo() {
    cd /
    rm -rf "${TMPDIR:-/tmp/nonexistent}"
}

@test "fetch-diff: outputs JSON with expected fields" {
    setup_git_repo

    # Make a change so there's a diff.
    echo "changed" > newfile.ts
    git add newfile.ts

    export INPUT_MAX_FILES=100
    export INPUT_MAX_DIFF_LINES=8000
    export INPUT_BASE_BRANCH=main
    export GITHUB_BASE_REF=main

    run bash "$SRC_DIR/fetch-diff.sh"
    [ "$status" -eq 0 ]

    result=$(echo "$output" | jq -c '.')
    [ "$(echo "$result" | jq -r '.total_files')" -ge 0 ]
    echo "$result" | jq -e '.changed_files | type == "array"'
    echo "$result" | jq -e '.binary_files | type == "array"'
    echo "$result" | jq -e '.truncated | type == "boolean"'
    echo "$result" | jq -e '.diff | type == "string"'

    teardown_git_repo
}

@test "fetch-diff: binary file detection" {
    setup_git_repo

    # Create a feature branch off main.
    git checkout -b feature --quiet

    echo "text content" > text.txt
    dd if=/dev/urandom of=binary.bin bs=32 count=1 2>/dev/null
    git add text.txt binary.bin
    git commit -m "add text and binary" --quiet

    # Now HEAD (feature) has changes relative to main.
    export INPUT_MAX_FILES=100
    export INPUT_MAX_DIFF_LINES=8000
    export INPUT_BASE_BRANCH=main
    export GITHUB_BASE_REF=main

    run bash "$SRC_DIR/fetch-diff.sh"

    # binary_files should contain binary.bin (it's a new file in this diff)
    echo "$output" | jq -e '.binary_files | index("binary.bin") != null'

    # changed_files should contain text.txt
    echo "$output" | jq -e '.changed_files | index("text.txt") != null'

    teardown_git_repo
}

@test "fetch-diff: empty repo has total_files=0" {
    setup_git_repo

    # No changes — just run against HEAD.
    export INPUT_MAX_FILES=100
    export INPUT_MAX_DIFF_LINES=8000
    export INPUT_BASE_BRANCH=main
    export GITHUB_BASE_REF=main

    run bash "$SRC_DIR/fetch-diff.sh"
    [ "$status" -eq 0 ]
    [ "$(echo "$output" | jq -r '.total_files')" -eq 0 ]

    teardown_git_repo
}
