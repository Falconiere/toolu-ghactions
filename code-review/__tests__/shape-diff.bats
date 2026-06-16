#!/usr/bin/env bash
# shape-diff.bats — tests for shape-diff.sh (line-priming + changed_lines).
# Feeds a real `git diff` (the actual data shape shape-diff consumes).

load helpers

setup_repo() {
    TMP_REPO=$(mktemp -d)
    cd "$TMP_REPO"
    git init --initial-branch=main --quiet
    git config user.email t@t.com; git config user.name T
    printf 'alpha\nbeta\ngamma\ndelta\n' > a.txt
    git add a.txt; git commit -m init --quiet
}
teardown_repo() { cd /; rm -rf "${TMP_REPO:-/tmp/nope}"; }

@test "shape-diff: primes added/context with new-file line numbers and removed with L---" {
    setup_repo
    # Replace line 2, append a line.
    printf 'alpha\nBETA\ngamma\ndelta\nepsilon\n' > a.txt
    raw=$(git diff HEAD -- a.txt)

    out=$(printf '%s\n' "$raw" | bash "$SRC_DIR/shape-diff.sh")

    # Valid JSON with the two expected keys.
    echo "$out" | jq -e 'has("diff") and has("files")'
    diff_text=$(echo "$out" | jq -r '.diff')

    # Added line carries its new-file number; removed line is unnumbered.
    echo "$diff_text" | grep -qE '^L[0-9]+: \+BETA'
    echo "$diff_text" | grep -qE '^L[0-9]+: \+epsilon'
    echo "$diff_text" | grep -qE '^L---: -beta'
    # Context lines are numbered too.
    echo "$diff_text" | grep -qE '^L[0-9]+:  alpha'

    teardown_repo
}

@test "shape-diff: records changed_lines for the file (added + context, not removed)" {
    setup_repo
    printf 'alpha\nBETA\ngamma\ndelta\nepsilon\n' > a.txt
    raw=$(git diff HEAD -- a.txt)

    out=$(printf '%s\n' "$raw" | bash "$SRC_DIR/shape-diff.sh")

    echo "$out" | jq -e '[.files[] | select(.path=="a.txt")] | length == 1'
    # epsilon is appended at new-file line 5 — must be anchorable.
    echo "$out" | jq -e '[.files[] | select(.path=="a.txt")][0].changed_lines | index(5) != null'
    # changed_lines are unique + sorted ints.
    echo "$out" | jq -e '[.files[] | select(.path=="a.txt")][0].changed_lines | (. == (unique))'

    teardown_repo
}

@test "shape-diff: empty diff yields empty files array and empty diff" {
    out=$(printf '' | bash "$SRC_DIR/shape-diff.sh")
    echo "$out" | jq -e '.files == []'
    echo "$out" | jq -e '.diff == ""'
}
