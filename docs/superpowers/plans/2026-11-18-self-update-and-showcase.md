# Self-update and Showcase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship ZumiBot as private GitHub releases starting at v0.1.0, let the server find and install them from the app (toast + About), move the live install to `zumibot-server.mhdaljuboori.me` via the installer, and put a public showcase site on `zumibot.mhdaljuboori.me`.

**Architecture:** `release.yml` builds a tarball on a `v*` tag with notes from `CHANGELOG.md`. A new backend area `core/update/` polls the GitHub API with a vault-sealed token, downloads and verifies the tarball, and hands it to the release's own `install.sh` through `systemd-run --user` so the install outlives the service restart. A new workspace `zumi-bot-site/` is a static Vite + React page built on Vercel with the latest release's version and notes baked in at build time.

**Tech Stack:** Node 22, TypeScript, React 19, Vite, vitest, POSIX sh, systemd user units, GitHub REST API, Vercel.

**Spec:** `docs/superpowers/specs/2026-11-18-self-update-and-showcase-design.md`

## Global Constraints

- Repo `MhdAljuboori/ZumiBot` stays private. Nothing on the showcase site links to a tarball, an asset URL or an install command.
- Version restarts at `0.1.0` in every workspace; first tag `v0.1.0`. Semver `MAJOR.MINOR.PATCH`, optional leading `v`; anything else is "not newer".
- Release notes come only from the `## vX.Y.Z — YYYY-MM-DD` section of `CHANGELOG.md`; `release.yml` fails if it is missing or empty.
- `npm run deploy` (`deploy.mjs`, `deploy.sh`) is removed. `npm run sync` stays and restarts with `systemctl --user restart zumibot` (no sudo).
- New origin: `https://zumibot-server.mhdaljuboori.me`. Showcase: `https://zumibot.mhdaljuboori.me`.
- The GitHub token never appears in logs, URLs, error messages, process arguments, plain-text files or agent environments. Stored only sealed with the vault key (`vaultCrypto.seal/open`), id `update-token`.
- Update check every 6 h (`UPDATE_CHECK_MS = 21_600_000`) plus on demand. Every install is a user's click; it refuses while replies run unless the user confirms (`--force`).
- In-app update exists only for an installer install with a user unit (`ZUMIBOT_INSTALL_DIR` set, `<dir>/bin/zumibot-update` present). Local mode and containers say why and show no button.
- Snapshot before swap: `<dir>/data.prev`, a copy of the data dir minus `browsers/`, `browser-runtime/`, `claude-tmp/`, the control socket and the lock file.
- Dependencies pinned to exact versions; all workspaces share one version. Comments short, say why.
- **No git commit, push or tag without the user's explicit instruction** (user's global rule). "Checkpoint" steps below mean: stop, show the diff summary, commit only if told.
- Never touch the VPS, DNS or sudo without asking first (CLAUDE.md). Tasks 11–12 are run with the user.

## Review Focus

1. **Token revoked or expired** — check sets `token: 'rejected'`, no toast, About says "GitHub token was rejected"; install refuses with the same message. Test in Task 6.
2. **A reply starts between the click and the swap** — the installer refuses, the server comes back on the old version, `lastResult.kind === 'failed'` with the log tail. Test in Task 6 (boot with pending + same version).
3. **Download fails or checksum mismatches** — no updater is spawned, the partial file is removed, `error` names the cause. Test in Task 6.
4. **Double click / two tabs click Update** — the second call gets `ALREADY_UPDATING`, one `systemd-run`. Test in Task 6.
5. **Odd tags** (`v0.1.0-rc1`, `latest`, equal or older version after a rollback) — `isNewer` is false, no toast. Test in Task 1.

---

### Task 1: Shared update types and version compare

**Files:**
- Create: `zumi-bot-server/shared/src/update.ts`
- Modify: `zumi-bot-server/shared/src/types.ts` (add `update` to `ZumiBotApi`)
- Test: `zumi-bot-server/shared/tests/update.test.ts`

