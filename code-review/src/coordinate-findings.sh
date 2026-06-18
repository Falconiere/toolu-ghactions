#!/usr/bin/env bash
# coordinate-findings.sh — multi-provider verdict merger (deterministic, no LLM).
#
# stdin : { providers: [ {provider, verdict|error, findings, top_must_fix, other_checks, ...} ],
#           strategy: "conservative"|"majority"|"all_approve" }
# stdout: { verdict, findings, review_plan, other_checks, top_must_fix }
set -euo pipefail

INPUT=$(cat)
STRATEGY=$(echo "$INPUT" | jq -r '.strategy // "conservative"')

N_PROVIDERS=$(echo "$INPUT" | jq '.providers | length')
if [ "$N_PROVIDERS" -eq 0 ]; then
    jq -nc '{review_plan:"No providers configured — the review could not run.", verdict:"error", findings:[], other_checks:"", top_must_fix:[]}'
    exit 0
fi

# Validate the strategy up front so an unknown strategy always fails loud, even
# on the all-errored path below (which skips the per-strategy case).
case "$STRATEGY" in
    conservative|majority|all_approve) ;;
    *) jq -nc --arg s "$STRATEGY" '{error:("unknown strategy: " + $s)}' >&2; exit 1 ;;
esac

DISPOSITIONS=$(echo "$INPUT" | jq -c '[.providers[] | {provider: .provider, d: (if .error then "error" else .verdict end)}]')
N_CHANGES=$(echo "$DISPOSITIONS" | jq '[.[] | select(.d == "changes")] | length')
N_APPROVED=$(echo "$DISPOSITIONS" | jq '[.[] | select(.d == "approved")] | length')
N_ERROR=$(echo "$DISPOSITIONS" | jq '[.[] | select(.d == "error")] | length')

# Providers that returned a real verdict. An errored provider ABSTAINS: a crash,
# rate-limit, or bad response is an infra failure, NOT a request for changes, and
# must never masquerade as one — that conflation produced "Changes requested"
# comments with zero findings whenever a single provider hiccuped.
N_DECIDED=$((N_CHANGES + N_APPROVED))

if [ "$N_DECIDED" -eq 0 ]; then
    # No provider produced a verdict (all errored). Surface an honest
    # review-incomplete state rather than a bogus approve/changes.
    VERDICT="error"
else
    case "$STRATEGY" in
        conservative)
            if [ "$N_CHANGES" -eq 0 ]; then VERDICT="approved"; else VERDICT="changes"; fi ;;
        majority)
            THRESHOLD=$(( (N_DECIDED / 2) + 1 ))
            if [ "$N_CHANGES" -ge "$THRESHOLD" ]; then VERDICT="changes"; else VERDICT="approved"; fi ;;
        all_approve)
            if [ "$N_APPROVED" -eq "$N_DECIDED" ]; then VERDICT="approved"; else VERDICT="changes"; fi ;;
    esac
fi

# Dedupe findings by (path, line, end_line, text-fingerprint-80). Max severity within group.
DEDUPED=$(echo "$INPUT" | jq -c '
    [ (.providers // [])[] | (.findings // [])[]? | { path: (.path // ""), line: (.line // null), end_line: (.end_line // .line // null), severity: (.severity // "low"), category: (.category // null), confidence: (.confidence // null), quoted_line: (.quoted_line // null), suggestion: (.suggestion // null), text: (.text // "") } ] |
    group_by(.path + "|" + (.line|tostring) + "|" + (.end_line|tostring) + "|" + (.text | ascii_downcase | gsub("[^a-z0-9 ]"; "") | gsub("\\s+"; " ") | .[0:80])) |
    map({ path: .[0].path, line: .[0].line, end_line: .[0].end_line, severity: ([.[].severity] | min_by(if . == "blocker" then 0 elif . == "high" then 1 elif . == "medium" then 2 elif . == "low" then 3 else 4 end)), category: (map(.category) | map(select(. != null)) | .[0] // null), confidence: (map(.confidence) | map(select(. != null)) | .[0] // null), quoted_line: (map(.quoted_line) | map(select(. != null)) | .[0] // null), suggestion: (map(.suggestion) | map(select(. != null)) | .[0] // null), text: .[0].text })
')

# top_must_fix: dedupe by path, cap 3.
TOP_MUST_FIX=$(echo "$INPUT" | jq -c '[ (.providers // [])[] | (.top_must_fix // [])[]? ] | unique | .[0:3]')

PROVIDER_LIST=$(echo "$INPUT" | jq -r '[.providers[].provider] | join(", ")')
AGREEMENT=$(echo "$DISPOSITIONS" | jq -r '.[] | "\(.provider)=\(.d)"' | paste -sd ", " -)
REVIEW_PLAN="Reviewed by ${N_PROVIDERS} providers: ${PROVIDER_LIST}. Merged with ${STRATEGY}."
if [ "$VERDICT" = "error" ]; then
    REVIEW_PLAN="Review could not complete — all ${N_PROVIDERS} provider(s) errored (${PROVIDER_LIST}). No verdict was produced; this is a provider/infrastructure error, not a request for changes."
elif [ "$N_ERROR" -gt 0 ]; then
    REVIEW_PLAN+=" ($N_ERROR of ${N_PROVIDERS} errored and abstained)."
fi
OTHER_CHECKS="Per-provider: ${AGREEMENT}. Merged $(echo "$DEDUPED" | jq 'length') findings from $N_PROVIDERS providers."

VERDICT_JSON=$(printf '%s' "$VERDICT" | jq -R .)
jq -nc --argjson v "$VERDICT_JSON" --argjson findings "$DEDUPED" --argjson top_must_fix "$TOP_MUST_FIX" --arg review_plan "$REVIEW_PLAN" --arg other_checks "$OTHER_CHECKS" \
    '{ verdict: $v, findings: $findings, review_plan: $review_plan, other_checks: $other_checks, top_must_fix: $top_must_fix }'
