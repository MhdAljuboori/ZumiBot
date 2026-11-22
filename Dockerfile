# ZumiBot server image. Three stages: build the self-contained bundle, name it `dist`, then ship it with the claude CLI.
# The server still binds 127.0.0.1 only; docker-compose.yml puts Caddy in the same network namespace, and Caddy
# is the only listener. See docs/architecture/install.md.

# Pinned by digest, so a rebuild months from now is the same base. node:22-bookworm-slim (Debian 12), which has
# bash — the server asks a login shell for its PATH and for `claude`.
FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS build

WORKDIR /src

# Manifests first, so a source-only change does not reinstall. Every workspace's package.json is needed for `npm ci`.
COPY package.json package-lock.json ./
COPY zumi-bot-server/shared/package.json zumi-bot-server/shared/
COPY zumi-bot-server/frontend/package.json zumi-bot-server/frontend/
COPY zumi-bot-server/backend/package.json zumi-bot-server/backend/
COPY zumi-bot-desktop/package.json zumi-bot-desktop/
COPY zumi-bot-site/package.json zumi-bot-site/
COPY zumi-bot-docs/package.json zumi-bot-docs/

# --ignore-scripts: nothing here needs a build step, and it keeps Electron's postinstall from downloading a ~100 MB
# binary this image never runs (the desktop, site and docs workspaces are only here because the lockfile covers them).
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY . .
# Frontend (vite) then backend: one dist/server.mjs with every dependency bundled, plus dist/login and dist/web.
RUN npm run build:server


# The server bundle, as its own stage so a release can swap it: `--build-context dist=<signed tarball's app/>` replaces
# this stage, BuildKit never runs `build`, and the image runs exactly the signed bytes. A source build still uses it.
FROM scratch AS dist
COPY --from=build /src/zumi-bot-server/backend/dist /


FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

# The CLI the server runs for every reply. Pinned: ZumiBot leans on flags the e2e suite checks, so a new CLI is a
# deliberate bump followed by `npm run e2e` (docs/architecture/e2e.md).
ARG CLAUDE_CODE_VERSION=2.1.325

# git: the git chip and worktrees shell out to it. tzdata: routines and workflows schedule in the user's time zone.
# ca-certificates: outbound TLS to the API. Nothing for computer use or the agent browsers is installed here; both
# are Linux-only features that need more packages, and install.md lists them.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git tzdata ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm i -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force

# A fixed uid, so the volumes keep one owner across rebuilds.
RUN useradd --create-home --uid 10001 --shell /bin/bash zumibot

COPY --from=dist / /app

# The same command name the VPS launcher uses, so documented CLI steps read the same here:
#   docker compose exec zumibot zumibot-server set-password
RUN printf '%s\n' '#!/bin/sh' 'exec node /app/server.mjs "$@"' > /usr/local/bin/zumibot-server \
 && chmod 0755 /usr/local/bin/zumibot-server

# Made in the image and owned by the server's user, so a named volume mounted over one is not left owned by root.
RUN mkdir -p /data /vault /home/zumibot/.claude \
 && chown -R zumibot:zumibot /data /vault /home/zumibot

ENV NODE_ENV=production HOME=/home/zumibot ZUMIBOT_DATA_DIR=/data

# Outside the data dir on purpose, in a folder of its own: no copy or backup of /data carries the key.
ENV ZUMIBOT_VAULT_KEY_FILE=/vault/vault.key

# Exactly the home's .claude: ZumiBot reads the agents folder and the CLI's session logs from HOME, and this pulls
# ~/.claude.json in beside them, so one volume holds the login, the settings, the agents and the memories.
ENV CLAUDE_CONFIG_DIR=/home/zumibot/.claude

# The CLI is installed globally by root, so it could not update itself anyway; this keeps it from trying.
ENV DISABLE_AUTOUPDATER=1

USER zumibot
WORKDIR /home/zumibot
EXPOSE 4317

# Answers in the setup state too, so a container that is up but not set up still reads as healthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD zumibot-server busy >/dev/null || exit 1

CMD ["zumibot-server", "serve"]
