#!/usr/bin/env bash
# post-label.bats — tests for post-label.sh
# Mocks curl, recording each call (method + URL + body) to a log file so the
# assertions can verify which label was added/removed.

load helpers

setup_mock_curl() {
    MOCK_DIR=$(mktemp -d)
    CURL_LOG="$MOCK_DIR/curl.log"
    export CURL_LOG
    # MOCK_HTTP lets a test force the add-label POST to a non-2xx code.
    cat > "$MOCK_DIR/curl" << 'ENDSCRIPT'
#!/usr/bin/env bash
args=("$@"); method="GET"; url="${args[-1]}"; data=""; want_code=""
for i in "${!args[@]}"; do
    case "${args[$i]}" in
        -X) method="${args[$((i+1))]}" ;;
        --data) data="${args[$((i+1))]}" ;;
        -w) want_code="1" ;;
    esac
done
# Resolve --data @file to its contents for the log.
if [[ "$data" == @* ]]; then data="$(cat "${data#@}" 2>/dev/null)"; fi
echo "$method $url ${data//$'\n'/ }" >> "$CURL_LOG"
# When called with -w (the add-label POST), emit the HTTP code on stdout.
if [ -n "$want_code" ]; then printf '%s' "${MOCK_HTTP:-200}"; fi
exit 0
ENDSCRIPT
    chmod +x "$MOCK_DIR/curl"
    export PATH="$MOCK_DIR:$PATH"
    export GITHUB_TOKEN="ghp_test"
    export GITHUB_REPOSITORY="test-org/test-repo"
    export GITHUB_EVENT_PATH="$FIXTURES_DIR/test-pr-event.json"
}

teardown_mock_curl() {
    rm -rf "${MOCK_DIR:-/tmp/nonexistent}"
    unset MOCK_HTTP
}

@test "post-label: approved adds approved label and removes changes label" {
    setup_mock_curl

    run bash "$SRC_DIR/post-label.sh" approved
    [ "$status" -eq 0 ]

    # Opposite label removed via DELETE, verdict label added via POST.
    grep -q "DELETE .*/labels/agent-request-changes" "$CURL_LOG"
    grep -qE "POST .*/issues/[0-9]+/labels .*agent-merge-approved" "$CURL_LOG"

    teardown_mock_curl
}

@test "post-label: changes adds changes label and removes approved label" {
    setup_mock_curl

    run bash "$SRC_DIR/post-label.sh" changes
    [ "$status" -eq 0 ]

    grep -q "DELETE .*/labels/agent-merge-approved" "$CURL_LOG"
    grep -qE "POST .*/issues/[0-9]+/labels .*agent-request-changes" "$CURL_LOG"

    teardown_mock_curl
}

@test "post-label: error verdict is treated as request-changes" {
    setup_mock_curl

    run bash "$SRC_DIR/post-label.sh" error
    [ "$status" -eq 0 ]
    grep -qE "POST .*/issues/[0-9]+/labels .*agent-request-changes" "$CURL_LOG"

    teardown_mock_curl
}

@test "post-label: ensures the label exists in the repo before adding" {
    setup_mock_curl

    run bash "$SRC_DIR/post-label.sh" approved
    [ "$status" -eq 0 ]
    # A repo-level label create (idempotent) precedes attaching it to the PR.
    grep -qE "POST .*/repos/test-org/test-repo/labels .*agent-merge-approved" "$CURL_LOG"

    teardown_mock_curl
}

@test "post-label: MANAGE_LABELS=false skips entirely" {
    setup_mock_curl
    export INPUT_MANAGE_LABELS=false

    run bash "$SRC_DIR/post-label.sh" approved
    [ "$status" -eq 0 ]
    [ ! -s "$CURL_LOG" ]  # no API calls at all

    unset INPUT_MANAGE_LABELS
    teardown_mock_curl
}

@test "post-label: unknown verdict makes no label change" {
    setup_mock_curl

    run bash "$SRC_DIR/post-label.sh" skip
    [ "$status" -eq 0 ]
    [ ! -s "$CURL_LOG" ]

    teardown_mock_curl
}

@test "post-label: a non-2xx from the labels API is non-fatal" {
    setup_mock_curl
    export MOCK_HTTP=403

    run bash "$SRC_DIR/post-label.sh" approved
    [ "$status" -eq 0 ]
    [[ "$output" == *"non-fatal"* ]]

    teardown_mock_curl
}

@test "post-label: missing token skips without error" {
    setup_mock_curl
    unset GITHUB_TOKEN

    run bash "$SRC_DIR/post-label.sh" approved
    [ "$status" -eq 0 ]
    [ ! -s "$CURL_LOG" ]

    teardown_mock_curl
}
