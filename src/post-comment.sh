#!/usr/bin/env bash
# post-comment.sh — find, edit, or create the bot's PR verdict comment via
# GitHub REST API (curl).
#
# Reads GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_EVENT_PATH from env.
# Reads the markdown comment body from stdin.
# Outputs comment_url to stdout; also sets COMMENT_URL for output capture.
set -euo pipefail

TOKEN="${GITHUB_TOKEN:-}"
REPO="${GITHUB_REPOSITORY:-}"
EVENT_PATH="${GITHUB_EVENT_PATH:-/dev/null}"

if [ -z "$TOKEN" ]; then
    echo '{"error":"GITHUB_TOKEN is not set"}' >&2
    exit 1
fi

if [ -z "$REPO" ]; then
    echo '{"error":"GITHUB_REPOSITORY is not set"}' >&2
    exit 1
fi

COMMENT_BODY=$(cat)

# Extract PR number from the GitHub event payload.
if [ -f "$EVENT_PATH" ] && [ "$EVENT_PATH" != "/dev/null" ]; then
    PR_NUMBER=$(jq -r '.pull_request.number // ""' "$EVENT_PATH" 2>/dev/null || true)
else
    # Try to extract PR number from GITHUB_REF (refs/pull/N/merge).
    PR_NUMBER=$(echo "${GITHUB_REF:-}" | sed -n 's|refs/pull/\([0-9]*\)/.*|\1|p' || true)
fi

if [ -z "$PR_NUMBER" ] || [ "$PR_NUMBER" = "null" ]; then
    echo "{\"error\":\"Cannot determine PR number\",\"event_path\":\"$EVENT_PATH\"}" >&2
    exit 1
fi

API_BASE="${GITHUB_API_URL:-https://api.github.com}"
COMMENTS_URL="$API_BASE/repos/$REPO/issues/$PR_NUMBER/comments"
HEADER_AUTH="Authorization: Bearer $TOKEN"
HEADER_ACCEPT="Accept: application/vnd.github+json"
HEADER_API="X-GitHub-Api-Version: 2022-11-28"

# --- Find existing bot comment ---
# List all comments, find the last one by github-actions[bot] that contains
# our review markers.
EXISTING_COMMENT_ID=""
COMMENTS_PAGE=1

while true; do
    RESPONSE=$(curl -s -H "$HEADER_AUTH" -H "$HEADER_ACCEPT" -H "$HEADER_API" \
        "$COMMENTS_URL?per_page=100&page=$COMMENTS_PAGE" 2>/dev/null || echo "[]")

    # Find matching comment(s) in this page.
    MATCHING=$(echo "$RESPONSE" | jq -c '
        [.[] | select(
            .user.login == "github-actions[bot]" and
            (.body | test("### Code Review|### PR Review in Progress"))
        )] | sort_by(.created_at) | last // empty
    ' 2>/dev/null || true)

    if [ -n "$MATCHING" ] && [ "$MATCHING" != "null" ]; then
        EXISTING_COMMENT_ID=$(echo "$MATCHING" | jq -r '.id')
        break
    fi

    # Check if there are more pages.
    COUNT=$(echo "$RESPONSE" | jq 'length' 2>/dev/null || echo 0)
    if [ "$COUNT" -lt 100 ]; then
        break
    fi
    COMMENTS_PAGE=$((COMMENTS_PAGE + 1))
done

# --- Post or edit the comment ---
if [ -n "$EXISTING_COMMENT_ID" ] && [ "$EXISTING_COMMENT_ID" != "null" ]; then
    # Edit existing comment.
    COMMENT_ID="$EXISTING_COMMENT_ID"
    UPDATE_URL="$API_BASE/repos/$REPO/issues/comments/$COMMENT_ID"

    RESPONSE=$(curl -s -X PATCH \
        -H "$HEADER_AUTH" \
        -H "$HEADER_ACCEPT" \
        -H "$HEADER_API" \
        -d "$(jq -nc --arg body "$COMMENT_BODY" '{body: $body}')" \
        "$UPDATE_URL" 2>/dev/null)

    COMMENT_URL=$(echo "$RESPONSE" | jq -r '.html_url // ""')
    echo "{\"action\":\"updated\",\"comment_id\":\"$COMMENT_ID\",\"url\":\"$COMMENT_URL\"}" >&2
else
    # Create new comment.
    RESPONSE=$(curl -s -X POST \
        -H "$HEADER_AUTH" \
        -H "$HEADER_ACCEPT" \
        -H "$HEADER_API" \
        -d "$(jq -nc --arg body "$COMMENT_BODY" '{body: $body}')" \
        "$COMMENTS_URL" 2>/dev/null)

    COMMENT_URL=$(echo "$RESPONSE" | jq -r '.html_url // ""')
    echo "{\"action\":\"created\",\"url\":\"$COMMENT_URL\"}" >&2
fi

# Verify the API call succeeded.
if [ -z "$COMMENT_URL" ] || [ "$COMMENT_URL" = "null" ]; then
    echo "{\"error\":\"Failed to post comment\",\"response\":$(echo "$RESPONSE" | jq -Rc .)}" >&2
    exit 1
fi

# Output the comment URL for the action output.
echo "$COMMENT_URL"
