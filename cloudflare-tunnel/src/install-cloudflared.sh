#!/usr/bin/env bash
# install-cloudflared.sh — fetch the cloudflared binary into a destination,
# cross-platform (Linux + macOS, amd64 + arm64).
#
# Asset shapes differ by OS:
#   - Linux  → bare binary  cloudflared-linux-<arch>
#   - macOS  → gzipped tar  cloudflared-darwin-<arch>.tgz  (must be extracted)
#
# Inputs (env):
#   INPUT_CLOUDFLARED_VERSION   tag name, e.g. "2024.12.2"
#   INPUT_VERIFY_CHECKSUM       "true" to verify SHA256 against release checksums.txt
#   CF_OS / CF_ARCH             override auto-detected platform (used by hermetic tests)
#   INSTALL_DEST                install path (default /usr/local/bin/cloudflared)
#
# Output: an executable cloudflared at INSTALL_DEST. Exits non-zero on any failure.
# Logs progress to stderr; only the success path is quiet.
set -euo pipefail

VERSION="${INPUT_CLOUDFLARED_VERSION:-2024.12.2}"
VERIFY="${INPUT_VERIFY_CHECKSUM:-false}"
REPO="cloudflare/cloudflared"
DEST="${INSTALL_DEST:-/usr/local/bin/cloudflared}"

log() { printf '[install-cloudflared] %s\n' "$*" >&2; }
fail() { log "ERROR: $*"; exit 1; }

# sha256 of a file — portable across Linux (sha256sum) and macOS (shasum).
_sha256() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    else
        shasum -a 256 "$1" | awk '{print $1}'
    fi
}

# --- platform detection (overridable via CF_OS/CF_ARCH for hermetic tests) ---
OS="${CF_OS:-}"
ARCH="${CF_ARCH:-}"
if [ -z "$OS" ]; then
    case "$(uname -s)" in
        Linux)  OS=linux ;;
        Darwin) OS=darwin ;;
        *) fail "unsupported OS: $(uname -s) (supported: linux, darwin)" ;;
    esac
fi
if [ -z "$ARCH" ]; then
    case "$(uname -m)" in
        x86_64|amd64)  ARCH=amd64 ;;
        arm64|aarch64) ARCH=arm64 ;;
        *) fail "unsupported arch: $(uname -m) (supported: amd64, arm64)" ;;
    esac
fi

if [ "$OS" = "darwin" ]; then
    ASSET="cloudflared-darwin-${ARCH}.tgz"
else
    ASSET="cloudflared-${OS}-${ARCH}"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
BASE_URL="https://github.com/${REPO}/releases/download/${VERSION}"

log "Downloading ${ASSET} (${VERSION})..."
curl -fsSL --retry 3 --retry-delay 2 -o "${TMP}/${ASSET}" "${BASE_URL}/${ASSET}"

if [ "$VERIFY" = "true" ]; then
    log "Fetching checksums.txt for verification..."
    if ! curl -fsSL --retry 3 --retry-delay 2 -o "${TMP}/checksums.txt" "${BASE_URL}/checksums.txt"; then
        log "WARNING: failed to download checksums.txt — skipping verification"
    else
        # checksums.txt format — "<sha256>  <filename>", with the filename
        # optionally carrying a BSD '*' (binary-mode) prefix:
        #   <sha256>  cloudflared-darwin-arm64.tgz
        #   <sha256> *cloudflared-linux-amd64
        # Strip a leading '*' from the filename field ($2), then match it to the
        # asset and print the hash ($1).
        expected=$(awk -v target="$ASSET" '{
            name = $2; sub(/^\*/, "", name);
            if (name == target) { print $1; exit }
        }' "${TMP}/checksums.txt" || true)

        if [ -z "$expected" ]; then
            log "WARNING: could not parse SHA256 for ${ASSET} from checksums.txt — skipping verification"
            log "  checksums.txt content (first 5 lines):"
            head -5 "${TMP}/checksums.txt" | sed 's/^/    /' >&2
        else
            actual=$(_sha256 "${TMP}/${ASSET}")
            if [ "$expected" != "$actual" ]; then
                log "ERROR: SHA256 mismatch for ${ASSET}"
                log "  expected: $expected"
                log "  actual:   $actual"
                exit 1
            fi
            log "SHA256 verified"
        fi
    fi
fi

# Resolve the binary: extract on macOS, use the download directly on Linux.
BINARY_PATH="${TMP}/${ASSET}"
if [ "$OS" = "darwin" ]; then
    log "Extracting ${ASSET}..."
    tar -xzf "${TMP}/${ASSET}" -C "$TMP"
    BINARY_PATH="${TMP}/cloudflared"
    [ -f "$BINARY_PATH" ] || fail "cloudflared binary not found inside ${ASSET}"
fi

mkdir -p "$(dirname "$DEST")"
install -m 0755 "$BINARY_PATH" "$DEST"
log "Installed to ${DEST}"
