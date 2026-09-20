#!/usr/bin/env bash
# parse-verdict.sh — turn the CI review bot's issue comment (stdin) into a
# deterministic JSON verdict the babysit loop acts on. Keeps the parsing OUT of
# the LLM prompt so behaviour is testable (scripts/__tests__/parse-verdict.bats
# against a captured real comment) and stable.
#
# stdin : raw comment body (markdown)
# stdout: { is_review_comment, state, complete, verdict, verdict_label, findings[] }
#   state: in_progress | complete | unknown
#     - unknown  → no checkbox checklist found (cannot judge completeness; the
#                  caller degrades to GitHub check-conclusion behaviour)
#     - in_progress → ≥1 unchecked `- [ ]` (review still running; do not act)
#     - complete → ≥1 checkbox AND none unchecked
#   findings[]: { path, line|null, severity, text, key }  (key = path:line:sha1(text)[:8])
#
# Identification is by MARKER, robust to both header states the bot uses
# ("PR Review in Progress" → "Code Review —"): a CI job link, a "Code Review"
# header, or an "agent-merge" verdict label. No marker → is_review_comment:false.
set -euo pipefail

command -v jq >/dev/null 2>&1 || { echo "parse-verdict.sh: jq required" >&2; exit 2; }

input=$(cat 2>/dev/null || true)

_empty() { jq -nc '{is_review_comment:false, state:"unknown", complete:false, verdict:"none", verdict_label:"", findings:[]}'; }

# Empty / unreadable stdin → not a review comment.
[ -n "${input//[[:space:]]/}" ] || { _empty; exit 0; }

# --- Identify: marker-based, both states ---
# Precondition: the babysit pre-filters comments to claude[bot]/github-actions[bot]
# before calling this; the markers below are anchored to the bot's own structures
# (review headings, the [View job] CI link, a backticked agent-merge label) so a
# stray "actions/runs/…" or "agent-merge-…" in arbitrary prose won't false-positive.
is_review=false
if printf '%s' "$input" | grep -qE '^### Code Review|^### PR Review in Progress|\[View job\]\([^)]*actions/runs/[0-9]+|`agent-(merge|request)-[a-z]'; then
  is_review=true
fi
if [ "$is_review" != true ]; then _empty; exit 0; fi

# --- Completeness: checkbox state only ---
unchecked=$(printf '%s\n' "$input" | grep -cE '^[[:space:]]*-[[:space:]]\[[[:space:]]\]' || true)
checked=$(printf '%s\n'   "$input" | grep -cE '^[[:space:]]*-[[:space:]]\[[xX]\]'        || true)
boxes=$((unchecked + checked))
if   [ "$boxes" -eq 0 ];     then state="unknown"
elif [ "$unchecked" -gt 0 ]; then state="in_progress"
else                              state="complete"
fi
complete=false; [ "$state" = complete ] && complete=true

# --- Verdict --- the machine-readable `agent-merge-*` label is AUTHORITATIVE.
# Don't infer from prose when a label exists: finding TEXT routinely discusses
# "Changes requested"/"approved" (e.g. a finding about verdict parsing itself),
# and a whole-body grep would misclassify an approved PR as "changes". Fall back
# to prose only when no label is present (changes-first there, as the safe bias).
verdict_label=$(printf '%s' "$input" | grep -oE 'agent-(merge|request)-[a-z-]+' | head -1 || true)
if [[ "$verdict_label" == *approved* ]]; then
  verdict="approved"
elif [[ "$verdict_label" == *blocked* || "$verdict_label" == *changes* ]]; then
  verdict="changes"
elif printf '%s' "$input" | grep -qiE '\*\*Changes requested\*\*|changes-requested'; then
  verdict="changes"
elif printf '%s' "$input" | grep -qiE '\*\*Approved\*\*'; then
  verdict="approved"
else
  verdict="none"
fi

# --- Findings: only the `### Findings` … next `### ` block. Two shapes are
#     accepted, because a repo can be running an older bot than this script:
#       new (grouped blocks)   `#### 🟠 High · 2` heading, then per finding
#                              `**1.** `path` **L12**`, an optional `<sub>…</sub>`
#                              meta line, then the text paragraph;
#       old (one line each)    `path[:line]`: severity: text.
#     `#### ` sub-headings do NOT close the block — only a top-level `### ` does.
_sha1() { (sha1sum 2>/dev/null || shasum 2>/dev/null || echo nohash) | cut -c1-8; }
findings_block=$(printf '%s\n' "$input" | awk '/^### Findings([[:space:]]|$)/{f=1;next} /^### /{f=0} f')
findings_json="[]"

