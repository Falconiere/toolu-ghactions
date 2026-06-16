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
set -o pipefail

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
if printf '%s' "$input" | grep -qE '^### Code Review|^### PR Review in Progress|\[View job\]\([^)]*actions/runs/[0-9]+|`agent-merge-[a-z]'; then
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
verdict_label=$(printf '%s' "$input" | grep -oE 'agent-merge-[a-z-]+' | head -1 || true)
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

# --- Findings: only the `### Findings` … next `### ` block, lines of the form
#     `path[:line]`: severity: text
_sha1() { (sha1sum 2>/dev/null || shasum 2>/dev/null || echo nohash) | cut -c1-8; }
# Tolerate a decorated header (`### Findings`, `### Findings (6)`) — exact-match
# would miss a count suffix and silently report zero findings.
findings_block=$(printf '%s\n' "$input" | awk '/^### Findings([[:space:]]|$)/{f=1;next} /^### /{f=0} f')
findings_json="[]"
while IFS= read -r line; do
  [[ "$line" =~ ^\`([^\`]+)\`:\ (blocker|high|medium|low|nit):\ (.*)$ ]] || continue
  raw_path="${BASH_REMATCH[1]}"; sev="${BASH_REMATCH[2]}"; text="${BASH_REMATCH[3]}"
  if [[ "$raw_path" =~ ^(.+):([0-9]+)$ ]]; then path="${BASH_REMATCH[1]}"; ln="${BASH_REMATCH[2]}"; else path="$raw_path"; ln=""; fi
  h=$(printf '%s' "$text" | _sha1)
  key="${path}:${ln}:${h}"
  obj=$(jq -nc --arg path "$path" --arg line "$ln" --arg severity "$sev" --arg text "$text" --arg key "$key" \
    '{path:$path, line:(if $line=="" then null else ($line|tonumber) end), severity:$severity, text:$text, key:$key}') || continue
  findings_json=$(jq -c --argjson o "$obj" '. + [$o]' <<<"$findings_json")
done <<< "$findings_block"

jq -nc \
  --argjson is_review "$is_review" \
  --arg state "$state" \
  --argjson complete "$complete" \
  --arg verdict "$verdict" \
  --arg verdict_label "${verdict_label:-}" \
  --argjson findings "$findings_json" \
  '{is_review_comment:$is_review, state:$state, complete:$complete, verdict:$verdict, verdict_label:$verdict_label, findings:$findings}'
