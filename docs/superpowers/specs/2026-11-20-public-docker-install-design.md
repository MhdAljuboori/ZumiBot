# Public Docker install

Date: 2026-11-20. Status: approved by the owner (registry: Docker Hub; a manual check run before the first tag).

## Intent

The public docs site (`docs.zumibot.run`, spec `2026-11-20-docs-site-design.md`) does not go live until a stranger can
install ZumiBot with Docker. Today they cannot: `docker/install.sh` downloads GitHub's source archive and builds the
image on the host, and the repository is private, so every step 404s for anyone but the owner.

This project makes the Docker install public the way the non-Docker install already is: a ready-made image in a public
registry, built and pushed by the release workflow, and a `docker/install.sh` published on `zumibot.run` that pulls it.
Done when a machine with no GitHub access installs and updates ZumiBot with Docker.

## Goals

- A multi-arch image (`linux/amd64`, `linux/arm64`) on Docker Hub for every release, built by `release.yml`.
- `https://zumibot.run/releases/latest/docker/install.sh` installs and updates with nothing but Docker and `curl`.
- Every promise the Docker installer makes today holds: loopback by default, `--domain` for public, no sudo, `.env`
  survives, the busy check before an update, rollback.
- The same trust as the non-Docker install: what runs is what the publisher signed, so the site that serves the
  installer's downloads cannot change what runs.
- Install doc, README and `zumi-bot-server/shared/tests/dockerSetup.test.ts` describe the new path; tests pass.

## Non-goals

- In-app update for a container. It would need the Docker socket inside the container, which is an anti-goal. The
  app keeps saying updates come from outside; only its wording changes.
- An in-app "new version available" notice for containers. A possible follow-up.
- Older releases on the site. As for the non-Docker install, the site keeps the latest only.
- Computer use and agent browsers in the image. Still left out, as today.

## Anti-goals

- Anything public that points at the private repo: the registry, the image's labels, the installer, the docs.
- The Docker socket, `privileged`, `cap_add` or host networking in the compose file (the existing tests stay).
- An update that takes the server down before the new image is on the host, or one with no way back.
- A signing or registry secret in a job that runs npm code.

## Constraints found

- The VPS installer (`zumi-bot-server/deploy/install.sh`) already installs from `zumibot.run`: it reads
  `releases/latest.json`, downloads the tarball from `releases/<x.y.z>/`, checks `SHA256SUMS`, and verifies an
  ed25519 signature over `zumibot-server\n<version>\n<sha256>\n` against a key pinned in the script
  (`RELEASE_PUBLIC_KEY`, the same as `shared/src/update.ts`). It verifies with `node`, which a Docker host may lack.
- `release.yml` has two jobs on purpose: `build` (npm, read-only token) and `publish` (no npm, signing key, write
  token). `installScripts.test.ts` pins that split and forbids `packages:`, `id-token` and unpinned actions.
- The server tarball's `app/` is `backend/dist`, and it is architecture-independent: one tarball already serves every
  VPS. The agent SDK's and the CLI's platform binaries are not in it. So the image can be built from that exact
  `app/` for both architectures, with no npm in the image build.
- The Dockerfile's base, `node:22-bookworm-slim@sha256:e9f5…`, is a multi-arch index (amd64, arm64 among others).
  The `claude-code` npm package has `linux-arm64` and `linux-x64` builds.
- `zumi-bot-site/scripts/fetchRelease.mjs` re-publishes the latest release under `public/releases/` and extracts
  `install.sh` from the tarball into `releases/latest/`. Optional assets (desktop installers) are skipped with a
  warning when a release lacks them.
- The server already reports `availability: 'container'` in a container and never checks or installs there.
- No Docker on the development machine: the image build and a real install are checked by CI and on a real host.

## Approaches considered

**Where the image lives** (the owner picked Docker Hub):

| | Docker Hub (`zumibot/server`) | GHCR (`ghcr.io/<owner>/zumibot`) | Image tarball on `zumibot.run` |
|---|---|---|---|
| Public link to GitHub | none | username in the name; GitHub may show the private repo as linked | none |
| Setup | an account, two secrets | none; flip the package to public once, irreversibly | none |
| Updates | layers reused | layers reused | the whole image (~250 MB per arch) every time, over Vercel bandwidth |
| Anonymous pulls | 100 per 6 h per IP | unlimited | Vercel bandwidth |

**Signing** *(my call)*:

- **The release key signs a small Docker bundle** (picked): the compose file with the image pinned by digest, the
  Caddyfiles, `.env.example` and the installer. The signature covers the bundle, the bundle names the digest, and a
  digest names exactly one image, so one signature covers what runs. Same key, same rotation story, no new tool.
- cosign keyless: rejected. It writes the workflow's identity, the private repo's name, to the public Rekor log.
- cosign with a key: rejected. A second key to keep, and cosign on every host.
- Digest only, no signature: rejected. Whoever can deploy the site could point the installer at any image.