# Append one finding (silently skipped when it lacks a path, severity or text).
_emit() {
  local path="$1" ln="$2" sev="$3" text="$4" h key obj
  [ -n "$path" ] && [ -n "$sev" ] && [ -n "$text" ] || return 0
  h=$(printf '%s' "$text" | _sha1)
  key="${path}:${ln}:${h}"
  obj=$(jq -nc --arg path "$path" --arg line "$ln" --arg severity "$sev" --arg text "$text" --arg key "$key" \
    '{path:$path, line:(if $line=="" then null else ($line|tonumber) end), severity:$severity, text:$text, key:$key}') || return 0
  findings_json=$(jq -c --argjson o "$obj" '. + [$o]' <<<"$findings_json")
}

# State for the grouped shape: the severity of the current `#### ` group and the
# block being read (its text arrives on the lines AFTER its header).
cur_sev=""; pending=false; p_path=""; p_line=""; p_sev=""; p_text=""
_flush() {
  [ "$pending" = true ] && _emit "$p_path" "$p_line" "$p_sev" "$p_text"
  pending=false; p_path=""; p_line=""; p_sev=""; p_text=""
  return 0
}

# Regexes as variables: keeps the backtick/asterisk-heavy patterns out of the
# shell's quoting rules.
# Anchored to the WHOLE heading the renderer emits — `#### <emoji> <Severity> · N`
# — not just to the severity word appearing somewhere in it, so a heading of
# ordinary prose ("#### Why High severity matters") cannot open a group.
group_re='^#### [^[:space:]]+ (Blocker|High|Medium|Low|Nit) · [0-9]+[[:space:]]*$'
block_re='^\*\*[0-9]+\.\*\*[[:space:]]`([^`]+)`([[:space:]]\*\*L([0-9]+)\*\*)?[[:space:]]*$'
oneline_re='^`([^`]+)`: (blocker|high|medium|low|nit): (.*)$'
path_line_re='^(.+):([0-9]+)$'

while IFS= read -r line; do
  # Already reading a block's TEXT: nothing in it can be a header. A real header
  # is always preceded by the blank line that closed the previous block, and that
  # blank line flushes `pending` — so a header-shaped line reached HERE is the
  # model quoting one ("see `**2.** `src/other.ts` **L20**` above"), and honoring
  # it would truncate this finding and fabricate a second, bogus one.
  if [ "$pending" = true ] && [ -n "$p_text" ]; then
    if [ -z "${line//[[:space:]]/}" ]; then _flush; else p_text="$p_text $line"; fi
    continue
  fi
  # Group heading — severity for every block until the next one.
  if [[ "$line" =~ $group_re ]]; then
    _flush
    cur_sev=$(printf '%s' "${BASH_REMATCH[1]}" | tr '[:upper:]' '[:lower:]')
    continue
  fi
  # Block header: `**3.** `path/to/file.ts` **L75**` (the line part is optional).
  if [[ "$line" =~ $block_re ]]; then
    _flush
    p_path="${BASH_REMATCH[1]}"; p_line="${BASH_REMATCH[3]}"; p_sev="$cur_sev"; p_text=""; pending=true
    continue
  fi
  # Old one-line shape, still parsed so comments from an older bot keep working.
  if [[ "$line" =~ $oneline_re ]]; then
    _flush
    raw_path="${BASH_REMATCH[1]}"; sev="${BASH_REMATCH[2]}"; text="${BASH_REMATCH[3]}"
    if [[ "$raw_path" =~ $path_line_re ]]; then path="${BASH_REMATCH[1]}"; ln="${BASH_REMATCH[2]}"; else path="$raw_path"; ln=""; fi
    _emit "$path" "$ln" "$sev" "$text"
    continue
  fi
  # Between a block's header and its text: skip the `<sub>` meta line and the
  # blank line under it, and take the first line of the text.
  if [ "$pending" = true ]; then
    case "$line" in
      "<sub>"*) continue ;;
    esac
    [ -z "${line//[[:space:]]/}" ] && continue
    p_text="$line"
  fi
done <<< "$findings_block"
_flush

jq -nc \
  --argjson is_review "$is_review" \
  --arg state "$state" \
  --argjson complete "$complete" \
  --arg verdict "$verdict" \
  --arg verdict_label "${verdict_label:-}" \
  --argjson findings "$findings_json" \
  '{is_review_comment:$is_review, state:$state, complete:$complete, verdict:$verdict, verdict_label:$verdict_label, findings:$findings}'
