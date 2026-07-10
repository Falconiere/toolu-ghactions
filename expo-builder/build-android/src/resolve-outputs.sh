#!/usr/bin/env bash
# resolve-outputs.sh — locate built APK/AAB under android/app/build/outputs/ and
# resolve the app version via `npx expo config` (handles app.json AND
# app.config.js/ts); writes apk-path / aab-path / app-version to GITHUB_OUTPUT.
set -euo pipefail

dir="${EXPO_BUILDER_WORKING_DIR:-.}"
format="${EXPO_BUILDER_FORMAT:-apk}"
cd "$dir"

find_artifact() {
  local root="$1" ext="$2" found
  found="$(find "$root" -type f -name "*.$ext" 2>/dev/null | sort | head -n 1)"
  if [ -z "$found" ]; then
    echo "::error::no .$ext found under $root — the Gradle build did not produce it" >&2
    return 1
  fi
  printf '%s\n' "$found"
}

apk_path=""
aab_path=""
case "$format" in
  apk) apk_path="$(find_artifact "$PWD/android/app/build/outputs/apk/release" apk)" ;;
  aab) aab_path="$(find_artifact "$PWD/android/app/build/outputs/bundle/release" aab)" ;;
  both)
    apk_path="$(find_artifact "$PWD/android/app/build/outputs/apk/release" apk)"
    aab_path="$(find_artifact "$PWD/android/app/build/outputs/bundle/release" aab)"
    ;;
  *)
    echo "::error::invalid format '$format' (expected apk | aab | both)"
    exit 1
    ;;
esac

app_version="$(npx expo config --json --type public \
  | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version ?? ""')"
if [ -z "$app_version" ]; then
  echo "::error::could not resolve app version from 'npx expo config --json --type public'"
  exit 1
fi

{
  echo "apk-path=$apk_path"
  echo "aab-path=$aab_path"
  echo "app-version=$app_version"
} >>"$GITHUB_OUTPUT"
echo "[expo-builder] outputs: apk='$apk_path' aab='$aab_path' version='$app_version'"
