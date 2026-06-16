#!/usr/bin/env bash
# post-review.sh — post per-line PR review comments (with committable code
# suggestions) via the GitHub Pull Request Reviews API.
#
# Advisory: the review event is always COMMENT, so it never hard-blocks merge —
# the summary issue-comment + the agent-merge label remain the merge authority.
# Non-fatal: on any API error (e.g. a 422 from an unanchorable line) it logs and
# exits 0; the summary comment already conveys the verdict.
#
# stdin: { findings: [ {path,line,end_line,severity,category,confidence,suggestion,text} ] }
#        (expects findings already anchored by validate-findings.sh)
# env  : GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_EVENT_PATH, INPUT_INLINE_COMMENTS
set -euo pipefail

if [ "${INPUT_INLINE_COMMENTS:-true}" = "false" ]; then
    echo "post-review: INLINE_COMMENTS=false — skipping inline review" >&2
    exit 0
fi

TOKEN="${GITHUB_TOKEN:-}"
REPO="${GITHUB_REPOSITORY:-}"
EVENT_PATH="${GITHUB_EVENT_PATH:-/dev/null}"
API_BASE="${GITHUB_API_URL:-https://api.github.com}"
BACKOFF_BASE="${BACKOFF_BASE:-5}"

if [ -z "$TOKEN" ] || [ -z "$REPO" ]; then
    echo "post-review: GITHUB_TOKEN/GITHUB_REPOSITORY unset — skipping" >&2
    exit 0
fi

INPUT=$(cat)

if [ ! -f "$EVENT_PATH" ]; then
    echo "post-review: no event payload — skipping" >&2
    exit 0
fi
PR_NUMBER=$(jq -r '.pull_request.number // ""' "$EVENT_PATH")
HEAD_SHA=$(jq -r '.pull_request.head.sha // ""' "$EVENT_PATH")
if [ -z "$PR_NUMBER" ] || [ -z "$HEAD_SHA" ]; then
    echo "post-review: cannot resolve PR number / head sha — skipping" >&2
    exit 0
fi

# Build the inline comments. A multi-line span uses start_line..line; a code
# suggestion is a ```suggestion fenced block the author can commit directly.
COMMENTS=$(echo "$INPUT" | jq -c '[
    .findings[]? | select(.line != null)
    | { path: .path,
        body: ( "**" + (.severity // "note") + "**"
                + (if .category then " _(" + .category + ")_" else "" end)
                + ": " + (.text // "")
                + (if (.suggestion // "") != "" then "\n\n```suggestion\n" + .suggestion + "\n```" else "" end) ) }
      + ( if (.end_line // .line) > .line
          then {start_line: .line, start_side: "RIGHT", line: .end_line, side: "RIGHT"}
          else {line: .line, side: "RIGHT"} end )
]')

COUNT=$(echo "$COMMENTS" | jq 'length')
if [ "$COUNT" -eq 0 ]; then
    echo "post-review: no anchored findings — nothing to post" >&2
    exit 0
fi

BODY_FILE=$(mktemp)
TMP_RESP=$(mktemp)
trap 'rm -f "$BODY_FILE" "$TMP_RESP"' EXIT

SUMMARY="🤖 AI Code Review — ${COUNT} inline comment(s). See the summary comment for the full verdict."
jq -nc --arg commit "$HEAD_SHA" --arg body "$SUMMARY" --argjson comments "$COMMENTS" \
    '{commit_id: $commit, event: "COMMENT", body: $body, comments: $comments}' > "$BODY_FILE"

REVIEWS_URL="$API_BASE/repos/$REPO/pulls/$PR_NUMBER/reviews"

attempt=1
HTTP_CODE="000"
while [ "$attempt" -le 3 ]; do
    HTTP_CODE=$(curl -s -o "$TMP_RESP" -w '%{http_code}' \
        --connect-timeout 10 --max-time 30 \
        -X POST \
        -H "Authorization: Bearer $TOKEN" \
        -H "Accept: application/vnd.github+json" \
        -H "X-GitHub-Api-Version: 2022-11-28" \
        --data @"$BODY_FILE" \
        "$REVIEWS_URL" 2>/dev/null || echo "000")
    case "$HTTP_CODE" in
        2*) break ;;
        429|5*|000) [ "$BACKOFF_BASE" -gt 0 ] && sleep "$((BACKOFF_BASE * attempt))"; attempt=$((attempt + 1)) ;;
        *)  break ;;  # 4xx (e.g. 422 unanchorable) — not retryable
    esac
done

if [[ "$HTTP_CODE" == 2* ]]; then
    URL=$(jq -r '.html_url // ""' "$TMP_RESP")
    echo "post-review: posted $COUNT inline comment(s) — $URL" >&2
    exit 0
fi

# Non-fatal: log a truncated body and let the job succeed.
echo "post-review: reviews API returned $HTTP_CODE; inline comments skipped (summary still posted). $(head -c 200 "$TMP_RESP")" >&2
exit 0
