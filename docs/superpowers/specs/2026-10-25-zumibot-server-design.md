# ZumiBot Server — Design

Date: 2026-10-25
Status: draft, awaiting approval

Source app: `/home/mhdaljuboori/Developments/Desktop/ClaudeBot` (v0.12.0, Electron). Its specs in `docs/superpowers/specs/` describe every feature this design keeps. Read them first. This document only covers what changes.

## 1. Intent

Run ZumiBot on a VPS and use it from a browser at `https://zumibot.mhdaljuboori.me`, with exactly the UI the desktop app shows today: sidebar with group chats and agents, chat view, composer, approvals, agent editor, account popup, theme switch.

Why (confirmed with you): agents keep working when your PC is off or asleep, and you can reach them from any machine.

Alongside it, a new desktop app that is a thin shell around the same UI. It connects either to a **Local** server it starts on your PC or to the **VPS** server.

## 2. Goals

1. `https://zumibot.mhdaljuboori.me` shows the same UI as today's desktop app, and every current feature works there.
2. Agents run on the VPS: `claude` is installed and logged in there, agents are in the VPS's `~/.claude/agents/`, and working folders are repo copies on the VPS. Your PC's files are never touched in VPS mode.
3. A chat or group run keeps going when the browser tab is closed. Reopening shows where it got to.
4. Several tabs or machines connected at once all see the same live updates.
5. Strong sign-in: password plus a 6-digit code from an authenticator app.
6. A new desktop app that shows the same UI, switches between Local and VPS, and replaces the current desktop app.
7. Your existing chats (for example the Workiom 5 group and agent chats) carry over into the new desktop app's Local mode.
8. One command from your PC deploys a new version to the VPS.

## 3. Non-goals (v1)

- Syncing chats between Local and VPS. They are separate ZumiBots with separate histories.
- Moving existing chats to the VPS. The VPS starts empty.
- A phone or tablet layout. You'll use it from a PC. *(my call)*
- Several user accounts. It's one owner, you.
- Cloning repos or running git from inside the UI. You set up repos on the VPS over SSH.
- Setting up MCP servers, skills or plugins on the VPS. You do that yourself (decided with you). Agent files are copied once (§9).
- Changes to the current repo `Desktop/ZumiBot`. It stays as it is. *(guess)*

## 4. Anti-goals (would count as failure even if it "works")

- **Reachable without signing in.** No path, whether HTTP, WebSocket or attachment URL, may answer anything except the sign-in page and its assets without a valid session.
- **Exposing the server directly.** The Node server never listens on a public interface. Only HTTPS through the reverse proxy reaches it.
- **Losing or changing old chats during migration.** Migration only copies. The old data stays byte-for-byte as it was.
- **The UI drifting between web and desktop.** There is one frontend, and the desktop never ships its own copy of the UI for VPS mode.
- **Bypassing permissions.** Same as today: never `--dangerously-skip-permissions` or `bypassPermissions`.
- **Silent failures.** A dropped connection, a stopped server or a failed sign-in shows up visibly, never as a frozen screen.
- **Secrets leaking.** Passwords, TOTP secrets, session tokens and recovery codes never appear in logs, URLs or error messages.

## 5. Layout of the new repo (decided with you, details my call)

```
/home/mhdaljuboori/Developments/AI/ZumiBot/
  package.json              npm workspaces root
  zumi-bot-server/
    shared/                 types and pure helpers used by backend and frontend (today's src/shared)
    backend/                Node server (today's src/main minus Electron) + auth + HTTP/WebSocket + CLI
    frontend/               React UI (today's src/renderer)
    deploy/                 deploy script, systemd unit, nginx and Caddy configs
  zumi-bot-desktop/       thin Electron shell
  docs/superpowers/         specs and plans
```

- You chose separate backend and frontend folders. I added `shared/` so their types can't drift apart.
- It's one git repo with npm workspaces. *(my call)*
- Keep the current repo's library versions and tooling: React, Vite, TypeScript, Vitest, Electron, electron-builder. *(my call)*
- In production the backend serves the built frontend, so it's one process, one port, one URL.

## 6. How the backend replaces Electron

Today the UI talks to the backend only through `window.api` (`ZumiBotApi` in `src/shared/types.ts`), and Electron appears in only four backend files (`index.ts`, `ipc.ts`, `devEnv.ts`, `attachments/protocol.ts`). The plan keeps the services as they are (`ChatService`, `GroupService`, `AgentStore`, `ChatStore`, `SettingsStore`, `AttachmentStore`, `AccountService`, agents sync, claude runner) and swaps only the transport and the OS integrations:

