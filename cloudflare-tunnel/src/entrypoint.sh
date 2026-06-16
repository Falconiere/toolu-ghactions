#!/usr/bin/env bash
# entrypoint.sh — dispatch to the right sub-action script based on $1.
#
# Wired as the Docker image ENTRYPOINT (exec form). action.yml `runs.args`
# supplies the sub-action name which becomes $1 here.
#
# Dispatch:
#   start  → start.sh   (boot tunnel, emit outputs)
#   stop   → stop.sh    (terminate tunnel, idempotent)
#   wait   → wait.sh    (poll tunnel URL until ready)
#
# Exit 64 (EX_USAGE) on unknown sub-action.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

case "${1:-}" in
    start) exec bash "$SCRIPT_DIR/start.sh" ;;
    stop)  exec bash "$SCRIPT_DIR/stop.sh" ;;
    wait)  exec bash "$SCRIPT_DIR/wait.sh" ;;
    *)
        printf 'usage: %s {start|stop|wait}\n' "$0" >&2
        exit 64
        ;;
esac
