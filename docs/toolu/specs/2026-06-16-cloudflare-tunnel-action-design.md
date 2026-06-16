# Cloudflare Tunnel Action — Design

**Date:** 2026-06-16   **Status:** Approved (spec-review 2026-06-16: all 6 findings resolved — duplicate non-goal dropped, pid output rewording, tunnel-id extraction defined, crash-during-job failure mode added, image-path strategy captured for plan-time resolution, README troubleshooting scope expanded, verify-checksum default flipped to false with rationale)   **Author:** Falconiere   **Topic:** Publishable Docker GitHub Action that exposes workflow-runner ports to the public internet via Cloudflare Tunnels

## Problem

GitHub Actions runners cannot accept inbound traffic. Workflows that need to expose a local port to the internet — preview apps for visual review, webhook receivers for third-party CI callbacks, ephemeral test services for browser-automation suites — must currently install `cloudflared` themselves, manage its lifecycle around their own steps, and parse `trycloudflare.com` URLs out of stderr by hand. There is no first-class, marketplace-publishable GitHub Action that wraps `cloudflared`, surfaces the tunnel URL as a step output, and guarantees clean teardown on job failure or cancellation. Users re-implement this in every workflow.

This action ships two composable sub-actions (`start` + `stop`) that together provide a turnkey tunnel primitive matching the idiomatic GH Actions step model, plus a convenience `wait` step that blocks until the tunnel is reachable. Quick tunnels (no account, ephemeral `*.trycloudflare.com`) work out of the box; named tunnels (account-bound, persistent URL) activate when `TUNNEL_TOKEN` is provided.

## Non-Goals

1. **macOS / Windows runners** — v1 ships Linux only. `cloudflared` binary is downloaded per-OS in v2 if demand warrants.
2. **Tunnel creation / DNS management** — the action connects to an existing tunnel (quick auto-provisioned or pre-created via dashboard/`cloudflared tunnel create`). It does not call the Cloudflare API to create tunnels or DNS records beyond what `cloudflared` does itself.
3. **Multi-tunnel orchestration** — one tunnel per `start` invocation. Users wanting multiple tunnels run multiple `start` steps with distinct `NAME` inputs (each writes to its own tmpfile + outputs).
4. **Cloudflare Access / Zero Trust policies** — not configured by this action. Users wanting auth in front of their tunnel wire it up in the dashboard.
5. **Service-token issuance for named tunnels** — users provide their own `TUNNEL_TOKEN` (or `TUNNEL_TOKEN_FILE`); the action does not mint them.
6. **Tunnel metrics / observability** — beyond exit code and stderr surface, the action does not scrape `cloudflared` Prometheus endpoint or report connection events.
7. **Pre-built Docker image** — v1 builds from `Dockerfile` on each run. Pre-building and pushing to ghcr.io is a v2 optimization once build latency is measured.

## Architecture

**Docker container action, two sub-actions sharing one image, `bash` + `curl` + `jq` + `cloudflared`.**

Sub-action dispatch: each sub-action has its own `action.yml` (`start/action.yml`, `stop/action.yml`, `wait/action.yml`) but all reference `image: '../Dockerfile'` so a single image is built and reused. Entry-point script branched on `$0` / `argv[0]`.

### Lifecycle

```
┌─────────────────┐
│ actions/checkout│   (user's checkout, must come first per code-review action)
└────────┬────────┘
         │
┌────────▼────────┐   writes: /tmp/<NAME>-tunnel.pid, /tmp/<NAME>-tunnel.url (quick only)
│ tunnel/start    │──► outputs: tunnel-url, tunnel-id, tunnel-pid, tunnel-name
└────────┬────────┘
         │
┌────────▼────────┐
│ user's steps    │   run a server on $PORT, etc.
└────────┬────────┘
         │
┌────────▼────────┐
│ tunnel/wait     │   (optional) curl until URL responds 2xx (timeout: WAIT_TIMEOUT)
└────────┬────────┘
         │
┌────────▼────────┐   reads pid file → SIGTERM → SIGKILL after grace → pkill fallback
│ tunnel/stop     │──► if: always() baked into action.yml
└─────────────────┘
```

### Mode selection

