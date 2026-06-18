#!/usr/bin/env bash
# mint-app-token.sh — mint a short-lived GitHub App installation token so the
# review bot can post under a custom identity ("Toolu - Code Review") instead
# of github-actions[bot].
#
# Env in:
#   INPUT_APP_ID          — GitHub App ID (numeric).
#   INPUT_APP_PRIVATE_KEY — the App's PEM private key.
#   GITHUB_REPOSITORY     — owner/repo (used to resolve the installation).
#   GITHUB_API_URL        — API base (default https://api.github.com).
#
# Behavior:
#   - Neither APP_ID nor APP_PRIVATE_KEY set → print nothing, exit 0 (no App
#     configured; the caller falls back to github-actions[bot]).
#   - Exactly one set → WARN to stderr, empty stdout, exit 1 (misconfiguration).
#   - Both set → build an RS256 JWT, GET the repo installation, POST an
#     installation access token, and print the token to stdout, exit 0.
#   - Any mint failure → WARN to stderr, empty stdout, exit 1. The caller uses
#     an `&&` chain, so a non-zero exit safely falls back to the default token.
#
# Output: the installation token on stdout (success only).
#
# SECURITY: the private key, JWT, and token are NEVER echoed to stdout, stderr,
# or logs. The PEM is written to a 0600 mktemp file that is shredded on EXIT.
set -euo pipefail

API_BASE="${GITHUB_API_URL:-https://api.github.com}"
# Shared curl timeout flags: a hung GitHub connection must not stall the job.
CURL_TIMEOUTS=(--connect-timeout 10 --max-time 30)

# Path to the temp PEM file; a script-global (not a `main` local) so the EXIT
# trap can still see it under `set -u`. Empty until main writes the key.
KEY_FILE=""
# Shred + remove the key on ANY exit so it never lingers on disk. shred is GNU
# coreutils (absent on stock macOS) — fall back to rm.
cleanup_key() {
    [ -n "$KEY_FILE" ] || return 0
    shred -u "$KEY_FILE" 2>/dev/null || rm -f "$KEY_FILE"
}
trap cleanup_key EXIT

# base64url <stdin> — RFC 4648 §5: base64 with +/ → -_ and padding stripped.
base64url() {
    openssl base64 -A | tr '+/' '-_' | tr -d '='
}

# normalize_key <key> — accept either a raw PEM or a base64-encoded PEM. Storing
# a multiline PEM as a single base64 line is a common way to fit it into a secret;
# auto-detect so the workflow needs no decode step. A raw PEM carries the
# "-----BEGIN" header; otherwise base64-decode and use the result when THAT is a
# PEM. Falls back to the original input (the mint then fails with a clear error).
normalize_key() {
    local key="$1" decoded
    if printf '%s' "$key" | grep -q -- "-----BEGIN"; then
        printf '%s' "$key"
        return 0
    fi
    decoded=$(printf '%s' "$key" | tr -d '[:space:]' | openssl base64 -d -A 2>/dev/null || true)
    if printf '%s' "$decoded" | grep -q -- "-----BEGIN"; then
        printf '%s' "$decoded"
    else
        printf '%s' "$key"
    fi
}

# build_jwt <app_id> <key_file> — print a signed RS256 JWT to stdout.
# header.payload.signature, each segment base64url-encoded.
# iat is backdated 60s to tolerate clock skew; exp is +540s (well under the
# 10-minute GitHub maximum). Returns non-zero if signing fails.
build_jwt() {
    local app_id="$1" key_file="$2"
    local now header payload signing_input sig
    now=$(date +%s)

    header=$(printf '{"alg":"RS256","typ":"JWT"}' | base64url)
    payload=$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' "$((now - 60))" "$((now + 540))" "$app_id" | base64url)
    signing_input="${header}.${payload}"

    # Sign the header.payload string; base64url the raw signature. A failure
    # here (bad/empty key) makes openssl exit non-zero, which propagates.
    sig=$(printf '%s' "$signing_input" | openssl dgst -sha256 -sign "$key_file" -binary | base64url) || return 1
    [ -n "$sig" ] || return 1

    printf '%s.%s' "$signing_input" "$sig"
}

# github_api <method> <url> <jwt> — call the GitHub API with App JWT auth and
# print `<body>\n<http_status>` to stdout (the status is the LAST line). The
# caller splits the two and decides success. Status flows back through stdout
# because callers invoke this in a command-substitution subshell, where a global
# assignment would not propagate to the parent.
github_api() {
    local method="$1" url="$2" jwt="$3" body_file code resp
    body_file=$(mktemp)
    code=$(curl -s "${CURL_TIMEOUTS[@]}" -X "$method" -o "$body_file" -w '%{http_code}' \
        -H "Authorization: Bearer $jwt" \
        -H "Accept: application/vnd.github+json" \
        -H "X-GitHub-Api-Version: 2022-11-28" \
        "$url" 2>/dev/null || echo "000")
    resp=$(cat "$body_file")
    rm -f "$body_file"
    printf '%s\n%s' "$resp" "$code"
}

# warn <reason> — emit the standard fallback WARN to stderr and exit 1.
warn() {
    echo "[WARN] App token mint failed: $1" >&2
    exit 1
}

main() {
    local app_id="${INPUT_APP_ID:-}" private_key="${INPUT_APP_PRIVATE_KEY:-}"
    local repo="${GITHUB_REPOSITORY:-}"

    # No App configured at all → silent no-op success.
    if [ -z "$app_id" ] && [ -z "$private_key" ]; then
        exit 0
    fi

    # Exactly one credential → misconfiguration; warn and fall back.
    if [ -z "$app_id" ] || [ -z "$private_key" ]; then
        echo "[WARN] APP_ID and APP_PRIVATE_KEY must both be set; falling back to github-actions[bot]" >&2
        exit 1
    fi

    [ -n "$repo" ] || warn "GITHUB_REPOSITORY is not set"

    # Write the PEM to a private temp file (cleaned up by the EXIT trap). The key
    # may arrive raw or base64-encoded — normalize_key handles both.
    KEY_FILE=$(mktemp)
    chmod 600 "$KEY_FILE"
    normalize_key "$private_key" > "$KEY_FILE"

    local jwt
    jwt=$(build_jwt "$app_id" "$KEY_FILE") || warn "could not sign JWT"

    # Resolve the installation for this repository. The response carries the
    # HTTP status on its last line; split body from status.
    local install_out install_code install_body install_id
    install_out=$(github_api GET "$API_BASE/repos/$repo/installation" "$jwt")
    install_code="${install_out##*$'\n'}"
    install_body="${install_out%$'\n'*}"
    [[ "$install_code" == 2* ]] || warn "installation lookup returned HTTP $install_code"
    install_id=$(printf '%s' "$install_body" | jq -r '.id // empty' 2>/dev/null || true)
    [ -n "$install_id" ] || warn "no installation id in response"

    # Exchange the JWT for an installation access token.
    local token_out token_code token_body token
    token_out=$(github_api POST "$API_BASE/app/installations/$install_id/access_tokens" "$jwt")
    token_code="${token_out##*$'\n'}"
    token_body="${token_out%$'\n'*}"
    [[ "$token_code" == 2* ]] || warn "access-token request returned HTTP $token_code"
    token=$(printf '%s' "$token_body" | jq -r '.token // empty' 2>/dev/null || true)
    [ -n "$token" ] || warn "no token in access-token response"

    printf '%s\n' "$token"
}

# Source-guard: when sourced (e.g. by bats) only the functions are defined, so
# tests can call build_jwt directly without running main.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    main "$@"
fi
