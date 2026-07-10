#!/usr/bin/env bash
# prebuild.sh — run `expo prebuild` per mode: auto (skip when android/ exists),
# always, never. Expo output streams through unmodified; failures propagate.
set -euo pipefail

dir="${EXPO_BUILDER_WORKING_DIR:-.}"
mode="${EXPO_BUILDER_PREBUILD:-auto}"
cd "$dir"

case "$mode" in
  auto)
    if [ -d android ]; then
      echo "[expo-builder] skipping prebuild (android/ already exists)"
      exit 0
    fi
    ;;
  always) ;;
  never)
    if [ ! -d android ]; then
      echo "::error::prebuild is 'never' but '$dir' has no android/ directory — nothing to build"
      exit 1
    fi
    echo "[expo-builder] skipping prebuild (mode: never)"
    exit 0
    ;;
  *)
    echo "::error::invalid prebuild mode '$mode' (expected auto | always | never)"
    exit 1
    ;;
esac

args=(--platform android)
if [ -n "${EXPO_BUILDER_PREBUILD_ARGS:-}" ]; then
  # Intentional word-splitting of the user-supplied extra args.
  read -r -a extra <<<"$EXPO_BUILDER_PREBUILD_ARGS"
  args+=("${extra[@]}")
fi

echo "[expo-builder] npx expo prebuild ${args[*]}"
npx expo prebuild "${args[@]}"
