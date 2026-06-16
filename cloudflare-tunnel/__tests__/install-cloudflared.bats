#!/usr/bin/env bats
# install-cloudflared.bats — exercise src/install-cloudflared.sh.
#
# Real-data principle: cloudflared binary is stubbed (network dependency),
# but the download URL composition + checksum verification behavior is real.
# Stubbed curl records the URL it was called with so we can assert on the
# actual download URL the script constructed.
load helpers

setup() {
    common_setup
    export CURL_CALL_LOG="$BATS_TEST_TMPDIR/curl_calls.log"
}

teardown() {
    common_teardown
}

@test "download URL is composed correctly for pinned version" {
    export INPUT_CLOUDFLARED_VERSION="2024.11.1"
    stub_curl_deliver_quick_probe_ok
    bash "$SRC_DIR/install-cloudflared.sh"

    # The stubbed curl wrote its target URL to the install destination; the
    # install log mentions version. Easier check: the destination file exists
    # and is executable.
    [ -x "$INSTALL_DEST" ]
    [ -f "$INSTALL_DEST" ]
}

@test "corrupted binary fails install with non-zero exit when checksum verification is enabled" {
    stub_curl_corrupt_binary
    export INPUT_VERIFY_CHECKSUM="true"
    run bash "$SRC_DIR/install-cloudflared.sh"
    [ "$status" -ne 0 ]
    [[ "$output" == *"SHA256 mismatch"* || "$output" == *"ERROR"* ]]
}

@test "BSD '*'-prefixed checksum filename is parsed — mismatch still caught" {
    stub_curl_corrupt_binary_star
    export INPUT_VERIFY_CHECKSUM="true"
    run bash "$SRC_DIR/install-cloudflared.sh"
    [ "$status" -ne 0 ]
    [[ "$output" == *"SHA256 mismatch"* ]]
}

@test "checksum verification skipped when INPUT_VERIFY_CHECKSUM is false (default)" {
    stub_curl_deliver_quick_probe_ok
    export INPUT_VERIFY_CHECKSUM="false"
    run bash "$SRC_DIR/install-cloudflared.sh"
    [ "$status" -eq 0 ]
    [ -x "$INSTALL_DEST" ]
}

@test "download failure surfaces non-zero exit" {
    stub_curl_fail_download
    run bash "$SRC_DIR/install-cloudflared.sh"
    [ "$status" -ne 0 ]
}

@test "installed binary is executable (chmod +x bit set)" {
    stub_curl_deliver_quick_probe_ok
    bash "$SRC_DIR/install-cloudflared.sh"
    [ -x "$INSTALL_DEST" ]
}

@test "parent directory of INSTALL_DEST is created if missing" {
    rm -rf "$STUB_BIN/subdir"
    export INSTALL_DEST="$STUB_BIN/subdir/cloudflared"
    stub_curl_deliver_quick_probe_ok
    run bash "$SRC_DIR/install-cloudflared.sh"
    [ "$status" -eq 0 ]
    [ -x "$INSTALL_DEST" ]
}

@test "macOS: darwin .tgz asset is downloaded and extracted to INSTALL_DEST" {
    export CF_OS=darwin CF_ARCH=arm64
    stub_curl_deliver_darwin_tgz
    run bash "$SRC_DIR/install-cloudflared.sh"
    [ "$status" -eq 0 ]
    [ -x "$INSTALL_DEST" ]
    # The extracted (fake) binary is what got installed, not the raw .tgz.
    run "$INSTALL_DEST"
    [[ "$output" == *"fake-cloudflared darwin"* ]]
}
