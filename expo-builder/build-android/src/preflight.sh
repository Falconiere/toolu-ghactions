#!/usr/bin/env bash
# preflight.sh — validate runner + app dir before any Expo/Gradle work runs.
# Distinct ::error:: per failure so consumers can tell them apart in logs.
set -euo pipefail

dir="${EXPO_BUILDER_WORKING_DIR:-.}"
if ! cd "$dir" 2>/dev/null; then
  echo "::error::working-directory '$dir' does not exist"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "::error::node_modules not found in '$dir' — install dependencies (npm/yarn/pnpm/bun) before this action"
  exit 1
fi

has_config=0
for f in app.json app.config.js app.config.ts app.config.cjs app.config.mjs; do
  [ -f "$f" ] && { has_config=1; break; }
done
if [ "$has_config" -eq 0 ]; then
  echo "::error::'$dir' is not an Expo app — no app.json or app.config.{js,ts,cjs,mjs} found"
  exit 1
fi

sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [ -z "$sdk" ] || [ ! -d "$sdk" ]; then
  echo "::error::runner has no Android SDK — ANDROID_HOME/ANDROID_SDK_ROOT unset or missing (self-hosted runners must preinstall it)"
  exit 1
fi

# Persist for every later step in the job (prebuild, expo config).
echo "EXPO_NO_TELEMETRY=1" >>"$GITHUB_ENV"
echo "[expo-builder] preflight ok: $dir"
