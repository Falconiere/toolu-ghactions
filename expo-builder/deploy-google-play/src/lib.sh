#!/usr/bin/env bash
# lib.sh — helpers shared by the deploy-google-play scripts (sourced, not run).

# BSD (macOS) base64 decodes with -D on older systems, -d elsewhere. Probe with
# a known base64 string so the test exercises decode directly.
b64_decode_flag() {
  if printf 'eA==' | base64 -d >/dev/null 2>&1; then
    printf -- '-d'
  else
    printf -- '-D'
  fi
}