**Interfaces:**
- Produces:
```ts
export const UPDATE_REPO = 'MhdAljuboori/ZumiBot'
export const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000
export const ALREADY_UPDATING = 'ALREADY_UPDATING'
export type UpdateAvailability = 'ok' | 'local' | 'container' | 'notInstaller'
export type UpdateTokenState = 'unset' | 'set' | 'rejected' | 'vaultUnavailable'
export interface UpdateRelease { version: string; publishedAt: string; notes: string } // version without 'v'
export interface UpdateResult { kind: 'updated' | 'failed' | 'rolledBack'; from: string; to: string; at: number; logTail?: string }
export interface UpdateStatus {
  current: string; availability: UpdateAvailability; token: UpdateTokenState
  latest: UpdateRelease | null; newer: boolean
  checkedAt: number | null; checking: boolean; error: string | null
  installing: boolean; lastResult: UpdateResult | null; canRollBack: boolean
}
export function parseVersion(v: string): [number, number, number] | null
export function isNewer(candidate: string, current: string): boolean
// in ZumiBotApi:
update: {
  status(): Promise<UpdateStatus>
  check(): Promise<UpdateStatus>
  install(opts: { force: boolean }): Promise<{ started: true } | { busy: number }>
  rollBack(): Promise<{ started: true }>
  setToken(token: string | null): Promise<UpdateStatus>
  onChanged(cb: (s: UpdateStatus) => void): () => void
}
```

- [ ] **Step 1: Write failing tests** — `parseVersion('v0.1.0')` → `[0,1,0]`; `parseVersion('0.1.0-rc1')`, `'latest'`, `''`, `'1.2'` → `null`; `isNewer('v0.1.1','0.1.0')` true; `isNewer('0.2.0','0.10.0')` false; `isNewer('0.1.0','0.1.0')` false; `isNewer('v0.1.0-rc1','0.0.9')` false; `isNewer('1.0.0','garbage')` false.
- [ ] **Step 2:** `npx vitest run zumi-bot-server/shared/tests/update.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement `update.ts`; add the `update` block to `ZumiBotApi`.
- [ ] **Step 4:** Test passes; `npm run typecheck` fails only where `api.ts` lacks `update` (fixed in Task 7) — acceptable until then, or stub `update` in `frontend/src/net/api.ts` throwing `not implemented` to keep typecheck green.
- [ ] **Step 5: Checkpoint.**

### Task 2: CHANGELOG, bump script, release workflow

**Files:**
- Create: `CHANGELOG.md`, `zumi-bot-server/deploy/changelog.mjs`, `zumi-bot-server/deploy/bump.mjs`
- Modify: `package.json` scripts (`bump:patch|minor|major` → `node zumi-bot-server/deploy/bump.mjs <level>`, new `bump:set` → `node zumi-bot-server/deploy/bump.mjs`), `.github/workflows/release.yml`
- Test: `zumi-bot-server/shared/tests/changelog.test.ts`, extend `zumi-bot-server/shared/tests/installScripts.test.ts` (workflow checks)

**Interfaces:**
- Produces (`changelog.mjs`, ESM, no deps):
```js
export function changelogSection(text, version) // -> string body (trimmed, without heading) or null when missing/empty
export function addSection(text, version, date)  // -> text with "## v<version> — <date>\n\n" inserted under the "# Changelog" title; unchanged if present
// CLI: node changelog.mjs notes <version> <outFile>  -> exit 1 with "CHANGELOG.md has no notes for v<version>" when null
```
- `bump.mjs <patch|minor|major|X.Y.Z>`: runs `npm version <arg> --workspaces --no-git-tag-version --no-workspaces-update`, then `npm run bump:lock`, then `addSection` with today's date (UTC) and prints "Fill in CHANGELOG.md for v<new>".

- [ ] **Step 1: Failing tests** — `changelogSection` finds `## v0.1.0 — 2026-11-20` body between headings; returns `null` for a missing version and for a heading with only whitespace under it; accepts `0.1.0` and `v0.1.0`. `addSection` inserts once, newest first, idempotent. Workflow test: `release.yml` contains `changelog.mjs notes`, `--notes-file`, no `--generate-notes`, and the deploy-hook step is guarded by `if: env.VERCEL_DEPLOY_HOOK != ''` and reads it from `secrets.VERCEL_DEPLOY_HOOK`.
- [ ] **Step 2:** Run both test files → FAIL.
- [ ] **Step 3:** Implement `changelog.mjs`, `bump.mjs`, `CHANGELOG.md` (`# Changelog` + one-line intro, no sections yet), scripts, workflow: replace `--generate-notes` with `node zumi-bot-server/deploy/changelog.mjs notes "${GITHUB_REF_NAME#v}" release/NOTES.md` + `--notes-file release/NOTES.md`; final step `curl -fsS -X POST "$VERCEL_DEPLOY_HOOK"`.
- [ ] **Step 4:** Tests pass. Manual: `node zumi-bot-server/deploy/bump.mjs 10.6.4` on a scratch copy is a no-op version; verify `git diff` shows only the changelog section, then `git checkout -- .`.
- [ ] **Step 5: Checkpoint.**

