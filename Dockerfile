FROM alpine:3.21

RUN apk add --no-cache \
    bash \
    git \
    jq \
    curl

COPY src/ /action/src/
COPY prompts/ /action/prompts/

WORKDIR /github/workspace

ENTRYPOINT ["bash", "/action/src/main.sh"]
