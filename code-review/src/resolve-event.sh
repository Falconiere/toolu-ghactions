#!/usr/bin/env bash
# resolve-event.sh — normalize a `pull_request` OR `issue_comment` event into a
# single review decision, emitted as one JSON object on stdout.
#
# A `pull_request` event always runs a full review of HEAD. An `issue_comment`
# event is an `@toolu review …` re-trigger; because issue_comment runs with the
# repo's secrets, the permission gate FAILS CLOSED — any uncertainty (curl
# error, non-2xx, missing `.permission`) means run=false.
#
# Env in : GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_TOKEN,
#          GITHUB_REPOSITORY, GITHUB_API_URL (default https://api.github.com),
#          INPUT_TRIGGER_PHRASE (default @toolu),
#          INPUT_MIN_TRIGGER_PERMISSION (default write).
# Stdout  : {run, reason, pr_number, review_head, base_ref, full_review,
#            instruction, commenter, comment_id}
# Stderr  : diagnostics (never swallowed).
set -euo pipefail

EVENT_NAME="${GITHUB_EVENT_NAME:-}"
EVENT_PATH="${GITHUB_EVENT_PATH:-/dev/null}"
TOKEN="${GITHUB_TOKEN:-}"
REPO="${GITHUB_REPOSITORY:-}"
API_BASE="${GITHUB_API_URL:-https://api.github.com}"
TRIGGER_PHRASE="${INPUT_TRIGGER_PHRASE:-@toolu}"
MIN_PERMISSION="${INPUT_MIN_TRIGGER_PERMISSION:-write}"

# Shared curl timeout flags: a hung GitHub connection must not stall the job.
CURL_TIMEOUTS=(--connect-timeout 10 --max-time 30)
HDR_AUTH="Authorization: Bearer $TOKEN"
HDR_ACCEPT="Accept: application/vnd.github+json"
HDR_API="X-GitHub-Api-Version: 2022-11-28"

# emit_decision — print the decision JSON and exit 0. All fields are passed so
# the single object always carries the full contract shape.
emit_decision() {
    local run="$1" reason="$2" pr_number="$3" review_head="$4" base_ref="$5" \
        full_review="$6" instruction="$7" commenter="$8" comment_id="$9"
    jq -nc \
        --argjson run "$run" \
        --arg reason "$reason" \
        --argjson pr_number "$pr_number" \
        --arg review_head "$review_head" \
        --arg base_ref "$base_ref" \
        --argjson full_review "$full_review" \
        --arg instruction "$instruction" \
        --arg commenter "$commenter" \
        --argjson comment_id "$comment_id" \
        '{run:$run, reason:$reason, pr_number:$pr_number, review_head:$review_head,
          base_ref:$base_ref, full_review:$full_review, instruction:$instruction,
          commenter:$commenter, comment_id:$comment_id}'
}

# react — POST a reaction to the triggering comment. Non-fatal: a failure warns
# and continues, because the review decision must not hinge on a reaction.
react() {
    local comment_id="$1" content="$2" body_file
    body_file=$(mktemp)
    jq -nc --arg c "$content" '{content:$c}' > "$body_file"
    local http_code
    http_code=$(curl -s -o /dev/null -w '%{http_code}' "${CURL_TIMEOUTS[@]}" -X POST \
        -H "$HDR_AUTH" -H "$HDR_ACCEPT" -H "$HDR_API" \
        --data @"$body_file" \
        "$API_BASE/repos/$REPO/issues/comments/$comment_id/reactions" 2>/dev/null || echo "000")
    rm -f "$body_file"
    if [[ "$http_code" != 2* ]]; then
        echo "resolve-event: reaction '$content' returned $http_code (non-fatal)" >&2
    fi
}

if [ ! -f "$EVENT_PATH" ] || [ "$EVENT_PATH" = "/dev/null" ]; then
    echo "resolve-event: GITHUB_EVENT_PATH not readable: $EVENT_PATH" >&2
    emit_decision false "no-event-payload" null "" "" false "" "" null
    exit 0
fi

