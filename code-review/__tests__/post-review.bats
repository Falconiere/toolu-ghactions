#!/usr/bin/env bash
# post-review.bats — tests for post-review.sh (inline review comments + suggestions).
# Mocks curl; captures the POSTed reviews payload for inspection.

load helpers

setup_mock_curl() {
    MOCK_DIR=$(mktemp -d)
    cat > "$MOCK_DIR/curl" << 'ENDSCRIPT'
#!/usr/bin/env bash
# Capture --data @file into REVIEW_PAYLOAD; emit MOCK_CODE as the http_code.
args=("$@"); outfile=""; datafile=""
for i in "${!args[@]}"; do
    case "${args[$i]}" in
        -o) outfile="${args[$((i+1))]}" ;;
        --data) d="${args[$((i+1))]}"; datafile="${d#@}" ;;
    esac
done
[ -n "$datafile" ] && [ -n "${REVIEW_PAYLOAD:-}" ] && cp "$datafile" "$REVIEW_PAYLOAD"
code="${MOCK_CODE:-200}"
if [ "$code" = "200" ]; then
    body='{"id":1,"html_url":"https://github.com/test-org/test-repo/pull/42#pullrequestreview-1"}'
else
    body='{"message":"Validation Failed: line not part of the diff"}'
fi
[ -n "$outfile" ] && printf '%s' "$body" > "$outfile"
printf '%s' "$code"
ENDSCRIPT
    chmod +x "$MOCK_DIR/curl"
    export PATH="$MOCK_DIR:$PATH"
}

teardown_mock_curl() { rm -rf "${MOCK_DIR:-/tmp/nonexistent}"; }

@test "post-review: posts a COMMENT review with anchored comments and a suggestion block" {
    setup_mock_curl
    export GITHUB_TOKEN="ghp_test" GITHUB_REPOSITORY="test-org/test-repo"
    export REVIEW_PAYLOAD="$(mktemp)"

    findings='{"findings":[
        {"path":"src/a.ts","line":10,"severity":"high","category":"security","confidence":"high","suggestion":"sanitize(input)","text":"Unsanitized input"},
        {"path":"src/b.ts","line":5,"severity":"low","text":"Minor"}
    ]}'
    run bash "$SRC_DIR/post-review.sh" <<< "$findings"
    [ "$status" -eq 0 ]

    # Reviews payload shape.
    [ "$(jq -r '.event' "$REVIEW_PAYLOAD")" = "COMMENT" ]
    [ "$(jq -r '.commit_id' "$REVIEW_PAYLOAD")" = "abc123def456" ]
    [ "$(jq '.comments | length' "$REVIEW_PAYLOAD")" -eq 2 ]
    [ "$(jq -r '.comments[0].side' "$REVIEW_PAYLOAD")" = "RIGHT" ]
    # The high-confidence finding renders a committable suggestion block.
    jq -r '.comments[].body' "$REVIEW_PAYLOAD" | grep -q '```suggestion'
    jq -r '.comments[].body' "$REVIEW_PAYLOAD" | grep -q 'sanitize(input)'

    rm -f "$REVIEW_PAYLOAD"; teardown_mock_curl
}

@test "post-review: excludes findings without an anchorable line" {
    setup_mock_curl
    export GITHUB_TOKEN="ghp_test" GITHUB_REPOSITORY="test-org/test-repo"
    export REVIEW_PAYLOAD="$(mktemp)"

    findings='{"findings":[
        {"path":"src/a.ts","line":null,"severity":"high","text":"no line"},
        {"path":"src/a.ts","line":7,"severity":"high","text":"has line"}
    ]}'
    run bash "$SRC_DIR/post-review.sh" <<< "$findings"
    [ "$status" -eq 0 ]
    [ "$(jq '.comments | length' "$REVIEW_PAYLOAD")" -eq 1 ]
    [ "$(jq -r '.comments[0].line' "$REVIEW_PAYLOAD")" = "7" ]

    rm -f "$REVIEW_PAYLOAD"; teardown_mock_curl
}

@test "post-review: INLINE_COMMENTS=false skips posting entirely" {
    setup_mock_curl
    export GITHUB_TOKEN="ghp_test" GITHUB_REPOSITORY="test-org/test-repo"
    export REVIEW_PAYLOAD="$(mktemp)"
    : > "$REVIEW_PAYLOAD"  # empty marker

    findings='{"findings":[{"path":"src/a.ts","line":10,"severity":"high","text":"x"}]}'
    INPUT_INLINE_COMMENTS=false run bash "$SRC_DIR/post-review.sh" <<< "$findings"
    [ "$status" -eq 0 ]
    # No request was made → payload file stays empty.
    [ ! -s "$REVIEW_PAYLOAD" ]

    rm -f "$REVIEW_PAYLOAD"; teardown_mock_curl
}

@test "post-review: a 422 from the reviews API is non-fatal" {
    setup_mock_curl
    export GITHUB_TOKEN="ghp_test" GITHUB_REPOSITORY="test-org/test-repo"
    export REVIEW_PAYLOAD="$(mktemp)" MOCK_CODE=422 BACKOFF_BASE=0

    findings='{"findings":[{"path":"src/a.ts","line":10,"severity":"high","text":"x"}]}'
    run bash "$SRC_DIR/post-review.sh" <<< "$findings"
    [ "$status" -eq 0 ]

    rm -f "$REVIEW_PAYLOAD"; teardown_mock_curl
}
