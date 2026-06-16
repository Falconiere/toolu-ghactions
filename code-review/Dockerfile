FROM alpine:3.21@sha256:48b0309ca019d89d40f670aa1bc06e426dc0931948452e8491e3d65087abc07d

RUN apk add --no-cache \
    bash \
    git \
    jq \
    curl

COPY src/ /action/src/
COPY prompts/ /action/prompts/

WORKDIR /github/workspace

ENTRYPOINT ["bash", "/action/src/main.sh"]