- `TUNNEL_TOKEN` unset → quick tunnel: `cloudflared tunnel --no-autoupdate --url http://localhost:$PORT`
- `TUNNEL_TOKEN` set → named tunnel: `cloudflared tunnel --no-autoupdate run --token "$TUNNEL_TOKEN"`
  - Optional `TUNNEL_CONFIG` input writes `/etc/cloudflared/config.yml` for ingress routing (named mode only)

### URL discovery (quick mode)

`cloudflared` logs the URL to stderr once the tunnel is up, e.g.:
```
... INF https://<random-slug>.trycloudflare.com ...
```

`start` script:
1. Spawns `cloudflared` in background, redirects stdout/stderr to a log file
2. Tails the log file, regex-extracts `https://[\w-]+\.trycloudflare\.com`
3. Writes URL to `$NAME-tunnel.url` tmpfile + emits `tunnel-url` output
4. Bails with non-zero exit if URL not seen within `START_TIMEOUT` (default 30s)

### Cleanup safety

- `start` stores PID via shell's `$!` immediately after backgrounding; flushed to tmpfile on the next line so a crash between fork and write still leaves a killable process (caught by `pkill` fallback in `stop`)
- `stop` reads PID → `kill -TERM` → sleep 5 → `kill -KILL` if alive → `pkill -f cloudflared` as final fallback
- `stop` action.yml sets `if: always()` so it runs on job success, failure, and cancellation
- `stop` is idempotent: missing PID file → exit 0; tunnel already gone → exit 0

### Cloudflared install

- `CLOUDFLARED_VERSION` input (default: pinned in action.yml, currently `2024.12.2`)
- Downloaded at `start` time from `https://github.com/cloudflare/cloudflared/releases/download/<version>/cloudflared-linux-amd64`
- SHA256 verified against `checksums.txt` published in the same release (optional but cheap)
- Installed to `/usr/local/bin/cloudflared` (overwriting if present)
- Cache: not v1; revisit if download latency becomes a complaint

### Files and responsibilities

```
cloudflare-tunnel/
├── Dockerfile                      # Alpine + bash, curl, jq, ca-certificates
├── start/
│   └── action.yml                  # Inputs: name, port, tunnel-token, tunnel-config, cloudflared-version, start-timeout
├── stop/
│   └── action.yml                  # Inputs: name, stop-timeout. Runs with if: always()
├── wait/
│   └── action.yml                  # Inputs: url (or tunnel-url from start), wait-timeout, expected-status
├── src/
│   ├── lib.sh                      # Shared helpers: log, fail, slugify, regex-URL extraction, PID file resolution
│   ├── install-cloudflared.sh      # Download + sha256 verify + chmod +x
│   ├── start.sh                    # Install → spawn → wait for URL → emit outputs
│   ├── stop.sh                     # Read PID → SIGTERM → SIGKILL → pkill fallback
│   └── wait.sh                     # curl loop with backoff, exit on 2xx or timeout
└── __tests__/
    ├── helpers.bash                # Stub cloudflared binary + fixtures
    ├── start.bats                  # URL extraction, PID file write, mode dispatch, timeout
    ├── stop.bats                   # Kill sequence, pkill fallback, idempotence
    ├── wait.bats                   # Backoff, 2xx/4xx/5xx handling, timeout
    ├── install-cloudflared.bats    # Download URL composition, sha256 verification
    └── fixtures/
        ├── cloudflared-stderr-quick.log
        ├── cloudflared-stderr-named.log
        └── checksums.txt
```

### Test strategy

- **Unit (bats, hermetic):** `cloudflared` binary replaced by a stub script that prints recorded stderr to a controlled schedule. Verify URL regex, PID file contents, mode dispatch (token present → named invocation), timeout behavior, stop kill sequence, pkill fallback path, wait backoff math.
- **Integration (`.github/workflows/integration.yml`):** matrix over `ubuntu-latest` × `{quick, named}` × `{start+stop, start+wait+stop}`. Quick tunnel end-to-end fetches `${{ steps.start.outputs.tunnel-url }}` from a real trycloudflare.com URL and asserts 2xx. Named tunnel end-to-end uses a tunnel token stored as a repo secret (test account owned by Falconiere). Cleanup verified by asserting cloudflared not in `pgrep` after stop.

## Interfaces / Schema

### `start/action.yml`

