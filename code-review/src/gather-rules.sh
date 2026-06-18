#!/usr/bin/env bash
# gather-rules.sh — collect the target repo's project-convention files and emit
# them as a single text blob for the reviewer to check the diff against.
#
# Reads the fetch-diff JSON on stdin (for .changed_files and, as a fallback, the
# base SHA) plus INPUT_* env vars:
#   INPUT_CHECK_PROJECT_RULES   "true"|"false"  (default "true") — master switch
#   INPUT_RULES_GLOB            extra path globs (default "")
#   INPUT_RULES_MAX_BYTES       integer cap     (default 32768)
#   RULES_BASE_SHA              base-branch-tip SHA (else read .base_sha from stdin)
#
# SECURITY: convention files live in the repo, so a PR that edits CLAUDE.md could
# otherwise inject instructions into the reviewer. We read ONLY tracked blobs at
# the BASE ref — `git ls-tree <base>` + `git show <base>:<path>`. No working-tree
# reads occur, so a PR cannot poison the rules until it is merged, and RULES_GLOB
# cannot path-escape the repo (ls-tree lists tracked blobs only).
#
# CWD: operates in the inherited working directory (the caller — main.sh — runs in
# GITHUB_WORKSPACE; tests cd into the fixture repo). No hardcoded cd.
#
# Output (stdout): the assembled rules text, or nothing. Always exits 0 — project
# rules are best-effort context, never a hard failure of the review.
set -uo pipefail

CHECK="${INPUT_CHECK_PROJECT_RULES:-true}"
RULES_GLOB="${INPUT_RULES_GLOB:-}"
MAX_BYTES="${INPUT_RULES_MAX_BYTES:-32768}"
# A non-numeric cap would make the `[ $((..)) -gt "$MAX_BYTES" ]` test error out
# and fail open (cap disabled). Fall back to the default on any non-digit value.
case "$MAX_BYTES" in ''|*[!0-9]*) MAX_BYTES=32768 ;; esac

# Off switch: emit nothing.
[ "$CHECK" = "true" ] || exit 0

DIFF_DATA=$(cat || true)

BASE_SHA="${RULES_BASE_SHA:-}"
if [ -z "$BASE_SHA" ]; then
    BASE_SHA=$(printf '%s' "$DIFF_DATA" | jq -r '.base_sha // ""' 2>/dev/null || echo "")
fi

# Fail-safe: with no base ref we cannot read rules safely. Skip, don't guess.
if [ -z "$BASE_SHA" ]; then
    echo "[project-rules] skipped: no base ref" >&2
    exit 0
fi

# Enumerate tracked files at the base ref once. core.quotePath=false keeps
# non-ASCII paths verbatim (the default C-quotes them, e.g. "caf\303\251.md",
# which then never matches `git show` and is silently dropped).
TRACKED=$(git -c core.quotePath=false ls-tree -r --name-only "$BASE_SHA" 2>/dev/null || true)
if [ -z "${TRACKED//[[:space:]]/}" ]; then
    echo "[project-rules] skipped: no tracked files at base ref" >&2
    exit 0
fi

declare -A IS_TRACKED
while IFS= read -r p; do
    [ -n "$p" ] && IS_TRACKED["$p"]=1
done <<< "$TRACKED"

# Ordered selection with dedup.
declare -A SEEN
SELECTED=()
select_path() {
    local p="$1"
    [ -n "${IS_TRACKED[$p]:-}" ] || return 0
    [ -n "${SEEN[$p]:-}" ] && return 0
    SEEN["$p"]=1
    SELECTED+=("$p")
}

# --- Tier 1: root agent-rule files ---
for f in CLAUDE.md AGENTS.md .cursorrules .windsurfrules .github/copilot-instructions.md; do
    select_path "$f"
done

# --- Tier 2: nested CLAUDE.md/AGENTS.md in ancestor dirs of changed files ---
while IFS= read -r file; do
    [ -n "$file" ] || continue
    dir="${file%/*}"
    [ "$dir" = "$file" ] && continue  # no slash -> root file, tier 1 covers it
    while [ -n "$dir" ]; do
        select_path "$dir/CLAUDE.md"
        select_path "$dir/AGENTS.md"
        parent="${dir%/*}"
        [ "$parent" = "$dir" ] && break  # no more slashes
        dir="$parent"
    done
