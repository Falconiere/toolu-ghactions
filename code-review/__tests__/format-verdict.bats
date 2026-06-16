#!/usr/bin/env bash
# format-verdict.bats — tests for format-verdict.sh

load helpers

@test "format-verdict: renders approved comment with findings" {
    # Parse the approved response first.
    parsed=$(bash "$SRC_DIR/parse-response.sh" < "$FIXTURES_DIR/sample-openrouter-response-approved.json")

    run bash "$SRC_DIR/format-verdict.sh" <<< "$parsed"
    [ "$status" -eq 0 ]

    # Check required markers.
    [[ "$output" == *"### Code Review"* ]]
    [[ "$output" == *'`feat/add-login`'* ]]
    [[ "$output" == *"### Review Plan"* ]]
    [[ "$output" == *"Reviewing 4 files"* ]]
    [[ "$output" == *"agent-merge-approved"* ]]
    [[ "$output" == *"### Findings"* ]]
    [[ "$output" == *"### Other checks"* ]]
    [[ "$output" == *"### Top-N must-fix"* ]]
    [[ "$output" == *"View job"* ]]
    [[ "$output" == *"actions/runs/1234567890"* ]]

    # Checkbox checklist should be fully checked.
    [[ "$output" == *"- [x] Read repository context and PR diff"* ]]
    [[ "$output" == *"- [x] Post findings"* ]]
    [[ "$output" == *"- [x] Set verdict label"* ]]

    # Findings should appear.
    [[ "$output" == *'src/utils/format.ts:17'* ]]
    [[ "$output" == *'Temporary workaround'* ]]
}

@test "format-verdict: renders changes-requested comment with blocker" {
    parsed=$(bash "$SRC_DIR/parse-response.sh" < "$FIXTURES_DIR/sample-openrouter-response-changes.json")

    run bash "$SRC_DIR/format-verdict.sh" <<< "$parsed"
    [ "$status" -eq 0 ]

    [[ "$output" == *"Changes requested"* ]]
    [[ "$output" == *"agent-request-changes"* ]]
    [[ "$output" == *"🔴"*"blocker"* ]]  # Blocker badge.
    [[ "$output" == *"src/auth/login.ts:42"* ]]
    [[ "$output" == *"SQL injection"* ]]
}

@test "format-verdict: includes View job link with run ID" {
    parsed=$(bash "$SRC_DIR/parse-response.sh" < "$FIXTURES_DIR/sample-openrouter-response-approved.json")

    run bash "$SRC_DIR/format-verdict.sh" <<< "$parsed"
    [ "$status" -eq 0 ]

    [[ "$output" == *"https://github.com/test-org/test-repo/actions/runs/1234567890"* ]]
}

@test "format-verdict: parse-verdict.sh compatibility — markers present" {
    parsed=$(bash "$SRC_DIR/parse-response.sh" < "$FIXTURES_DIR/sample-openrouter-response-approved.json")
    comment=$(bash "$SRC_DIR/format-verdict.sh" <<< "$parsed")

    # The comment must contain markers parse-verdict.sh looks for.
    [[ "$comment" == *"### Code Review"* ]]
    [[ "$comment" == *'`agent-'* ]]  # Backtick-wrapped verdict label.
    [[ "$comment" == *"View job"* ]]
}

@test "format-verdict: no findings produces zero-count message" {
    # Construct a review with zero findings.
    review='{"review_plan":"","verdict":"approved","findings":[],"other_checks":"","top_must_fix":[]}'

    run bash "$SRC_DIR/format-verdict.sh" <<< "$review"
    [ "$status" -eq 0 ]

    [[ "$output" == *"Findings (0)"* ]]
}