```yaml
name: 'Cloudflare Tunnel — Start'
description: |
  Boots a Cloudflare Tunnel in the workflow job, exposing a local port
  (default 3000) to the public internet. Quick tunnels (no account, ephemeral
  trycloudflare.com URL) by default; set tunnel-token to use a named tunnel.
  Outputs the tunnel URL and PID for downstream steps and cleanup.
author: 'Falconiere'
branding:
  icon: 'cloud'
  color: 'orange'

inputs:
  name:
    description: 'Tunnel instance name. Used to namespace PID/URL tmpfiles and outputs when running multiple tunnels.'
    required: false
    default: 'default'
  port:
    description: 'Local port to expose (quick mode only).'
    required: false
    default: '3000'
  tunnel-token:
    description: 'Cloudflare Tunnel token (from dashboard or `cloudflared tunnel token`). When set, switches to named-tunnel mode.'
    required: false
    default: ''
  tunnel-config:
    description: 'Optional path to a cloudflared config.yml (named mode only). Enables custom ingress rules.'
    required: false
    default: ''
  cloudflared-version:
    description: 'cloudflared release version to download (tag name from cloudflare/cloudflared releases).'
    required: false
    default: '2024.12.2'
  verify-checksum:
    description: 'Verify cloudflared binary SHA256 against the release checksums.txt before installing. Defaults to false because the checksums.txt format is brittle (variable whitespace, optional BSD `*` prefix); opt in when you control the parser or have a pinned version known to parse cleanly.'
    required: false
    default: 'false'
  start-timeout:
    description: 'Seconds to wait for the tunnel URL to appear in cloudflared output before failing.'
    required: false
    default: '30'

outputs:
  tunnel-url:
    description: 'Public URL of the tunnel (quick mode only; empty in named mode unless ingress exposes a hostname).'
  tunnel-id:
    description: 'Tunnel ID (named mode only). Extracted by parsing the UUID from cloudflared stderr line matching `Registered tunnel connection.*<uuid>`, falling back to `cloudflared tunnel info <id-from-stdout>` after a 2s grace.'
  tunnel-pid:
    description: 'PID of the cloudflared process. Diagnostic only — stop reads its own tmpfile keyed by name, not this output.'
  tunnel-name:
    description: 'Echo of the name input (slugified), for downstream step convenience.'

runs:
  using: 'docker'
  image: '../Dockerfile'
  args:
    - 'start'
  env:
    INPUT_NAME: ${{ inputs.name }}
    INPUT_PORT: ${{ inputs.port }}
    INPUT_TUNNEL_TOKEN: ${{ inputs.tunnel-token }}
    INPUT_TUNNEL_CONFIG: ${{ inputs.tunnel-config }}
    INPUT_CLOUDFLARED_VERSION: ${{ inputs.cloudflared-version }}
    INPUT_VERIFY_CHECKSUM: ${{ inputs.verify-checksum }}
    INPUT_START_TIMEOUT: ${{ inputs.start-timeout }}
```

### `stop/action.yml`

```yaml
name: 'Cloudflare Tunnel — Stop'
description: |
  Stops a Cloudflare Tunnel started by the matching tunnel/start step.
  Idempotent and safe to run on job failure or cancellation.
author: 'Falconiere'
branding:
  icon: 'cloud-off'
  color: 'gray'

inputs:
  name:
    description: 'Tunnel instance name to stop (must match the start step).'
    required: false
    default: 'default'
  stop-timeout:
    description: 'Seconds to wait between SIGTERM and SIGKILL.'
    required: false
    default: '5'

runs:
  using: 'docker'
  image: '../Dockerfile'
  args:
    - 'stop'
  env:
    INPUT_NAME: ${{ inputs.name }}
    INPUT_STOP_TIMEOUT: ${{ inputs.stop-timeout }}
```

The `if: always()` semantics live in the **caller's** workflow (stop step is the last step, conditional on `${{ always() }}`). This matches the `appleboy/cloudflared-action` convention and avoids surprising "step didn't run because it had no `if:`" failures.

### `wait/action.yml`

