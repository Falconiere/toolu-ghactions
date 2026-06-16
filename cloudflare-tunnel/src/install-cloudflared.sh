#!/usr/bin/env bash
# install-cloudflared.sh — fetch cloudflared binary into /usr/local/bin.
#
# Inputs (env):
#   INPUT_CLOUDFLARED_VERSION   tag name, e.g. "2024.12.2"
#   INPUT_VERIFY_CHECKSUM       "true" to verify SHA256 against release checksums.txt
#
# Output: /usr/local/bin/cloudflared, executable. Exits non-zero on any failure.
# Logs progress to stderr; only the success path is silent.
set -euo pipefail

VERSION="${INPUT_CLOUDFLARED_VERSION:-2024.12.2}"
VERIFY="${INPUT_VERIFY_CHECKSUM:-false}"
REPO="cloudflare/cloudflared"
BINARY="cloudflared-linux-amd64"
DEST="${INSTALL_DEST:-/usr/local/bin/cloudflared}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

log() { printf '[install-cloudflared] %s\n' "$*" >&2; }

BASE_URL="https://github.com/${REPO}/releases/download/${VERSION}"

log "Downloading cloudflared ${VERSION}..."
curl -fsSL --retry 3 --retry-delay 2 -o "${TMP}/${BINARY}" "${BASE_URL}/${BINARY}"

if [ "$VERIFY" = "true" ]; then
    log "Fetching checksums.txt for verification..."
    if ! curl -fsSL --retry 3 --retry-delay 2 -o "${TMP}/checksums.txt" "${BASE_URL}/checksums.txt"; then
        log "WARNING: failed to download checksums.txt — skipping verification"
    else
        # checksums.txt format (BSD-style, optional '*' prefix on filename):
        #   <sha256>  cloudflared-linux-amd64
        #   <sha256> *cloudflared-linux-amd64
        # awk strips leading '*' and matches the binary name on either whitespace-separated field.
        expected=$(awk -v target="$BINARY" '{
            gsub(/^\*/, "", $1);
            if ($1 == target) { print $1; exit }
            if ($2 == target) { print $1; exit }
        }' "${TMP}/checksums.txt" || true)

        if [ -z "$expected" ]; then
            log "WARNING: could not parse SHA256 for ${BINARY} from checksums.txt — skipping verification"
            log "  checksums.txt content (first 5 lines):"
            head -5 "${TMP}/checksums.txt" | sed 's/^/    /' >&2
        else
            actual=$(sha256sum "${TMP}/${BINARY}" | awk '{print $1}')
            if [ "$expected" != "$actual" ]; then
                log "ERROR: SHA256 mismatch for ${BINARY}"
                log "  expected: $expected"
                log "  actual:   $actual"
                exit 1
            fi
            log "SHA256 verified"
        fi
    fi
fi

mkdir -p "$(dirname "$DEST")"
install -m 0755 "${TMP}/${BINARY}" "${DEST}"
log "Installed to ${DEST}"