**Update path** *(my call)*:

- **Run the installer again** (picked), as today. It verifies the new bundle, then the bundle's own installer does
  the update, as the VPS updater runs the new release's `install.sh`.
- In-app update: rejected, needs the Docker socket.
- Watchtower or another auto-updater: rejected, needs the Docker socket and skips the busy check.

## Design

### The image

- Name: `docker.io/zumibot/server` *(my call; one line in `release.yml` if the owner's Docker Hub namespace differs)*.
  Neutral on purpose: no GitHub username, no repo link.
- Tags: `<x.y.z>` and `latest`, added only after the release is signed (see the workflow below), so a tag never
  names a build that did not ship. The installer never uses a tag, only the digest.
- Platforms: `linux/amd64`, `linux/arm64`. Built with buildx; the arm64 runtime stage (apt, `npm i -g` the CLI)
  runs under QEMU. No npm runs for ZumiBot's own code.
- The Dockerfile gets a small stage between the two, so a release can swap in the packed bundle:

  ```dockerfile
  FROM node:22-bookworm-slim@sha256:… AS build      # unchanged: npm ci, npm run build:server
  FROM scratch AS dist
  COPY --from=build /src/zumi-bot-server/backend/dist /
  FROM node:22-bookworm-slim@sha256:…               # unchanged runtime
  COPY --from=dist / /app
  ```

  A source build (`docker compose up -d --build`) works as today. The release passes `--build-context dist=<the
  tarball's app/>`, which replaces the `dist` stage, so BuildKit never runs the `build` stage and the image's `/app`
  is byte for byte the signed server tarball's `app/`.
- No `org.opencontainers.image.source` or other label that names the repo.

### The release workflow

Three jobs; the workflow's default permissions stay none.

1. `build`: unchanged.
2. `image` (new), `needs: build`, `contents: read`: checks out with `persist-credentials: false` (for the
   Dockerfile), downloads the `release` artifact, unpacks the tarball's `app/`, sets up QEMU and buildx (actions
   pinned by commit), logs in to Docker Hub with `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` (stdin, never argv;
   the secrets only in that step's env), builds both platforms and **pushes by digest only, with no tag**
   (`push-by-digest=true`), and outputs the pushed index digest. No npm on the runner, no `setup-node` cache.
   Missing secrets fail the job with a message naming them, so a release never goes out without its Docker image
   *(my call; the owner adds the secrets before the next tag)*.
   The one npm command in the image build is the Dockerfile's `npm i -g` of the pinned `claude` CLI, inside a
   BuildKit `RUN` step: those run in their own container with no view of the runner's files or its registry login,
   and that package is in every image anyway *(my call: no separate push job for it)*.
3. `publish`, `needs: [build, image]`: as today, plus before signing it runs
   `node zumi-bot-server/deploy/docker-bundle.mjs <version> <image>@<digest> release`, which writes
   `release/zumibot-docker.tar.gz` and adds its line to `release/SHA256SUMS`. `release-sign.mjs` signs both
   tarballs. Then one step, with the Docker Hub secrets in its env only, tags the signed digest `<x.y.z>` and `latest`
   (`docker buildx imagetools create`, no npm, no rebuild). Then the release is created with `zumibot-docker.tar.gz`
   and `zumibot-docker.tar.gz.sig` as two more assets, then the site hook. A failed `publish` is re-run on its own:
   the `image` job's digest is kept, so nothing is rebuilt and the digest never moves.

### The check run (owner's choice)

`.github/workflows/docker-image-check.yml`, `workflow_dispatch` only, so the new image path is proven before a tag
bets a release on it. One job, `contents: read`, no secrets, pushes nothing: the `build` job's steps up to
`package.sh`, then the `image` job's build of both platforms from the packed `app/` with no push, then
`docker-bundle.mjs` with a placeholder digest and `docker compose config` on the bundle's compose file, and a short
smoke run of the amd64 image. About 10 to 15 minutes of Actions time per run. `release.yml` stays tag-only. Its
shell steps are kept the same as `release.yml`'s where they overlap, and a test checks that they match.

### The Docker bundle

```
zumibot-docker.tar.gz
  zumibot-docker/docker-compose.yml     the repo's, with build: and image: replaced by image: <name>:<x.y.z>@sha256:<digest>
  zumibot-docker/docker/Caddyfile
  zumibot-docker/docker/Caddyfile.local
  zumibot-docker/docker/install.sh      the installer itself, at the same path as in the repo
  zumibot-docker/.env.example
  zumibot-docker/VERSION
```

- `deploy/docker-bundle.mjs` uses node built-ins only (the publish job installs nothing). It refuses an image that is
  not `<name>:<x.y.z>@sha256:<64 hex>` with the release's own version, and refuses a compose file whose `build:` block
  and `image:` line it cannot find exactly once, so a reshaped compose file fails the release instead of shipping a
  bundle that builds from source. It packs reproducibly, as `package.sh` does.
- Signed text: `zumibot-docker\n<version>\n<sha256>\n` (`dockerSignedText` in `shared/src/update.ts`, beside
  `releaseSignedText`). The different first line means a server tarball's signature can never pass for a bundle's.

### The site

`fetchRelease.mjs` also publishes, when the release has them:

- `releases/<x.y.z>/zumibot-docker.tar.gz` and `.sig`, checked against `SHA256SUMS` like the server tarball;
- `releases/latest/docker/install.sh`, extracted from the bundle (the installer that matches it).

A release without a bundle (every release before this project) is published without one, with a warning. A bundle
that does not match `SHA256SUMS` fails the build. The existing `/releases/latest/(.*)` cache header already covers the
new path. The showcase's server scene gets no Docker tab here; the docs site documents it.

### The installer

First install, as the docs will show it:

```sh
curl -fsSL https://zumibot.run/releases/latest/docker/install.sh -o install.sh
less install.sh
sh install.sh                                  # or: sh install.sh --domain zumibot.example.com
```

Options: `--domain HOST`, `--dir PATH`, `--version X.Y.Z` (the site keeps only the latest), `--bundle PATH` (a local
bundle, not checked, like the VPS installer's `--tarball`), `--force`, `--help`. `--ref`, `--unsafe-ref` and
`--tarball` go: there is no source archive anymore. `ZUMIBOT_UPDATE_URL` overrides the site, as for the VPS installer.

Order of work:

1. **Host checks**: as today (docker, compose 2.17+, daemon reachable without sudo), plus `sha256sum` or `shasum`.
2. **Which release**: `--version`, or the `version` in `$SITE/releases/latest.json`, read with `sed` (no node on the
   host) and checked to be a plain `x.y.z`. The signature binds it, so a wrong one cannot get anything installed.
3. **Download** `zumibot-docker.tar.gz` and `.sig` from `$SITE/releases/<x.y.z>/`, so a site deploy in between
   cannot mix two releases. `--proto '=https'` as today.
4. **Verify**: sha256 on the host, then the ed25519 signature in a throwaway container from the pinned node base
   image (the same digest as the Dockerfile, so its layers are the ones the ZumiBot image reuses):
   `docker run --rm --network none --read-only -e … node:22-bookworm-slim@sha256:… node -e '…'`, values by env
   only, stdin from `/dev/null`, the same check as the VPS installer with the `zumibot-docker` first line. Anything
   short of a good signature stops with nothing changed. Then unpack and check `VERSION` is the signed version.
5. **Hand off**: run the bundle's own `docker/install.sh --bundle <file>` with the operator's options, as the VPS
   updater runs the new release's `install.sh`. A run with `--bundle` skips steps 2 to 5.
6. **Profile** and `.env`: as today. A first install writes `.env` with `umask 077`, loopback (`local`) unless
   `--domain`; an update keeps `.env` and refuses `--domain` that disagrees with it.
7. **Pull first**: `docker compose pull` with the new compose file while the old server still runs, so a slow or
   failed download never leaves the server down.
8. **Busy check**: as today, right before the swap: refuse while `zumibot-server busy` reports replies or cannot be
   read, unless `--force`.
9. **Swap**: `<dir>.next` → `<dir>`, the old one kept as `<dir>.prev`; `docker compose up -d --remove-orphans`, no
   `--build`. Wait for the server and print the next steps (where the setup code is, never the code).

Rollback: `mv <dir> <dir>.failed && mv <dir>.prev <dir> && cd <dir> && docker compose up -d`. The old compose file
names the old image by digest, which is still on the host (or is pulled again by digest).

**Moving an existing source-built install**: download the new installer from `zumibot.run` once and run it. It keeps
`.env` and the volumes (they belong to the compose project `zumibot`, not the folder); `<dir>.prev` keeps the old
source tree, and its `zumibot:local` image stays until `docker image rm zumibot:local`. Settings in `.env` that only a
source build reads (`ZUMIBOT_CLAUDE_VERSION`, `ZUMIBOT_IMAGE_TAG`) are ignored.

**Customised installs** *(my call)*: the installer manages the stock setup only. Each update replaces the folder
and keeps `.env` alone, and the compose file pins the image by digest, so a derived image (computer use, agent
browsers) runs from the operator's own compose project outside the installer's folder, `FROM
zumibot/server:<x.y.z>`, rebuilt by them for each release. install.md says so.

### Preview label (owner's choice, 2026-11-20)

The Docker install is called a **preview** until it has been proven on real hosts: the installer's `--help` and its
closing summary say so, and the Docker sections of the README and install.md open with a one-line "Preview" note.
No preview image tag, channel or version scheme: the label is text only, and dropping it later is a text change.

### The app

The container line in About changes from "pull a new image" to say the update is running the Docker installer again
(`frontend/src/state/update.ts` and its test). Nothing else in the updater changes.

### Docs and tests

- `docs/architecture/install.md` (Phase 2: the image, Updating, the one-line installer, the derived image now
  `FROM zumibot/server:<version>`), `docs/architecture/updates.md` (release flow, signing, what the site publishes),
  `README.md` (Docker quick start), `.env.example` (the CLI pin applies to source builds only).
- `dockerSetup.test.ts`: the new installer's promises (pinned key equals `RELEASE_PUBLIC_KEY`, verify image equals the
  Dockerfile's base, signature checked before unpack, `--bundle` hand-off, pull before swap, no github.com in the
  code), the Dockerfile's `dist` stage, the bundle script's rewrite of the real compose file.
- A run test of `docker/install.sh` with a fake `docker` on `PATH` and a local fixture site, as
  `installScripts.test.ts` does for the VPS installer: first install, update keeping `.env`, busy refusal, a bad
  signature refused, the hand-off.
- `installScripts.test.ts`: the `image` job's permissions, pinning, no npm, the Docker Hub secrets only there, the
  bundle signed before the release is created.
- Site tests for the bundle in `fetchRelease`.

### Owner's one-time setup (before the next tag)

1. A Docker Hub account or organization named `zumibot` (or change the image name in `release.yml`), with the
   repository `server` public.
2. An access token with read and write, saved as the repo secrets `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`.
3. Before the first tag: run **Docker image check** from the Actions tab once, and fix anything it finds.
4. After the first release: `docker logout && docker pull zumibot/server:<x.y.z>` on any machine, and one real
   install and update on a fresh host, before the docs' Docker tab goes live.

## Left to the builder

- Helper and file names inside the scripts and tests, message wording, the fixture site's shape.
- Which pinned actions set up QEMU and buildx, and their exact commits.
- How the fake `docker` in the run test answers each subcommand.
- What the check run's smoke run of the amd64 image calls.

## Amendment 2026-11-20: Mac hosts, Tailscale, no downgrades (owner's choices)

Raised by a review from the MacBook server work (a spare Apple silicon or Intel Mac running Docker Desktop, OrbStack or
Colima, reached over Tailscale). The owner chose both changes below.

- **`--origin` for Tailscale** (local profile only). `--origin https://HOST:8443` on a first install writes
  `ZUMIBOT_LOCAL_ORIGIN=https://HOST:8443`; the publish stays `127.0.0.1:8443`. The port must be 8443: compose publishes
  `${ZUMIBOT_LOCAL_PUBLISH}:8443` and `Caddyfile.local` listens on the origin's own port, so any other port breaks. No
  scheme other than https, no path, host lowercased from `[a-z0-9.-]`. Refused with `--domain`, and on an existing
  install unless `.env` already says the same (as `--domain` is). With a non-localhost origin, the closing text says to
  run `tailscale serve --bg --tcp=8443 tcp://127.0.0.1:8443` on the host and open `<origin>/setup` from the tailnet; with
  the default origin it keeps the `ssh -L` form and names `--origin` for Tailscale. The old advice (publish on the
  tailnet IP) goes: it fails on Colima, where that IP is on the Mac and not in the VM, and at boot on Linux when
  tailscaled starts after Docker. Caddy's `tls internal` certificate follows the origin's host, so the browser warning
  is the same as for localhost.
- **No downgrades.** A download run refuses a release older than `$DIR/VERSION` (when that file is a plain x.y.z), before
  downloading anything, because `latest.json` is not signed and a tampered site could otherwise roll a server back to an
  older signed release. The same version (a repair) is allowed. Going back on purpose is the `.prev` rollback or
  `--bundle`. A source-built install has no `VERSION`, so the first update from it is not checked.
- **Mac host messages.** On Darwin, a missing `docker` or an unreachable daemon names Docker Desktop, OrbStack or Colima
  instead of Docker Engine and the `usermod -aG docker` line. Hashing already falls back to `shasum -a 256`, `getent`
  is optional, and the script uses no GNU-only flags.
- `.env.example` and install.md: the local port is fixed at 8443, and the Tailscale form replaces the tailnet-IP form.
- The first real end-to-end check (arm64 pull, wizard, `claude` sign-in, a reply, then an update) can be the owner's Mac.
- **Image name.** The owner created the Docker Hub repository as `mhdaljuboori/zumibot` (public), not `zumibot/server`,
  so the image is `docker.io/mhdaljuboori/zumibot` (`DOCKER_IMAGE`, `release.yml`'s `IMAGE`, the check workflow). The
  public name now carries the owner's username; the repository it matches on GitHub stays private.