```yaml
name: 'Cloudflare Tunnel — Wait'
description: |
  Blocks until a tunnel URL responds with an expected HTTP status (default 2xx).
  Useful after start to ensure the tunnel is reachable before downstream steps
  that hit the URL.
author: 'Falconiere'
branding:
  icon: 'hourglass'
  color: 'blue'

inputs:
  url:
    description: 'URL to poll. Typically ${{ steps.start.outputs.tunnel-url }}.'
    required: true
  wait-timeout:
    description: 'Seconds to wait before failing.'
    required: false
    default: '60'
  expected-status:
    description: 'HTTP status code (or prefix "2"/"3"/"4"/"5") that counts as success.'
    required: false
    default: '2'

runs:
  using: 'docker'
  image: '../Dockerfile'
  args:
    - 'wait'
  env:
    INPUT_URL: ${{ inputs.url }}
    INPUT_WAIT_TIMEOUT: ${{ inputs.wait-timeout }}
    INPUT_EXPECTED_STATUS: ${{ inputs.expected-status }}
```

### Entrypoint dispatch

`src/entrypoint.sh` (default `ENTRYPOINT` of Dockerfile) routes by `$1`:

```bash
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
case "${1:-}" in
    start) exec bash "$SCRIPT_DIR/start.sh" ;;
    stop)  exec bash "$SCRIPT_DIR/stop.sh" ;;
    wait)  exec bash "$SCRIPT_DIR/wait.sh" ;;
    *)     echo "usage: $0 {start|stop|wait}" >&2; exit 64 ;;
esac
```

### Output file conventions

- PID: `/tmp/cf-tunnel-<NAME>.pid`
- URL: `/tmp/cf-tunnel-<NAME>.url` (quick mode only)
- Log: `/tmp/cf-tunnel-<NAME>.log`

`NAME` slugified (`s/[^a-zA-Z0-9-]/-/g`) to keep filenames safe.

### Error behavior

- `start`: missing required env → exit 1 with message; download/checksum failure → exit 1; URL not seen within `START_TIMEOUT` → kill cloudflared + exit 1
- `stop`: missing PID file → exit 0 (already stopped); kill fails → fall through to pkill; pkill finds nothing → exit 0
- `wait`: timeout → exit 1; URL never resolves → exit 1
- **Tunnel crash between start and user steps:** cloudflared may die (network blip, account quota, killed by OOM). `tunnel-url` output goes stale; downstream curls fail. Mitigations: (a) `start` does a single best-effort HTTP probe to the URL before exiting (non-fatal — failures warn but start still succeeds); (b) `wait` step at the top of the user's section re-establishes reachability before they rely on it; (c) troubleshooting section in README documents `cloudflared` log inspection via `/tmp/cf-tunnel-<NAME>.log`.

### Image path strategy

Sub-actions reference `image: '../Dockerfile'` in their `action.yml`. Resolved at plan time — if GH Actions rejects the parent-dir path, fall back to three thin Dockerfiles (`start/Dockerfile`, `stop/Dockerfile`, `wait/Dockerfile`) each `FROM alpine` and `COPY src/entrypoint.sh /action/`. Both approaches share the same Alpine base + tooling layer; trade-off is image-build time vs action.yml portability.

### Slugify behavior

User-supplied `name` is slugified via `s/[^a-zA-Z0-9-]/-/g` before use as tmpfile prefix and `tunnel-name` output. Empty string is treated as unset → default `'default'`.

## Acceptance Criteria

