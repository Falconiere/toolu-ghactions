#!/usr/bin/env bats
# merge-gate.bats — run src/merge-gate.sh against real recorded pull requests
# (see helpers.bash for where each fixture came from). No mocks: only `gh` is
# replayed, and the verdict comes from the script's own jq over real payloads.
load helpers

setup() { common_setup; }
teardown() { common_teardown; }

@test "#289: approved, bot follow-ups answered, resolved code-scanning thread exempt → ready" {
    stub_gh_pr 289
    PR=289 run bash "$SCRIPT"
    [ "$status" -eq 0 ]
    [ "$output" = 'PR #289 is ready to auto-merge: labeled `merge-approved` and every review thread answered.' ]
    [ "$(cat "$GITHUB_STEP_SUMMARY")" = "$output" ]
}

@test "#302: approved with no review threads → ready" {
    stub_gh_pr 302
    PR=302 run bash "$SCRIPT"
    [ "$status" -eq 0 ]
    [[ "$output" == 'PR #302 is ready to auto-merge:'* ]]
}

@test "#204: approved, but the bot only answered itself on two threads → not ready" {
    stub_gh_pr 204
    PR=204 run bash "$SCRIPT"
    [ "$status" -eq 1 ]
    expected="::error::review thread has no reply: CHANGELOG.md: $(first_comment_url 204 0)
::error::review thread has no reply: CHANGELOG.md: $(first_comment_url 204 1)"
    [ "$output" = "$expected" ]
}

@test "#304: request-changes label and an unanswered thread → both reported" {
    stub_gh_pr 304
    PR=304 run bash "$SCRIPT"
    [ "$status" -eq 1 ]
    expected='::error::label `merge-approved` is missing; the Code Review action adds it when its verdict is approved'"
::error::review thread has no reply: CHANGELOG.md: $(first_comment_url 304 0)"
    [ "$output" = "$expected" ]
    summary='### Merge gate: PR #304 is not ready
- label `merge-approved` is missing; the Code Review action adds it when its verdict is approved'"
- review thread has no reply: CHANGELOG.md: $(first_comment_url 304 0)"
    [ "$(cat "$GITHUB_STEP_SUMMARY")" = "$summary" ]
}

@test "an unreadable API names the permission and the API's message, and stops" {
    stub_gh_labels_404
    PR=999999 run bash "$SCRIPT"
    [ "$status" -eq 1 ]
    [ "$output" = "::error::Could not read PR #999999 in Falconiere/comemory. The calling workflow must grant pull-requests read access. API said: gh: Not Found (HTTP 404)" ]
    # The threads query never ran after the labels call failed.
    [ "$(wc -l < "$GH_LOG" | tr -d ' ')" -eq 1 ]
}

@test "a malformed pull request number is rejected before any API call" {
    stub_gh_pr 289
    PR='12; rm -rf /' run bash "$SCRIPT"
    [ "$status" -eq 1 ]
    [ "$output" = "::error::unexpected pull request number '12; rm -rf /'" ]
    [ ! -e "$GH_LOG" ]
}

@test "an empty pull request number is rejected (not a pull_request event)" {
    stub_gh_pr 289
    PR='' run bash "$SCRIPT"
    [ "$status" -eq 1 ]
    [ "$output" = "::error::unexpected pull request number ''" ]
    [ ! -e "$GH_LOG" ]
}

@test "a repository that is not owner/name is rejected before any API call" {
    stub_gh_pr 289
    REPO='Falconiere/comemory/extra' PR=289 run bash "$SCRIPT"
    [ "$status" -eq 1 ]
    [ "$output" = "::error::unexpected repository 'Falconiere/comemory/extra'" ]
    REPO='comemory' PR=289 run bash "$SCRIPT"
    [ "$status" -eq 1 ]
    [ "$output" = "::error::unexpected repository 'comemory'" ]
    [ ! -e "$GH_LOG" ]
}
