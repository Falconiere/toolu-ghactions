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

# --- settled-findings recompute (#123) --------------------------------------
# SETTLE_* are the outputs of the composite's `recompute` step (merge-gate/recompute,
# code-review's read-only settle evaluation), exactly as action.yml maps them in.

@test "#307: request-changes, every thread answered, recompute approves → ready without the label" {
    stub_gh_pr 307
    SETTLE_OUTCOME=approve SETTLE_REASON= SETTLE_VERDICT=approved SETTLE_SETTLED=3 SETTLE_TOTAL=3 PR=307 run bash "$SCRIPT"
    [ "$status" -eq 0 ]
    [ "$output" = 'PR #307 is ready to auto-merge: every blocking finding of the last review is settled (3 of 3 settled, no model call) and every review thread answered.' ]
    [ "$(cat "$GITHUB_STEP_SUMMARY")" = "$output" ]
}

@test "#307: an advisory remainder (verdict changes) is named, not claimed settled" {
    stub_gh_pr 307
    SETTLE_OUTCOME=approve SETTLE_VERDICT=changes SETTLE_SETTLED=1 SETTLE_TOTAL=3 PR=307 run bash "$SCRIPT"
    [ "$status" -eq 0 ]
    [ "$output" = 'PR #307 is ready to auto-merge: every blocking finding of the last review is settled (1 of 3 settled, the rest below approve-below, no model call) and every review thread answered.' ]
}

@test "#307: recompute finds a newer push (stale-head) → not ready, and the reason is named" {
    stub_gh_pr 307
    SETTLE_OUTCOME=unchanged SETTLE_REASON=stale-head SETTLE_SETTLED=0 SETTLE_TOTAL=0 PR=307 run bash "$SCRIPT"
    [ "$status" -eq 1 ]
    [ "$output" = '::error::label `merge-approved` is missing; the Code Review action adds it when its verdict is approved (settled-findings recompute: stale-head)' ]
}

@test "#307: recompute finds an incomplete review → not ready, and the reason is named" {
    stub_gh_pr 307
    SETTLE_OUTCOME=unchanged SETTLE_REASON=incomplete PR=307 run bash "$SCRIPT"
    [ "$status" -eq 1 ]
    [ "$output" = '::error::label `merge-approved` is missing; the Code Review action adds it when its verdict is approved (settled-findings recompute: incomplete)' ]
}

@test "#307: a reason token with digits is named too" {
    stub_gh_pr 307
    SETTLE_OUTCOME=unchanged SETTLE_REASON=http-404 PR=307 run bash "$SCRIPT"
    [ "$status" -eq 1 ]
    [ "$output" = '::error::label `merge-approved` is missing; the Code Review action adds it when its verdict is approved (settled-findings recompute: http-404)' ]
}

@test "#307: a crashed recompute step (empty outputs) → today's missing-label line" {
    stub_gh_pr 307
    SETTLE_OUTCOME= SETTLE_REASON= PR=307 run bash "$SCRIPT"
    [ "$status" -eq 1 ]
    [ "$output" = '::error::label `merge-approved` is missing; the Code Review action adds it when its verdict is approved' ]
}

@test "#307: an unexpected reason value is not echoed into the annotation" {
    stub_gh_pr 307
    SETTLE_OUTCOME=unchanged SETTLE_REASON='x%0A::error::forged' PR=307 run bash "$SCRIPT"
    [ "$status" -eq 1 ]
    [ "$output" = '::error::label `merge-approved` is missing; the Code Review action adds it when its verdict is approved' ]
}

@test "#304: recompute approves but a thread is unanswered → not ready on the thread only" {
    stub_gh_pr 304
    SETTLE_OUTCOME=approve SETTLE_SETTLED=1 SETTLE_TOTAL=1 PR=304 run bash "$SCRIPT"
    [ "$status" -eq 1 ]
    [ "$output" = "::error::review thread has no reply: CHANGELOG.md: $(first_comment_url 304 0)" ]
}

@test "#289: the label is present, so an unchanged recompute is ignored" {
    stub_gh_pr 289
    SETTLE_OUTCOME=unchanged SETTLE_REASON=not-changes PR=289 run bash "$SCRIPT"
    [ "$status" -eq 0 ]
    [ "$output" = 'PR #289 is ready to auto-merge: labeled `merge-approved` and every review thread answered.' ]
}

@test "action.yml runs the read-only recompute first and hands its outputs to the gate" {
    action="$(cd "${BATS_TEST_DIRNAME}/.." && pwd)/action.yml"
    uses_line="$(grep -n 'uses: \$/merge-gate/recompute$' "$action" | cut -d: -f1)"
    gate_line="$(grep -n 'src/merge-gate.sh' "$action" | cut -d: -f1)"
    [ -n "$uses_line" ] && [ -n "$gate_line" ] && [ "$uses_line" -lt "$gate_line" ]
    grep -q '^ *id: recompute$' "$action"
    grep -q '^ *continue-on-error: true$' "$action"
    grep -q "if: \${{ inputs.settle-recompute == 'true' }}" "$action"
    for out in outcome reason verdict settled total; do
        upper="$(tr '[:lower:]' '[:upper:]' <<<"$out")"
        grep -q "SETTLE_${upper}: \${{ steps.recompute.outputs.${out} }}" "$action"
    done
    [ -f "$(dirname "$action")/recompute/action.yml" ]
    grep -q "main: 'index.cjs'" "$(dirname "$action")/recompute/action.yml"
}
