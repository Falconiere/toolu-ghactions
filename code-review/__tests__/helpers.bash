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
}

# Cleanup after each test.
teardown() {
    true
}