### Task 3: Installer — token download, ships itself, data snapshot, rollback

**Files:**
- Modify: `zumi-bot-server/deploy/install.sh`, `zumi-bot-server/deploy/package.sh`, `zumi-bot-server/deploy/zumibot-user.service`
- Create: `zumi-bot-server/deploy/bin/zumibot-rollback`
- Test: `zumi-bot-server/shared/tests/installScripts.test.ts`

**Interfaces:**
- Produces: tarball contains `zumibot-server/install.sh` and `zumibot-server/bin/zumibot-rollback`. Unit `Environment=` gains `ZUMIBOT_INSTALL_DIR=<ZUMIBOT_DIR>`. Installer flag `--snapshot-data`. Token read from env `ZUMIBOT_GITHUB_TOKEN` (fallback `GITHUB_TOKEN`), never an argument. `<dir>/data.prev/.zumibot-from` holds the version being replaced.
- `zumibot-rollback` (no args): needs `<dir>/app.prev` and `<dir>/data.prev`; `systemctl --user stop zumibot`; `app` → `app.failed`, `app.prev` → `app`; data dir → `<data>.failed`, `data.prev` → data dir, then move `browsers/` and `browser-runtime/` back from `<data>.failed`; write `<data>/update-rolled-back` with the from/to versions; `systemctl --user start zumibot`. Refuses as root, exits 1 with a message if either `.prev` is missing.

