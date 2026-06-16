# Cloudflare Tunnel Action — Build Plan

**Date:** 2026-06-16   **Spec:** `docs/toolu/specs/2026-06-16-cloudflare-tunnel-action-design.md`

## Context

Ship a publishable Docker GH Action that boots a Cloudflare Tunnel in a workflow job, exposes the URL as a step output, and guarantees clean teardown. Three sub-actions (`start`, `stop`, `wait`) under `cloudflare-tunnel/`. Quick tunnels (no account) work out of the box; named tunnels activate when `TUNNEL_TOKEN` is set. Fills the gap of "how do I expose a runner port to the internet?" that every visual-review / webhook-receiver workflow currently reinvents.

## Approach

Mirror the sibling `code-review/` action's **GHCR pre-built image pattern** (matches main's state after rebase 2026-06-16): each top-level action (`code-review`, `cloudflare-tunnel`) gets its own Docker image built once per release via `release.yml`'s `publish-image` job and pushed to `ghcr.io/falconiere/toolu-ghactions/<action>:<tag>`. Sub-actions (`start`/`stop`/`wait` for tunnel) reference the same published image with different `runs.args`. The root `action.yml` is the code-review entry (existing); tunnel action is referenced via sub-path: `falconiere/toolu-ghactions/cloudflare-tunnel/start@v1`.

**Multi-action publish layout:**
```
ghcr.io/falconiere/toolu-ghactions/code-review:v1         (existing)
ghcr.io/falconiere/toolu-ghactions/cloudflare-tunnel:v1  (new)
```

Single repo version (release-please `simple` release-type, unchanged). Both actions ship on every release.

**cloudflared at runtime, not in image (intentional):** image stays small + `CLOUDFLARED_VERSION` input stays flexible. Trade-off: each `start` run hits github.com releases CDN (~5s). Spec AC #17 covers image reuse (single published image for the action); cloudflared download latency is the user's cost for version flexibility.

**Test data principle:** cloudflared binary is stubbed in bats (unavoidable — real binary needs network + auth + daemon). Stub replays recorded real cloudflared stderr from `__tests__/fixtures/cloudflared-stderr-{quick,named}.log`. Stderr flowing through start.sh under test is real cloudflared output, not fabricated. No mock finding data.

## Steps (machine-readable)

