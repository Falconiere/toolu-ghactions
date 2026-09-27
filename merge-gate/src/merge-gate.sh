#!/usr/bin/env bash
# merge-gate.sh — fail the `merge-gate` check until a pull request is ready to
# auto-merge: it carries the `merge-approved` label (or the composite's read-only
# recompute found every finding of the last review settled on the live head), and
# every review thread has a reply from someone other than the account that opened it. Green CI and
# resolved threads are left to branch protection (required checks and required
# conversation resolution); this gate checks only what GitHub cannot express.
#
# env : GH_TOKEN (needs pull-requests: read), REPO (owner/name), PR (number),
#       GITHUB_STEP_SUMMARY (optional; the verdict is appended when set),
#       SETTLE_OUTCOME / SETTLE_REASON / SETTLE_SETTLED / SETTLE_TOTAL (optional; the
#       outputs of the composite's `recompute` step — merge-gate/recompute)
# exit: 0 ready to merge; 1 not ready, bad input, or an unreadable API.
set -euo pipefail

command -v jq >/dev/null 2>&1 || { echo "::error::merge-gate.sh: jq required"; exit 1; }
command -v gh >/dev/null 2>&1 || { echo "::error::merge-gate.sh: gh required"; exit 1; }

REPO="${REPO:-}"
PR="${PR:-}"
summary="${GITHUB_STEP_SUMMARY:-/dev/null}"

# A PR number is digits and a repo is `owner/name`; neither goes into a query
# unchecked.
case "$PR" in
  *[!0-9]*|"") echo "::error::unexpected pull request number '$PR'"; exit 1 ;;
esac
case "$REPO" in
  */*/*|"") echo "::error::unexpected repository '$REPO'"; exit 1 ;;
  */*) ;;
  *) echo "::error::unexpected repository '$REPO'"; exit 1 ;;
esac

# Run one `gh api` call into API_OUT, keeping stderr apart from stdout: a
# notice gh prints on a successful call must not reach the JSON jq parses, and
# a failed call should name the API's own message rather than die as a bare
# `set -e` exit. Called directly, not in `$(...)`, so the annotation reaches
# the log and the exit ends the script.
api() {
  local err
  err="$(mktemp)"
  if ! API_OUT="$(gh api "$@" 2>"$err")"; then
    echo "::error::Could not read PR #$PR in $REPO. The calling workflow must grant pull-requests read access. API said: $(head -1 "$err")"
    rm -f "$err"
    exit 1
  fi
  rm -f "$err"
}

problems=()
settled_by_recompute=0

# Read the labels fresh rather than from the event payload: the Code Review
# action swaps `request-changes` for `merge-approved` during its own job, after
# the payload of the event that started this run was frozen.
api "repos/$REPO/issues/$PR/labels?per_page=100"
if ! jq -e 'any(.[]; .name == "merge-approved")' >/dev/null <<<"$API_OUT"; then
  # The label is missing. The recompute step (no model call, read-only) may still
  # show that every finding of the last review on the LIVE head is settled — a reply
  # on a thread is a trigger, and the label only moves inside a review run. Anything
  # but an explicit `approve` (unchanged, empty from a skipped or crashed step) keeps
  # the problem: fail closed.
  if [ "${SETTLE_OUTCOME:-}" = "approve" ]; then
    settled_by_recompute=1
  else
    missing="label \`merge-approved\` is missing; the Code Review action adds it when its verdict is approved"
    # The reason is one of the recompute's own tokens; anything else is not echoed.
    case "${SETTLE_REASON:-}" in
      ""|*[!a-z-]*) ;;
      *) missing="$missing (settled-findings recompute: $SETTLE_REASON)" ;;
    esac
    problems+=("$missing")
  fi
fi

# Every review thread across every page; --slurp wraps the pages in one array.
api graphql --paginate --slurp \
  -F owner="${REPO%/*}" -F name="${REPO#*/}" -F pr="$PR" \
  -f query='
    query($owner: String!, $name: String!, $pr: Int!, $endCursor: String) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $pr) {
          reviewThreads(first: 100, after: $endCursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              isResolved
              path
              comments(first: 100) { nodes { url author { login } } }
            }
          }
        }
      }
    }'

# A thread is answered once a later comment comes from an author other than
# its opener. The reviewer posts follow-ups inside its own threads, so "has a
# second comment" would count the bot answering itself. A code-scanning thread
# (`github-advanced-security`) is exempt once resolved: resolving it is the
# finding being fixed or dismissed. Only a thread's first 100 comments are
# read; past that cap a reply can only be missed, never invented, so the gate
# errs toward blocking.
unanswered="$(jq -r '
  .[].data.repository.pullRequest.reviewThreads.nodes[]
  | (.comments.nodes[0].author.login // "ghost") as $opener
  | select(($opener == "github-advanced-security" and .isResolved) | not)
  | select([.comments.nodes[1:][] | .author.login // "ghost"]
           | any(. != $opener) | not)
  | "\(.path): \(.comments.nodes[0].url)"' <<<"$API_OUT")"
while IFS= read -r thread; do
  [ -n "$thread" ] && problems+=("review thread has no reply: $thread")
done <<<"$unanswered"

if [ "${#problems[@]}" -eq 0 ]; then
  if [ "$settled_by_recompute" -eq 1 ]; then
    count() { case "$1" in ""|*[!0-9]*) echo "?" ;; *) echo "$1" ;; esac; }
    echo "PR #$PR is ready to auto-merge: every finding of the last review is settled ($(count "${SETTLE_SETTLED:-}") of $(count "${SETTLE_TOTAL:-}"), no model call) and every review thread answered." \
      | tee -a "$summary"
  else
    echo "PR #$PR is ready to auto-merge: labeled \`merge-approved\` and every review thread answered." \
      | tee -a "$summary"
  fi
  exit 0
fi

{
  echo "### Merge gate: PR #$PR is not ready"
  for p in "${problems[@]}"; do echo "- $p"; done
} >>"$summary"
for p in "${problems[@]}"; do echo "::error::$p"; done
exit 1
