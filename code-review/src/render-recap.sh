#!/usr/bin/env bash
# render-recap.sh — render the "changes since last review" recap and the
# collapsed review-history table for the sticky PR review comment.
#
# Single responsibility: turn review-state.sh's diff/history JSON (passed via
# env) into markdown. Pure rendering — it never calls review-state.sh itself.
#
# Reads from env:
#   REVIEW_RECAP_JSON   { new, open, resolved, counts:{new,open,resolved,total} }
#                       (present only when a PRIOR review existed)
#   REVIEW_HISTORY_JSON [ { sha, ts, verdict, counts:{new,open,resolved,total} } ]
#                       (already capped to <=10 by the caller)
#   FULL_REVIEW         "true"/"false" — when "false", omit the Resolved list and
#                       note that resolutions were not recomputed.
#
# Subcommands:
#   recap    print the "### Changes since last review" section (nothing if absent).
#   history  print the collapsed "<details>" history table (nothing if empty).
set -euo pipefail

# Cap on how many items we inline per recap bucket before collapsing the rest.
RECAP_LIST_CAP=8

# Render one bucket: a labelled line plus a short list, collapsing overflow.
# Args: <emoji+label> <count> <items-json-array>
render_bucket() {
    local label="$1" count="$2" items="$3"
    printf '%s (%s)\n' "$label" "$count"
    if [ "$count" -eq 0 ]; then
        return
    fi
    # `path:line` — text, one per line, capped.
    printf '%s' "$items" | jq -r --argjson cap "$RECAP_LIST_CAP" '
        .[0:$cap][]
        | "- `" + .path + (if .line then ":" + (.line|tostring) else "" end) + "` — " + .text'
    local extra=$((count - RECAP_LIST_CAP))
    if [ "$extra" -gt 0 ]; then
        printf '_… %s more_\n' "$extra"
    fi
}

cmd_recap() {
    local recap="${REVIEW_RECAP_JSON:-}"
    if [ -z "$recap" ]; then
        return 0
    fi
    if ! printf '%s' "$recap" | jq -e . >/dev/null 2>&1; then
        echo "render-recap: REVIEW_RECAP_JSON is not valid JSON" >&2
        return 1
    fi

    local full_review n_new n_open n_resolved new open resolved
    full_review="${FULL_REVIEW:-true}"
    n_new=$(printf '%s' "$recap" | jq '.counts.new // (.new | length)')
    n_open=$(printf '%s' "$recap" | jq '.counts.open // (.open | length)')
    n_resolved=$(printf '%s' "$recap" | jq '.counts.resolved // (.resolved | length)')
    new=$(printf '%s' "$recap" | jq -c '.new // []')
    open=$(printf '%s' "$recap" | jq -c '.open // []')
    resolved=$(printf '%s' "$recap" | jq -c '.resolved // []')

    echo "### Changes since last review"
    echo
    if [ "$full_review" = "true" ]; then
        render_bucket "✅ Resolved" "$n_resolved" "$resolved"
        echo
    else
        echo "_scoped review — resolutions not recomputed_"
        echo
    fi
    render_bucket "🔁 Still open" "$n_open" "$open"
    echo
    render_bucket "⚠️ New" "$n_new" "$new"
    echo
}

cmd_history() {
    local history="${REVIEW_HISTORY_JSON:-}"
    if [ -z "$history" ]; then
        return 0
    fi
    if ! printf '%s' "$history" | jq -e . >/dev/null 2>&1; then
        echo "render-recap: REVIEW_HISTORY_JSON is not valid JSON" >&2
        return 1
    fi
    local passes
    passes=$(printf '%s' "$history" | jq 'length')
    if [ "$passes" -eq 0 ]; then
        return 0
    fi

    echo "<details><summary>📜 Review history (${passes} passes)</summary>"
    echo
    echo "| Pass | Commit | Verdict | New | Open | Resolved |"
    echo "| --- | --- | --- | --- | --- | --- |"
    # Newest last: pass number = index + 1.
    printf '%s' "$history" | jq -r '
        to_entries[]
        | "| " + ((.key + 1)|tostring)
          + " | `" + (.value.sha // "?")
          + "` | " + (.value.verdict // "?")
          + " | " + ((.value.counts.new // 0)|tostring)
          + " | " + ((.value.counts.open // 0)|tostring)
          + " | " + ((.value.counts.resolved // 0)|tostring)
          + " |"'
    echo
    echo "</details>"
}

main() {
    local sub="${1:-}"
    case "$sub" in
        recap)   cmd_recap ;;
        history) cmd_history ;;
        "")
            echo "render-recap: missing subcommand (recap|history)" >&2
            exit 2 ;;
        *)
            echo "render-recap: unknown subcommand '$sub' (recap|history)" >&2
            exit 2 ;;
    esac
}

main "$@"