done < <(printf '%s' "$DIFF_DATA" | jq -r '.changed_files[]? // empty' 2>/dev/null || true)

# --- Tier 3: rule directories ---
while IFS= read -r p; do
    case "$p" in
        .cursor/rules/*|.windsurf/rules/*) select_path "$p" ;;
    esac
done <<< "$TRACKED"

# --- Tier 4: curated conventions docs ---
select_path "CONVENTIONS.md"
select_path "CONTRIBUTING.md"
while IFS= read -r p; do
    case "$p" in
        docs/conventions/*) select_path "$p" ;;
    esac
done <<< "$TRACKED"

# --- Tier 5: user-supplied RULES_GLOB (split on newline and comma) ---
if [ -n "${RULES_GLOB//[[:space:]]/}" ]; then
    globs=$(printf '%s' "$RULES_GLOB" | tr ',\n' '\n\n')
    while IFS= read -r raw; do
        # trim surrounding whitespace
        entry="${raw#"${raw%%[![:space:]]*}"}"
        entry="${entry%"${entry##*[![:space:]]}"}"
        [ -n "$entry" ] || continue
        # `**` and `*` are wildcards inside case patterns, so detect the literal
        # suffixes with string ops instead.
        if [ "${entry: -3}" = "/**" ]; then
            prefix="${entry%\*\*}"; mode="prefix"   # dir/** -> everything under dir/
        elif [ "${entry: -1}" = "/" ]; then
            prefix="$entry"; mode="prefix"          # dir/   -> everything under dir/
        else
            prefix=""; mode="glob"
        fi
        while IFS= read -r p; do
            [ -n "$p" ] || continue
            if [ "$mode" = "prefix" ]; then
                [[ "$p" == "$prefix"* ]] && select_path "$p"
            else
                # shellcheck disable=SC2053  # intentional glob match against the entry
                [[ "$p" == $entry ]] && select_path "$p"
            fi
        done <<< "$TRACKED"
    done <<< "$globs"
fi

# --- Read selected blobs from the base ref, honoring the byte cap (whole-file). ---
OUT=""
total_bytes=0
omitted=0
BLOB_TMP=$(mktemp)
trap 'rm -f "$BLOB_TMP"' EXIT
# Guard the empty-array expansion under `set -u` (older bash aborts on it).
for path in ${SELECTED[@]+"${SELECTED[@]}"}; do
    # Read the blob once. An unreadable blob (bad ref / vanished path) is logged
    # and skipped, not silently dropped.
    if ! git show "$BASE_SHA:$path" > "$BLOB_TMP" 2>/dev/null; then
        echo "[project-rules] skipped unreadable: $path" >&2
        continue
    fi
    # Skip blank/empty blobs (no printable, non-whitespace line).
    grep -q '[^[:space:]]' "$BLOB_TMP" || continue
    # Skip binary blobs (any NUL byte). NOT `grep -I`: busybox grep accepts -I but
    # ignores it, so on the Alpine runtime binary files would slip through.
    if [ "$(LC_ALL=C tr -dc '\000' < "$BLOB_TMP" | wc -c | tr -d '[:space:]')" != "0" ]; then
        continue
    fi
    blob=$(cat "$BLOB_TMP")
    section="### $path
$blob
"
    sec_bytes=$(printf '%s' "$section" | wc -c | tr -d '[:space:]')
    if [ $((total_bytes + sec_bytes)) -gt "$MAX_BYTES" ]; then
        omitted=$((omitted + 1))
        continue  # whole-file drop: never emit a half-rule
    fi
    OUT+="$section"
    total_bytes=$((total_bytes + sec_bytes))
done

# No rule text assembled -> emit nothing. If files existed but every one
# exceeded the cap, log it rather than emitting a bare, content-free notice
# (which build-prompt would otherwise inject as an authoritative-but-empty block).
if [ -z "$OUT" ]; then
    [ "$omitted" -gt 0 ] && echo "[project-rules] all $omitted rule file(s) exceeded ${MAX_BYTES} bytes; none injected" >&2
    exit 0
fi

printf '%s' "$OUT"
if [ "$omitted" -gt 0 ]; then
    printf '\n[Project rules truncated at %s bytes; %s file(s) omitted.]\n' "$MAX_BYTES" "$omitted"
fi
exit 0
