#!/usr/bin/env bash
# resolve-event.bats — tests for resolve-event.sh.
#
# Mocks curl via PATH, branching on the requested URL (permission + pulls +
# reactions endpoints) and APPENDING every requested URL to a log file so a
# test can assert that the CHEAP GUARDS short-circuit BEFORE any API call.
# Reaction POSTs record their `content` so a test can assert eyes vs -1.
# The `git fetch pull/N/head` path runs against a REAL temp git repo with a
# refs/pull/42/head ref — no mock data.
#
# The script writes the decision JSON to stdout and diagnostics to stderr, so
# every invocation is `bash -c "... 2>/dev/null"` to capture stdout-only into
# $output (mirrors fetch-diff.bats / mint-app-token.bats). Reaction/URL logs are
# written to files, so those assertions are unaffected by dropping stderr.

load helpers

# setup_mock_curl — install a PATH curl shim.
#   MOCK_PERM_FIXTURE : file served for the .../permission GET (default perm-write).
#   MOCK_PERM_CODE    : http_code emitted for the permission GET (default 200).
#   $MOCK_DIR/url.log : every requested URL, one per line.
#   $MOCK_DIR/react.log : reaction `content` values, one per line.
setup_mock_curl() {
    MOCK_DIR=$(mktemp -d)
    URL_LOG="$MOCK_DIR/url.log"
    REACT_LOG="$MOCK_DIR/react.log"
    export URL_LOG REACT_LOG
    : > "$URL_LOG"
    : > "$REACT_LOG"
    export MOCK_PERM_FIXTURE="${MOCK_PERM_FIXTURE:-$FIXTURES_DIR/event/perm-write.json}"
    export MOCK_PERM_CODE="${MOCK_PERM_CODE:-200}"
    export MOCK_PULL_FIXTURE="$FIXTURES_DIR/event/pull-42.json"
    cat > "$MOCK_DIR/curl" << 'ENDSCRIPT'
#!/usr/bin/env bash
# Mock curl: branch on the requested URL; log every URL and reaction content.
args=("$@"); method="GET"; outfile=""; want_code=""; data=""
for i in "${!args[@]}"; do
    case "${args[$i]}" in
        -o) outfile="${args[$((i+1))]}" ;;
        -X) method="${args[$((i+1))]}" ;;
        -w) want_code="1" ;;
        --data) data="${args[$((i+1))]}" ;;
    esac
done
url="${args[-1]}"
echo "$url" >> "$URL_LOG"