1. **Quick tunnel start** — Given `name: 'preview'` and `port: 3000`, `start` exits 0 within `start-timeout` (default 30s) and emits a `tunnel-url` output matching `^https://[\w-]+\.trycloudflare\.com$`.
2. **PID file written** — After start, `/tmp/cf-tunnel-preview.pid` exists and contains a PID that is alive (`kill -0` returns 0).
3. **Named tunnel mode dispatch** — Given `tunnel-token: '...'`, `start` invokes `cloudflared tunnel --no-autoupdate run --token '...'` (no `--url`, no `--port`). Verified via stubbed cloudflared arg inspection in bats.
4. **Custom config wiring** — Given `tunnel-config: './my-config.yml'` in named mode, `start` writes the file to `/etc/cloudflared/config.yml` and passes `--config /etc/cloudflared/config.yml` to cloudflared.
5. **Version pinning** — Given `cloudflared-version: '2024.11.1'`, `install-cloudflared.sh` downloads from `https://github.com/cloudflare/cloudflared/releases/download/2024.11.1/cloudflared-linux-amd64`.
6. **Checksum verification** — With `verify-checksum: 'true'`, a corrupted binary fails install with a non-zero exit and a message naming the expected vs actual SHA256.
7. **Stop sends SIGTERM then SIGKILL** — Stubbed cloudflared ignores SIGTERM; `stop` sends SIGKILL after `stop-timeout` (default 5s).
8. **Stop pkill fallback** — With PID file missing, `stop` runs `pkill -f cloudflared` and exits 0.
9. **Stop is idempotent** — Calling stop twice in a row both exit 0; second call sees missing PID file and skips.
10. **Wait success path** — Given a URL that returns 200 after 3 polls, `wait` exits 0 within `wait-timeout`.
11. **Wait timeout path** — Given a URL that never returns 2xx, `wait` exits 1 after `wait-timeout` and prints last-seen status + URL.
12. **Wait status filter** — Given `expected-status: '3'`, a URL returning 302 succeeds; 200 fails (out of filter).
13. **Multiple concurrent tunnels** — Two `start` steps with distinct `name` values write distinct PID/URL files; stop on one does not kill the other.
14. **Caller-side always()** — Workflow with `start` + failing step + `stop` (with `if: always()`) runs `stop` even when the middle step exits non-zero. Verified by integration test.
15. **Real quick tunnel E2E** — Integration workflow boots `python3 -m http.server 3000` + `start` + `wait` + `curl $URL` from a separate runner context, asserts 200; stop cleans up so post-job `pgrep cloudflared` is empty.
16. **Real named tunnel E2E** — Integration workflow uses a test-account tunnel token; `start` succeeds; `curl $HOSTNAME` returns 200 against the named tunnel's ingress.
17. **Image reuse** — All three sub-actions run from the same built Docker image (single `Dockerfile`, sub-action `action.yml` files reference `image: '../Dockerfile'`). Verified by inspecting `docker images` after one matrix run.
18. **Marketplace readiness** — Each `action.yml` passes `npx @action-validator/cli`. Names, descriptions, branding icons all valid.
19. **Docs in sync** — README quickstart shows 4-step workflow (checkout → start → user steps → stop with `if: always()`); inputs tables match action.yml for all three sub-actions; outputs section lists all four (`tunnel-url`, `tunnel-id`, `tunnel-pid`, `tunnel-name`); **troubleshooting section** covers: cloudflared download blocked (corporate proxy / IP-allowlist needed for `github.com` asset CDN), trycloudflare URL regex timeout (version regression — set `cloudflared-version` explicitly), stale PID file across matrix (`name` collision — use distinct names per matrix leg), named-tunnel `TUNNEL_TOKEN` secret hygiene (must be a secret, never echoed, scoped to one Cloudflare account).
20. **size discipline** — No script exceeds 300 lines (code only, blanks/comments excluded). `start.sh` likely the biggest; split `install-cloudflared.sh` out if it grows.

## Open Questions

1. **Quick-tunnel URL collision on parallel jobs** — trycloudflare.com slugs are random but the same job retrying could theoretically collide. Not a problem in practice (slug entropy is high), but worth a note in README. *Owner: Falconiere — document, do not solve.*
2. **Checksum verification robustness** — `checksums.txt` from cloudflared releases is plaintext with one line per binary. Parsing is brittle (variable whitespace, optional `*` prefix on BSD sums). May need a one-off sha256 manifest per binary. *Owner: Falconiere — implement straight-line `awk` parser; fall back to skipping verification with a warning if parse fails.*
3. **Self-hosted runner support** — action assumes outbound network to download cloudflared. Air-gapped self-hosted runners will fail. Worth a `skip-install: 'true'` input that lets users pre-stage the binary? *Owner: Falconiere — defer to v2 unless a user asks.*
4. **wait/curl HTTP method** — v1 uses `curl -fsS -o /dev/null`. Some servers only respond to HEAD or specific paths. Should `wait` accept a `path` and `method` input? *Owner: Falconiere — defer; users wanting custom probes can write their own step.*
5. **`tunnel-name` output on quick mode** — quick tunnels auto-name themselves (`<random>-user` or similar). Should `start` surface cloudflared's chosen name as `tunnel-name` even in quick mode, or echo only the user-supplied `name`? *Owner: Falconiere — echo user-supplied `name` for v1 (simpler contract); expose cloudflared's name later if anyone asks.*
6. **Integration test flakiness on trycloudflare.com** — quick-tunnel E2E depends on trycloudflare.com being up. If it flakes, integration matrix fails. *Owner: Falconiere — retry once on 5xx, mark flaky-job in workflow annotations; document in CONTRIBUTING.*
