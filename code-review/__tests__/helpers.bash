#!/usr/bin/env bash
# helpers.bash — shared setup and utilities for bats tests.

REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
FIXTURES_DIR="$REPO_ROOT/code-review/__tests__/fixtures"
SRC_DIR="$REPO_ROOT/code-review/src"

# Setup: set common env vars.
setup() {
    export GITHUB_SERVER_URL="https://github.com"
    export GITHUB_REPOSITORY="test-org/test-repo"
    export GITHUB_RUN_ID="1234567890"
    export GITHUB_HEAD_REF="feat/add-login"
    export GITHUB_EVENT_PATH="$FIXTURES_DIR/test-pr-event.json"
    export GITHUB_BASE_REF="main"
    export INPUT_MODEL="minimax/minimax-m3"
    export INPUT_BASE_BRANCH="main"
    export INPUT_MAX_FILES="100"
    export INPUT_MAX_DIFF_LINES="8000"
    # Multi-provider test defaults (overridden per-test as needed).
    export INPUT_PROVIDERS=""
    export INPUT_MERGE_STRATEGY="conservative"
    export INPUT_REVIEW_MODE="single"
    export INPUT_OPENROUTER_API_KEY=""
    export INPUT_FALLBACK_MODEL=""
    export INPUT_ENFORCE_JSON_SCHEMA="true"
    export INPUT_REVIEW_PROMPT_FILE=""
    export INPUT_CODEBASE_OVERVIEW=""
    export INPUT_INLINE_COMMENTS="true"
    export INPUT_MANAGE_LABELS="true"
}

# Cleanup after each test.
teardown() {
    true
}

# assert_json_path <json> <jq-path> <expected>
# Fails the test if <jq-path> in <json> does not equal <expected>.
assert_json_path() {
    local json="$1" path="$2" expected="$3"
    local actual
    actual=$(echo "$json" | jq -r "$path")
    if [ "$actual" != "$expected" ]; then
        echo "assert_json_path: expected $path = '$expected', got '$actual'" >&2
        echo "json was: $json" >&2
        return 1
    fi
}

# assert_contains <haystack> <needle>
# Fails the test if <haystack> does not contain <needle>.
assert_contains() {
    local haystack="$1" needle="$2"
    if ! [[ "$haystack" == *"$needle"* ]]; then
        echo "assert_contains: haystack does not contain '$needle'" >&2
        return 1
    fi
}

# stub_curl_with_fixture <fixture-path>
# Replaces `curl` with a shell function that reads <fixture-path> and prints it to stdout,
# with HTTP code 200 and a Content-Type header. Tests should `unset -f curl` in teardown.
# Usage: stub_curl_with_fixture "$FIXTURES_DIR/openai/success.json"
stub_curl_with_fixture() {
    local fixture="$1"
    eval "curl() { cat '$fixture'; }"
}

# capture_temp_file <var-name>
# Sets <var-name> to a fresh mktemp path the test can use to read a script's output.
capture_temp_file() {
    local var_name="$1"
    local path
    path=$(mktemp)
    printf -v "$var_name" '%s' "$path"
    export "$var_name"
}
