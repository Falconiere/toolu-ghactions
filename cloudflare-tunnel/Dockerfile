FROM alpine:3.21@sha256:48b0309ca019d89d40f670aa1bc06e426dc0931948452e8491e3d65087abc07d

# bash: shell scripting. jq: JSON output parsing. curl: cloudflared download +
# tunnel wait probes. ca-certificates: TLS to github.com releases. bash-completion:
# not strictly needed but matches sibling code-review image tooling.
RUN apk add --no-cache \
    bash \
    jq \
    curl \
    ca-certificates

COPY src/ /action/src/

# Exec-form ENTRYPOINT so action.yml `runs.args` (start|stop|wait) appends as CMD.
# Shell-form would consume args as entrypoint argv and break the dispatcher.
ENTRYPOINT ["bash", "/action/src/entrypoint.sh"]