case "$EVENT_NAME" in
    pull_request)
        PR_NUMBER=$(jq -r '.pull_request.number // ""' "$EVENT_PATH")
        BASE_REF=$(jq -r '.pull_request.base.ref // ""' "$EVENT_PATH")
        if [ -z "$PR_NUMBER" ]; then
            echo "resolve-event: pull_request payload has no .pull_request.number" >&2
            emit_decision false "no-pr-number" null "" "" false "" "" null
            exit 0
        fi
        emit_decision true "pull_request" "$PR_NUMBER" "HEAD" "$BASE_REF" true "" "" null
        exit 0
        ;;

    issue_comment)
        # ---- CHEAP GUARDS FIRST (no API call) ----

        # Guard 1: ignore bot authors (the action's own comments included). The
        # GITHUB_ACTOR/own login check guards against re-triggering on our own
        # verdict comments even if user.type is User.
        COMMENT_USER_TYPE=$(jq -r '.comment.user.type // ""' "$EVENT_PATH")
        COMMENTER=$(jq -r '.comment.user.login // ""' "$EVENT_PATH")
        OWN_LOGIN="${GITHUB_ACTOR:-github-actions[bot]}"
        if [ "$COMMENT_USER_TYPE" = "Bot" ] || [ "$COMMENTER" = "$OWN_LOGIN" ]; then
            echo "resolve-event: comment author is a bot ('$COMMENTER') — skipping" >&2
            emit_decision false "bot-author" null "" "" false "" "" null
            exit 0
        fi

        # Guard 2: the comment must be on a pull request, not a plain issue.
        HAS_PR=$(jq -r 'if (.issue.pull_request // null) == null then "no" else "yes" end' "$EVENT_PATH")
        if [ "$HAS_PR" != "yes" ]; then
            echo "resolve-event: comment is not on a pull request — skipping" >&2
            emit_decision false "not-a-pull-request" null "" "" false "" "" null
            exit 0
        fi

        # Guard 3: the body must contain "<phrase> review" (phrase + the word
        # `review` matched case-insensitively). The instruction is the trimmed
        # remainder after it. Pure-bash regex keeps this jq+bash-only (no perl).
        BODY=$(jq -r '.comment.body // ""' "$EVENT_PATH")
        BODY_LC=$(printf '%s' "$BODY" | tr '[:upper:]' '[:lower:]')
        PHRASE_LC=$(printf '%s' "$TRIGGER_PHRASE" | tr '[:upper:]' '[:lower:]')
        # Locate "<phrase> review" in the lowercased body, then slice the SAME
        # offset out of the original body so the instruction keeps its case.
        TRIGGER_LC="$PHRASE_LC review"
        if [[ "$BODY_LC" == *"$TRIGGER_LC"* ]]; then
            PREFIX="${BODY_LC%%"$TRIGGER_LC"*}"
            START=$(( ${#PREFIX} + ${#TRIGGER_LC} ))
            INSTRUCTION="${BODY:$START}"
            # Trim leading/trailing whitespace from the remainder.
            INSTRUCTION="${INSTRUCTION#"${INSTRUCTION%%[![:space:]]*}"}"
            INSTRUCTION="${INSTRUCTION%"${INSTRUCTION##*[![:space:]]}"}"
        else
            echo "resolve-event: body lacks '$TRIGGER_PHRASE review' trigger — skipping" >&2
            emit_decision false "no-trigger" null "" "" false "" "" null
            exit 0
        fi
        COMMENT_ID=$(jq -r '.comment.id // ""' "$EVENT_PATH")
        PR_NUMBER=$(jq -r '.issue.number // ""' "$EVENT_PATH")

        # ---- PERMISSION GATE (API call) — FAIL CLOSED ----
        PERM_FILE=$(mktemp)
        PERM_CODE=$(curl -s -o "$PERM_FILE" -w '%{http_code}' "${CURL_TIMEOUTS[@]}" \
            -H "$HDR_AUTH" -H "$HDR_ACCEPT" -H "$HDR_API" \
            "$API_BASE/repos/$REPO/collaborators/$COMMENTER/permission" 2>/dev/null || echo "000")
        PERMISSION=$(jq -r '.permission // ""' "$PERM_FILE" 2>/dev/null || echo "")
        rm -f "$PERM_FILE"
        if [[ "$PERM_CODE" != 2* ]] || [ -z "$PERMISSION" ]; then
            echo "resolve-event: permission check failed (http=$PERM_CODE, permission='$PERMISSION') — failing closed" >&2
            emit_decision false "permission-check-failed" null "" "" false "" "$COMMENTER" null
            exit 0
        fi

        # Floor check: write accepts {admin,write}; admin accepts {admin}.
        ALLOWED="no"
        case "$MIN_PERMISSION" in
            admin) [ "$PERMISSION" = "admin" ] && ALLOWED="yes" ;;
            *)     { [ "$PERMISSION" = "admin" ] || [ "$PERMISSION" = "write" ]; } && ALLOWED="yes" ;;
        esac
        if [ "$ALLOWED" != "yes" ]; then
            echo "resolve-event: commenter '$COMMENTER' has '$PERMISSION' < floor '$MIN_PERMISSION' — denying" >&2
            react "$COMMENT_ID" "-1"
            emit_decision false "insufficient-permission" null "" "" false "" "$COMMENTER" null
            exit 0
        fi

        # ---- ALLOWED ----
        react "$COMMENT_ID" "eyes"

        PULL_FILE=$(mktemp)
        curl -s -o "$PULL_FILE" "${CURL_TIMEOUTS[@]}" \
            -H "$HDR_AUTH" -H "$HDR_ACCEPT" -H "$HDR_API" \
            "$API_BASE/repos/$REPO/pulls/$PR_NUMBER" 2>/dev/null || true
        BASE_REF=$(jq -r '.base.ref // ""' "$PULL_FILE" 2>/dev/null || echo "")
        rm -f "$PULL_FILE"

        # Fetch the PR head into FETCH_HEAD (best-effort). On failure we still
        # set review_head=FETCH_HEAD and let the diff step surface the error.
        if ! git fetch origin "pull/$PR_NUMBER/head" >/dev/null 2>&1; then
            echo "resolve-event: git fetch pull/$PR_NUMBER/head failed (diff step will surface it)" >&2
        fi

        if [ -z "$INSTRUCTION" ]; then FULL_REVIEW=true; else FULL_REVIEW=false; fi
        emit_decision true "mention" "$PR_NUMBER" "FETCH_HEAD" "$BASE_REF" \
            "$FULL_REVIEW" "$INSTRUCTION" "$COMMENTER" "$COMMENT_ID"
        exit 0
        ;;

    *)
        echo "resolve-event: unsupported event '$EVENT_NAME'" >&2
        emit_decision false "unsupported-event" null "" "" false "" "" null
        exit 0
        ;;
esac
