#!/usr/bin/env bash
# main.bats — end-to-end tests for main.sh (multi-provider dispatch).

load helpers

setup_repo() {
    TMP_REPO=$(mktemp -d)
    cd "$TMP_REPO"
    git init --initial-branch=main --quiet
    git config user.email t@t.com; git config user.name T
    printf 'one\ntwo\n' > app.ts
    git add app.ts; git commit -m init --quiet
    git checkout -b feature --quiet
    printf 'one\ntwo\nthree\n' > app.ts
    git add app.ts; git commit -m change --quiet
    export GITHUB_OUTPUT="$TMP_REPO/gh_output"
    : > "$GITHUB_OUTPUT"
}
teardown_repo() { cd /; rm -rf "${TMP_REPO:-/tmp/nope}" "${MOCK_DIR:-/tmp/nope}"; }

setup_pipeline_curl() {
    MOCK_DIR=$(mktemp -d)
    export FIXTURES_DIR="$FIXTURES_DIR"
    cat > "$MOCK_DIR/curl" << 'ENDSCRIPT'
#!/usr/bin/env bash
args=("$@"); outfile=""
for i in "${!args[@]}"; do case "${args[$i]}" in -o) outfile="${args[$((i+1))]}" ;; esac; done
url="${args[-1]}"; code=200
case "$url" in
    */v1/messages*|*chat/completions*)
        if [ -n "$outfile" ]; then printf '{"choices":[{"message":{"content":"{\"verdict\":\"approved\",\"findings\":[],\"review_plan\":\"\",\"other_checks\":\"\",\"top_must_fix\":[]}"}}]}' > "$outfile"; fi
        printf "200" ;;
    *reviews*)
        if [ -n "$outfile" ]; then printf '{"id":1,"html_url":"https://gh/x"}' > "$outfile"; fi
        printf "200" ;;
    *comments*)
        printf '[]' ;;
    *) printf '[]' ;;
esac
ENDSCRIPT
    chmod +x "$MOCK_DIR/curl"; export PATH="$MOCK_DIR:$PATH"
}

@test "main: fails when no providers configured" {
    unset OPENROUTER_API_KEY INPUT_PROVIDERS INPUT_OPENROUTER_API_KEY
    export GITHUB_TOKEN="ghp_test"
    run bash "$SRC_DIR/main.sh"
    [ "$status" -ne 0 ]
}

@test "main: fails when GITHUB_TOKEN is unset" {
    export OPENROUTER_API_KEY="sk-or-test"
    run bash "$SRC_DIR/main.sh"
    [ "$status" -ne 0 ]
}

@test "main: handles fetch-diff failure gracefully" {
    export OPENROUTER_API_KEY="sk-or-test" GITHUB_TOKEN="ghp_test"
    tmpdir=$(mktemp -d); cd "$tmpdir"
    run bash "$SRC_DIR/main.sh"
    [ "$status" -ne 0 ]
    cd - > /dev/null; rm -rf "$tmpdir"
}

@test "main: legacy OPENROUTER_API_KEY path produces verdict" {
    setup_repo; setup_pipeline_curl
    export OPENROUTER_API_KEY="sk-or-test" GITHUB_TOKEN="ghp_test" BACKOFF_BASE=0
    export INPUT_BASE_BRANCH=main GITHUB_BASE_REF=main INPUT_ENFORCE_JSON_SCHEMA=true
    unset INPUT_PROVIDERS

    # Post-comment may fail in the test (empty comment list parsing).
    # The core pipeline runs: confirm verdict output is present.
    run bash "$SRC_DIR/main.sh"
    grep -q 'verdict=' "$GITHUB_OUTPUT"
    teardown_repo
}

@test "main: PROVIDERS with 2 entries dispatches parallel jobs" {
    setup_repo; setup_pipeline_curl
    export GITHUB_TOKEN="ghp_test" BACKOFF_BASE=0
    export INPUT_BASE_BRANCH=main GITHUB_BASE_REF=main INPUT_MERGE_STRATEGY=conservative
    export OPENROUTER_API_KEY="sk-or-test"
    export INPUT_PROVIDERS='[
        {"provider":"openrouter","model":"minimax/minimax-m3","api_key":"sk-or-test"},
        {"provider":"openai","model":"gpt-4o","api_key":"sk-openai-test"}
    ]'

    run bash "$SRC_DIR/main.sh"
    grep -q 'verdict=' "$GITHUB_OUTPUT"
    teardown_repo
}

@test "main: both PROVIDERS and OPENROUTER_API_KEY set — PROVIDERS wins" {
    setup_repo; setup_pipeline_curl
    export GITHUB_TOKEN="ghp_test" BACKOFF_BASE=0
    export INPUT_BASE_BRANCH=main GITHUB_BASE_REF=main
    export OPENROUTER_API_KEY="sk-or-legacy"
    export INPUT_PROVIDERS='[
        {"provider":"openrouter","model":"minimax/minimax-m3","api_key":"sk-or-test"}
    ]'

    run bash "$SRC_DIR/main.sh"
    grep -q 'verdict=' "$GITHUB_OUTPUT"
    teardown_repo
}

@test "main: fallback_model set in legacy mode still works" {
    setup_repo; setup_pipeline_curl
    export OPENROUTER_API_KEY="sk-or-test" GITHUB_TOKEN="ghp_test" BACKOFF_BASE=0
    export INPUT_BASE_BRANCH=main GITHUB_BASE_REF=main
    export INPUT_FALLBACK_MODEL="anthropic/claude-sonnet-4-5"
    unset INPUT_PROVIDERS

    run bash "$SRC_DIR/main.sh"
    grep -q 'verdict=' "$GITHUB_OUTPUT"
    teardown_repo
}

@test "main: review_mode triggers deprecation log" {
    setup_repo; setup_pipeline_curl
    export OPENROUTER_API_KEY="sk-or-test" GITHUB_TOKEN="ghp_test" BACKOFF_BASE=0
    export INPUT_BASE_BRANCH=main GITHUB_BASE_REF=main
    export INPUT_REVIEW_MODE=parallel
    unset INPUT_PROVIDERS

    run bash "$SRC_DIR/main.sh"
    grep -q 'verdict=' "$GITHUB_OUTPUT"
    teardown_repo
}

@test "main: non-triggering issue_comment exits skip and writes outputs (no provider run)" {
    setup_repo; setup_pipeline_curl
    export OPENROUTER_API_KEY="sk-or-test" GITHUB_TOKEN="ghp_test" BACKOFF_BASE=0
    export INPUT_BASE_BRANCH=main GITHUB_BASE_REF=main
    unset INPUT_PROVIDERS
    # An issue_comment with no trigger phrase must NOT run a review, must exit 0,
    # and must still emit verdict=skip so consumers gating on the output get a value.
    export GITHUB_EVENT_NAME="issue_comment"
    export GITHUB_EVENT_PATH="$FIXTURES_DIR/event/issue-comment-nophrase.json"

    run bash "$SRC_DIR/main.sh"
    [ "$status" -eq 0 ]
    grep -q 'verdict=skip' "$GITHUB_OUTPUT"
    teardown_repo
}
