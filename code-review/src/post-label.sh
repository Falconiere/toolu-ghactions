#!/usr/bin/env bash
# post-label.sh — set the verdict label (a real GitHub label chip) on the PR,
# mirroring the machine-readable token in the summary comment so the PR is
# filterable/automatable from the GitHub UI.
#
# Adds the verdict label and removes the opposite one so a PR never carries both
# `agent-merge-approved` and `agent-request-changes` at once.
#
# arg1 (or $VERDICT env): approved | changes | error
# env : GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_EVENT_PATH, GITHUB_API_URL,
#       GITHUB_REF, INPUT_MANAGE_LABELS (default true)
#
# Non-fatal: any API error logs and exits 0; the summary comment + its token
# remain the merge authority.
set -euo pipefail

if [ "${INPUT_MANAGE_LABELS:-true}" = "false" ]; then
    echo "post-label: MANAGE_LABELS=false — skipping" >&2
    exit 0
fi

VERDICT="${1:-${VERDICT:-}}"
TOKEN="${GITHUB_TOKEN:-}"
REPO="${GITHUB_REPOSITORY:-}"
EVENT_PATH="${GITHUB_EVENT_PATH:-/dev/null}"
API_BASE="${GITHUB_API_URL:-https://api.github.com}"

if [ -z "$TOKEN" ] || [ -z "$REPO" ]; then
    echo "post-label: GITHUB_TOKEN/GITHUB_REPOSITORY unset — skipping" >&2
    exit 0
fi

APPROVED_LABEL="agent-merge-approved"
CHANGES_LABEL="agent-request-changes"

# Map verdict → (label to add, label to remove, chip color).
case "$VERDICT" in
    approved)      ADD="$APPROVED_LABEL"; REMOVE="$CHANGES_LABEL"; COLOR="0e8a16" ;;
    changes|error) ADD="$CHANGES_LABEL"; REMOVE="$APPROVED_LABEL"; COLOR="d93f0b" ;;
    *) echo "post-label: verdict '$VERDICT' — no label change" >&2; exit 0 ;;
esac

# PR number from the event payload, else GITHUB_REF (refs/pull/N/merge).
if [ -f "$EVENT_PATH" ] && [ "$EVENT_PATH" != "/dev/null" ]; then
    PR_NUMBER=$(jq -r '.pull_request.number // ""' "$EVENT_PATH" 2>/dev/null || true)
else
    PR_NUMBER=$(echo "${GITHUB_REF:-}" | sed -n 's|refs/pull/\([0-9]*\)/.*|\1|p' || true)
fi
if [ -z "$PR_NUMBER" ] || [ "$PR_NUMBER" = "null" ]; then
    echo "post-label: cannot determine PR number — skipping" >&2
    exit 0
fi

HDR_AUTH="Authorization: Bearer $TOKEN"
HDR_ACCEPT="Accept: application/vnd.github+json"
HDR_API="X-GitHub-Api-Version: 2022-11-28"
TIMEOUTS=(--connect-timeout 10 --max-time 30)
ISSUE_URL="$API_BASE/repos/$REPO/issues/$PR_NUMBER"
BODY_FILE=$(mktemp)
trap 'rm -f "$BODY_FILE"' EXIT

# Ensure the label exists in the repo (idempotent — a 422 means it already does,
# which is fine). Guarantees the add below works even on a fresh repo.
jq -nc --arg n "$ADD" --arg c "$COLOR" --arg d "AI code review verdict" \
    '{name:$n, color:$c, description:$d}' > "$BODY_FILE"
curl -s "${TIMEOUTS[@]}" -X POST -H "$HDR_AUTH" -H "$HDR_ACCEPT" -H "$HDR_API" \
    --data @"$BODY_FILE" "$API_BASE/repos/$REPO/labels" >/dev/null 2>&1 || true

# Remove the opposite verdict label (ignore a 404 when it isn't set). The label
# name is URL-encoded so it stays a single safe path segment.
REMOVE_ENC=$(printf '%s' "$REMOVE" | jq -sRr @uri)
curl -s "${TIMEOUTS[@]}" -X DELETE -H "$HDR_AUTH" -H "$HDR_ACCEPT" -H "$HDR_API" \
    "$ISSUE_URL/labels/$REMOVE_ENC" >/dev/null 2>&1 || true

# Add the verdict label.
jq -nc --arg n "$ADD" '{labels:[$n]}' > "$BODY_FILE"
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' "${TIMEOUTS[@]}" -X POST \
    -H "$HDR_AUTH" -H "$HDR_ACCEPT" -H "$HDR_API" \
    --data @"$BODY_FILE" "$ISSUE_URL/labels" 2>/dev/null || echo "000")

if [[ "$HTTP_CODE" == 2* ]]; then
    echo "post-label: set '$ADD' on PR #$PR_NUMBER" >&2
else
    echo "post-label: labels API returned $HTTP_CODE; label not set (non-fatal)" >&2
fi
exit 0