```json
[
  {
    "id": "01-scaffold",
    "title": "Scaffold cloudflare-tunnel/{src,start,stop,wait,__tests__/fixtures} and add cloudflare-tunnel/README.md placeholder",
    "check": "test -d cloudflare-tunnel/src && test -d cloudflare-tunnel/start && test -d cloudflare-tunnel/stop && test -d cloudflare-tunnel/wait && test -d cloudflare-tunnel/__tests__/fixtures && test -f cloudflare-tunnel/README.md"
  },
  {
    "id": "02-dockerfile",
    "title": "Write cloudflare-tunnel/Dockerfile (alpine:3.21 + bash, jq, curl, ca-certificates, bash-completion; COPY src/ /action/src/; ENTRYPOINT [\"bash\", \"/action/src/entrypoint.sh\"] exec-form so action.yml runs.args appends as CMD args)",
    "check": "test -f cloudflare-tunnel/Dockerfile && grep -q '^FROM alpine:3.21' cloudflare-tunnel/Dockerfile && grep -q 'COPY src/ /action/src/' cloudflare-tunnel/Dockerfile && grep -q 'ENTRYPOINT \\[\"bash\", \"/action/src/entrypoint.sh\"\\]' cloudflare-tunnel/Dockerfile"
  },
  {
    "id": "03-lib",
    "title": "Write src/lib.sh with slugify(), log(), fail(), pid_path(), url_path(), log_path(), tunnel_url_regex, tunnel_id_regex (sourced by start/stop/wait)",
    "check": "test -f cloudflare-tunnel/src/lib.sh && bash -n cloudflare-tunnel/src/lib.sh && grep -q 'slugify' cloudflare-tunnel/src/lib.sh && grep -q 'pid_path' cloudflare-tunnel/src/lib.sh && grep -q 'trycloudflare.com' cloudflare-tunnel/src/lib.sh"
  },
  {
    "id": "04-install",
    "title": "Write src/install-cloudflared.sh: download cloudflared from github releases at $INPUT_CLOUDFLARED_VERSION, chmod +x, optional sha256 verification against checksums.txt (gated on INPUT_VERIFY_CHECKSUM)",
    "check": "test -f cloudflare-tunnel/src/install-cloudflared.sh && bash -n cloudflare-tunnel/src/install-cloudflared.sh && grep -q 'github.com/${REPO}/releases/download' cloudflare-tunnel/src/install-cloudflared.sh && grep -q 'sha256sum' cloudflare-tunnel/src/install-cloudflared.sh"
  },
  {
    "id": "05-start",
    "title": "Write src/start.sh: source lib.sh → call install-cloudflared.sh → mode dispatch (TUNNEL_TOKEN empty → quick with --url; else named with --token) → spawn cloudflared in background → tail log until tunnel_url_regex matches → write PID/URL files → best-effort HTTP probe → emit tunnel-url/tunnel-id/tunnel-pid/tunnel-name outputs → exit 1 if URL not seen within INPUT_START_TIMEOUT",
    "check": "test -f cloudflare-tunnel/src/start.sh && bash -n cloudflare-tunnel/src/start.sh && grep -q 'GITHUB_OUTPUT' cloudflare-tunnel/src/start.sh && grep -q 'tunnel-url' cloudflare-tunnel/src/start.sh && grep -q 'INPUT_START_TIMEOUT' cloudflare-tunnel/src/start.sh"
  },
  {
    "id": "06-stop",
    "title": "Write src/stop.sh: source lib.sh → read PID file → kill -TERM → sleep INPUT_STOP_TIMEOUT → kill -KILL if alive → pkill -f cloudflared as fallback → exit 0 on missing PID file (idempotent)",
    "check": "test -f cloudflare-tunnel/src/stop.sh && bash -n cloudflare-tunnel/src/stop.sh && grep -q 'pkill' cloudflare-tunnel/src/stop.sh && grep -q 'SIGTERM' cloudflare-tunnel/src/stop.sh"
  },
  {
    "id": "07-wait",
    "title": "Write src/wait.sh: source lib.sh → curl -fsS -o /dev/null INPUT_URL in a loop with exponential backoff → match status against INPUT_EXPECTED_STATUS prefix → exit 0 on match, exit 1 after INPUT_WAIT_TIMEOUT",
    "check": "test -f cloudflare-tunnel/src/wait.sh && bash -n cloudflare-tunnel/src/wait.sh && grep -q 'curl' cloudflare-tunnel/src/wait.sh && grep -q 'WAIT_TIMEOUT' cloudflare-tunnel/src/wait.sh"
  },
  {
    "id": "08-entrypoint",
    "title": "Write src/entrypoint.sh with `set -euo pipefail` and case $1 in start|stop|wait exec corresponding script; else exit 64 (EX_USAGE)",
    "check": "test -f cloudflare-tunnel/src/entrypoint.sh && bash -n cloudflare-tunnel/src/entrypoint.sh && grep -q '^set -euo pipefail' cloudflare-tunnel/src/entrypoint.sh && grep -q 'start' cloudflare-tunnel/src/entrypoint.sh && grep -q 'stop' cloudflare-tunnel/src/entrypoint.sh && grep -q 'wait' cloudflare-tunnel/src/entrypoint.sh"
  },
  {
    "id": "09-action-yml",
    "title": "Write start/action.yml, stop/action.yml, wait/action.yml per spec — rebranded as 'Toolu Cloudflare Tunnel — Start/Stop/Wait', image: docker://ghcr.io/falconiere/toolu-ghactions/cloudflare-tunnel:v1 (matches main's pre-built-GHCR pattern), runs.args dispatcher (start|stop|wait), env mapping for all inputs",
    "check": "npx --yes @action-validator/cli cloudflare-tunnel/start/action.yml && npx --yes @action-validator/cli cloudflare-tunnel/stop/action.yml && npx --yes @action-validator/cli cloudflare-tunnel/wait/action.yml && grep -q 'ghcr.io/falconiere/toolu-ghactions/cloudflare-tunnel:v1' cloudflare-tunnel/start/action.yml && grep -q \"name: 'Toolu Cloudflare Tunnel — Start'\" cloudflare-tunnel/start/action.yml && grep -q \"name: 'Toolu Cloudflare Tunnel — Stop'\" cloudflare-tunnel/stop/action.yml && grep -q \"name: 'Toolu Cloudflare Tunnel — Wait'\" cloudflare-tunnel/wait/action.yml"
  },
  {
    "id": "09b-release-workflow",
    "title": "Add publish-cloudflare-tunnel job to .github/workflows/release.yml — convert publish-image into matrix over [code-review, cloudflare-tunnel]; context: ./${{ matrix.action }}, file: ./${{ matrix.action }}/Dockerfile, IMAGE env set to ghcr.io/${{ github.repository_owner }}/toolu-ghactions/${{ matrix.action }}; tags stay :${{ tag_name }}, :v${{ major }}, :latest (image path distinguishes the two)",
    "check": "grep -q 'cloudflare-tunnel' .github/workflows/release.yml && grep -q 'matrix.action' .github/workflows/release.yml && grep -q 'action: \\[code-review, cloudflare-tunnel\\]' .github/workflows/release.yml && yq .github/workflows/release.yml >/dev/null"
  },
  {
    "id": "09c-tests-workflow",
    "title": "Update .github/workflows/tests.yml to add tunnel-action coverage — new jobs: tunnel-test (bats cloudflare-tunnel/__tests__/*.bats), tunnel-lint (shellcheck cloudflare-tunnel/src/*.sh + action-validator on each tunnel action.yml), tunnel-build (docker build -t cloudflare-tunnel-action:test cloudflare-tunnel/)",
    "check": "grep -q 'cloudflare-tunnel/__tests__' .github/workflows/tests.yml && grep -q 'cloudflare-tunnel/src' .github/workflows/tests.yml && grep -q 'cloudflare-tunnel/start/action.yml' .github/workflows/tests.yml && grep -q 'cloudflare-tunnel/stop/action.yml' .github/workflows/tests.yml && grep -q 'cloudflare-tunnel/wait/action.yml' .github/workflows/tests.yml && yq .github/workflows/tests.yml >/dev/null"
  },
  {
    "id": "10-fixtures",
    "title": "Add __tests__/fixtures/{cloudflared-stderr-quick.log,cloudflared-stderr-named.log,checksums.txt} and __tests__/helpers.bash (PATH stub for cloudflared, tmpdir setup/teardown)",
    "check": "test -f cloudflare-tunnel/__tests__/helpers.bash && test -f cloudflare-tunnel/__tests__/fixtures/cloudflared-stderr-quick.log && test -f cloudflare-tunnel/__tests__/fixtures/cloudflared-stderr-named.log && grep -q 'trycloudflare.com' cloudflare-tunnel/__tests__/fixtures/cloudflared-stderr-quick.log"
  },
  {
    "id": "11-bats-install",
    "title": "Write __tests__/install-cloudflared.bats: download URL composition (AC #5), corrupted binary → non-zero exit + message naming expected vs actual SHA256 (AC #6), chmod +x bit set; stubbed curl replays a corrupted binary from fixtures/",
    "check": "grep -q 'corrupted' cloudflare-tunnel/__tests__/install-cloudflared.bats && bats cloudflare-tunnel/__tests__/install-cloudflared.bats"
  },
  {
    "id": "12-bats-start",
    "title": "Write __tests__/start.bats: quick URL extraction (AC #1, replays cloudflared-stderr-quick.log), PID file (AC #2), named mode arg dispatch (AC #3), config wiring (AC #4), timeout exit (AC #1 negative), best-effort probe non-fatal; stubbed cloudflared binary replays recorded stderr from fixtures/",
    "check": "bats cloudflare-tunnel/__tests__/start.bats"
  },
  {
    "id": "13-bats-stop",
    "title": "Write __tests__/stop.bats: SIGTERM→SIGKILL escalation (AC #7), pkill fallback (AC #8), idempotence (AC #9), distinct-name non-interference (AC #13); uses fixture-generated fake PID file + stub pkill to verify the sequence without real signals",
    "check": "bats cloudflare-tunnel/__tests__/stop.bats"
  },
  {
    "id": "14-bats-wait",
    "title": "Write __tests__/wait.bats: success path (AC #10, replays real curl response from fixtures), timeout (AC #11), status filter 2xx/3xx (AC #12); stubbed curl returns recorded responses with controlled timing",
    "check": "bats cloudflare-tunnel/__tests__/wait.bats"
  },
  {
    "id": "15-integration",
    "title": "Write .github/workflows/integration.yml: matrix ubuntu-latest × {quick,named} × {start-only, start+wait+stop} with python3 -m http.server 3000 backing service and curl-from-second-runner probe (AC #14, #15, #16)",
    "check": "test -f .github/workflows/integration.yml && yq .github/workflows/integration.yml >/dev/null"
  },
  {
    "id": "16-readme-action",
    "title": "Write cloudflare-tunnel/README.md per spec AC #19: quickstart 4-step YAML using sub-path refs (falconiere/toolu-ghactions/cloudflare-tunnel/start@v1, /stop@v1), inputs tables for all three sub-actions, outputs list, troubleshooting section (proxy/CDN block, regex timeout, PID stale across matrix, token hygiene)",
    "check": "grep -q 'quickstart\\|Quick start\\|Quick Start' cloudflare-tunnel/README.md && grep -q 'tunnel-url\\|tunnel_url' cloudflare-tunnel/README.md && grep -q 'Troubleshooting\\|troubleshooting' cloudflare-tunnel/README.md && grep -q 'if: always' cloudflare-tunnel/README.md && grep -q 'falconiere/toolu-ghactions/cloudflare-tunnel/start' cloudflare-tunnel/README.md && grep -q 'falconiere/toolu-ghactions/cloudflare-tunnel/stop' cloudflare-tunnel/README.md"
  },
  {
    "id": "17-root-readme",
    "title": "Update root README.md to mention cloudflare-tunnel alongside code-review in the actions list and add a one-line description for it",
    "check": "grep -q 'cloudflare-tunnel\\|tunnel/' README.md && grep -q 'code-review' README.md"
  },
  {
    "id": "18-quality-gate",
    "title": "Run full quality gate: shellcheck clean on all cloudflare-tunnel/src/*.sh, action-validator clean on all tunnel action.yml files + root action.yml, workflow YAML validity (release.yml + tests.yml + integration.yml), full bats suite green",
    "check": "shellcheck --severity=warning cloudflare-tunnel/src/*.sh && npx --yes @action-validator/cli cloudflare-tunnel/start/action.yml && npx --yes @action-validator/cli cloudflare-tunnel/stop/action.yml && npx --yes @action-validator/cli cloudflare-tunnel/wait/action.yml && npx --yes @action-validator/cli action.yml && yq .github/workflows/release.yml >/dev/null && yq .github/workflows/tests.yml >/dev/null && yq .github/workflows/integration.yml >/dev/null && bats cloudflare-tunnel/__tests__/*.bats"
  }
]
```

