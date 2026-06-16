#!/usr/bin/env bats
# stop.bats — exercise src/stop.sh: idempotence, PID cleanup, pkill fallback.
load helpers

setup() { common_setup; }
teardown() { common_teardown; }

@test "live PID: kill -TERM accepts, stop succeeds, PID file removed" {
    # Spawn a bash process that sleeps and accepts SIGTERM.
    bash -c 'sleep 30' &
    PID=$!
    echo "$PID" > /tmp/cf-tunnel-default.pid
    stub_pkill_recording
    export INPUT_STOP_TIMEOUT=1
    run bash "$SRC_DIR/stop.sh"
    [ "$status" -eq 0 ]
    [ ! -f /tmp/cf-tunnel-default.pid ]
    # The sleep process should be dead.
    ! kill -0 "$PID" 2>/dev/null
    rm -f /tmp/cf-tunnel-default.pid
}

@test "pkill fallback: PID file missing triggers pkill + exits 0" {
    stub_pkill_recording
    rm -f /tmp/cf-tunnel-default.pid
    run bash "$SRC_DIR/stop.sh"
    [ "$status" -eq 0 ]
    [[ "$output" == *"No PID file"* ]]
    grep -q "pkill.*cloudflared" "$BATS_TEST_TMPDIR/pkill.log"
}

@test "idempotence: calling stop twice both exit 0" {
    stub_pkill_recording
    rm -f /tmp/cf-tunnel-default.pid
    run bash "$SRC_DIR/stop.sh"
    [ "$status" -eq 0 ]
    run bash "$SRC_DIR/stop.sh"
    [ "$status" -eq 0 ]
}

@test "dead PID in file: removes stale file and exits 0" {
    stub_pkill_recording
    echo 99999 > /tmp/cf-tunnel-default.pid
    run bash "$SRC_DIR/stop.sh"
    [ "$status" -eq 0 ]
    [[ "$output" == *"not alive"* ]]
    [ ! -f /tmp/cf-tunnel-default.pid ]
}

@test "AC #7: SIGTERM-immune process: stop escalates to SIGKILL after stop-timeout" {
    # Spawn a bash process that ignores SIGTERM. `exec sleep 60` replaces
    # bash with sleep so SIGKILL on the PID kills the sleep too (no orphan).
    setsid bash -c 'trap "" TERM; exec sleep 60' >/dev/null 2>&1 &
    PID=$!
    # Give the trap a moment to register.
    sleep 0.1
    echo "$PID" > /tmp/cf-tunnel-default.pid
    stub_pkill_recording
    export INPUT_STOP_TIMEOUT=1
    run bash "$SRC_DIR/stop.sh"
    [ "$status" -eq 0 ]
    # Process must be dead — SIGKILL worked even though SIGTERM was ignored
    # (setsid ensures the process is in its own session so SIGKILL on bash
    # also kills the underlying sleep child).
    ! kill -0 "$PID" 2>/dev/null
    [ ! -f /tmp/cf-tunnel-default.pid ]
    # Final safety: ensure no orphan sleep survives past the test.
    kill -KILL "$PID" 2>/dev/null || true
    rm -f /tmp/cf-tunnel-default.pid
}
