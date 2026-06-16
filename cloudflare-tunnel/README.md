# Toolu Cloudflare Tunnel

Expose a local `HOST:PORT` from your GitHub Actions runner to the public internet via a Cloudflare Tunnel. Quick tunnels (no account, ephemeral `*.trycloudflare.com` URL) work out of the box. Named tunnels (account-bound, persistent URL) activate when `tunnel-token` is set.

These are **composite actions**: `cloudflared` runs directly on the runner host (Linux and macOS), not inside a container. That means `HOST:PORT` resolves to a service on the runner — e.g. an app you started with `docker run -p 8000:8000` or `npm run dev` — and the tunnel process survives across steps so later steps (and external clients, via the public URL) can reach it. Pair `start` with `stop` (`if: always()`) to tear the tunnel down on success, failure, or cancellation.

## Quick start

```yaml
name: Preview
on: [push, pull_request]

jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run preview server
        run: npm run dev &
      - name: Start tunnel
        id: tunnel
        uses: falconiere/toolu-ghactions/cloudflare-tunnel/start@v1
        with:
          host: 127.0.0.1
          port: 3000
      - name: Wait for tunnel
        uses: falconiere/toolu-ghactions/cloudflare-tunnel/wait@v1
        with:
          url: ${{ steps.tunnel.outputs.tunnel-url }}
      - name: Use the URL
        run: |
          echo "Tunnel is live at ${{ steps.tunnel.outputs.tunnel-url }}"
          # Pass it to visual review tools, browser-automation suites, etc.
      - name: Stop tunnel
        if: always()
        uses: falconiere/toolu-ghactions/cloudflare-tunnel/stop@v1
```

The `start` step writes the tunnel URL to `${{ steps.tunnel.outputs.tunnel-url }}`. The `stop` step is idempotent and safe to run on any outcome when paired with `if: always()`.

## Outputs

| Output | Description |
|---|---|
| `tunnel-url` | Public URL of the tunnel. Quick mode only — empty in named mode unless your config exposes a hostname. |
| `tunnel-id` | Tunnel UUID. Named mode only. |
| `tunnel-pid` | PID of the `cloudflared` process. Diagnostic only. |
| `tunnel-name` | Slugified echo of the `name` input. |

## `start` inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `name` | no | `default` | Instance name. Use distinct names to run multiple tunnels in one job. |
| `host` | no | `localhost` | Local host to expose (quick mode only). Resolves on the runner host — e.g. `127.0.0.1` for a port published by `docker run -p`. |
| `port` | no | `3000` | Local port to expose (quick mode only). |
| `tunnel-token` | no | *(empty)* | Cloudflare tunnel token. Setting this switches to named-tunnel mode. |
| `tunnel-config` | no | *(empty)* | Path to a `cloudflared` config.yml with custom ingress rules (named mode only). |
| `cloudflared-version` | no | `2024.12.2` | cloudflared release tag to download. |
| `verify-checksum` | no | `false` | Verify cloudflared binary SHA256 against the release `checksums.txt` before installing. |
| `start-timeout` | no | `30` | Seconds to wait for the URL/ID to appear in cloudflared output before failing. |

## `stop` inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `name` | no | `default` | Instance name to stop. Must match the `start` step. |
| `stop-timeout` | no | `5` | Seconds between SIGTERM and SIGKILL. |

## `wait` inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `url` | **yes** | — | URL to poll. Typically `${{ steps.start.outputs.tunnel-url }}`. |
| `wait-timeout` | no | `60` | Seconds before failing. |
| `expected-status` | no | `2` | HTTP status class (`2`, `3`, etc.) or exact code (`200`, `404`). |

## Named tunnel setup

1. Create a named tunnel in the Cloudflare dashboard or via `cloudflared tunnel create my-tunnel`.
2. Copy the tunnel token (Dashboard → Zero Trust → Networks → Tunnels → your tunnel → token).
3. Add it as a repo secret (e.g. `CLOUDFLARE_TUNNEL_TOKEN`).
4. Configure DNS routes in the dashboard (or via `cloudflared tunnel route dns`).
5. Reference in your workflow:

```yaml
- uses: falconiere/toolu-ghactions/cloudflare-tunnel/start@v1
  with:
    tunnel-token: ${{ secrets.CLOUDFLARE_TUNNEL_TOKEN }}
    # Optional: bring your own config for custom ingress rules.
    # tunnel-config: .cloudflared/config.yml
```

## Troubleshooting

### Cloudflared download blocked

Some corporate networks block `github.com` asset CDN. The `start` step downloads `cloudflared` from `https://github.com/cloudflare/cloudflared/releases/download/<version>/<asset>` on every run, where `<asset>` is `cloudflared-linux-<arch>` on Linux or `cloudflared-darwin-<arch>.tgz` on macOS (`<arch>` is `amd64` or `arm64`). If your runner is firewalled, set `cloudflared-version` to a known-good release and ensure egress is open.

### trycloudflare URL never appears / regex timeout

If `start` fails with `tunnel URL not seen within 30s`, the regex is looking for `https://[\w-]+\.trycloudflare\.com` in cloudflared's stderr. A cloudflared regression could change the format. Workarounds: pin `cloudflared-version` to a known-good release, or check the log at `/tmp/cf-tunnel-<NAME>.log` in the runner to see the actual stderr.

### Stale PID file across matrix legs

If you run multiple matrix legs in parallel and use the same `name` input, both will write to the same `/tmp/cf-tunnel-<NAME>.pid` file — second writer wins, first leg's `stop` kills the wrong process. Use distinct `name` values per leg: `name: preview-${{ matrix.shard }}`.

### `TUNNEL_TOKEN` secret hygiene

The `tunnel-token` input should be set from a secret (`${{ secrets.X }}`), never committed to the workflow file. Cloudflare's token grants the holder full control of the tunnel — anyone with the token can route arbitrary traffic through it. Scope the token to one tunnel, not a Cloudflare account.

### `name: ''` (empty)

The `name` input is slugified. Empty string is treated as unset → falls back to `default`. If you need truly empty (which is invalid), pass `name: default` explicitly.

### Probe warning but start succeeds

`start` does a single best-effort HTTP probe to the tunnel URL before exiting. If the probe fails (e.g. cloudflared died, or the URL isn't reachable from inside the runner), start.sh logs a `WARNING` but still exits 0. The downstream steps can still try the URL. Inspect the cloudflared log at `/tmp/cf-tunnel-<NAME>.log` for the real failure cause.

## Notes

- The sub-actions (`start`, `stop`, `wait`) are **composite actions** — they run `cloudflared` on the runner host, not in a container. Supported runners: Linux and macOS (`amd64` and `arm64`). Container/Windows runners are not supported.
- `cloudflared` is downloaded at runtime and pinned via `cloudflared-version`. Linux pulls a bare binary; macOS pulls the `.tgz` and extracts it. Trade-off: each `start` run adds a few seconds for the download.
- Cleanup: `stop` (`if: always()`) terminates the tunnel on success/failure/cancellation. On GitHub-hosted runners the VM is destroyed at job end regardless, so an ephemeral quick tunnel never outlives the job.
- Repo: [github.com/Falconiere/toolu-ghactions](https://github.com/Falconiere/toolu-ghactions)
- License: MIT
