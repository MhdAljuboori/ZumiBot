# Self-update and showcase site

Date: 2026-11-18. Status: decisions in, awaiting approval.

## Intent

Mohammed's own ZumiBot moves from `zumibot.mhdaljuboori.me` to `zumibot-server.mhdaljuboori.me`, installed
with the one-command installer (`zumi-bot-server/deploy/install.sh`). The old domain becomes a public
**showcase site**: "I have this and I work with it". Anyone can find it and see what ZumiBot is and what is new in
the latest version, but nobody can download or install it yet.

Inside ZumiBot, a new version is announced by a toast ("New version available" + **Update**), and Settings › About
gets **Check for updates** and **Install update**. Updating happens from the app; no laptop, SSH or `npm run
deploy` needed.

## Goals

- Move the live install to the new domain and the installer layout **without losing anything**: chats, settings,
  attachments, agents, memories, the CLI login, the vault and its key, 2FA, routines, workflows and their hooks.
- Versions are published as **private GitHub releases** (repo `MhdAljuboori/ZumiBot` stays private), built by the
  existing `.github/workflows/release.yml` on a `v*` tag.
- The server finds new releases itself, shows them, and installs one on request, then comes back on the new version.
- The showcase site shows the latest version number and its release notes, read from the same releases.

## Non-goals

- Public downloads, install instructions for others, accounts, sign-ups. (Later, maybe; not now.)
- Updating the desktop Electron shell. It loads its UI from the server, so a server update already updates the UI.
- Updating the `claude` CLI. Its own updater handles that.
- Auto-install with no click. Every install is a user's click.

## Anti-goals

- The tarball, the token or anything that lets someone else install ZumiBot reachable from the public site.
- An update that leaves the server down with no way back. The installer keeps `app.prev`; a failed update must say
  how to roll back.
- An update that silently kills running replies. It refuses while replies run unless the user confirms.
- A secret (GitHub token) in logs, URLs, error messages, the data dir in plain text, or any agent's environment.

## Constraints found

- `install.sh` downloads anonymously from GitHub; the repo is private, so it needs a token or `--tarball`.
- The current install is a **system** unit restarted with `sudo -n systemctl restart zumibot`. The installer makes a
  **user** unit (`systemctl --user`), which the server can restart with no sudo. Self-update needs the user unit.
- `npm run deploy` (`deploy/deploy.mjs`) hardcodes `SITE = https://zumibot.mhdaljuboori.me` and restarts the
  system unit. After the move it would start the old unit and fight the new one over port 4317.
- A process the server spawns lives in the service's cgroup; `systemctl --user restart zumibot` kills it. The
  updater must run outside that cgroup (`systemd-run --user`).
- DNS is on Vercel and the user changes records; sudo on the VPS needs the user's password, so root steps go in a
  script the user runs in a Terminal tab.
- `release.yml` only runs on a pushed tag, and refuses a tag that disagrees with the workspace version. There are no
  tags yet. `origin/master` is 10.6.4; the VPS runs 10.6.3 (deployed 2026-11-18).
- `--generate-notes` lists merged PRs, and almost all work is merged locally from `claude/*` branches, so generated
  notes would be near empty.
- `sync.mjs` (and the desktop Sync window) also restarts with `sudo -n systemctl restart zumibot`.
- `bin/zumibot-update` runs the copy of `install.sh` saved at first install; the tarball does not carry one.

## Approaches considered

- **A. Private GitHub releases (picked).** Tag → `release.yml` builds tarball + `SHA256SUMS`. Server holds a
  read-only GitHub token, polls the latest release, downloads with the token, checks the sum, runs the installer.
  Showcase site reads the same releases with its own server-side token and shows version + notes only. One source
  of versions, built by CI, private file never on the public site. Cost: two tokens.
- B. Showcase site hosts a hidden download behind a secret. New upload pipeline; private file on a public host.
- C. Laptop pushes builds to the server. No real "update available"; no version source for the site.

## Version reset and order

When this goes live the version restarts at **0.1.0** (decided): every workspace, the first tag `v0.1.0`, the first
`CHANGELOG.md` section. Nothing in the code compares versions today (only `__APP_VERSION__` is displayed), so the
reset breaks no data or compatibility check. Semver from 0.1.0 on is what the updater compares.

