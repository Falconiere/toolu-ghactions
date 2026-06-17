#!/usr/bin/env bash
# find-sticky-comment.sh — locate the latest sticky review comment on a PR,
# LOGIN-AGNOSTIC, via the GitHub REST API (curl).
#
# Identity is no longer pinned to "github-actions[bot]": a custom GitHub App
# may author the comment, so we match on body content, not author login.
# Prefer the hidden state marker; fall back to legacy headers only when no
# marker comment exists anywhere.
#
# Reads GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_API_URL (default
# https://api.github.com), and the PR number from PR_NUMBER (override) or the
# GitHub event payload / GITHUB_REF.
# Outputs {"id": <id>, "body": <body>} to stdout when found, {} when none.
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

# Hidden state marker a later step writes; matched as a literal prefix.
MARKER_PREFIX='<!-- toolu-review-state:v1'
# Legacy fallback headers (pre-marker comments).
LEGACY_HEADERS='### Code Review|### PR Review in Progress'

# Shared curl timeout flags: a hung GitHub connection must not stall the job.
CURL_TIMEOUTS=(--connect-timeout 10 --max-time 30)

# Resolve PR number: explicit override wins, then event payload, then ref.
PR_NUMBER="${PR_NUMBER:-}"
if [ -z "$PR_NUMBER" ]; then
    if [ -f "$EVENT_PATH" ] && [ "$EVENT_PATH" != "/dev/null" ]; then
        PR_NUMBER=$(jq -r '.pull_request.number // ""' "$EVENT_PATH" 2>/dev/null || true)
    else
        # Try to extract PR number from GITHUB_REF (refs/pull/N/merge).
        PR_NUMBER=$(echo "${GITHUB_REF:-}" | sed -n 's|refs/pull/\([0-9]*\)/.*|\1|p' || true)
    fi
fi

# No PR context means no sticky comment — succeed with an empty object.
if [ -z "$PR_NUMBER" ] || [ "$PR_NUMBER" = "null" ]; then
    echo '{}'
    exit 0
fi

API_BASE="${GITHUB_API_URL:-https://api.github.com}"
COMMENTS_URL="$API_BASE/repos/$REPO/issues/$PR_NUMBER/comments"
HEADER_AUTH="Authorization: Bearer $TOKEN"
HEADER_ACCEPT="Accept: application/vnd.github+json"
HEADER_API="X-GitHub-Api-Version: 2022-11-28"

# --- Collect sticky comments across ALL pages ---
# Keep marker matches and legacy matches in separate buckets so we can prefer
# markers globally and only fall back to legacy when no marker exists anywhere.
# A per-page choice would wrongly favor a stale comment on a later page.
MARKER_MATCHES="[]"
LEGACY_MATCHES="[]"
COMMENTS_PAGE=1

while true; do
    RESPONSE=$(curl -s "${CURL_TIMEOUTS[@]}" -H "$HEADER_AUTH" -H "$HEADER_ACCEPT" -H "$HEADER_API" \
        "$COMMENTS_URL?per_page=100&page=$COMMENTS_PAGE" 2>/dev/null || echo "[]")

    PAGE_MARKER=$(echo "$RESPONSE" | jq -c --arg m "$MARKER_PREFIX" '
        [.[] | select(.body | contains($m))]' 2>/dev/null || echo "[]")
    PAGE_LEGACY=$(echo "$RESPONSE" | jq -c --arg m "$MARKER_PREFIX" --arg h "$LEGACY_HEADERS" '
        [.[] | select((.body | contains($m) | not) and (.body | test($h)))]' 2>/dev/null || echo "[]")

    MARKER_MATCHES=$(jq -cn --argjson a "$MARKER_MATCHES" --argjson b "$PAGE_MARKER" '$a + $b' 2>/dev/null || echo "$MARKER_MATCHES")
    LEGACY_MATCHES=$(jq -cn --argjson a "$LEGACY_MATCHES" --argjson b "$PAGE_LEGACY" '$a + $b' 2>/dev/null || echo "$LEGACY_MATCHES")

    # Stop at a short page (last page) or a hard cap (guards a misbehaving API).
    COUNT=$(echo "$RESPONSE" | jq 'length' 2>/dev/null || echo 0)
    if [ "$COUNT" -lt 100 ] || [ "$COMMENTS_PAGE" -ge 20 ]; then
        break
    fi
    COMMENTS_PAGE=$((COMMENTS_PAGE + 1))
done

# Prefer marker matches; fall back to legacy only when no marker exists.
SELECTED="$MARKER_MATCHES"
if [ "$(echo "$MARKER_MATCHES" | jq 'length' 2>/dev/null || echo 0)" -eq 0 ]; then
    SELECTED="$LEGACY_MATCHES"
fi

# Pick the latest by created_at and emit {id, body}; {} when none.
echo "$SELECTED" | jq -c '
    if length > 0
    then (sort_by(.created_at) | last | {id: .id, body: .body})
    else {} end' 2>/dev/null || echo '{}'