# Resolve --data @file to its contents.
if [[ "$data" == @* ]]; then data="$(cat "${data#@}" 2>/dev/null)"; fi

if [[ "$url" == */permission ]]; then
    body="$(cat "$MOCK_PERM_FIXTURE" 2>/dev/null)"
    [ -n "$outfile" ] && printf '%s' "$body" > "$outfile"
    [ -n "$want_code" ] && printf '%s' "${MOCK_PERM_CODE:-200}"
    exit 0
elif [[ "$url" == */reactions ]]; then
    # Record the reaction content for assertions.
    content="$(printf '%s' "$data" | jq -r '.content // ""' 2>/dev/null)"
    echo "$content" >> "$REACT_LOG"
    [ -n "$want_code" ] && printf '%s' "201"
    exit 0
elif [[ "$url" == */pulls/* ]]; then
    body="$(cat "$MOCK_PULL_FIXTURE" 2>/dev/null)"
    [ -n "$outfile" ] && printf '%s' "$body" > "$outfile"
    [ -n "$want_code" ] && printf '%s' "200"
    exit 0
fi
[ -n "$want_code" ] && printf '%s' "200"
exit 0
ENDSCRIPT
    chmod +x "$MOCK_DIR/curl"
    export PATH="$MOCK_DIR:$PATH"
    export GITHUB_TOKEN="ghp_test"
    export GITHUB_REPOSITORY="test-org/test-repo"
}

teardown_mock_curl() {
    rm -rf "${MOCK_DIR:-/tmp/nonexistent}"
    unset MOCK_PERM_FIXTURE MOCK_PERM_CODE MOCK_PULL_FIXTURE
}

# make_pr_repo — a real temp git repo whose `origin` carries refs/pull/42/head,
# so `git fetch origin pull/42/head` resolves to a real commit.
make_pr_repo() {
    PR_REPO=$(mktemp -d)
    git -C "$PR_REPO" init -q
    git -C "$PR_REPO" config user.email t@t.test
    git -C "$PR_REPO" config user.name t
    echo seed > "$PR_REPO/seed.txt"
    git -C "$PR_REPO" add -A
    git -C "$PR_REPO" commit -qm seed
    # Publish the commit as the PR head ref on the same repo (acts as origin).
    git -C "$PR_REPO" update-ref refs/pull/42/head HEAD
    git -C "$PR_REPO" remote add origin "$PR_REPO"
}

@test "resolve-event: pull_request → run=true, full_review=true, reason pull_request" {
    export GITHUB_EVENT_NAME="pull_request"
    export GITHUB_EVENT_PATH="$FIXTURES_DIR/event/pull-request.json"

    run bash -c "bash '$SRC_DIR/resolve-event.sh' 2>/dev/null"
    [ "$status" -eq 0 ]
    assert_json_path "$output" '.run' "true"
    assert_json_path "$output" '.full_review' "true"
    assert_json_path "$output" '.reason' "pull_request"
    assert_json_path "$output" '.pr_number' "42"
    assert_json_path "$output" '.review_head' "HEAD"
    assert_json_path "$output" '.base_ref' "main"
}

@test "resolve-event: issue_comment write user + focus text → run=true mention, reacts eyes" {
    setup_mock_curl
    make_pr_repo
    export GITHUB_EVENT_NAME="issue_comment"
    export GITHUB_EVENT_PATH="$FIXTURES_DIR/event/issue-comment-pr.json"

    cd "$PR_REPO"
    run bash -c "bash '$SRC_DIR/resolve-event.sh' 2>/dev/null"
    [ "$status" -eq 0 ]
    assert_json_path "$output" '.run' "true"
    assert_json_path "$output" '.reason' "mention"
    assert_json_path "$output" '.full_review' "false"
    assert_json_path "$output" '.instruction' "focus on auth"
    assert_json_path "$output" '.pr_number' "42"
    assert_json_path "$output" '.review_head' "FETCH_HEAD"
    assert_json_path "$output" '.base_ref' "main"
    assert_json_path "$output" '.commenter' "alice"
    assert_json_path "$output" '.comment_id' "5551234"
    # A permission call WAS made, and the allowed reaction was eyes.
    grep -q "/collaborators/alice/permission" "$URL_LOG"
    grep -qx "eyes" "$REACT_LOG"
    # The PR head ref really resolved into FETCH_HEAD.
    git rev-parse FETCH_HEAD

    rm -rf "$PR_REPO"
    teardown_mock_curl
}

@test "resolve-event: empty instruction → full_review=true" {
    setup_mock_curl
    make_pr_repo
    # Same fixture but body has no trailing instruction.
    EV=$(mktemp)
    jq '.comment.body = "@toolu review"' "$FIXTURES_DIR/event/issue-comment-pr.json" > "$EV"
    export GITHUB_EVENT_NAME="issue_comment"
    export GITHUB_EVENT_PATH="$EV"

    cd "$PR_REPO"
    run bash -c "bash '$SRC_DIR/resolve-event.sh' 2>/dev/null"
    [ "$status" -eq 0 ]
    assert_json_path "$output" '.run' "true"
    assert_json_path "$output" '.full_review' "true"
    assert_json_path "$output" '.instruction' ""

    rm -f "$EV"; rm -rf "$PR_REPO"
    teardown_mock_curl
}

@test "resolve-event: read user → run=false insufficient-permission, reacts -1" {
    export MOCK_PERM_FIXTURE="$FIXTURES_DIR/event/perm-read.json"
    setup_mock_curl
    export GITHUB_EVENT_NAME="issue_comment"
    export GITHUB_EVENT_PATH="$FIXTURES_DIR/event/issue-comment-readonly.json"

    run bash -c "bash '$SRC_DIR/resolve-event.sh' 2>/dev/null"
    [ "$status" -eq 0 ]
    assert_json_path "$output" '.run' "false"
    assert_json_path "$output" '.reason' "insufficient-permission"
    # The denial reaction was -1, never eyes.
    grep -qx -- "-1" "$REACT_LOG"
    ! grep -qx "eyes" "$REACT_LOG"

    teardown_mock_curl
}

@test "resolve-event: bot author → run=false bot-author, NO permission API call" {
    setup_mock_curl
    export GITHUB_EVENT_NAME="issue_comment"
    export GITHUB_EVENT_PATH="$FIXTURES_DIR/event/issue-comment-bot.json"

    run bash -c "bash '$SRC_DIR/resolve-event.sh' 2>/dev/null"
    [ "$status" -eq 0 ]
    assert_json_path "$output" '.run' "false"
    assert_json_path "$output" '.reason' "bot-author"
    # Cheap guard short-circuited: NO permission call, no API call at all.
    ! grep -q "/permission" "$URL_LOG"
    [ ! -s "$URL_LOG" ]

    teardown_mock_curl
}

@test "resolve-event: not-a-PR → run=false not-a-pull-request, no API call" {
    setup_mock_curl
    export GITHUB_EVENT_NAME="issue_comment"
    export GITHUB_EVENT_PATH="$FIXTURES_DIR/event/issue-comment-not-pr.json"

    run bash -c "bash '$SRC_DIR/resolve-event.sh' 2>/dev/null"
    [ "$status" -eq 0 ]
    assert_json_path "$output" '.run' "false"
    assert_json_path "$output" '.reason' "not-a-pull-request"
    [ ! -s "$URL_LOG" ]

    teardown_mock_curl
}

@test "resolve-event: no phrase → run=false no-trigger, no API call" {
    setup_mock_curl
    export GITHUB_EVENT_NAME="issue_comment"
    export GITHUB_EVENT_PATH="$FIXTURES_DIR/event/issue-comment-nophrase.json"

    run bash -c "bash '$SRC_DIR/resolve-event.sh' 2>/dev/null"
    [ "$status" -eq 0 ]
    assert_json_path "$output" '.run' "false"
    assert_json_path "$output" '.reason' "no-trigger"
    [ ! -s "$URL_LOG" ]

    teardown_mock_curl
}

@test "resolve-event: permission API non-2xx → run=false permission-check-failed (fail-closed)" {
    export MOCK_PERM_CODE="404"
    setup_mock_curl
    export GITHUB_EVENT_NAME="issue_comment"
    export GITHUB_EVENT_PATH="$FIXTURES_DIR/event/issue-comment-pr.json"

    run bash -c "bash '$SRC_DIR/resolve-event.sh' 2>/dev/null"
    [ "$status" -eq 0 ]
    assert_json_path "$output" '.run' "false"
    assert_json_path "$output" '.reason' "permission-check-failed"
    # Failed closed: never reacted eyes (no review was authorized).
    ! grep -qx "eyes" "$REACT_LOG"

    teardown_mock_curl
}

@test "resolve-event: case-insensitive phrase (@TOOLU Review) still triggers" {
    setup_mock_curl
    make_pr_repo
    EV=$(mktemp)
    jq '.comment.body = "@TOOLU Review check the SQL"' "$FIXTURES_DIR/event/issue-comment-pr.json" > "$EV"
    export GITHUB_EVENT_NAME="issue_comment"
    export GITHUB_EVENT_PATH="$EV"

    cd "$PR_REPO"
    run bash -c "bash '$SRC_DIR/resolve-event.sh' 2>/dev/null"
    [ "$status" -eq 0 ]
    assert_json_path "$output" '.run' "true"
    assert_json_path "$output" '.reason' "mention"
    # Instruction keeps its ORIGINAL case (slice taken from the raw body).
    assert_json_path "$output" '.instruction' "check the SQL"

    rm -f "$EV"; rm -rf "$PR_REPO"
    teardown_mock_curl
}

@test "resolve-event: unsupported event → run=false unsupported-event" {
    export GITHUB_EVENT_NAME="push"
    export GITHUB_EVENT_PATH="$FIXTURES_DIR/event/pull-request.json"

    run bash -c "bash '$SRC_DIR/resolve-event.sh' 2>/dev/null"
    [ "$status" -eq 0 ]
    assert_json_path "$output" '.run' "false"
    assert_json_path "$output" '.reason' "unsupported-event"
}

@test "resolve-event: admin floor rejects a write user" {
    export MOCK_PERM_FIXTURE="$FIXTURES_DIR/event/perm-write.json"
    setup_mock_curl
    export INPUT_MIN_TRIGGER_PERMISSION="admin"
    export GITHUB_EVENT_NAME="issue_comment"
    export GITHUB_EVENT_PATH="$FIXTURES_DIR/event/issue-comment-pr.json"

    run bash -c "bash '$SRC_DIR/resolve-event.sh' 2>/dev/null"
    [ "$status" -eq 0 ]
    assert_json_path "$output" '.run' "false"
    assert_json_path "$output" '.reason' "insufficient-permission"
    grep -qx -- "-1" "$REACT_LOG"

    unset INPUT_MIN_TRIGGER_PERMISSION
    teardown_mock_curl
}
