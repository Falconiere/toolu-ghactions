#!/usr/bin/env bash
# main.bats — end-to-end tests for main.sh orchestration.
# Uses a real temp git repo for the diff and a smart curl stub that routes by
# URL + request content (OpenRouter chat vs GitHub comments vs reviews).

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
    # main.sh writes outputs to $GITHUB_OUTPUT (a file in CI, /dev/stdout when
    # unset). Pin it to a file so assertions are env-independent.
    export GITHUB_OUTPUT="$TMP_REPO/gh_output"
    : > "$GITHUB_OUTPUT"
}
teardown_repo() { cd /; rm -rf "${TMP_REPO:-/tmp/nope}" "${MOCK_DIR:-/tmp/nope}"; }

# $FAIL_DIM (optional) makes that dimension's OpenRouter call return 500.
setup_pipeline_curl() {
    MOCK_DIR=$(mktemp -d)
    export FIXTURES_DIR="$FIXTURES_DIR"
    cat > "$MOCK_DIR/curl" << 'ENDSCRIPT'
#!/usr/bin/env bash
args=("$@"); outfile=""; datafile=""
for i in "${!args[@]}"; do
    case "${args[$i]}" in
        -o) outfile="${args[$((i+1))]}" ;;
        --data-binary|--data) d="${args[$((i+1))]}"; datafile="${d#@}" ;;
    esac
done
url="${args[-1]}"
reqbody=""; [ -n "$datafile" ] && [ -f "$datafile" ] && reqbody=$(cat "$datafile")
code=200
case "$url" in
    *chat/completions*)
        if echo "$reqbody" | grep -q "coordinating reviewer"; then
            body=$(cat "$FIXTURES_DIR/sample-coordinator-response.json")
        elif [ -n "${FAIL_DIM:-}" ] && echo "$reqbody" | grep -q "Your dimension: ${FAIL_DIM}"; then
            code=500; body='{"error":{"code":500,"message":"boom"}}'
        else
            body=$(cat "$FIXTURES_DIR/sample-openrouter-response-correctness.json")
        fi ;;
    *reviews*)  body='{"id":1,"html_url":"https://github.com/x/pull/42#pullrequestreview-1"}' ;;
    *comments*)
        # GitHub lists comments as an array (GET, no body); create/update returns
        # the object (POST/PATCH, has --data).
        if [ -n "$datafile" ]; then body='{"id":999,"html_url":"https://github.com/x/issues/42#issuecomment-999"}'; else body='[]'; fi ;;
    *)          body='[]' ;;
esac
# With -o (call-openrouter / post-review): body to file, http_code to stdout.
# Without -o (post-comment): body straight to stdout.
if [ -n "$outfile" ]; then printf '%s' "$body" > "$outfile"; printf '%s' "$code"; else printf '%s' "$body"; fi
ENDSCRIPT
    chmod +x "$MOCK_DIR/curl"; export PATH="$MOCK_DIR:$PATH"
}

@test "main: fails when OPENROUTER_API_KEY is unset" {
    unset OPENROUTER_API_KEY; export GITHUB_TOKEN="ghp_test"
    run bash "$SRC_DIR/main.sh"
    [ "$status" -ne 0 ]
}

@test "main: fails when GITHUB_TOKEN is unset" {
    export OPENROUTER_API_KEY="sk-or-test"; unset GITHUB_TOKEN
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

@test "main: single mode runs the linear pipeline end to end" {
    setup_repo; setup_pipeline_curl
    export OPENROUTER_API_KEY="sk-or-test" GITHUB_TOKEN="ghp_test" BACKOFF_BASE=0
    export INPUT_REVIEW_MODE=single INPUT_BASE_BRANCH=main GITHUB_BASE_REF=main

    run bash "$SRC_DIR/main.sh"
    [ "$status" -eq 0 ]
    grep -q 'verdict=' "$GITHUB_OUTPUT"
    teardown_repo
}

@test "main: parallel mode fans out dimensions and posts a verdict" {
    setup_repo; setup_pipeline_curl
    export OPENROUTER_API_KEY="sk-or-test" GITHUB_TOKEN="ghp_test" BACKOFF_BASE=0
    export INPUT_REVIEW_MODE=parallel INPUT_BASE_BRANCH=main GITHUB_BASE_REF=main

    run bash "$SRC_DIR/main.sh"
    [ "$status" -eq 0 ]
    grep -q 'verdict=' "$GITHUB_OUTPUT"
    teardown_repo
}

@test "main: parallel mode tolerates a partial dimension failure" {
    setup_repo; setup_pipeline_curl
    export OPENROUTER_API_KEY="sk-or-test" GITHUB_TOKEN="ghp_test" BACKOFF_BASE=0
    export INPUT_REVIEW_MODE=parallel INPUT_BASE_BRANCH=main GITHUB_BASE_REF=main
    export FAIL_DIM=security

    run bash "$SRC_DIR/main.sh"
    [ "$status" -eq 0 ]   # one dimension failed but the rest carried the review
    grep -q 'verdict=' "$GITHUB_OUTPUT"
    teardown_repo
}
