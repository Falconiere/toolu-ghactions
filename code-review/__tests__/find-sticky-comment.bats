#!/usr/bin/env bash
# find-sticky-comment.bats — tests for find-sticky-comment.sh
# Mocks curl with recorded GitHub issue-comments payloads (no synthetic data).

load helpers

# setup_mock_curl <fixture> — install a PATH curl mock that returns <fixture>
# for the first comments page and an empty array for any later page (so the
# pagination loop terminates the same way the real API's short last page does).
setup_mock_curl() {
    local fixture="$1"
    MOCK_DIR=$(mktemp -d)
    cat > "$MOCK_DIR/curl" << ENDSCRIPT
#!/usr/bin/env bash
args=("\$@")
url="\${args[-1]}"
page=1
[[ "\$url" =~ [?\&]page=([0-9]+) ]] && page="\${BASH_REMATCH[1]}"
if [ "\$page" = "1" ]; then
    cat '$fixture'
else
    printf '%s' '[]'
fi
ENDSCRIPT
    chmod +x "$MOCK_DIR/curl"
    export PATH="$MOCK_DIR:$PATH"
}

teardown_mock_curl() {
    rm -rf "${MOCK_DIR:-/tmp/nonexistent}"
}

@test "find-sticky-comment: prefers marker comment over legacy, login-agnostic" {
    setup_mock_curl "$FIXTURES_DIR/sticky/comments-page.json"
    export GITHUB_TOKEN="ghp_test"
    export GITHUB_REPOSITORY="test-org/test-repo"
    export GITHUB_EVENT_PATH="$FIXTURES_DIR/test-pr-event.json"

    run bash "$SRC_DIR/find-sticky-comment.sh"
    [ "$status" -eq 0 ]
    # Marker comment (id 777, authored by toolu-code-review[bot]) must win over
    # the legacy github-actions[bot] comment — proves login-agnostic matching.
    assert_json_path "$output" '.id' "777"
    assert_contains "$output" "toolu-review-state:v1"

    teardown_mock_curl
}

@test "find-sticky-comment: falls back to legacy header when no marker exists" {
    setup_mock_curl "$FIXTURES_DIR/sticky/legacy-only.json"
    export GITHUB_TOKEN="ghp_test"
    export GITHUB_REPOSITORY="test-org/test-repo"
    export GITHUB_EVENT_PATH="$FIXTURES_DIR/test-pr-event.json"

    run bash "$SRC_DIR/find-sticky-comment.sh"
    [ "$status" -eq 0 ]
    assert_json_path "$output" '.id' "333"

    teardown_mock_curl
}

@test "find-sticky-comment: returns {} when no sticky comment exists" {
    setup_mock_curl "$FIXTURES_DIR/sticky/none.json"
    export GITHUB_TOKEN="ghp_test"
    export GITHUB_REPOSITORY="test-org/test-repo"
    export GITHUB_EVENT_PATH="$FIXTURES_DIR/test-pr-event.json"

    run bash "$SRC_DIR/find-sticky-comment.sh"
    [ "$status" -eq 0 ]
    assert_json_path "$output" '.' "{}"

    teardown_mock_curl
}

@test "find-sticky-comment: PR_NUMBER override is used directly" {
    setup_mock_curl "$FIXTURES_DIR/sticky/comments-page.json"
    export GITHUB_TOKEN="ghp_test"
    export GITHUB_REPOSITORY="test-org/test-repo"
    unset GITHUB_EVENT_PATH
    unset GITHUB_REF
    export PR_NUMBER="42"

    run bash "$SRC_DIR/find-sticky-comment.sh"
    [ "$status" -eq 0 ]
    assert_json_path "$output" '.id' "777"

    teardown_mock_curl
}

@test "find-sticky-comment: {} + exit 0 when PR number cannot be determined" {
    export GITHUB_TOKEN="ghp_test"
    export GITHUB_REPOSITORY="test-org/test-repo"
    unset GITHUB_EVENT_PATH
    unset GITHUB_REF

    run bash "$SRC_DIR/find-sticky-comment.sh"
    [ "$status" -eq 0 ]
    [ "$output" = "{}" ]
}

@test "find-sticky-comment: fails when GITHUB_TOKEN is unset" {
    unset GITHUB_TOKEN
    export GITHUB_REPOSITORY="test-org/test-repo"

    run bash "$SRC_DIR/find-sticky-comment.sh"
    [ "$status" -ne 0 ]
}

@test "find-sticky-comment: fails when GITHUB_REPOSITORY is unset" {
    export GITHUB_TOKEN="ghp_test"
    unset GITHUB_REPOSITORY

    run bash "$SRC_DIR/find-sticky-comment.sh"
    [ "$status" -ne 0 ]
}
