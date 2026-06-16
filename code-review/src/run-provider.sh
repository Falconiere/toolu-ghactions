#!/usr/bin/env bash
# run-provider.sh — run one provider end to end.
#
# Usage: run-provider.sh <entry.json> <output-file>
#
# <entry.json>   : JSON object with { provider, model, api_key, enforce_json_schema?, max_tokens? }
# <output-file>  : path to write the normalized result to.
#
# Sets PROVIDER, MODEL, API_KEY, MAX_TOKENS, ENFORCE_JSON_SCHEMA env vars from the entry,
# then runs the pipeline:
#   diff-stdin | build-prompt | providers/$PROVIDER/build-request | providers/$PROVIDER/call | parse-response | validate-findings
#
# Result written to <output-file>:
#   success: { provider, model, verdict, findings, review_plan, other_checks, top_must_fix }
#   failure: { provider, model, error, verdict: null, findings: [] }
#
# Note: the diff JSON is read from stdin (passed through the entire pipeline). The action
# passes the same diff data to every provider in parallel.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

ENTRY="${1:-}"
OUTPUT="${2:-}"

if [ -z "$ENTRY" ] || [ -z "$OUTPUT" ]; then
    jq -nc '{error:"run-provider.sh usage: run-provider.sh <entry.json> <output-file>"}' > "$OUTPUT"
    exit 1
fi

# Parse the entry from a file — fail loud on malformed JSON.
if [ -f "$ENTRY" ]; then
    ENTRY_JSON=$(cat "$ENTRY")
else
    jq -nc --arg e "$ENTRY" '{error: ("entry file not found: " + $e)}' > "$OUTPUT"
    exit 1
fi
if ! echo "$ENTRY_JSON" | jq -e . >/dev/null 2>&1; then
    jq -nc --arg e "$ENTRY_JSON" '{error: ("malformed entry JSON: " + $e)}' > "$OUTPUT"
    exit 1
fi

PROVIDER=$(echo "$ENTRY_JSON" | jq -r '.provider // ""')
MODEL=$(echo "$ENTRY_JSON" | jq -r '.model // ""')
API_KEY=$(echo "$ENTRY_JSON" | jq -r '.api_key // ""')
ENFORCE_JSON_SCHEMA=$(echo "$ENTRY_JSON" | jq -r '.enforce_json_schema // true')
ENTRY_MAX_TOKENS=$(echo "$ENTRY_JSON" | jq -r '.max_tokens // null')

if [ -z "$PROVIDER" ] || [ -z "$MODEL" ] || [ -z "$API_KEY" ]; then
    jq -nc --arg p "$PROVIDER" --arg m "$MODEL" '{error: ("entry missing required field: provider=" + $p + " model=" + $m)}' > "$OUTPUT"
    exit 1
fi

# Validate provider name (alphanumeric only — guards against path injection in build-request.sh).
if ! [[ "$PROVIDER" =~ ^[a-z0-9]+$ ]]; then
    jq -nc --arg p "$PROVIDER" '{error: ("invalid provider name (must be lowercase alphanumeric): " + $p)}' > "$OUTPUT"
    exit 1
fi

# Per-entry max_tokens > legacy MAX_TOKENS > 4096.
if [ "$ENTRY_MAX_TOKENS" != "null" ] && [ -n "$ENTRY_MAX_TOKENS" ]; then
    MAX_TOKENS="$ENTRY_MAX_TOKENS"
elif [ -n "${MAX_TOKENS:-}" ]; then
    MAX_TOKENS="${MAX_TOKENS}"
else
    MAX_TOKENS="4096"
fi

export PROVIDER MODEL API_KEY MAX_TOKENS ENFORCE_JSON_SCHEMA
export INPUT_MODEL="$MODEL"
export INPUT_MAX_TOKENS="$MAX_TOKENS"
export INPUT_ENFORCE_JSON_SCHEMA="$ENFORCE_JSON_SCHEMA"
export INPUT_PROVIDER="$PROVIDER"

PROVIDER_DIR="$SCRIPT_DIR/providers/$PROVIDER"
if [ ! -d "$PROVIDER_DIR" ]; then
    jq -nc --arg p "$PROVIDER" '{error: ("unknown provider (no script dir): " + $p)}' > "$OUTPUT"
    exit 1
fi
if [ ! -x "$PROVIDER_DIR/build-request.sh" ] || [ ! -x "$PROVIDER_DIR/call.sh" ]; then
    jq -nc --arg p "$PROVIDER" '{error: ("provider scripts missing or not executable: " + $p)}' > "$OUTPUT"
    exit 1
fi

# Build the user prompt + system prompt envelope. Read the diff from stdin and pass through.
# The pipeline is: stdin (diff) -> build-prompt -> providers/<p>/build-request -> providers/<p>/call
# -> parse-response -> validate-findings -> output file
ERR_TMP=$(mktemp)
trap 'rm -f "$ERR_TMP"' EXIT

set +e
RESULT=$(cat \
    | bash "$SCRIPT_DIR/build-prompt.sh" 2>"$ERR_TMP" \
    | bash "$PROVIDER_DIR/build-request.sh" 2>>"$ERR_TMP" \
    | bash "$PROVIDER_DIR/call.sh" 2>>"$ERR_TMP" \
    | bash "$SCRIPT_DIR/parse-response.sh" 2>>"$ERR_TMP" \
    | bash "$SCRIPT_DIR/validate-findings.sh" 2>>"$ERR_TMP")
RC=$?
set -e

if [ $RC -ne 0 ] || [ -z "$RESULT" ]; then
    ERR_TAIL=$(tail -c 400 "$ERR_TMP" 2>/dev/null | tr '\n' ' ' | head -c 200)
    jq -nc --arg p "$PROVIDER" --arg m "$MODEL" --arg e "job exited $RC: $ERR_TAIL" \
        '{provider:$p, model:$m, error:$e, verdict:null, findings:[]}' > "$OUTPUT"
    exit $RC
fi

# Stamp provider + model onto the result (parse-response doesn't know the entry shape).
echo "$RESULT" | jq -c --arg p "$PROVIDER" --arg m "$MODEL" \
    '. + {provider:$p, model:$m}' > "$OUTPUT"
