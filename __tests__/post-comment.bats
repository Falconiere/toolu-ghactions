#!/usr/bin/env bash
# post-comment.bats — tests for post-comment.sh
# Mocks curl to avoid hitting the real GitHub API.

load helpers

setup_mock_curl() {
    MOCK_DIR=$(mktemp -d)
    cat > "$MOCK_DIR/curl" << 'ENDSCRIPT'
#!/usr/bin/env bash
# Mock curl: return canned GitHub API responses.
outfile=""
args=("$@")
method="GET"
for i in "${!args[@]}"; do
    case "${args[$i]}" in
        -o) outfile="${args[$((i+1))]}" ;;
        -X) method="${args[$((i+1))]}" ;;
    esac
done

# Determine which endpoint is being called.
url="${args[-1]}"

if [[ "$url" == */comments* && "$method" != "PATCH" ]]; then
    # List or create comments. Return a list with one existing bot comment.
    body='[{"id": 999, "user": {"login": "github-actions[bot]"}, "body": "### Code Review — old", "created_at": "2026-01-01T00:00:00Z", "html_url": "https://github.com/test-org/test-repo/issues/42#issuecomment-999"}]'
else
    # PATCH update or POST create. Return success.
    body='{"id": 999, "html_url": "https://github.com/test-org/test-repo/issues/42#issuecomment-999"}'
fi

if [ -n "$outfile" ]; then
    echo "$body" > "$outfile"
fi
printf "%s" "$body"
ENDSCRIPT
    chmod +x "$MOCK_DIR/curl"
    export PATH="$MOCK_DIR:$PATH"
}

teardown_mock_curl() {
    rm -rf "${MOCK_DIR:-/tmp/nonexistent}"
}

@test "post-comment: finds and updates existing comment" {
    setup_mock_curl
    export GITHUB_TOKEN="ghp_test"
    export GITHUB_REPOSITORY="test-org/test-repo"
    export GITHUB_EVENT_PATH="$FIXTURES_DIR/test-pr-event.json"

    run bash "$SRC_DIR/post-comment.sh" <<< "### Code Review — test comment"
    [ "$status" -eq 0 ]
    [[ "$output" == *"https://github.com"* ]]

    teardown_mock_curl
}

@test "post-comment: fails when GITHUB_TOKEN is unset" {
    unset GITHUB_TOKEN
    export GITHUB_REPOSITORY="test-org/test-repo"

    run bash "$SRC_DIR/post-comment.sh" <<< "test"
    [ "$status" -ne 0 ]
}

@test "post-comment: fails when GITHUB_REPOSITORY is unset" {
    export GITHUB_TOKEN="ghp_test"
    unset GITHUB_REPOSITORY

    run bash "$SRC_DIR/post-comment.sh" <<< "test"
    [ "$status" -ne 0 ]
}

@test "post-comment: extracts PR number from event payload" {
    setup_mock_curl
    export GITHUB_TOKEN="ghp_test"
    export GITHUB_REPOSITORY="test-org/test-repo"
    export GITHUB_EVENT_PATH="$FIXTURES_DIR/test-pr-event.json"

    run bash "$SRC_DIR/post-comment.sh" <<< "test"
    [ "$status" -eq 0 ]

    teardown_mock_curl
}
