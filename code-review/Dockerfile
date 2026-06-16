FROM alpine:3.21

RUN apk add --no-cache \
    bash \
    git \
    jq \
    curl

COPY code-review/src/ /action/src/
COPY code-review/prompts/ /action/prompts/

WORKDIR /github/workspace

ENTRYPOINT ["bash", "/action/src/main.sh"]
