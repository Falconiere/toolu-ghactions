#!/usr/bin/env bash
# setup-signing.sh — decode the release keystore into RUNNER_TEMP and export the
# EXPO_BUILDER_KEYSTORE_* env consumed by signing.init.gradle. All four keystore
# inputs together or none: 1-3 is a hard error; none falls back to the Android
# debug keystore (warning) unless require-signing is true.
set -euo pipefail

missing=()
[ -n "${EXPO_BUILDER_INPUT_KEYSTORE_BASE64:-}" ] || missing+=("keystore-base64")
[ -n "${EXPO_BUILDER_INPUT_KEYSTORE_PASSWORD:-}" ] || missing+=("keystore-password")
[ -n "${EXPO_BUILDER_INPUT_KEY_ALIAS:-}" ] || missing+=("key-alias")
[ -n "${EXPO_BUILDER_INPUT_KEY_PASSWORD:-}" ] || missing+=("key-password")

if [ "${#missing[@]}" -eq 4 ]; then
  if [ "${EXPO_BUILDER_REQUIRE_SIGNING:-false}" = "true" ]; then
    echo "::error::require-signing is true but no keystore inputs were provided"
    exit 1
  fi
  echo "::warning::no keystore inputs — falling back to the Android debug keystore; the binary is NOT store-uploadable"
  echo "[expo-builder] debug-keystore fallback"
  exit 0
fi

if [ "${#missing[@]}" -gt 0 ]; then
  echo "::error::incomplete keystore inputs — missing: ${missing[*]} (provide all four keystore inputs or none)"
  exit 1
fi

# BSD (macOS) base64 decodes with -D on older systems, -d elsewhere.
if printf 'x' | base64 | base64 -d >/dev/null 2>&1; then
  decode_flag="-d"
else
  decode_flag="-D"
fi

tmp="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/expo-builder.XXXXXX")"
keystore="$tmp/release.keystore"
if ! printf '%s' "$EXPO_BUILDER_INPUT_KEYSTORE_BASE64" | base64 "$decode_flag" >"$keystore" || [ ! -s "$keystore" ]; then
  echo "::error::keystore-base64 did not decode to a non-empty keystore file"
  exit 1
fi
chmod 600 "$keystore"

{
  echo "EXPO_BUILDER_KEYSTORE_PATH=$keystore"
  echo "EXPO_BUILDER_KEYSTORE_PASSWORD=$EXPO_BUILDER_INPUT_KEYSTORE_PASSWORD"
  echo "EXPO_BUILDER_KEY_ALIAS=$EXPO_BUILDER_INPUT_KEY_ALIAS"
  echo "EXPO_BUILDER_KEY_PASSWORD=$EXPO_BUILDER_INPUT_KEY_PASSWORD"
} >>"$GITHUB_ENV"
echo "[expo-builder] release keystore ready: $keystore"
