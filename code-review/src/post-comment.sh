#!/usr/bin/env bash
# post-comment.sh — find, edit, or create the bot's PR verdict comment via
# GitHub REST API (curl).
#
# Reads GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_EVENT_PATH from env.
# Reads the markdown comment body from stdin.
# Outputs comment_url to stdout; also sets COMMENT_URL for output capture.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

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

# Temp file for request bodies — avoids ARG_MAX on large verdict comments and
# keeps the body out of the process argument list.
BODY_FILE=$(mktemp)
trap 'rm -f "$BODY_FILE"' EXIT

# Shared curl timeout flags: a hung GitHub connection must not stall the job.
CURL_TIMEOUTS=(--connect-timeout 10 --max-time 30)

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

# --- Find existing sticky comment ---
# Dedup is LOGIN-AGNOSTIC: a custom GitHub App may author the comment, so we
# match on a hidden marker (with a legacy-header fallback), not the bot login.
# When the caller already fetched the sticky id, it passes STICKY_COMMENT_ID to
# skip the search and the duplicate comments-list round-trip.
if [ -n "${STICKY_COMMENT_ID:-}" ]; then
    EXISTING_COMMENT_ID="$STICKY_COMMENT_ID"
else
    STICKY_JSON=$(bash "$SCRIPT_DIR/find-sticky-comment.sh")
    EXISTING_COMMENT_ID=$(echo "$STICKY_JSON" | jq -r '.id // ""' 2>/dev/null || echo "")
fi

# --- Post or edit the comment ---
if [ -n "$EXISTING_COMMENT_ID" ] && [ "$EXISTING_COMMENT_ID" != "null" ]; then
    # Edit existing comment.
    COMMENT_ID="$EXISTING_COMMENT_ID"
    UPDATE_URL="$API_BASE/repos/$REPO/issues/comments/$COMMENT_ID"

    jq -nc --arg body "$COMMENT_BODY" '{body: $body}' > "$BODY_FILE"
    RESPONSE=$(curl -s "${CURL_TIMEOUTS[@]}" -X PATCH \
        -H "$HEADER_AUTH" \
        -H "$HEADER_ACCEPT" \
        -H "$HEADER_API" \
        --data @"$BODY_FILE" \
        "$UPDATE_URL" 2>/dev/null)

    COMMENT_URL=$(echo "$RESPONSE" | jq -r '.html_url // ""')
    echo "{\"action\":\"updated\",\"comment_id\":\"$COMMENT_ID\",\"url\":\"$COMMENT_URL\"}" >&2
else
    # Create new comment.
    jq -nc --arg body "$COMMENT_BODY" '{body: $body}' > "$BODY_FILE"
    RESPONSE=$(curl -s "${CURL_TIMEOUTS[@]}" -X POST \
        -H "$HEADER_AUTH" \
        -H "$HEADER_ACCEPT" \
        -H "$HEADER_API" \
        --data @"$BODY_FILE" \
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