| Today (Electron) | Server version |
|---|---|
| `ipcRenderer.invoke` / `ipcMain.handle` | Request/response messages over one WebSocket per tab. The frontend's `api.ts` becomes a WebSocket client that implements the same `ZumiBotApi`, so components barely change. |
| `chats:push`, `agents:changed` events | Server events over the WebSocket, **broadcast to every connected tab** |
| `app:pickFolder` native dialog | In-page folder browser over the server's filesystem: starts at the agent's last folder or home, can go up, show hidden folders, and make a new folder *(my call)* |
| `attachments:pick` native dialog | Browser file input, which uploads |
| Drag-drop path (`webUtils.getPathForFile` + `stagePaths`) | Upload the bytes (the existing `stageBytes` path). `pathOf` / `stagePaths` drop out of the API. |
| `zumibot-attachment://` protocol | An HTTP route behind sign-in with the same strict id format (`parseAttachmentUrl` rules) |
| `shell.openPath` (open attachment) | Opens in a new browser tab: inline for images, PDF and text, download for everything else |
| `shell.openExternal` (links in replies) | `target="_blank" rel="noopener noreferrer"` |
| `shell.trashItem` (delete agent) | Move to the server user's freedesktop trash (`~/.local/share/Trash`), so it stays recoverable. Never a hard delete. |
| `nativeTheme` + portal (theme "System") | Browser `prefers-color-scheme`. The desktop shell keeps its no-flash show gate. |
| `setEditorDirty` / save-before-close | Browser: a `beforeunload` warning. Desktop shell: keeps today's Save / Discard / Cancel. |
| `devEnv` (`app.isPackaged`) | Explicit dev/test env flags, ignored when `NODE_ENV=production` |
| Single-instance lock | Server takes a lock on its data folder, so a second server on the same data refuses to start |

**Connection loss.** The frontend reconnects automatically with backoff. While disconnected, a visible "Reconnecting…" bar shows, and sending is disabled. On reconnect it reloads the chat list and the open chat's items, so it never relies on missed events. An expired session sends the tab to the sign-in page, and unsent drafts stay.

**Server data folder:** `ZUMIBOT_DATA_DIR`, default `~/.local/share/zumibot`. It holds the same files the desktop keeps in `~/.config/ZumiBot` today (`chats.json`, `chats/`, `settings.json`, `usage.json`, `attachments/`), plus `auth.json` (mode 600). *(my call)*

Everything else behaves as today: interrupted chats recovered at startup, staged attachments cleared at startup, the agents folder watched, Zumi Bot built in, the claude-missing banner, and the account popup showing the server's Claude account and usage.

## 7. Sign-in and security (decided with you, mechanics my call)