## Critical files

| File | Action | Notes |
|---|---|---|
| `cloudflare-tunnel/Dockerfile` | Create | Alpine + bash/jq/curl/ca-certs; COPY src/; ENTRYPOINT entrypoint.sh |
| `cloudflare-tunnel/src/lib.sh` | Create | slugify, log, fail, pid_path/url_path/log_path, regexes |
| `cloudflare-tunnel/src/install-cloudflared.sh` | Create | Download + sha256 verify (opt-in via INPUT_VERIFY_CHECKSUM) |
| `cloudflare-tunnel/src/start.sh` | Create | Mode dispatch + spawn + URL capture + probe + outputs |
| `cloudflare-tunnel/src/stop.sh` | Create | SIGTERM → SIGKILL → pkill fallback, idempotent |
| `cloudflare-tunnel/src/wait.sh` | Create | curl loop with backoff + status filter |
| `cloudflare-tunnel/src/entrypoint.sh` | Create | argv dispatch to start/stop/wait |
| `cloudflare-tunnel/start/action.yml` | Create | Docker container, image: '../Dockerfile', args: ['start'] |
| `cloudflare-tunnel/stop/action.yml` | Create | Docker container, args: ['stop'] |
| `cloudflare-tunnel/wait/action.yml` | Create | Docker container, args: ['wait'] |
| `cloudflare-tunnel/__tests__/helpers.bash` | Create | PATH stub for cloudflared, tmpdir lifecycle |
| `cloudflare-tunnel/__tests__/fixtures/cloudflared-stderr-quick.log` | Create | Real-ish quick-tunnel stderr containing trycloudflare URL |
| `cloudflare-tunnel/__tests__/fixtures/cloudflared-stderr-named.log` | Create | Real-ish named-tunnel stderr containing tunnel UUID |
| `cloudflare-tunnel/__tests__/fixtures/checksums.txt` | Create | Synthetic BSD-style sha256 manifest |
| `cloudflare-tunnel/__tests__/install-cloudflared.bats` | Create | AC #5, #6 |
| `cloudflare-tunnel/__tests__/start.bats` | Create | AC #1, #2, #3, #4 + negative cases |
| `cloudflare-tunnel/__tests__/stop.bats` | Create | AC #7, #8, #9, #13 |
| `cloudflare-tunnel/__tests__/wait.bats` | Create | AC #10, #11, #12 |
| `.github/workflows/integration.yml` | Create | Matrix E2E over modes (AC #14, #15, #16) |
| `cloudflare-tunnel/README.md` | Create | AC #19 (quickstart + tables + troubleshooting) |
| `README.md` | Edit | Add cloudflare-tunnel action entry |

## Verification

```bash
# Quality gate — all must exit 0
shellcheck --severity=warning cloudflare-tunnel/src/*.sh
npx --yes @action-validator/cli cloudflare-tunnel/start/action.yml
npx --yes @action-validator/cli cloudflare-tunnel/stop/action.yml
npx --yes @action-validator/cli cloudflare-tunnel/wait/action.yml
bats cloudflare-tunnel/__tests__/*.bats

# Image builds and dispatches
docker build -f cloudflare-tunnel/Dockerfile -t cf-tunnel:test cloudflare-tunnel/
docker run --rm cf-tunnel:test 2>&1 | grep -q 'usage:'

# E2E (post-merge via release-please v1 tag)
gh workflow run integration.yml

# Release-please picks up tunnel changes: simple release-type watches whole
# repo. Verify on first merge that a feat: commit under cloudflare-tunnel/
# opens a release PR. If not, add explicit package entries for
# cloudflare-tunnel/start, /stop, /wait to release-please-config.json.
```

If step 09 (`image: '../Dockerfile'`) fails validation, re-plan: split into three thin Dockerfiles (`start/Dockerfile`, `stop/Dockerfile`, `wait/Dockerfile`) each `FROM alpine:3.21@sha256:<pin>` and `COPY src/entrypoint.sh /action/`. Single bash-loop edit, no spec changes needed.

## Deviations

- **step 09 check + step 18 check + Verification section** — original check used `npx @action-validator/cli A B C` with multiple positional args; the CLI accepts only one file per invocation. Split into three `&&`-chained invocations. No semantic change.
- **step 04 check** — original check greped for the literal substring `github.com/cloudflare/cloudflared/releases/download`, but the script interpolates `$REPO` so the literal doesn't appear. Updated check to match the interpolated form `github.com/${REPO}/releases/download`.
- **branding values** (discovered during step 09 implementation, not in original plan): `stop/action.yml` color "gray" → "gray-dark", icon "cloud-off" → "x-circle" (neither "gray" nor "cloud-off" is in the action-validator enum). `wait/action.yml` icon "hourglass" → "clock" ("hourglass" not in enum). Validator doesn't surface the valid set, so trial-and-error.
- **step 11 check** — original check used `bats --list-tests ... | grep -q 'corrupted'`; installed bats (1.x) has no `--list-tests` flag. Switched to direct `grep -q 'corrupted'` on the .bats file.
- **step 04 script** — added `INSTALL_DEST` env override (default `/usr/local/bin/cloudflared`) so bats can hermetically install to a tmpdir without touching `/usr/local/bin`. Also `mkdir -p` on the parent dir before `install`. Required to make `install-cloudflared.bats` tests writeable.
- **step 11 test approach** — `start.sh` invokes `bash "$SCRIPT_DIR/install-cloudflared.sh"` (path-based, not PATH-based). Tests stub `curl` on PATH so install-cloudflared.sh downloads a fake binary script that emits fixture stderr + sleeps. Then start.sh scrapes the URL from the spawned cloudflared's log. No test-only branches in start.sh.
