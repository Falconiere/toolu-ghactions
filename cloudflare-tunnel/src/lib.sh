#!/usr/bin/env bash
# lib.sh — shared helpers for cloudflare-tunnel sub-actions.
#
# Sourced by start.sh, stop.sh, wait.sh. Defines slugify(), path helpers, log,
# fail, and the regexes used to scrape cloudflared output. No side effects on
# source.
#
# Conventions:
#   - All paths resolve to /tmp/cf-tunnel-<NAME>.{pid,url,log}
#   - NAME is slugified; empty/unset becomes "default"
#   - All functions echo (capture with $()) or print to stderr; never both
set -euo pipefail

# slugify NAME
#   Replace any non-[a-zA-Z0-9-] with a single hyphen. Empty input returns "default".
slugify() {
    local name="${1:-}"
    if [ -z "$name" ]; then
        printf 'default\n'
        return
    fi
    printf '%s\n' "$name" | tr -c 'a-zA-Z0-9-' '-' | tr -s '-' | sed 's/^-//; s/-$//'
}

# pid_path NAME → /tmp/cf-tunnel-<slug>.pid
pid_path() { printf '/tmp/cf-tunnel-%s.pid\n' "$(slugify "${1:-}")"; }

# url_path NAME → /tmp/cf-tunnel-<slug>.url (quick-mode URL cache)
url_path() { printf '/tmp/cf-tunnel-%s.url\n' "$(slugify "${1:-}")"; }

# log_path NAME → /tmp/cf-tunnel-<slug>.log (raw cloudflared stderr)
log_path() { printf '/tmp/cf-tunnel-%s.log\n' "$(slugify "${1:-}")"; }

# log MSG  — informational to stderr
log() { printf '[cloudflare-tunnel] %s\n' "$*" >&2; }

# fail MSG [DETAIL]
#   Print error to stderr and exit 1. Used by start.sh for unrecoverable errors
#   (missing required env, install failure, URL not seen within timeout).
fail() {
    local msg="$1"
    local detail="${2:-}"
    log "ERROR: $msg"
    if [ -n "$detail" ]; then
        printf '%s\n' "$detail" >&2
    fi
    exit 1
}

# Regex matching the public quick-tunnel URL emitted by cloudflared to stderr.
# Captured group: the full https URL. Matches e.g.:
#   2024-12-02T12:34:56Z INF https://example-slug.trycloudflare.com ...
# shellcheck disable=SC2034 # consumed by sourced callers (start.sh)
TUNNEL_URL_REGEX='https://[A-Za-z0-9_-]+\.trycloudflare\.com'

# Regex matching the named-tunnel UUID emitted by `cloudflared tunnel run`.
# Captured group: 36-char UUID. Matches e.g.:
#   ... INF Registered tunnel connection ... <uuid> ...
# shellcheck disable=SC2034 # consumed by sourced callers (start.sh)
TUNNEL_ID_REGEX='[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
