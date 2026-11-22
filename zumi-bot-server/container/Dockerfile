# The default image for agents with container isolation (docs/architecture/governance.md 2.4). Built locally by
# `npm run container:image`; its tag is AGENT_IMAGE in backend/src/core/isolation/containerSupport.ts (raise both together).
# The claude CLI is not in it: each run mounts the server's own native binary read-only, so the versions always match.
FROM docker.io/library/node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep python3 build-essential curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
LABEL io.zumibot.image="agent"
USER node