Because of the reset, the move happens **once, onto v0.1.0** (my call): build the repo changes of Phases 1–3 first,
bump to 0.1.0, write its changelog entry, push and tag, and let `release.yml` publish it. Phase 1's install then uses
that release (downloaded with the token, or its tarball via `--tarball`) instead of a local 10.6.4 build. The old
domain keeps serving 10.6.3 until then. Every update after that goes through **Update** in the app.

One-time side effect: the desktop `.deb` goes from 10.x to 0.1.0, which `dpkg`/`apt` see as a downgrade, so the
desktop app is reinstalled once (`sudo apt install --allow-downgrades ./zumibot_0.1.0_amd64.deb`, or remove and
install). The `bump:*` scripts need a way to set an exact version (`bump:set 0.1.0`).

## Design

### Phase 1: migration to the new domain

Data stays in place: same user `mhdaljuboori`, same `~/zumibot`, `~/.local/share/zumibot`, `~/.claude`,
`~/.config/zumibot-vault/vault.key`. The installer swaps only `app/`.

1. Backup: run the restic job (`sudo vps-backup run`) and a local `tar` of the three folders + vault key.
2. User adds DNS `A zumibot-server → 144.91.101.151` in Vercel.
3. Get the v0.1.0 release tarball onto the VPS (installer download with the token, or `scp` + `--tarball`).
4. Root script the user runs: stop + disable the system unit `zumibot`, nginx site + certbot for the new host
   (from the installer's `proxy/nginx-zumibot.conf`), `loginctl enable-linger mhdaljuboori`.
5. `sh install.sh --tarball … --origin https://zumibot-server.mhdaljuboori.me` (treated as an update: `app/`
   exists; no first-run setup because `auth.json` exists).
6. Verify: login + 2FA, chats, agents, vault status `ready`, a reply runs, routines/workflows listed.
7. Remove the old system unit file, its NOPASSWD sudo rule and the old nginx site; the old cert is reused or deleted
   when the showcase site takes the domain (Phase 4).
8. User-side: desktop app server URL, re-enable push notifications per device, update the one workflow webhook's
   caller to the new URL.

Between Phase 1 and Phase 4 the old host is a 301 to the new one (nginx), so bookmarks and the phone PWA land
somewhere (my call). The server accepts one origin only, so the old host cannot keep serving the app.

Repo changes in the same phase: `sync.mjs` uses the user unit (`systemctl --user restart zumibot`, no sudo) and
the new site URL; desktop picker default URL; `SETUP-VPS.md`, `deploy-and-sync.md`, `install.md`; tests that pin the
old domain.

### Phase 2: private releases

- The tarball ships `install.sh`, and an in-app update runs the **new** release's installer from the downloaded
  tarball, not the copy saved at first install, so installer fixes reach the server (my call; `package.sh` and the
  required-files check change with it).
- `install.sh` learns a token: if `GITHUB_TOKEN` (or `ZUMIBOT_GITHUB_TOKEN`) is set, download release assets
  through the GitHub API (`/repos/{repo}/releases/{latest|tags/X}` → asset `url`, `Accept: application/octet-stream`,
  `Authorization: Bearer`). Token from the environment only, never an argument (it would show in `ps`).
- Release notes come from **`CHANGELOG.md`** at the repo root (decided). One `## vX.Y.Z — YYYY-MM-DD` section per
  version, short and written for a public reader, added when the version is bumped (the `bump:*` scripts add an
  empty section to fill in). `release.yml` extracts that version's section and passes it as `--notes-file`, replacing
  `--generate-notes`, and stops if the section is missing or empty. The first release's entry is a hand-written
  summary of what ZumiBot is today, not the whole history.
- **`npm run deploy` is retired** (decided). Shipping is: `npm run bump:*`, fill in the changelog section, commit, push,
  tag `vX.Y.Z`, push the tag, then **Update** in ZumiBot. `deploy.mjs`, `deploy.sh` and the `deploy` script are
  removed with their tests and docs; the busy check lives on in the installer and the in-app updater. `sync.mjs`
  stays (it syncs data, not builds) and restarts the user unit.
- First release: push master, `npm run bump:*`, tag, push the tag.

### Phase 3: in-app update

Backend `core/update/`:

- **Token.** Settings › About has a "GitHub token" field (fine-grained, this repo only, Contents: read). Stored
  encrypted with the vault key (`vaultCrypto.ts`) in `update.json` in the data dir, 0600. Never sent back to the UI;
  the UI sees only "set / not set / rejected".
- **Check.** Every 6 hours and on demand: `GET /repos/MhdAljuboori/ZumiBot/releases/latest` with the token.
  Compare its tag to the running version (semver). Keep `{latest, notes, checkedAt, error}` in memory and push
  `update:changed` to every tab.
- **Install.** Refuses unless the install is the installer layout (`<dir>/bin/zumibot-update` exists and the unit
  is a user unit). Downloads the asset with the token to a temp file, checks `SHA256SUMS`, then starts
  `systemd-run --user --unit=zumibot-updater --collect <dir>/bin/zumibot-update --tarball <file>` so it outlives
  the restart. Running replies: the RPC returns the count first; the UI asks "N replies running. Update anyway?",
  and a yes adds `--force`. Before the swap the installer copies the data dir to `<dir>/data.prev` (`--snapshot-data`), leaving out the
  downloaded browsers (`browsers/`, `browser-runtime/`, 2.6 GB, re-downloadable) and `claude-tmp/`, so the copy is
  about 150 MB on the VPS today (my call; a hardlink snapshot would not survive in-place appends). Rollback restores `app.prev` **and** `data.prev`, since new versions
  migrate data on first start (my call; the daily restic backup stays the safety net for anything older). Writes `update-log` (last run's output, no token) to the data dir for the About page.
- **After restart.** The new server compares its version with what was requested; About shows "Updated to vX" or
  "Update failed, still on vY" with the log tail and a **Roll back** button (restores `app.prev` + `data.prev`,
  restarts through the same `systemd-run` path).
- Not available in Local (desktop) mode or a Docker install: About says why and hides the button.

RPC: `update:status`, `update:check`, `update:install`, `update:setToken`; event `update:changed`. Shared types in
`shared/src/update.ts`.

Frontend:

- Toast, bottom corner, once per new version: "ZumiBot vX is available" · **Update** · **What's new** · dismiss.
  Dismissal remembered per version.
- About: current version, latest version, last checked, **Check for updates**, **Install update**, release notes
  (markdown), token field, last update's result.
- During install: a full-screen "Updating… ZumiBot will be back in a moment" that reconnects and reloads when the
  socket returns on the new version.

### Phase 4: showcase site

- New workspace `zumi-bot-site/`, static-first, deployed on Vercel at `zumibot.mhdaljuboori.me` (DNS moves from
  the VPS to Vercel; old nginx site and cert removed from the VPS).
- Content: what ZumiBot is, feature highlights with screenshots, "Latest: vX · date" and its release notes, a
  "Built by Mohammed" footer. No download, no install command.
- Latest version: read at build time from the GitHub API with a Vercel env token (read-only), and rebuilt on each
  release (a deploy hook called from `release.yml`). The token never reaches the browser; the page only gets tag,
  date and notes.
- Notes shown are the `CHANGELOG.md` sections, written for the public, so nothing private leaks by accident.

## Left to the builder

- Exact toast and About layout, following the app's existing styles.
- Showcase site stack (plain Vite/React like the frontend is the default) and visual design; screenshots taken from
  the real app with demo data.
- Poll interval tuning, semver parsing details, how the updater's progress is surfaced.

## Amendment 2026-11-18: no token, releases on the showcase site

Decided after v0.1.1: any install must be able to check for and install updates **without a GitHub token**, since the
app may be given to others. Of a public releases repo, a public main repo, or the showcase site (picked: C), the site
hosts the files.

- Releases are still built by `release.yml` as private GitHub releases. The site's build (which already holds a
  read-only token on Vercel) downloads the latest release's package and `SHA256SUMS`, checks the hash, and publishes
  them as static files: `/releases/latest.json` (version, date, notes, package path, sha256), `/releases/<x.y.z>/…`,
  and `/releases/latest/{zumibot-server.tar.gz,SHA256SUMS,install.sh}`. Only the latest release is kept.
- The server reads `latest.json` with no token, downloads the package from the same origin, and checks its sha256.
  The token field, `update-token.json` (deleted if left over) and the `update:setToken` call are gone.
  `install.sh` downloads from the same paths with no token.
- **Anti-goal changed:** the package is now publicly downloadable (unlisted: the page does not link to it). It is the
  built server, so this is close to publishing the code. The page still offers no download or install command.
- Trust is unchanged: https plus the checksum, as before. Signed releases are a possible later step.
