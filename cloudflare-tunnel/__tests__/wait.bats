#!/usr/bin/env bats
# wait.bats — exercise src/wait.sh: backoff, status matching, timeout.
load helpers

setup() { common_setup; }
teardown() { common_teardown; }

@test "success: returns 0 when URL responds with 200 in first poll" {
    stub_curl_status 200
    export INPUT_URL="https://example-slug-here.trycloudflare.com"
    export INPUT_WAIT_TIMEOUT=10
    export INPUT_EXPECTED_STATUS=2
    run bash "$SRC_DIR/wait.sh"
    [ "$status" -eq 0 ]
}

@test "status filter: 2 prefix matches 200, 3 prefix matches 302" {
    stub_curl_status 302
    export INPUT_URL="https://example-slug-here.trycloudflare.com"
    export INPUT_WAIT_TIMEOUT=5
    export INPUT_EXPECTED_STATUS=3
    run bash "$SRC_DIR/wait.sh"
    [ "$status" -eq 0 ]
}

@test "exact status: 404 matches exactly, 200 fails when expecting 404" {
    stub_curl_status 200
    export INPUT_URL="https://example-slug-here.trycloudflare.com"
    export INPUT_WAIT_TIMEOUT=5
    export INPUT_EXPECTED_STATUS=404
    run bash "$SRC_DIR/wait.sh"
    [ "$status" -eq 1 ]
    [[ "$output" == *"did not respond"* ]]
}

@test "timeout: URL never responds with expected status within deadline" {
    stub_curl_fail
    export INPUT_URL="https://example-slug-here.trycloudflare.com"
    export INPUT_WAIT_TIMEOUT=3
    export INPUT_EXPECTED_STATUS=2
    run bash "$SRC_DIR/wait.sh"
    [ "$status" -eq 1 ]
    [[ "$output" == *"did not respond"* ]]
}

@test "eventual success: URL returns 503 then 200 — succeeds on 200" {
    stub_curl_sequence 503 200
    export INPUT_URL="https://example-slug-here.trycloudflare.com"
    export INPUT_WAIT_TIMEOUT=10
    export INPUT_EXPECTED_STATUS=2
    run bash "$SRC_DIR/wait.sh"
    [ "$status" -eq 0 ]
}

@test "missing URL input: exits 1" {
    export INPUT_URL=""
    run bash "$SRC_DIR/wait.sh"
    [ "$status" -eq 1 ]
}
