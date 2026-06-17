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

setup_paginating_curl() {
    MOCK_DIR=$(mktemp -d)
    cat > "$MOCK_DIR/curl" << 'ENDSCRIPT'
#!/usr/bin/env bash
# Paginating mock: page 1 = 100 comments incl. an OLD bot comment (id 111);
# page 2 = a NEWER bot comment (id 222). Global selection must pick 222.
args=("$@"); method="GET"; outfile=""
for i in "${!args[@]}"; do
    case "${args[$i]}" in -o) outfile="${args[$((i+1))]}" ;; -X) method="${args[$((i+1))]}" ;; esac
done
url="${args[-1]}"
emit() { [ -n "$outfile" ] && printf '%s' "$1" > "$outfile"; printf '%s' "$1"; }
if [ "$method" = "PATCH" ]; then
    id="${url##*/}"
    emit "{\"id\": $id, \"html_url\": \"https://github.com/test-org/test-repo/issues/42#issuecomment-$id\"}"
    exit 0
fi
page=1; [[ "$url" =~ page=([0-9]+) ]] && page="${BASH_REMATCH[1]}"
if [ "$page" = "1" ]; then
    arr='[{"id":111,"user":{"login":"github-actions[bot]"},"body":"### Code Review — old","created_at":"2026-01-01T00:00:00Z","html_url":"u"}'
    for n in $(seq 1 99); do
        arr="$arr,{\"id\":$((1000+n)),\"user\":{\"login\":\"human\"},\"body\":\"chatter\",\"created_at\":\"2026-01-01T00:00:00Z\",\"html_url\":\"u\"}"
    done
    emit "${arr}]"
else
    emit '[{"id":222,"user":{"login":"github-actions[bot]"},"body":"### Code Review — new","created_at":"2026-06-01T00:00:00Z","html_url":"u"}]'
fi
ENDSCRIPT
    chmod +x "$MOCK_DIR/curl"
    export PATH="$MOCK_DIR:$PATH"
}

@test "post-comment: selects globally-latest bot comment across pages" {
    setup_paginating_curl
    export GITHUB_TOKEN="ghp_test"
    export GITHUB_REPOSITORY="test-org/test-repo"
    export GITHUB_EVENT_PATH="$FIXTURES_DIR/test-pr-event.json"

    run bash "$SRC_DIR/post-comment.sh" <<< "### Code Review — updated"
    [ "$status" -eq 0 ]
    # The newer comment (id 222, page 2) must win over the older (id 111, page 1).
    [[ "$output" == *"issuecomment-222"* ]]

    rm -rf "${MOCK_DIR:-/tmp/nonexistent}"
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

# Mock whose GET comments-list returns a marker comment authored by an
# ARBITRARY (non-github-actions) login. PATCH echoes the id back in html_url.
# Also logs every requested URL so a test can assert which endpoints were hit.
setup_marker_curl() {
    MOCK_DIR=$(mktemp -d)
    export URL_LOG="$MOCK_DIR/urls.log"
    : > "$URL_LOG"
    cat > "$MOCK_DIR/curl" << 'ENDSCRIPT'
#!/usr/bin/env bash
args=("$@"); method="GET"; outfile=""
for i in "${!args[@]}"; do
    case "${args[$i]}" in -o) outfile="${args[$((i+1))]}" ;; -X) method="${args[$((i+1))]}" ;; esac
done
url="${args[-1]}"
printf '%s %s\n' "$method" "$url" >> "$URL_LOG"
emit() { [ -n "$outfile" ] && printf '%s' "$1" > "$outfile"; printf '%s' "$1"; }
if [ "$method" = "PATCH" ]; then
    id="${url##*/}"
    emit "{\"id\": $id, \"html_url\": \"https://github.com/test-org/test-repo/issues/42#issuecomment-$id\"}"
    exit 0
fi
# GET comments list: a marker-bearing comment authored by a CUSTOM app login.
emit '[{"id":555,"user":{"login":"toolu-code-review[bot]"},"body":"<!-- toolu-review-state:v1 verdict=approve -->\n### Code Review\nlgtm","created_at":"2026-06-10T00:00:00Z","html_url":"https://github.com/test-org/test-repo/issues/42#issuecomment-555"}]'
ENDSCRIPT
    chmod +x "$MOCK_DIR/curl"
    export PATH="$MOCK_DIR:$PATH"
}

@test "post-comment: updates marker comment authored by arbitrary login (login-agnostic dedup)" {
    setup_marker_curl
    export GITHUB_TOKEN="ghp_test"
    export GITHUB_REPOSITORY="test-org/test-repo"
    export GITHUB_EVENT_PATH="$FIXTURES_DIR/test-pr-event.json"

    run bash "$SRC_DIR/post-comment.sh" <<< "<!-- toolu-review-state:v1 verdict=approve -->
### Code Review
updated"
    [ "$status" -eq 0 ]
    # The marker comment (id 555) is found despite a non-github-actions login,
    # so post-comment PATCHes it rather than creating a new one.
    [[ "$output" == *"issuecomment-555"* ]]
    grep -q "PATCH .*/issues/comments/555" "$URL_LOG"

    rm -rf "${MOCK_DIR:-/tmp/nonexistent}"
}

@test "post-comment: STICKY_COMMENT_ID skips search and PATCHes that id" {
    setup_marker_curl
    export GITHUB_TOKEN="ghp_test"
    export GITHUB_REPOSITORY="test-org/test-repo"
    export GITHUB_EVENT_PATH="$FIXTURES_DIR/test-pr-event.json"
    export STICKY_COMMENT_ID="777"

    run bash "$SRC_DIR/post-comment.sh" <<< "### Code Review — direct id"
    [ "$status" -eq 0 ]
    # Patched the supplied id directly...
    [[ "$output" == *"issuecomment-777"* ]]
    grep -q "PATCH .*/issues/comments/777" "$URL_LOG"
    # ...and never hit the comments-LIST endpoint (no search round-trip).
    ! grep -q "GET .*/issues/42/comments" "$URL_LOG"

    unset STICKY_COMMENT_ID
    rm -rf "${MOCK_DIR:-/tmp/nonexistent}"
}