- [ ] **Step 1: Failing tests** (string checks, the file's existing style): token only via env and only as an `Authorization: Bearer` header on `curl` (never on the command line of `fetch` args — use `-H @-` or a `--config` from stdin so it is not in `ps`); with a token the download goes through `api.github.com/repos/$REPO/releases/...` and `Accept: application/octet-stream`; `--snapshot-data` excludes `browsers`, `browser-runtime`, `claude-tmp`, `control.sock`, the lock file; `package.sh` stages `install.sh` and `bin/zumibot-rollback`; the required-files list includes `install.sh`; the user unit carries `ZUMIBOT_INSTALL_DIR=<ZUMIBOT_DIR>` and the installer substitutes it; rollback refuses root.
- [ ] **Step 2:** `npx vitest run zumi-bot-server/shared/tests/installScripts.test.ts` → FAIL.
- [ ] **Step 3:** Implement. Snapshot runs after the busy check and before the swap, using `tar -C "$data" --exclude=… -cf - . | tar -C "$DIR/data.prev.new" -xf -`, then rename to `data.prev`. Check the real control-socket and lock file names in `backend/src/control.ts` and `lock.ts` and use those. Token mode needs `curl` (die with a message if only `wget`).
- [ ] **Step 4:** Tests pass. Manual: `npm run build:server && sh zumi-bot-server/deploy/package.sh /tmp/<scratch>/rel` then `tar -tzf …/zumibot-server.tar.gz | grep -E 'install.sh|zumibot-rollback'`.
- [ ] **Step 5: Checkpoint.**

### Task 4: Retire deploy, sync on the user unit, new domain defaults

**Files:**
- Delete: `zumi-bot-server/deploy/deploy.mjs`, `zumi-bot-server/deploy/deploy.sh`, `zumi-bot-server/backend/tests/deploy.test.ts`, `zumi-bot-server/deploy/zumibot.service`
- Modify: `package.json` (drop `deploy`), `zumi-bot-server/deploy/sync.mjs:1113-1120`, `zumi-bot-desktop/electron.vite.config.ts:20` (drop `deploy.mjs` from the copied list), `zumi-bot-desktop/src/pages/picker.html:24`, `zumi-bot-desktop/tests/servers.test.ts`, `zumi-bot-desktop/tests/navigation.test.ts`, `zumi-bot-server/deploy/Caddyfile`, `nginx-zumibot.conf` (template host → `zumibot-server.mhdaljuboori.me`; `install.sh`'s `sed` pattern updated to match), `README.md`, `zumi-bot-server/deploy/SETUP-VPS.md` (replaced by a short pointer to the installer), `docs/architecture/deploy-and-sync.md`, `docs/architecture/processes.md`, root `CLAUDE.md` (Commands + deploy line)
- Test: `zumi-bot-server/backend/tests/sync.test.ts`

- [ ] **Step 1: Failing test** — sync's remote restart command is `systemctl --user restart zumibot` and contains no `sudo`; its failure message names `systemctl --user status zumibot`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement the list above. `grep -rn "zumibot.mhdaljuboori.me\|npm run deploy\|deploy.mjs" --exclude-dir=node_modules --exclude-dir=superpowers .` returns only the showcase references added later.
- [ ] **Step 4:** `npm test` and `npm run typecheck` pass; `CLAUDE.md` stays under 16 KB (`repoDocs.test.ts`).
- [ ] **Step 5: Checkpoint.**

### Task 5: GitHub client

**Files:**
- Create: `zumi-bot-server/backend/src/core/update/github.ts`
- Test: `zumi-bot-server/backend/tests/core/update/github.test.ts`

**Interfaces:**
```ts
export interface GithubRelease { tag: string; publishedAt: string; body: string; assets: { name: string; apiUrl: string }[] }
export class GithubError extends Error { constructor(readonly kind: 'unauthorized' | 'notFound' | 'network' | 'http', readonly status?: number) }
export function latestRelease(repo: string, token: string, fetchImpl?: typeof fetch): Promise<GithubRelease>
export function downloadAsset(apiUrl: string, token: string, dest: string, fetchImpl?: typeof fetch): Promise<void>
```

- [ ] **Step 1: Failing tests** with a fake `fetch`: request goes to `https://api.github.com/repos/MhdAljuboori/ZumiBot/releases/latest` with `Authorization: Bearer <t>`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, `User-Agent: ZumiBot`; 401/403 → `GithubError('unauthorized')`; 404 → `notFound`; thrown fetch → `network`; asset download uses `Accept: application/octet-stream`, streams to `dest` via `writeFileAtomic`-style temp + rename, and on failure leaves no file at `dest`; no error message contains the token.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Map JSON `tag_name`, `published_at`, `body`, `assets[].name`, `assets[].url`.
- [ ] **Step 4:** Tests pass.
- [ ] **Step 5: Checkpoint.**

### Task 6: UpdateService, token store, RPC and wiring

**Files:**
- Create: `zumi-bot-server/backend/src/core/update/tokenStore.ts`, `zumi-bot-server/backend/src/core/update/updateService.ts`, `zumi-bot-server/backend/src/core/update/CLAUDE.md` (pointer to `docs/architecture/updates.md`)
- Modify: `zumi-bot-server/backend/src/app.ts` (build + start/stop the service), `zumi-bot-server/backend/src/rpc/handlers.ts` (5 handlers), `zumi-bot-server/backend/vite.config.ts` (`define: { __SERVER_VERSION__: JSON.stringify(<backend package.json version>) }`, plus a `globals.d.ts` declaration)
- Test: `zumi-bot-server/backend/tests/core/update/updateService.test.ts`, `tokenStore.test.ts`, `zumi-bot-server/backend/tests/rpc/update.test.ts`

**Interfaces:**
- Consumes: Task 1 types, Task 5 client, `vaultCrypto.seal/open/readKey`, `writeFileAtomic`.
```ts
// tokenStore.ts — file <dataDir>/update-token.json, mode 0600, { updatedAt, sealed }
export function readToken(dataDir: string, keyFile: string): Promise<{ token: string | null; vault: boolean }>
export function writeToken(dataDir: string, keyFile: string, token: string | null): Promise<void> // throws VAULT_UNAVAILABLE without a key
// updateService.ts
export interface UpdateDeps {
  dataDir: string; keyFile: string; installDir: string | null; availability: UpdateAvailability; current: string
  busy: () => number; broadcast: (s: UpdateStatus) => void
  fetchImpl?: typeof fetch; now?: () => number
  runDetached?: (argv: string[], logFile: string) => Promise<void> // default: systemd-run --user --collect --unit=zumibot-updater-<ts> -p StandardOutput=truncate:<log> -p StandardError=append:<log> <argv>
}
export class UpdateService {
  constructor(d: UpdateDeps)
  start(): Promise<void> // reads update.json, settles a pending install into lastResult, starts the 6 h timer, first check after 60 s
  stop(): void
  status(): UpdateStatus
  check(): Promise<UpdateStatus>
  install(o: { force: boolean }): Promise<{ started: true } | { busy: number }>
  rollBack(): Promise<{ started: true }>
  setToken(t: string | null): Promise<UpdateStatus>
}
export function detectAvailability(mode: 'vps' | 'local', env: NodeJS.ProcessEnv, exists: (p: string) => boolean): { availability: UpdateAvailability; installDir: string | null }
```
- State file `<dataDir>/update.json`: `{ pending?: { from, to, at }, lastResult?: UpdateResult }`. Log `<dataDir>/update-log.txt`. Downloads `<installDir>/updates/v<ver>/` (outside the data dir, so not in the snapshot).
- Install steps: refuse unless `availability === 'ok'`, token set, `latest` newer; `installing` → throw `ALREADY_UPDATING`; `busy() > 0 && !force` → `{ busy }`; download tarball + `SHA256SUMS`, verify, extract only `zumibot-server/install.sh`; write `pending`; `runDetached(['sh', <extracted install.sh>, '--dir', installDir, '--tarball', <tar>, '--snapshot-data', ...(force ? ['--force'] : [])], log)` with the token **not** passed (the tarball is local). Errors clear `installing`, delete the download dir, set `error`.
- `rollBack`: `runDetached([<installDir>/bin/zumibot-rollback], log)`; `canRollBack` = `<installDir>/app.prev` and `<installDir>/data.prev` both exist.
- Boot settle: `pending.to === current` → `updated`; else `failed` with the last 20 lines of the log. `<dataDir>/update-rolled-back` present → `rolledBack`, file removed.
- Availability: `mode === 'local'` → `local`; `/.dockerenv` exists or `ZUMIBOT_CONTAINER` set → `container`; no `ZUMIBOT_INSTALL_DIR` or no `<dir>/bin/zumibot-update` → `notInstaller`; else `ok`.
- RPC: `update:status`, `update:check`, `update:install` (`{ force: boolean }` checked with the existing arg helpers), `update:rollBack`, `update:setToken` (string ≤ 400 chars or null); event `update:changed` carries `UpdateStatus` and is broadcast on every change.

- [ ] **Step 1: Failing tests** — every Review Focus item 1–4: 401 → `token: 'rejected'`, `newer: false`, install rejects with "GitHub token was rejected"; boot with `pending.to = '0.1.1'`, current `0.1.0` → `lastResult.kind === 'failed'` with `logTail`; checksum mismatch → `runDetached` never called, `<installDir>/updates` empty, `error` mentions checksum; two concurrent `install()` → one resolves, the other rejects `ALREADY_UPDATING`, `runDetached` called once; `busy = 2`, `force: false` → `{ busy: 2 }`; argv contains `--snapshot-data` and never the token; token file is 0600 and does not contain the token in clear; `status()` never contains the token; `detectAvailability` table for the four cases; RPC rejects `update:install` with a non-boolean `force`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement and wire in `app.ts` next to the vault (`config.vaultKeyFile`, `chats`' running count for `busy`, hub `broadcast({ type: 'update:changed', … })` in the shape the hub already uses).
- [ ] **Step 4:** `npx vitest run --project backend -t update` passes; `npm run typecheck` passes.
- [ ] **Step 5: Checkpoint.**

### Task 7: Frontend — toast, About, updating overlay

**Files:**
- Create: `zumi-bot-server/frontend/src/state/update.ts`, `zumi-bot-server/frontend/src/useUpdate.ts`, `zumi-bot-server/frontend/src/components/UpdateToast.tsx`, `zumi-bot-server/frontend/src/components/UpdatingOverlay.tsx`
- Modify: `zumi-bot-server/frontend/src/net/api.ts` (`update` mapping), `zumi-bot-server/frontend/src/components/Settings.tsx` (`AboutSettings`), `zumi-bot-server/frontend/src/App.tsx` (mount toast + overlay), `zumi-bot-server/frontend/src/styles.css`
- Test: `zumi-bot-server/frontend/tests/state/update.test.ts`

**Interfaces:**
```ts
// state/update.ts (pure)
export const DISMISS_KEY = 'zumibot.update.dismissed'
export function toastVersion(s: UpdateStatus | null, dismissed: string | null): string | null
export function aboutLine(s: UpdateStatus): string // "Up to date", "Version 0.1.1 is available", "Checking…", "GitHub token was rejected", "Updates are not available in the desktop app's Local mode", "Updates are not available in a container install: pull a new image", "Updates need the installer install"
export function reloadAfterReconnect(before: string, s: UpdateStatus): boolean // true when s.current !== before or s.lastResult?.at is newer than the click
```
- [ ] **Step 1: Failing tests** — `toastVersion` null when not newer, when availability ≠ `ok`, when installing, when `latest.version === dismissed`; returns the version otherwise. `aboutLine` for each state above. `reloadAfterReconnect` true on version change and on a fresh failed result, false otherwise.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Toast: bottom-right, "ZumiBot v<x> is available" · **Update** · **What's new** (opens Settings › About) · ✕ (stores `DISMISS_KEY`, `localStorage` in try/catch). Update with `{ busy: n }` → confirm "n replies are running. Updating stops them. Update anyway?" → `install({ force: true })`. Overlay: full-screen "Updating ZumiBot… it will be back in a moment", reloads when `reloadAfterReconnect`. About: Version, Latest, Last checked, **Check for updates**, **Install update**, notes rendered with the app's existing markdown component, token field (password input, Save / Remove, state text only), last result line with **Roll back** when `canRollBack` and the last result is `updated` or `failed`.
- [ ] **Step 4:** Tests pass; `npm run typecheck`; manual check in Task 10.
- [ ] **Step 5: Checkpoint.**

### Task 8: Showcase site

**Files:**
- Create: `zumi-bot-site/package.json` (name `@zumibot/site`, version = workspace version, pinned deps matching `frontend`), `zumi-bot-site/index.html`, `zumi-bot-site/vite.config.ts`, `zumi-bot-site/src/main.tsx`, `zumi-bot-site/src/App.tsx`, `zumi-bot-site/src/styles.css`, `zumi-bot-site/src/releaseInfo.ts`, `zumi-bot-site/scripts/fetchRelease.mjs`, `zumi-bot-site/public/shots/*.png`, `zumi-bot-site/vercel.json`, `zumi-bot-site/CLAUDE.md` (pointer)
- Modify: root `package.json` workspaces, `vitest.config.*` projects (`zumi-bot-site`)
- Test: `zumi-bot-site/tests/releaseInfo.test.ts`

**Interfaces:**
```ts
export interface ReleaseInfo { version: string; publishedAt: string; notes: string }
export function toReleaseInfo(apiJson: unknown): ReleaseInfo | null // tag_name minus 'v', published_at, body; nothing else
```
- `fetchRelease.mjs` (prebuild): with `GITHUB_TOKEN` fetches latest release, writes `src/release.json` from `toReleaseInfo`; without a token or on error writes `null` and the page says "Release notes coming soon" (local builds work).

- [ ] **Step 1: Failing tests** — `toReleaseInfo` maps the three fields, strips `v`, returns null on missing `tag_name`; `JSON.stringify(result)` has no `assets`, `url`, `tarball`, `zipball` or `browser_download_url`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Page sections: hero ("ZumiBot — chat with your Claude Code agents, alone or in groups"), 4–6 feature cards drawn from About's list and `docs/architecture` areas (group rooms, approvals, routines + workflows, vault, voice, desktop app), screenshots, "Latest: v<x> · <date>" with notes as markdown, footer "Built by Mohammed Al-Juboori" linking `https://mhdaljuboori.me/`. No download or install text. Light/dark via `prefers-color-scheme`. Screenshots: `npm run shot` against demo data, no real chats.
- [ ] **Step 4:** Tests pass; `npm run build -w @zumibot/site` succeeds without a token.
- [ ] **Step 5: Checkpoint.**

### Task 9: Docs

**Files:**
- Create: `docs/architecture/updates.md` (release flow, CHANGELOG rule, token, check/install/rollback, availability, files in data dir, showcase build)
- Modify: `CLAUDE.md` (index line for Updates; Commands: `bump:set`, no `deploy`), `docs/architecture/install.md` (token download, `--snapshot-data`, rollback, tarball ships installer), `docs/architecture/data.md` (`update.json`, `update-token.json`, `update-log.txt`, `update-rolled-back`), `docs/architecture/ui.md` (toast, About)

- [ ] **Step 1:** Write the docs.
- [ ] **Step 2:** `npm test` (repoDocs size check) passes.
- [ ] **Step 3: Checkpoint.**

### Task 10: Version 0.1.0 and the first release (with the user)

- [ ] **Step 1:** `npm test && npm run typecheck && npm run build` all pass. Whole-branch review.
- [ ] **Step 2:** `npm run bump:set -- 0.1.0`; write the `v0.1.0` CHANGELOG section (public summary of what ZumiBot is today); `npm run build:server` and check About shows `Version 0.1.0`.
- [ ] **Step 3: Ask the user** to approve commit, merge into `master`, push, then `git tag v0.1.0 && git push origin v0.1.0`.
- [ ] **Step 4:** Watch the Release workflow; `gh release view v0.1.0 -R MhdAljuboori/ZumiBot` lists `zumibot-server.tar.gz` and `SHA256SUMS`, notes equal the changelog section.
- [ ] **Step 5:** User creates a fine-grained token (this repo, Contents: read) for the server, and a second one for Vercel.

### Task 11: Migrate the VPS (with the user)

Read-only checks may run freely; every write step is announced first. Root steps go in `~/zumibot-migrate-root.sh` on the VPS, which the user reads and runs in a Terminal tab.

- [ ] **Step 1:** `~/zumibot/bin/zumibot-server busy` → `0`. User runs `sudo /usr/local/sbin/vps-backup run`; plus `tar -C ~ -czf ~/backups/zumibot-pre-0.1.0.tgz --exclude=.local/share/zumibot/browsers --exclude=.local/share/zumibot/browser-runtime .local/share/zumibot .claude .config/zumibot-vault`.
- [ ] **Step 2:** User adds Vercel DNS `A zumibot-server 144.91.101.151`; `getent hosts zumibot-server.mhdaljuboori.me` shows it.
- [ ] **Step 3:** Root script: `systemctl disable --now zumibot`; install nginx site `zumibot-server` (from the installer's `proxy/nginx-zumibot.conf`, written after Step 4's `--no-service` dry run or from the repo template), `certbot --nginx -d zumibot-server.mhdaljuboori.me`; old site becomes `return 301 https://zumibot-server.mhdaljuboori.me$request_uri;`; `loginctl enable-linger mhdaljuboori`; `nginx -t && systemctl reload nginx`.
- [ ] **Step 4:** As `mhdaljuboori`: copy `install.sh` from the release tarball, then `ZUMIBOT_GITHUB_TOKEN=… sh install.sh --version v0.1.0 --snapshot-data --origin https://zumibot-server.mhdaljuboori.me` (token typed by the user in the Terminal, not by Claude). Expect "Updating the install in /home/mhdaljuboori/zumibot" and "The server is up." `--snapshot-data` keeps the 10.x app and data as `app.prev`/`data.prev`, so `~/zumibot/bin/zumibot-rollback` over SSH can restore them (the in-app Roll back only appears after an in-app update, since a manual install leaves no update result).
- [ ] **Step 5:** Verify in the browser at the new origin: login + 2FA, chats and agents listed, a reply runs, vault `ready`, routines and workflows listed, About shows 0.1.0 and "Up to date" after the user saves the token.
- [ ] **Step 6:** Root script part 2 (user runs): remove `/etc/systemd/system/zumibot.service`, the `NOPASSWD: /usr/bin/systemctl restart zumibot` sudoers line, `systemctl daemon-reload`.
- [ ] **Step 7:** User-side: desktop app server URL, push notifications per device, update the workflow webhook caller URL, reinstall desktop `.deb` 0.1.0 with `--allow-downgrades`. Update the `vps-server` memory.

### Task 12: Showcase live (with the user)

- [ ] **Step 1:** Create Vercel project from `zumi-bot-site/` (root directory), env `GITHUB_TOKEN` (the read-only token), create a deploy hook; user adds it as GitHub secret `VERCEL_DEPLOY_HOOK`.
- [ ] **Step 2:** Add domain `zumibot.mhdaljuboori.me` to the project; user switches DNS from the VPS A record to Vercel.
- [ ] **Step 3:** Root script: remove the old `zumibot` nginx redirect site and `certbot delete --cert-name zumibot.mhdaljuboori.me`.
- [ ] **Step 4:** Verify: site shows v0.1.0 and its notes; page source has no asset or `api.github.com` URL; `curl -sI https://zumibot.mhdaljuboori.me` served by Vercel.
- [ ] **Step 5:** End-to-end update test: `bump:patch`, changelog, tag `v0.1.1` (user approves), toast appears on the server, **Update** → back on 0.1.1, showcase shows 0.1.1.