**Setup is from the command line on the VPS. There is no sign-up page.**
- `zumibot-server set-password` asks for the password twice, hidden, and requires at least 16 characters. `--generate` prints a random 24+ character one instead.
- The password is stored only as a scrypt hash with a random salt (Node's built-in `crypto.scrypt`).
- `zumibot-server setup-2fa` prints a QR code in the terminal (and the `otpauth://` text) for your authenticator app. It asks for one code to confirm, then prints 10 one-time recovery codes, which are stored hashed.
- In VPS mode the server **refuses to start** until both password and 2FA are set up.

**Sign-in**
- One page with password + 6-digit code, or a recovery code in place of the code. TOTP is 30-second steps with ±1 step of drift, and a used code can't be reused.
- Wrong tries are slowed down per IP, then that IP is locked out for 15 minutes after 10 failures. Failures are logged without the submitted values. Exact thresholds are the builder's call, with one rule: an attacker must not be able to lock you out from every IP.
- On success: a random 256-bit session token, stored hashed on the server, valid 30 days. The cookie is `HttpOnly`, `Secure`, `SameSite=Lax` (it was `Strict` until 2026-11-12: Chrome on Android withholds a `Strict` cookie when an installed PWA is launched from the home screen, so the app was signed out on every launch; the `Origin` check below still guards every write).

**Every request**
- The HTTP routes and the WebSocket upgrade check the session and the `Origin` header.
- Security headers: a strict CSP (scripts and connections only from itself), no framing, `Referrer-Policy: no-referrer`. The proxy adds HSTS.
- The server listens on `127.0.0.1` only. It trusts `X-Forwarded-For` only from the local proxy.

**Account controls** in the account popup: "Sign out" and "Sign out everywhere". Changing the password or redoing 2FA also signs out every session.

**On the VPS**
- The server runs as a normal user, not root, and `claude` runs as that same user.
- The firewall allows only SSH, 80 and 443.

## 8. Desktop app (decided with you, details my call)

A thin Electron shell, `zumi-bot-desktop`.

- **It never bundles the UI for VPS mode.** It loads the page from whichever server it is connected to, so the UI always matches that server's version.
- **First run** shows a small picker: **Local** or **VPS** (a URL, prefilled `https://zumibot.mhdaljuboori.me`). The choice is remembered.
- **Switching:** the footer account menu gets "Switch server…", which shows only inside the desktop shell (the preload exposes a flag). The browser never shows it.
- **Local mode**
  - The `.deb` bundles the built backend and frontend and runs the backend with Electron's own Node (`ELECTRON_RUN_AS_NODE`), so there's no system Node needed.
  - The server listens on `127.0.0.1`, on a random free port.
  - Sign-in: the shell makes a fresh random secret each launch, passes it to the server, and sets it as the session cookie, so you're signed in automatically. Without that secret, the local server answers nothing. Local mode needs no password or 2FA.
  - Closing the desktop stops the local server, so today's quit guard ("a reply is still running") still applies.
- **VPS mode**
  - Loads the VPS URL. The server's own sign-in page shows the first time, and the cookie persists in the shell.
  - Closing the window stops nothing.
  - If the server can't be reached: an error page with **Retry** and **Switch server**.
- **It keeps from today's app:** launcher icon, remembered window size, position and maximized state, single instance, no default menu, the no-flash show gate, and the save-before-close dialog.
- **It replaces the current app.** It keeps `appId: com.mhdaljuboori.zumibot`, `productName: ZumiBot`, `executableName: zumibot` and the icon, and starts at version **1.0.0** (above today's 0.12.0), so installing the new `.deb` upgrades over the old one. *(my call)*
- **Electron safety for remote pages.** The window has `contextIsolation`, `sandbox` and no Node integration. Navigation and new windows stay locked to the connected server's origin, and anything else opens in the system browser. The preload exposes only the desktop bridge: the in-shell flag, Switch server, and editor-dirty / save-before-close. *(my call)*
- **Switching away from Local while a reply runs** stops the local server, so it shows the same warning as the quit guard first. *(my call)*
- In Local mode, the account popup hides "Sign out" and "Sign out everywhere". *(my call)*

**Migration (decided with you: carry chats over into Local mode).** The first time the local server starts with an empty data folder, it copies `chats.json`, `chats/`, `settings.json`, `usage.json` and `attachments/` (whichever exist) from `~/.config/ZumiBot`. It never moves or edits the source. Chats keep their `sessionId` and `cwd`, so `--resume` keeps working on the same PC. A chat that was mid-reply in the old app shows as interrupted, as it does today.

## 9. VPS deployment (decided with you, details my call)

- **Address:** `https://zumibot.mhdaljuboori.me`. You add a DNS A record for `zumibot` pointing at the VPS IP, plus AAAA if the VPS has IPv6.
- **Proxy and HTTPS:** if the VPS already runs nginx, add a server block plus a Let's Encrypt certificate via certbot. Otherwise install Caddy, which gets certificates itself. Either way the WebSocket upgrade is forwarded and idle timeouts are long, and the server pings to keep sockets alive. The builder checks which applies on the VPS.
- **Needed once on the VPS:** Ubuntu, Node LTS (22+), the `claude` CLI installed and logged in as the server user (by running `claude` and signing in), git, and the repos the agents will work in.
- **Service:** systemd unit for the server user, starts at boot, `Restart=on-failure`, env for data folder and port.
- **Memory:** a group run starts several `claude` processes at once. The builder checks the VPS's RAM, and if it's under 2 GB, tells you before deploying. *(my call)*
- **Agents copied once (decided with you).** On the first deploy, the script copies your PC's `~/.claude/agents/*.md` into the server user's `~/.claude/agents/` on the VPS. Rules:
  - It copies only when that folder is missing or has no `.md` files, so it never overwrites or merges anything already on the VPS.
  - Later deploys never copy agents again.
  - Zumi Bot is left out, since the server creates its own built-in copy.
  - You set up the MCP servers, skills and plugins on the VPS yourself. The deploy script prints a reminder after the first copy.
- **VPS address and SSH user** for the deploy script live in a local, git-ignored config file next to it. The builder asks you for them at deploy time. *(my call)*
- **Deploy from your PC:** `zumi-bot-server/deploy/deploy.sh`. It builds locally, copies the build to the VPS over SSH, installs production dependencies there, and restarts the service. Because a restart interrupts running replies, it refuses while any reply or group run is running unless given `--force`. It asks the server whether it's busy over a localhost-only check through SSH. No git remote is needed.

## 10. Testing

- Bring over the current repo's unit tests (`tests/main`, `tests/renderer`, `tests/shared`) and fixtures (`fake-claude.mjs`, `fake-moderator.mjs`, `stream/`). They must pass against the moved code.
- New unit tests:
  - password hashing and checks
  - TOTP check, drift and reuse
  - recovery codes
  - rate limiting and lockout
  - session creation, expiry and sign-out everywhere
  - cookie flags
  - Origin check
  - unauthenticated requests rejected on every route and the WebSocket
  - request/response and broadcast over the WebSocket
  - reconnect and resync
  - upload
  - folder browser
  - freedesktop trash
  - migration copying without touching the source
  - Local-mode secret
- End-to-end with Playwright, using fake claude:
  - the server in a browser: sign in, new chat, streaming reply, approval, group run, reload mid-run, two tabs in sync
  - the desktop shell in Local mode, starting with migrated fixture data

## 11. Left to the builder

- WebSocket message format, HTTP framework (or plain `node:http` + `ws`), and the backend build tool.
- Exact rate-limit numbers, within §7's rule.
- Folder browser styling, as long as it matches the app's existing dialogs.
- Error page and server picker styling, matching the app.
- Proxy choice on the VPS (§9 rule).
- Plan split and order. Suggested: move code and get the tests green, then the server transport, then auth, then the web-only replacements, then the desktop shell and migration, then deploy.
