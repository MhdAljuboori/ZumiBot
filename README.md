# ZumiBot

Manage your Claude Code agents and chat with them, alone or in group chats. ZumiBot runs in two places with the same UI:

- **VPS**: a server at `https://zumibot-server.mhdaljuboori.me`, used from any browser. Agents keep working when your PC is off. Stand one up with [Docker](#quick-start-with-docker), or with the [installer](#install-on-a-linux-host-without-docker), then the proxy step in [SETUP-VPS.md](zumi-bot-server/deploy/SETUP-VPS.md).
- **Desktop**: a Linux app (`.deb`) that connects either to a **Local** server it starts on your PC, or to the **VPS**.

Local and VPS are separate servers. Optional data sync does not transfer agent browser profiles or browser runtimes: website sign-ins stay separate.

## Contents

- [Quick start with Docker](#quick-start-with-docker)
- [Install on a Linux host without Docker](#install-on-a-linux-host-without-docker)
- [How it fits together](#how-it-fits-together)
- [Repository layout](#repository-layout)
- [Requirements](#requirements)
- [Getting started](#getting-started)
- [Scripts](#scripts)
- [Releasing a new version](#releasing-a-new-version)
- [Sync from the app](#sync-from-the-app)
- [Desktop app](#desktop-app)
- [Server reference](#server-reference)
- [Agent browsers](#agent-browsers)
- [Where data lives](#where-data-lives)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)

## Quick start with Docker

**Preview:** the Docker install has not been proven on many real hosts yet. It is the same signed release, but expect rough edges.

A server anyone can stand up, on any Linux host with Docker. For a public address you need a domain whose `A` (and
`AAAA`) record already points at the host, ports 80 and 443 free and reachable, and a synced clock (two-factor codes
need it).

**One line**, with nothing but Docker installed:

```bash
# Download, read, then run
curl -fsSL https://zumibot.run/releases/latest/docker/install.sh -o install.sh
less install.sh
# Private by default: https://localhost:8443 on loopback only (reach it with an SSH tunnel or Tailscale)
sh install.sh
# Or over Tailscale: this machine's name on the tailnet, port 8443 (then run the tailscale serve line it prints)
sh install.sh --origin https://<this-machine>.<tailnet>.ts.net:8443
# Or public, with a certificate for your domain (opens ports 80 and 443)
sh install.sh --domain zumibot.example.com
```

It pulls the latest signed release's image (nothing is built on your machine) into `~/zumibot-docker`, checks the
publisher's signature first, never runs sudo, and prints the next steps. Run it again to update. From a source
checkout: `cp .env.example .env`, edit `.env` first (set `ZUMIBOT_DOMAIN`, or `COMPOSE_PROFILES=local`), then `docker compose up -d --build`.

Open `https://<your domain>/setup` (the installer prints the address and where the code is), paste the code, and the wizard walks you through the password, the authenticator
QR code, the recovery codes and a check of the `claude` CLI. It then hands the port to the app and takes you to the
sign-in page.

One thing is left to do by hand, because the server runs the `claude` CLI for every reply and the login has to be
made inside the container (run it in `~/zumibot-docker`; without `--domain` the service is `zumibot-local`):

```bash
docker compose exec zumibot claude   # open the printed URL on any device, paste the code back, then exit
```

Caddy runs in the server's own network namespace and gets the certificate itself; the server still binds `127.0.0.1`
only, so Caddy is the only listener. **No domain?** That is the installer's default; from a source checkout set `COMPOSE_PROFILES=local` in `.env` instead: nothing is
published beyond `127.0.0.1:8443`, for use through an SSH tunnel (`ssh -L 8443:127.0.0.1:8443 you@host`) or over
Tailscale (`--origin`, as above; the origin's port is always 8443). A Mac with Docker Desktop, OrbStack or Colima works
as the host too. The installer refuses an older release than the one installed unless you pass `--bundle`. There is no plain-HTTP mode.

Computer use and the agent browsers are Linux-only features that need extra packages and are deliberately left out
of the image; everything else works. Full detail, including what to back up and how to update:
[docs/architecture/install.md](docs/architecture/install.md).

## Install on a Linux host without Docker

For a host with Node.js 22+ and no Docker. It installs under your own account as a systemd **user** service, so
nothing runs as root:

```bash
curl -fsSL https://zumibot.run/releases/latest/install.sh -o install.sh
less install.sh      # read it first: it writes a systemd unit and may ask to run one sudo command
sh install.sh --origin https://zumibot.example.com
```

It checks Node and the `claude` CLI, downloads the latest release and checks it against `SHA256SUMS`, installs
into `~/zumibot`, starts the service, and prints what is left: the reverse proxy (it writes ready-made Caddy and
nginx configs with your host filled in, but installs neither — that needs root), the `/setup` URL, and the command
that shows the one-time setup code. The only thing it may ask root for is `loginctl enable-linger`, so the service
keeps running when you log out; it prints that command and asks before running it.

Run it again to update: it refuses while a reply is running, swaps the build in place, and
restarts. `~/zumibot/bin/zumibot-update` does the same with no arguments. Both download from the showcase site (`https://zumibot.run/releases/`), so no token is needed.

| Option | |
|---|---|
| `--origin URL` | the public https origin (required the first time, remembered afterwards) |
| `--dir PATH` | where to install (default `~/zumibot`) |
| `--version TAG` | a release tag instead of the latest |
| `--tarball PATH` | install from a local `zumibot-server.tar.gz` instead of downloading |
| `--no-service` | install the files only |
| `--force` | swap the build even while replies are running |
| `--yes` | answer yes to the one optional sudo step |

Detail, including what the release tarball holds: [docs/architecture/install.md](docs/architecture/install.md).

## How it fits together

```
                ┌──────────────────────────── VPS ────────────────────────────┐
 Browser ──┐    │  Caddy / nginx (HTTPS) ──► zumibot-server (127.0.0.1:4317) │
           ├───►│                              serves web UI + WebSocket API   │
 Desktop ──┘    │                              runs `claude` for each agent    │
 (VPS mode)     └──────────────────────────────────────────────────────────────┘

 Desktop (Local mode) ──► bundled zumibot-server on 127.0.0.1:<random port>
                          runs `claude` on your PC
```

- There is **one frontend**. The backend serves the built frontend, so each server is one process, one port, one URL.
- The desktop app **never bundles the UI for VPS mode**. It loads the page from the VPS, so the UI always matches the server's version.
- In Local mode the `.deb` bundles the built server and runs it with Electron's own Node. No system Node is needed to run the installed app.
- The browser talks to the server over one WebSocket per tab. Every open tab or machine sees the same live updates.

## Repository layout

```
package.json                npm workspaces root; every script you need lives here
zumi-bot-server/
  shared/                   types and pure helpers used by backend and frontend
  backend/                  Node server: chats, agents, auth, HTTP/WebSocket, CLI
  frontend/                 React UI (Vite)
  deploy/                   sync and installer scripts, systemd user unit, nginx and Caddy configs, VPS runbook
  e2e/                      Playwright end-to-end suites for the web app
zumi-bot-desktop/         Electron shell (server picker, Local server launcher)
  e2e/                      end-to-end suite for the packaged desktop app
docs/superpowers/           design spec, implementation plan, handoff notes
```

## Requirements

On your PC:

- Linux with `apt` (the desktop app ships as a `.deb`; `install:deb` assumes `amd64`)
- Node.js **22+** and npm
- The `claude` CLI installed and signed in (Local mode runs it)
- For `npm run sync`: `ssh` and `rsync`, with key-based SSH access to the VPS

To run the server on another Linux host: [Quick start with Docker](#quick-start-with-docker), or
[install.sh](#install-on-a-linux-host-without-docker) without Docker.

On the VPS: see [zumi-bot-server/deploy/SETUP-VPS.md](zumi-bot-server/deploy/SETUP-VPS.md).

## Getting started

```bash
npm install
```

Check that everything compiles and the tests pass:

```bash
npm run typecheck
```

```bash
npm test
```

Run the desktop app from source (builds the server first, then starts Electron in dev mode):

```bash
npm run dev
```

In dev mode the desktop app runs the server from `zumi-bot-server/backend/dist`, so after changing backend or frontend code, stop it and run `npm run dev` again.

## Scripts

Run all of these from the repository root.

| Script | What it does |
|---|---|
| `npm run dev` | Builds the server, then starts the desktop app in dev mode |
| `npm run build` | Builds frontend, backend and desktop app (no packaging) |
| `npm run browser:check` | Checks the built browser runtime with a temporary sandboxed profile |
| `npm run browser:install` | Explicitly downloads pinned Chromium into the selected data directory |
| `npm run build:server` | Builds frontend and backend only, into `zumi-bot-server/backend/dist` |
| `npm run build:deb` | Full build, then packages `zumi-bot-desktop/dist/ZumiBot_<version>_amd64.deb` |
| `npm run install:deb` | `sudo apt install` of the `.deb` for the current version |
| `npm run package` | Packages `release/zumibot-server.tar.gz` + `SHA256SUMS` from the built server (what a tag publishes) |
| `npm run sync` | Merges this PC’s chats and Claude data with the VPS, with backups; close the local app first |
| `npm run bump:patch` | Bumps all workspaces `x.y.z` → `x.y.(z+1)` and syncs `package-lock.json` |
| `npm run bump:minor` | Bumps all workspaces `x.y.z` → `x.(y+1).0` and syncs `package-lock.json` |
| `npm run bump:major` | Bumps all workspaces `x.y.z` → `(x+1).0.0` and syncs `package-lock.json` |
| `npm run bump:lock` | Syncs `package-lock.json` only (the bump scripts call it) |
| `npm run typecheck` | Type-checks every workspace |
| `npm test` | Unit tests (Vitest) |
| `npm run e2e` | Web app end-to-end suite |
| `npm run e2e:auth` | Sign-in, 2FA and session end-to-end suite |
| `npm run e2e:setup` | First-run setup wizard end-to-end, on a fresh data folder |
| `npm run e2e:resilience` | Reconnect and resync end-to-end suite |
| `npm run e2e:zumi-bot` | Zumi Bot end-to-end suite |
| `npm run e2e:group` | Group chat end-to-end suite |
| `npm run e2e:desktop` | Desktop app end-to-end suite, on the packaged layout |
| `npm run shot` | Builds, then takes UI screenshots into `zumi-bot-server/e2e/screenshots/` |

The bump scripts never create a git tag or commit.

## Releasing a new version

To publish a release other people can install (what [install.sh](#install-on-a-linux-host-without-docker) downloads), bump the version as below, commit, then push a matching tag:

```bash
git tag v10.2.5 && git push origin v10.2.5
```

[.github/workflows/release.yml](.github/workflows/release.yml) then builds the server tarball and `SHA256SUMS`, pushes the Docker image (`mhdaljuboori/zumibot`) by digest, packs and signs the Docker bundle, adds the image's version and `latest` tags after signing, and creates the GitHub release. It stops before publishing if the tag and the version in the workspaces disagree. Tagging is the only trigger: nothing else publishes, and the workflow never creates a git tag itself (it only tags the image).

One-time setup: a release fails at "Sign in to Docker Hub" unless the repository secrets `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` exist and the `mhdaljuboori/zumibot` repository exists on Docker Hub. The header of [.github/workflows/release.yml](.github/workflows/release.yml) lists the secrets and what each job holds.

**1. Bump the version** (pick one):

```bash
npm run bump:patch
```

```bash
npm run bump:minor
```

```bash
npm run bump:major
```

**2. Check** (optional, recommended):

```bash
npm run typecheck
```

```bash
npm test
```

**3. Update the VPS.** Push the tag above. The VPS updates from that release, with the in-app **Update** or `~/zumibot/bin/zumibot-update` on the VPS; the installer refuses while replies are running, and `--force` interrupts them. Open browser tabs keep the old UI until reloaded: a normal reload (F5) is enough, since `index.html` is served `no-cache` and the other files have hashed names.

**4. Build the desktop app.** This updates the desktop app's Local mode:

```bash
npm run build:deb
```

**5. Quit ZumiBot completely**, then install. A running old instance holds the single-instance lock, so a new launch would quit silently. Quitting also stops any running Local replies.

```bash
npm run install:deb
```

Then launch ZumiBot from the app menu.

**6. Verify**

```bash
dpkg -s zumibot | grep Version
```

- In the desktop app, switch between Local and VPS and send a message in each.
- In a browser, open https://zumibot-server.mhdaljuboori.me and send a message.

## Sync from the app

Open the account menu at the bottom of the sidebar and choose **Sync…**. In the desktop app, the sync window shows the destination, progress, errors, and backup locations. In a browser, choose **Open ZumiBot** to hand off to the installed desktop app on that PC; confirm the destination there. On a phone or tablet the page says to start Sync from the desktop app on your PC instead. Browser handoff needs the updated Linux `.deb` installed so the `zumibot://` link is registered. An older desktop app displays update guidance when connected to an updated server UI.

On the installed app’s first sync, use **Choose deploy.env…** to import your existing deployment settings. Only `VPS_HOST`, `VPS_USER`, and `VPS_DIR` are saved privately in the desktop app’s `sync.env`; SSH keys are never imported or bundled. Development runs can use `zumi-bot-server/deploy/deploy.env` directly. You can choose a different file later. The PC needs `ssh`, `rsync` and working key-based SSH access; the VPS restart is `systemctl --user restart zumibot`, so it needs no sudo rule.

`npm run e2e:sync` checks this flow with temporary home folders and fake SSH/rsync commands; it never contacts the real VPS.

Sync uses the same implementation as `npm run sync`. It refuses while replies are running, saves or discards unsaved agent edits with your confirmation, stops an idle local server, and reconnects afterward even if sync fails. Keep the app open until it finishes. A custom `ZUMIBOT_DATA_DIR` or `XDG_DATA_HOME` pointing elsewhere is refused because the CLI sync uses `~/.local/share/zumibot`. Browser profiles and runtimes stay private on each machine.

## First-time VPS setup

Install with [install.sh](#install-on-a-linux-host-without-docker) as a plain user, then put a reverse proxy (nginx + certbot, or Caddy) in front of `127.0.0.1:4317`: the commands are in [zumi-bot-server/deploy/SETUP-VPS.md](zumi-bot-server/deploy/SETUP-VPS.md). Then open `https://<your host>/setup`, paste the one-time code from `journalctl --user -u zumibot -n 20`, and it walks you through the password, the authenticator QR code, the recovery codes (shown once) and a check that the `claude` CLI is signed in. Afterwards, clone the repos your agents work in, and set up the MCP servers, skills and plugins they need, on the VPS.

To copy chats and agents between your PC and the VPS, copy `zumi-bot-server/deploy/deploy.env.example` to `deploy.env` (git-ignored), fill in `VPS_HOST` and `VPS_USER` (and `VPS_DIR` if not `/home/<VPS_USER>/zumibot`), and run `npm run sync`.

## Desktop app

- **First run** shows a picker: **Local**, or **VPS** with a URL (prefilled `https://zumibot-server.mhdaljuboori.me`). The choice is remembered.
- **Switching server**: "Switch server…" in the account menu, or `Ctrl+Shift+S`, or start it with:

  ```bash
  zumibot --switch-server
  ```

- **Local mode** starts the bundled server on `127.0.0.1` on a random free port and signs you in automatically with a secret made fresh at each launch. No password or 2FA. Closing the app stops the local server, so it warns you first if a reply is still running.
- **VPS mode** loads the VPS URL and shows its sign-in page the first time. Closing the window stops nothing on the VPS. If the server can't be reached, an error page offers **Retry** and **Switch server**.
- **Migration**: the first time the Local server starts with an empty data folder, it copies chats, settings, usage and attachments from the old app's `~/.config/ZumiBot`. The source is never changed.

## Server reference

### CLI

The VPS launcher is `<VPS_DIR>/bin/zumibot-server`. It pins `ZUMIBOT_DATA_DIR` so the service and the CLI share the same data.

| Command | What it does |
|---|---|
| `zumibot-server` / `zumibot-server serve` | Runs the server |
| `zumibot-server set-password` | Sets the sign-in password (asked twice, hidden, 16+ characters). `--generate` prints a random one instead |
| `zumibot-server setup-2fa` | Shows a QR code for your authenticator app, confirms one code, prints 10 recovery codes |
| `zumibot-server browser-install` | Downloads pinned Chromium into `<dataDir>/browser-runtime`; never installs OS packages |
| `zumibot-server browser-check` | Checks shipped assets, executable and a sandboxed launch/cleanup using an ephemeral profile |
| `zumibot-server --help` | Lists commands without starting the server |
| `zumibot-server busy` | Prints how many replies are running (the installer and sync use it) |

Changing the password or redoing 2FA signs out every session.

In VPS mode, a server with neither set serves the **first-run setup wizard** at `/setup` instead of starting the app: every other page redirects there, nothing else answers, and each step needs the one-time code the server prints to its own log at start (`journalctl -u zumibot -n 20`, or `docker compose logs zumibot`). Only a hash of that code is kept, in memory, so it dies when setup finishes or the server restarts. Finishing hands the same port to the app, so no restart is needed. The two CLI commands above still work and are interchangeable with the wizard; `set-password` is also how you change a password you mistyped in it. See [docs/architecture/install.md](docs/architecture/install.md).

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `ZUMIBOT_MODE` | `vps` | `vps` or `local` |
| `ZUMIBOT_PORT` | `4317` (vps), random (local) | Port on `127.0.0.1` |
| `ZUMIBOT_ORIGIN` | (required in vps) | Public `https://` origin, e.g. `https://zumibot-server.mhdaljuboori.me` |
| `ZUMIBOT_DATA_DIR` | `$XDG_DATA_HOME/zumibot` or `~/.local/share/zumibot` | Chats, settings, attachments, auth data |
| `ZUMIBOT_AGENTS_DIR` | `~/.claude/agents` | Agent definitions |
| `ZUMIBOT_WEB_DIR` | `web/` next to `server.mjs` | Built frontend |
| `ZUMIBOT_LOCAL_SECRET` | (required in local) | Session secret, 32+ characters. The desktop app sets it |
| `ZUMIBOT_MIGRATE_FROM` | none | Local mode only: folder to copy old chats from. The desktop app sets it |

On the VPS these are set in the systemd user unit; add your own in a drop-in (`systemctl --user edit zumibot`), which an update leaves alone. Logs:

```bash
journalctl --user -u zumibot -n 50
```

## Agent browsers

Each agent has its own persistent cookies and site storage under `ZUMIBOT_DATA_DIR/browsers/<opaqueProfileId>/`. Local and VPS sign-ins are separate; sign in through the viewer on each server. Browser profiles and `browser-runtime/` must be excluded from data sync and whole-data backups: copying live Chromium SQLite files or process ownership metadata is unsafe. The sync script excludes both directories from pull and backups; its final push includes only chat/settings/attachment paths. For a deliberate browser backup, stop the server cleanly first and manage that backup separately.

No browser starts or downloads at app startup or during text-only chat. An agent browser tool or your explicit **Open Browser** starts it; live frames begin only when you open a viewer. **Take control** starts off. Missing Chromium leaves text chat available. The current managed process lifecycle supports Linux (`x64` and `arm64`).

After a build, run setup explicitly as your normal user (or the VPS service user), with the same `ZUMIBOT_DATA_DIR` as the server:

```bash
npm run browser:install
npm run browser:check
```

The shipped Playwright Core **1.64.1** CLI installs its pinned Chromium, currently revision **1248**, with `install --no-shell chromium`. It writes only to `<dataDir>/browser-runtime`, ignoring a separate `PLAYWRIGHT_BROWSERS_PATH`. Expect hundreds of megabytes of network download; budget at least **1 GB** for installation/extraction, plus site caches, profiles and downloads. Upgrades may require additional space. Neither command starts the app server or uses an agent profile. The check observes a fresh blank page in a temporary sandboxed profile, closes the owned process tree, and removes it.

You can instead set `ZUMIBOT_BROWSER_EXECUTABLE_PATH` to an absolute supported Chromium executable. Resolution is: explicit override (with no fallback if missing), the shipped version's managed Chromium, then known system Chrome/Chromium locations. An existing system browser may need no download. An override must be compatible with the pinned Playwright version; `browser-check` verifies launch and observation.

The operator must install required OS libraries separately. To inspect the pinned runtime's dependency command without installing anything:

```bash
node zumi-bot-server/backend/dist/node_modules/playwright-core/cli.js install-deps --dry-run chromium
```

Review that output and arrange OS packages with your administrator, then rerun `browser-check`. Run the service as a non-root user with working Chromium sandbox support (user namespaces or a correctly configured Chromium sandbox helper). A failed check names library/sandbox prerequisites; it never downloads or installs dependencies automatically. Keep sandboxing enabled.

For an installed desktop, run the same bundled command with Electron's Node mode (adjust `/opt/ZumiBot` if installed elsewhere):

```bash
ELECTRON_RUN_AS_NODE=1 /opt/ZumiBot/zumibot /opt/ZumiBot/resources/server/server.mjs browser-install
ELECTRON_RUN_AS_NODE=1 /opt/ZumiBot/zumibot /opt/ZumiBot/resources/server/server.mjs browser-check
```

The desktop ships the same complete server artifact, including workers, MCP bridge, shared chunks and pinned Playwright package. No system Node or repository `node_modules` is needed by the installed app.

The default **two browser slots per server** include starting and closing browsers, viewers and pending handoffs. Two open viewers can occupy both slots; close one to let waiting work proceed. Browsers close promptly once no visible viewer, agent owner or queued command, active operation, manual control drain, or pending handoff needs them. Between commands, an agent retains its browser until release, turn end, or the configured idle limits (two minutes by default); capacity pressure can reclaim a safely idle browser sooner. Cookies/site storage remain, while tabs, navigation state and unsaved forms can be lost. A safe last-viewed origin may be offered for explicit reopening. Website memory varies: counts and bounded frame buffers do not impose a fixed RAM ceiling.

All browser settings use the `ZUMIBOT_BROWSER_` prefix:

| Suffix | Default | Meaning / upper bound |
|---|---|---|
| `EXECUTABLE_PATH` | managed/system discovery | Absolute Chromium executable override |
| `MAX_BROWSERS` | `2` | Concurrent browsers, at most 32 |
| `MAX_TABS` | `4` | Tabs/popups per browser, at most 32 |
| `IDLE_MS` | `120000` | Idle shutdown delay |
| `LEASE_IDLE_MS` | `120000` | Agent ownership inactivity delay |
| `HANDOFF_IDLE_MS` | `600000` | Unattended user-action expiry |
| `COMMAND_MS` | `30000` | Browser command deadline |
| `QUEUE_MS` | `120000` | Capacity/ownership wait deadline |
| `FPS` | `10` | Viewed frames per second, at most 10 |
| `WIDTH` | `1280` | Viewport width, at most 1920 |
| `HEIGHT` | `800` | Viewport height, at most 1080 |

Numeric values must be positive integers. Time limits are capped at `86400000` ms (one day). There is no frame recording or browsing history archive. Downloads/uploads use bounded staging (25 MiB per file, 100 MiB per profile including retained source copies); links expire after one hour or server restart. Stream progress can transiently cross a byte limit before cancellation. Use **Clear browser data** in agent settings to explicitly reset that agent's saved website state.

## Where data lives

| What | Where |
|---|---|
| Local server data (chats, settings, attachments) | `~/.local/share/zumibot` |
| Desktop app settings (server choice, window state) | `~/.config/ZumiBot` |
| Agents (Local) | `~/.claude/agents` |
| VPS app files | `<VPS_DIR>/app` (replaced on every update) and `<VPS_DIR>/bin` |
| VPS server data | server user's `~/.local/share/zumibot` (never touched by updates) |
| Agents (VPS) | server user's `~/.claude/agents` |
| Agent browser profiles | `<dataDir>/browsers/<opaqueProfileId>/` (private, separate Local/VPS) |
| Managed Chromium | `<dataDir>/browser-runtime/` (explicit install only) |
| Built `.deb` | `zumi-bot-desktop/dist/` |

## Testing

- `npm test` runs the unit tests with Vitest.
- The `e2e*` scripts build everything first, then run Playwright against a real server using a fake `claude`, so they never call the real CLI.
- `npm run e2e:desktop` packages the app unpacked (`electron-builder --dir`) and tests it in Local mode.

## Troubleshooting

| Problem | Fix |
|---|---|
| Sync says `Restart failed` | On the VPS run `systemctl --user status zumibot`; the user service needs `loginctl enable-linger` to keep running |
| The VPS does not answer after an update or sync | `journalctl --user -u zumibot -n 50` on the VPS |
| New desktop app does nothing when launched | An old instance is still running. Quit it fully, then launch again |
| Desktop stuck on a wrong or dead VPS URL | `Ctrl+Shift+S` or `zumibot --switch-server` |
| Browser still shows the old UI after an update | Reload the tab (F5) |
| `install:deb` can't find the file | Run `npm run build:deb` first; on a non-`amd64` machine, change the arch in the script |
| Agents on the VPS fail to use tools | Set up their MCP servers, skills and plugins on the VPS; an update does not copy them |
