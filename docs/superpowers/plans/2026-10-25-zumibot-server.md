# ZumiBot Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn ZumiBot into a Node server + web UI reachable at `https://zumibot.mhdaljuboori.me`, plus a thin Electron desktop shell that connects to a Local or VPS server, with the same UI everywhere.

**Architecture:** Today's Electron main-process services move unchanged into `zumi-bot-server/backend`. Only the transport changes: IPC becomes one WebSocket per tab, carrying the same channel names. Electron-only calls get web replacements. The React renderer moves to `zumi-bot-server/frontend`, and its `api.ts` becomes a WebSocket client that implements the same `ZumiBotApi`. The desktop shell starts a bundled local server or points at the VPS, and always loads the UI from the server it is connected to.

**Tech Stack:** TypeScript, Node 22, `node:http` + `ws`, React 19 + Vite, Vitest, Electron + electron-vite + electron-builder, Playwright (`playwright-core` + system Chrome), nginx or Caddy, systemd.

**Spec:** `docs/superpowers/specs/2026-10-25-zumibot-server-design.md` (read it first; it links the old repo's specs for every kept feature).

**Source repo (read-only):** `/home/mhdaljuboori/Developments/Desktop/ClaudeBot` (below: `OLD/`). Never edit it.

## Global Constraints

- Repo root: `/home/mhdaljuboori/Developments/AI/ZumiBot` (below: `./`). `git init` on `master`.
- **Never commit unless the user explicitly says so.** Each task ends with a **Checkpoint** step: stop and report, and commit only if told to. Commit message rules are in the user's CLAUDE.md.
- Pin exact versions (`npm i -E`). Reuse the old repo's versions: react/react-dom 19.3.1, vite 8.3.5, @vitejs/plugin-react 6.1.2, typescript 7.0.2, vitest 5.0.5, electron 45.0.0, electron-vite 6.0.0, electron-builder 26.15.3, playwright-core 1.64.1, all @tiptap/* 3.32.0, react-markdown 10.1.0, remark-gfm 4.0.1, yaml 2.9.1, @types/node 22.20.5, @types/react and @types/react-dom 19.3.0. New: `ws` (latest 8.x) + `@types/ws`, `qrcode` (latest 1.x) + `@types/qrcode`. No other runtime dependencies without asking.
- Node ≥ 22 everywhere.
- The server listens on `127.0.0.1` only. This is not configurable.
- Never pass `--dangerously-skip-permissions` or `bypassPermissions` (kept from the old spec).
- Passwords, TOTP secrets, session tokens, the local secret and recovery codes never appear in logs, URLs or error messages.
- VPS origin: `https://zumibot.mhdaljuboori.me`. Default VPS port `4317`.
- Server data dir: `ZUMIBOT_DATA_DIR`, default `${XDG_DATA_HOME:-$HOME/.local/share}/zumibot`.
- Desktop identity: package `name: zumibot`, `appId: com.mhdaljuboori.zumibot`, `productName: ZumiBot`, `executableName: zumibot`, `version: 1.0.0`.
- Code style matches the old repo: 2 spaces, no semicolons, single quotes, short "why" comments, the same comment density.
- After any Playwright or Chrome run, kill every browser and Playwright process it started (user rule).

## Review Focus

1. **Server restarts mid-run** (deploy, crash). Open tabs must show "Reconnecting…", then the chat marked interrupted with no stuck spinner. The test is in Task 10.
2. **Opening an uploaded `.html` or `.svg` attachment.** It must download, never render on the app's origin. The test is in Task 4.
3. **"Sign out everywhere" or session expiry while another tab is open.** That tab's socket closes at once (code 4401) and goes to `/login`, and the composer draft survives. Tests are in Task 6 (server) and Task 8 (client).
4. **A file over 25 MB, or a proxy answering 413 with an HTML body.** Either way the chip shows "`<name>` is over 25 MB". The test is in Task 8.
5. **Theme set to Dark or Light while the OS prefers the other.** The page follows the setting, not the OS. Tests are in Task 9 (unit) and Task 10 (e2e computed background).

---

## File Structure

```
./package.json                       workspaces: zumi-bot-server/{shared,backend,frontend}, zumi-bot-desktop
./vitest.config.ts                   test.projects = the four packages
./tsconfig.base.json                 shared compiler options (old tsconfig.node.json options)
zumi-bot-server/
  shared/   package @zumibot/shared   src/ = OLD/src/shared/* + rpc.ts + desktop.ts; tests/ = OLD/tests/shared/*
  backend/  package @zumibot/backend
    src/core/        OLD/src/main/{agents,attachments(-protocol.ts),chat,store,claudeAccount.ts,fsutil.ts,groupMembers.ts} + trash.ts + folders.ts
    src/rpc/         handlers.ts (from OLD/src/main/ipc.ts), hub.ts
    src/http/        server.ts, headers.ts, attachments.ts, upload.ts, static.ts, login/{login.html,login.css,login.js}
    src/auth/        password.ts, totp.ts, recovery.ts, rateLimit.ts, authStore.ts, guard.ts, routes.ts
    src/config.ts, lock.ts, control.ts, migrate.ts, app.ts (wiring), cli.ts (entry)
    tests/           OLD/tests/main/* (minus Electron-only) + new tests; tests/fixtures = OLD/tests/fixtures
  frontend/ package @zumibot/frontend   src/ = OLD/src/renderer/src/* ; index.html; src/net/{rpc.ts,api.ts,upload.ts,folderPicker.ts}; tests/ = OLD/tests/renderer/*
  deploy/   deploy.sh, deploy.mjs, deploy.env.example, zumibot.service, nginx-zumibot.conf, Caddyfile, bin/zumibot-server, SETUP-VPS.md
  e2e/      web harness + ported suites
zumi-bot-desktop/  package zumibot
  src/main/  index.ts, window.ts (createWindow from OLD index.ts), servers.ts, localServer.ts, navigation.ts, attachmentsOpen.ts,
             closeFlow.ts, quitGuard.ts, windowState.ts, desktopTheme.ts (moved from OLD/src/main)
  src/preload/index.ts, src/pages/{picker.html,picker.js,error.html,error.js}
  tests/     OLD/tests/main/{closeFlow,quitGuard,windowState,desktopTheme}.test.ts + new
  e2e/local.e2e.mjs, electron-builder.yml, build/ (OLD/build/*)
```

---

## Part A — Monorepo with code moved

### Task 1: Scaffold repo, move shared + backend core, ported tests green

**Files:**
- Create: `./package.json`, `./vitest.config.ts`, `./tsconfig.base.json`, `./.gitignore` (OLD/.gitignore + `zumi-bot-server/deploy/deploy.env`), `zumi-bot-server/shared/{package.json,tsconfig.json,vitest.config.ts}`, `zumi-bot-server/backend/{package.json,tsconfig.json,vitest.config.ts}`
- Copy: `OLD/src/shared/*` → `zumi-bot-server/shared/src/`; `OLD/tests/shared/*` → `zumi-bot-server/shared/tests/`
- Copy: `OLD/src/main/{agents,chat,store,claudeAccount.ts,fsutil.ts,groupMembers.ts}`, `OLD/src/main/attachments/{attachmentStore,content,sniff}.ts` → `zumi-bot-server/backend/src/core/`
- Copy: `OLD/tests/main/*.test.ts`, except `closeFlow`, `quitGuard`, `windowState`, `desktopTheme` and `attachmentProtocol` → `zumi-bot-server/backend/tests/core/`; `OLD/tests/fixtures` → `zumi-bot-server/backend/tests/fixtures`

**Interfaces:**
- Produces: package names `@zumibot/shared` (source-only; `exports: { "./*": "./src/*.ts" }`), `@zumibot/backend`. Backend and frontend import shared as `@zumibot/shared/types`, `@zumibot/shared/attachments` and so on. Rewrite every `../shared/…` / `../../shared/…` import to that form.

- [ ] **Step 1:** `git init -b master` in `./`. Write the root `package.json`: `private: true`, `workspaces`, scripts `test: vitest run`, `typecheck: npm run typecheck --workspaces --if-present`, `build: npm run build -w @zumibot/frontend && npm run build -w @zumibot/backend`. Root `vitest.config.ts` sets `test.projects` to the package folders that exist; Task 11 adds `zumi-bot-desktop`. Each package has its own `vitest.config.ts` with `test.name` set to `shared`, `backend`, `frontend` or `zumibot`, plus `environment: 'node'` and `include: ['tests/**/*.test.ts']`.
- [ ] **Step 2:** Copy the files listed above. Fix imports to `@zumibot/shared/*`. Fix test imports from `../../src/main/…` to `../../src/core/…`.
- [ ] **Step 3:** Run `grep -rn "from 'electron'" zumi-bot-server/backend/src`. Expected: no output (`index.ts`, `ipc.ts`, `devEnv.ts`, `protocol.ts` were not copied).
- [ ] **Step 4:** Run `npm install`, then `npx vitest run --project shared --project backend`. Expected: all ported tests PASS, with the same count as the old repo's matching files.
- [ ] **Step 5:** Run `npm run typecheck`. Expected: exit 0.
- [ ] **Step 6: Checkpoint.**

### Task 2: Move frontend, ported renderer tests green

**Files:**
- Create: `zumi-bot-server/frontend/{package.json,tsconfig.json,vite.config.ts,vitest.config.ts,index.html}`
- Copy: `OLD/src/renderer/src/*` → `zumi-bot-server/frontend/src/`, `OLD/src/renderer/index.html` → `zumi-bot-server/frontend/index.html`, `OLD/tests/renderer/*` → `zumi-bot-server/frontend/tests/`

**Interfaces:**
- Consumes: `@zumibot/shared/*` (rewrite the old `@shared/*` alias imports).
- Produces: `vite build` → `zumi-bot-server/frontend/dist/` (`index.html` + `assets/`). The dev server proxies `/api` and `/ws` (ws: true) to `http://127.0.0.1:${ZUMIBOT_PORT ?? 4317}`.

- [ ] **Step 1:** Copy the files. In `index.html`, delete the CSP `<meta>` (the server sends the CSP header from Task 4).
- [ ] **Step 2:** Run `npx vitest run --project frontend`. Expected: all ported renderer tests PASS.
- [ ] **Step 3:** Run `npm run build -w @zumibot/frontend`. Expected: `dist/index.html` exists. `api.ts` still reads `window.api` at this point; Task 8 replaces it.
- [ ] **Step 4: Checkpoint.**

---

## Part B — Server

### Task 3: Wire protocol, RPC handlers, folder browser, trash

**Files:**
- Create: `zumi-bot-server/shared/src/rpc.ts`, `zumi-bot-server/backend/src/rpc/handlers.ts`, `zumi-bot-server/backend/src/core/folders.ts`, `zumi-bot-server/backend/src/core/trash.ts`, `zumi-bot-server/backend/src/devEnv.ts`
- Modify: `zumi-bot-server/shared/src/types.ts` (API surface below), `zumi-bot-server/shared/src/attachments.ts` (`attachmentUrl`)
- Test: `zumi-bot-server/backend/tests/rpc/handlers.test.ts`, `tests/core/folders.test.ts`, `tests/core/trash.test.ts`, `zumi-bot-server/shared/tests/attachments.test.ts` (update)

**Interfaces:**
- Produces (shared/rpc.ts):
  ```ts
  export type RpcRequest = { id: number; method: string; args: unknown[] }
  export type RpcResponse = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string }
  export type RpcEvent = { event: 'chats:push'; payload: ChatPush } | { event: 'agents:changed'; payload: AgentRename[] }
  export const CLOSE_SIGNED_OUT = 4401
  ```
- Produces (shared/types.ts):
  - `export interface DirListing { path: string; parent: string | null; dirs: string[] }`
  - `export type ServerMode = 'vps' | 'local'`
  - `export type ConnectionStatus = 'connected' | 'reconnecting'`
  - In `ZumiBotApi`:
    - remove `attachments.pathOf` and `attachments.stagePaths`
    - add `session: { mode(): Promise<ServerMode>; signOut(): Promise<void>; signOutEverywhere(): Promise<void> }`
    - add `connection: { onStatus(cb: (s: ConnectionStatus) => void): () => void }`
    - add `desktop: DesktopBridge | null` (type from Task 11; declare it now in `shared/src/desktop.ts`, see Task 11's Interfaces)
    - everything else unchanged
- Produces (shared/attachments.ts): `attachmentUrl(chatId, id)` returns `/api/attachments/staged/<id>` or `/api/attachments/chat/<chatId>/<id>`. Remove `ATTACHMENT_SCHEME`.
- Produces (backend):
  - `export type Handlers = Record<string, (...args: unknown[]) => Promise<unknown>>`
  - `createHandlers(d: HandlerDeps): Handlers`. `HandlerDeps` = OLD `IpcDeps` minus `getWindow` and `setEditorDirty`, `applyTheme` removed, plus `home: string`, `mode: ServerMode`, `testPickFolder: string | null`.
  - `devEnv(name: string): string | undefined` returns `undefined` when `NODE_ENV === 'production'`, otherwise `process.env[name]`. It replaces OLD `devEnv`'s `app.isPackaged` check. `ZUMIBOT_TEST_PICK_FOLDER`, `ZUMIBOT_PERMISSION_MODE` and every other test hook read through it.
  - `listDirs(path: string | null, home: string): Promise<DirListing>`
  - `makeDir(parent: string, name: string): Promise<string>`
  - `trashPath(path: string, home: string, now: () => Date): Promise<void>`

- [ ] **Step 1: Write failing tests.**
  - `handlers.test.ts`:
    - `exposes exactly the kept channels`: the keys equal OLD `ipc.ts` handle channels minus `attachments:stagePaths`, `attachments:pick`, `attachments:open`, `app:pickFolder`, plus `app:folderStart`, `app:mode`, `fs:listDirs`, `fs:makeDir`.
    - `rejects a non-string chatId` (`chats:items` with `5` rejects `/chatId must be a string/`).
    - `app:folderStart returns the fixed folder for Zumi Bot`: `{ fixed: true, path: agentsDir }`.
    - `app:folderStart otherwise starts at last folder or home`: `{ fixed: false, path }`.
    - `app:folderStart returns testPickFolder as fixed when set`.
    - `answering an approval twice is harmless`: the second `chats:answer` for the same request resolves or rejects with an `Error`, never throws synchronously, and leaves the item status from the first answer.
  - `folders.test.ts`:
    - `lists only directories, sorted, hidden ones included` (`['.git', 'a', 'b']` for a tmp tree that also contains files)
    - `parent of / is null`
    - `null path means home`
    - `skips unreadable children`
    - `rejects a path that is not a directory` with `Not a folder: <path>`
    - `makeDir rejects names with / or that are . or ..`
    - `makeDir returns the new absolute path`
  - `trash.test.ts`:
    - `moves the file to <home>/.local/share/Trash/files/<name>`
    - `writes Trash/info/<name>.trashinfo with Path=<url-encoded abs path> and DeletionDate=YYYY-MM-DDTHH:MM:SS`
    - `a second file with the same name gets <stem>.2<ext>`
  - `attachments.test.ts`: the new `attachmentUrl` shapes.
- [ ] **Step 2:** Run `npx vitest run --project backend --project shared`. Expected: the new tests FAIL (modules missing).
- [ ] **Step 3:** Implement `handlers.ts` by moving OLD `ipc.ts`'s handler bodies into an object keyed by the same channel names. Keep `str`, `strings`, `attachmentIds`, `replyTo`, `reaction` and `themePref` as they are. `app:setTheme` only saves (no `applyTheme`). `app:mode` returns `d.mode`. Pass `trashPath` to `AgentStore` as `trashFn`.
- [ ] **Step 4:** Implement `folders.ts` and `trash.ts`. The trash follows the freedesktop spec, and `rename` falls back to copy + unlink on `EXDEV`.
- [ ] **Step 5:** Run the same command. Expected: PASS. Run `npm run typecheck`. Expected: only the frontend errors about the removed `pathOf`/`stagePaths` remain (fixed in Task 9). Note them in the checkpoint report.
- [ ] **Step 6: Checkpoint.**

### Task 4: HTTP server, WebSocket hub, attachments and upload routes

**Files:**
- Create: `zumi-bot-server/backend/src/rpc/hub.ts`, `src/http/{server.ts,headers.ts,attachments.ts,upload.ts,static.ts}`
- Test: `zumi-bot-server/backend/tests/http/{hub.test.ts,attachments.test.ts,upload.test.ts,static.test.ts,headers.test.ts}`
- Port: OLD `tests/main/attachmentProtocol.test.ts` → `tests/http/attachments.test.ts` (same id-strictness cases against `parseAttachmentPath`)

**Interfaces:**
- Consumes: `createHandlers` (Task 3), `AttachmentStore` (`stagedFile`, `chatFile`, `stageBytes`).
- Produces:
  ```ts
  export interface Gate { // filled in by Task 6; tests pass a stub
    authorize(req: IncomingMessage): boolean
    originOk(req: IncomingMessage): boolean
    handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> // auth routes (/login, /api/login…); true = handled
  }
  export function createHub(handlers: Handlers, o?: { pingMs?: number; isValid?(sessionKey: string): Promise<boolean> }): Hub // each ping also re-checks isValid; false → close 4401
  // Hub: attach(ws: WebSocket, sessionKey: string): void; broadcast(e: RpcEvent): void; closeSession(sessionKey: string | 'all'): void; size(): number
  export function createAppServer(o: { gate: Gate; hub: Hub; attachments: AttachmentStore; webDir: string; sessionKey(req: IncomingMessage): string }): http.Server
  export function parseAttachmentPath(pathname: string): { chatId: string | null; id: string } | null
  export const SECURITY_HEADERS: Record<string, string>
  ```
- Routes (pin these):
  - `GET /ws` (upgrade): requires `authorize` + `originOk`, otherwise socket closed with `CLOSE_SIGNED_OUT`.
  - `GET /api/attachments/staged/:id`, `GET /api/attachments/chat/:chatId/:id`, both with `?download=1` optional.
  - `HEAD` of the same paths: 200 or 404 (used by "open").
  - `POST /api/attachments/stage`: header `X-File-Name` (URI-encoded), raw body, answers `StageResult` JSON. Over `ATTACH_MAX_BYTES` gives 413 with `{ ok: false, name, error: stageErrors.tooBig(name) }`, aborted early by `Content-Length` or a running count.
  - Everything else under `/api/` gives 404 JSON.
  - Any other `GET` serves from `webDir`, falling back to `index.html`.
  - Every route except the `Gate.handle` routes needs `authorize`. When it fails, `/api/*` gives 401 JSON, and other GETs redirect 302 to `/login`.

- [ ] **Step 1: Write failing tests.**
  - `hub.test.ts` (real server on port 0, `ws` client, stub gate allowing):
    - `answers a request with the handler value`
    - `answers a throwing handler with ok:false and its message`
    - `unknown method gives ok:false "Unknown method: x"`
    - `broadcast reaches two clients`
    - `closeSession(key) closes only that key's sockets with 4401`
    - `closeSession('all') closes all`
    - `a client that stops answering pings is terminated after 2 ping intervals` (pingMs 50)
    - `a socket whose isValid turns false is closed with 4401 at the next ping`
  - `attachments.test.ts`:
    - the ported strict-id cases
    - `serves a png inline with its mime and nosniff`
    - `serves a text file inline as text/plain; charset=utf-8`
    - `serves text/html and image/svg+xml as application/octet-stream with Content-Disposition: attachment`
    - `download=1 forces attachment with the RFC 5987 encoded file name`
    - `HEAD on a missing id is 404`
  - `upload.test.ts`:
    - `stages raw bytes under the decoded X-File-Name`
    - `answers 413 with tooBig for Content-Length > 25 MiB without reading the body`
    - `answers 413 when a chunked body passes the limit`
    - `missing X-File-Name is 400`
  - `static.test.ts`:
    - `serves index.html for /chat/xyz`
    - `rejects ../ traversal with 404`
    - `hashed /assets/* get Cache-Control: public, max-age=31536000, immutable; index.html gets no-cache`
  - `headers.test.ts`:
    - every response carries `SECURITY_HEADERS`: CSP `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`, plus `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Opener-Policy: same-origin`
    - `unauthorized /api/x is 401 JSON, unauthorized / redirects to /login, unauthorized /ws is closed 4401` (stub gate denying)
- [ ] **Step 2:** Run `npx vitest run --project backend tests/http`. Expected: FAIL.
- [ ] **Step 3:** Implement with `node:http` + `ws` (`noServer: true`, handling `upgrade`). Inline mime types: `THUMB_TYPES`, `application/pdf`, `text/plain`. All others are served as an `application/octet-stream` download.
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 5: Auth primitives

**Files:**
- Create: `zumi-bot-server/backend/src/auth/{password.ts,totp.ts,recovery.ts,rateLimit.ts,authStore.ts}`
- Test: `zumi-bot-server/backend/tests/auth/{password,totp,recovery,rateLimit,authStore}.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function hashPassword(pw: string): Promise<string>              // 'scrypt$32768$8$1$<salt b64>$<key b64>', 16-byte salt, 64-byte key, maxmem 64 MiB
  export function verifyPassword(pw: string, stored: string): Promise<boolean> // timingSafeEqual
  export const PASSWORD_MIN = 16
  export function newTotpSecret(): string                                 // base32 of 20 random bytes
  export function totpAt(secret: string, timeMs: number): string           // 6 digits, SHA-1, 30 s step
  export function verifyTotp(secret: string, code: string, nowMs: number, lastStep: number): number | null // matched step in [now-1, now+1] and > lastStep, else null
  export function otpauthUri(secret: string): string                     // otpauth://totp/ZumiBot:zumibot?secret=…&issuer=ZumiBot&algorithm=SHA1&digits=6&period=30
  export function newRecoveryCodes(): { codes: string[]; hashes: string[] } // 10 codes 'XXXXX-XXXXX' (base32 alphabet), sha256 hex of normalized code
  export function normalizeRecovery(input: string): string                // uppercase, strip spaces and dashes
  export function createLimiter(o: { now(): number }): { check(ip: string): { allowed: boolean; retryAfterMs: number }; fail(ip: string): void; succeed(ip: string): void }
  export type Limiter = ReturnType<typeof createLimiter>
  export function sessionKeyOf(token: string): string // sha256 hex; what auth.json stores and what the hub keys sockets by
  export class AuthStore { // <dataDir>/auth.json, written with writeFileAtomic then chmod 0o600; read fresh on every call, so CLI changes apply to the running server at once
    constructor(dataDir: string, now: () => number)
    configured(): Promise<{ password: boolean; totp: boolean }>
    setPassword(hash: string): Promise<void>                    // also revokes all sessions
    setTotp(secret: string, recoveryHashes: string[]): Promise<void> // also revokes all sessions
    checkLogin(password: string, code: string): Promise<boolean> // password + (TOTP or unused recovery code); records lastStep / marks code used
    createSession(): Promise<string>                             // 32 random bytes base64url; stores sha256 hex + expiresAt = now + 30 days
    checkSession(token: string): Promise<boolean>
    checkSessionKey(key: string): Promise<boolean>              // for the hub's re-check
    revokeSession(token: string): Promise<void>
    revokeAll(): Promise<void>
  }
  ```
- Limiter rules (pin): `n` = failures for that IP in the last 15 min (rolling). With `n < 3` there's no wait. With `3 ≤ n < 10`, the next try waits `min(2^(n-3), 60)` s after the last failure. With `n ≥ 10`, the IP is locked 15 min from the 10th failure. Success clears that IP. State is per IP only, so one IP can never lock out another.

- [ ] **Step 1: Write failing tests.**
  - `totp.test.ts`, with RFC 6238 SHA-1 vectors, secret `GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ`:
    - `totpAt(s, 59_000) === '287082'`
    - `totpAt(s, 1111111109_000) === '081804'`
    - `totpAt(s, 1234567890_000) === '005924'`
    - `totpAt(s, 2000000000_000) === '279037'`
    - `verifyTotp accepts ±1 step and rejects ±2`
    - `verifyTotp rejects a step <= lastStep (reuse)`
    - `rejects non-6-digit input`
  - `password.test.ts`:
    - `round-trips`
    - `wrong password is false`
    - `stored format starts with scrypt$32768$8$1$`
    - `two hashes of the same password differ`
    - `garbage stored string is false, not a throw`
  - `recovery.test.ts`:
    - `10 unique codes matching /^[A-Z2-7]{5}-[A-Z2-7]{5}$/`
    - `normalizeRecovery(' abcde-fghij ') === 'ABCDEFGHIJ'`
  - `rateLimit.test.ts`:
    - `after 2 failures still allowed`
    - `after the 3rd, retryAfterMs is 1000`
    - `after the 4th, 2000`
    - `after the 9th, the cap 60000`
    - `the 10th failure locks for 900000`
    - `the lock is per IP (another IP allowed)`
    - `success clears`
    - `failures older than 15 min drop out`
  - `authStore.test.ts`:
    - `file mode is 0o600`
    - `checkLogin needs both password and code`
    - `a recovery code works once`
    - `a TOTP code works once`
    - `sessions expire after 30 days (fake now)`
    - `setPassword revokes sessions`
    - `the file never contains a raw session token` (read the file and assert it doesn't include the returned token)
- [ ] **Step 2:** Run `npx vitest run --project backend tests/auth`. Expected: FAIL.
- [ ] **Step 3:** Implement with `node:crypto` only (`scrypt`, `createHmac('sha1')`, `randomBytes`, `timingSafeEqual`, `createHash('sha256')`).
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 6: Auth wiring, login page, CLI setup commands, config

**Files:**
- Create: `zumi-bot-server/backend/src/auth/{guard.ts,routes.ts}`, `src/http/login/{login.html,login.css,login.js}`, `src/config.ts`
- Create: `src/cli.ts` (commands `set-password` and `setup-2fa` here; `serve` and `busy` come in Task 7)
- Test: `zumi-bot-server/backend/tests/auth/{guard,routes}.test.ts`, `tests/config.test.ts`, `tests/cli.test.ts`

**Interfaces:**
- Consumes: `AuthStore`, `createLimiter`, `Gate` (Task 4), `Hub.closeSession`.
- Produces:
  ```ts
  export interface Config { mode: ServerMode; port: number; dataDir: string; agentsDir: string; webDir: string; origin: string; localSecret: string | null; migrateFrom: string | null }
  export function loadConfig(env: NodeJS.ProcessEnv): Config
  export function createGate(o: { config: Config; auth: AuthStore; limiter: Limiter; hub: () => Hub; log(line: string): void }): Gate & { sessionKey(req: IncomingMessage): string }
  // a failed login logs `login failed from <ip>`, nothing else; app.ts passes the hub isValid = auth.checkSessionKey (vps) or () => true (local)
  ```
- `loadConfig`:
  - `ZUMIBOT_MODE` is `vps` (default) or `local`.
  - `ZUMIBOT_PORT` defaults to 4317 (vps) or 0 (local).
  - `ZUMIBOT_ORIGIN` is required in vps mode, and must be `https://…` with no path. In local mode it is computed after listen as `http://127.0.0.1:<port>`.
  - `ZUMIBOT_LOCAL_SECRET` is required in local mode, at least 32 chars.
  - `ZUMIBOT_AGENTS_DIR` defaults to `~/.claude/agents`.
  - `ZUMIBOT_WEB_DIR` defaults to `<dir of server bundle>/web`.
  - `ZUMIBOT_MIGRATE_FROM` is local mode only.
  - Unknown mode, or a missing required value, throws with a message naming the variable, never its value.
- Cookies:
  - vps: `cb_session=<token>; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`
  - local: `cb_local=<secret>`, compared with `timingSafeEqual`; no login routes exist in local mode
- `sessionKey(req)` is the sha256 of the session cookie, so the hub can close one session's sockets.
- Client IP comes from the single `X-Forwarded-For` value when the socket peer is `127.0.0.1`, otherwise from the socket address.
- `Origin` must equal `config.origin` on the WS upgrade and on every non-GET request. A missing `Origin` on those fails.
- Routes in `routes.ts` (vps mode):
  - `GET /login`, `/login.css`, `/login.js`: served without auth. A signed-in `GET /login` redirects 302 to `/`.
  - `POST /api/login`: JSON `{ password, code }`, max 4 KiB.
    - success: 204 + cookie
    - failure: 401 `{ error: 'Wrong password or code.' }`, never saying which part was wrong
    - limited: 429 `{ error: 'Too many tries. Try again in N seconds.', retryAfterSec }` + `Retry-After`
  - `POST /api/logout`: revokes this session, closes its sockets, clears the cookie, 204.
  - `POST /api/logout-all`: `revokeAll`, `hub.closeSession('all')`, clears the cookie, 204.
- Login page: same look as the app, with tokens copied from `styles.css` (light/dark via `prefers-color-scheme`). Password field, a 6-digit code field (`inputmode=numeric`, `autocomplete=one-time-code`), and a "Use a recovery code" link that swaps in a text field. Errors show inline. On success it goes to `/`. No inline script or style.
- CLI:
  - `zumibot-server set-password [--generate]`
    - prompts twice with hidden input and rejects passwords under `PASSWORD_MIN` with `Use at least 16 characters.`
    - `--generate` prints a 24-char password from `randomBytes` in base64url, once
  - `zumibot-server setup-2fa`
    - prints a terminal QR of `otpauthUri` (`qrcode.toString(uri, { type: 'terminal', small: true })`) and the URI
    - asks for one code and loops until it is valid
    - prints the 10 recovery codes once with `Store these somewhere safe. Each works once.`
    - saves

- [ ] **Step 1: Write failing tests.**
  - `config.test.ts`:
    - `vps without ZUMIBOT_ORIGIN throws naming ZUMIBOT_ORIGIN`
    - `origin with a path throws`
    - `local without a secret throws`
    - `defaults resolve under XDG_DATA_HOME`
    - `error text never includes the secret value`
  - `guard.test.ts`:
    - `no cookie → not authorized`
    - `a valid session authorizes`
    - `an expired session does not`
    - `a wrong Origin on POST fails originOk`
    - `missing Origin on POST fails`
    - `GET without Origin passes originOk`
    - `local mode: the right cb_local authorizes, a wrong one or cb_session does not`
    - `IP from X-Forwarded-For only when the peer is 127.0.0.1`
  - `routes.test.ts` (real server, Task 4's `createAppServer` with the real gate, auth configured in a tmp dir):
    - `every route answers 401/302/4401 without a session`: loop over `/`, `/api/attachments/staged/x`, `POST /api/attachments/stage`, `/ws`
    - `login sets the cookie with exactly the pinned attributes`
    - `wrong code is 401 with the generic message`
    - `after 3 wrong tries, an immediate 4th is 429 with Retry-After 1`
    - `a failed login logs "login failed from <ip>" and the log never contains the submitted password or code`
    - `logout-all closes an open socket with 4401 and the old cookie then gets 401`
    - `set-password through a second AuthStore on the same dir closes an open socket with 4401 within 2 ping intervals` (pingMs 50)
    - `logout clears only its own session`
    - `the login page is served with SECURITY_HEADERS and no session`
    - `local mode has no /login (404) and no /api/login (404)`
  - `cli.test.ts`: run `set-password` with stdin piped and an injected tty-less prompt:
    - `rejects 15 chars with "Use at least 16 characters."`
    - `stores a hash that verifyPassword accepts`
    - `--generate output is 24 chars and is accepted`
- [ ] **Step 2:** Run `npx vitest run --project backend tests/auth tests/config.test.ts tests/cli.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. `setup-2fa` is tested by hand in Task 14, not in CI.
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 7: Server entry: wiring, data lock, control socket, migration, shutdown

**Files:**
- Create: `zumi-bot-server/backend/src/{app.ts,lock.ts,control.ts,migrate.ts}`, `vite.config.ts` (SSR build)
- Modify: `src/cli.ts` (add `serve` (default) and `busy`), `zumi-bot-server/backend/package.json` (`exports: { "./control": "./src/control.ts" }`, so the desktop can bundle `queryBusy`)
- Test: `zumi-bot-server/backend/tests/{lock,control,migrate,app}.test.ts`

**Interfaces:**
- Consumes: everything above. Copy OLD `index.ts` `start()` service wiring: `createClaudeLocator`, `createRunEnv`, `ChatService`, `GroupService`, `createAgentsSync`, `AccountService`, `recoverInterrupted`, `clearStaged`, `agents.watch`.
- Produces:
  ```ts
  export function startServer(config: Config): Promise<{ port: number; origin: string; close(): Promise<void> }> // app.ts
  export function acquireDataLock(dataDir: string): Promise<() => Promise<void>> // lock.ts; <dataDir>/server.lock with pid; a stale pid (not alive) is taken over
  export function serveControl(sockPath: string, o: { busy(): number }): Promise<() => Promise<void>> // control.ts; unix socket, mode 0o600; line 'busy' → '<n>\n'
  export function queryBusy(sockPath: string, timeoutMs?: number): Promise<number>  // rejects when no server
  export function migrateFromDesktop(from: string, to: string): Promise<string[]>   // migrate.ts; returns copied entry names
  ```
- `CONTROL_SOCK = '<dataDir>/control.sock'`.
- `push` → `hub.broadcast({ event: 'chats:push', payload })`. Agents sync `notify` → `hub.broadcast({ event: 'agents:changed', payload })`.
- In vps mode, `startServer` refuses (throws `Run "zumibot-server set-password" and "zumibot-server setup-2fa" first.`) unless both are configured.
- On listen, print exactly `LISTENING <port>` to stdout. The desktop parses it.
- `SIGTERM`/`SIGINT`:
  - `chatService.stopAll()`
  - close the hub sockets with 1001
  - close the server and the control socket
  - release the lock
  - exit 0, within 10 s
- `busy()` = `chatService.runningCount()`.
- Migration (local mode only, when `migrateFrom` is set):
  - runs before the stores load, only when `<to>/chats.json` is missing
  - copies whichever of `chats.json`, `chats/`, `settings.json`, `usage.json`, `attachments/` exist, recursively, with `fs.cp({ recursive: true, errorOnExist: true, force: false })`
  - never touches `from`
- The backend build is `vite build --ssr src/cli.ts` with `ssr.noExternal: true`, giving one ESM file `dist/server.mjs` with the dependencies bundled and a `#!/usr/bin/env node` banner. The build also copies `src/http/login/*` → `dist/login/`, and `../frontend/dist` → `dist/web/` (the root `build` script builds frontend first). *(This bundles deps, so the VPS needs no `npm install`. Spec §9's "installs production dependencies" step goes away. The intent is unchanged.)*

- [ ] **Step 1: Write failing tests.**
  - `lock.test.ts`:
    - `second acquire rejects "Another ZumiBot server is using <dir>"`
    - `a stale lock with a dead pid is taken over`
    - `release removes the file`
  - `control.test.ts`:
    - `queryBusy returns busy()`
    - `socket mode is 0o600`
    - `queryBusy rejects when no server`
  - `migrate.test.ts`:
    - `copies existing entries only`
    - `source tree unchanged byte-for-byte (hash before/after)`
    - `skips when target chats.json exists`
    - `never overwrites a target file`
  - `app.test.ts` (fake claude from `tests/fixtures/fake-claude.mjs` via `settings.claudePath` in a tmp data dir, local mode):
    - `prints LISTENING <port>`
    - `a ws client sends chats:create + chats:send and receives chats:push deltas then an items push`
    - `a chat marked inFlight in chats.json on start is recovered as interrupted`
    - `SIGTERM while a reply streams stops it, marks the chat stopped, exits 0`
    - `vps mode without auth refuses with the pinned message`
- [ ] **Step 2:** Run `npx vitest run --project backend tests/lock.test.ts tests/control.test.ts tests/migrate.test.ts tests/app.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run again. Expected: PASS. Run `npm run build -w @zumibot/backend`. Expected: `dist/server.mjs`, `dist/login/`, `dist/web/index.html`.
- [ ] **Step 5:** Smoke test by hand:
  - `ZUMIBOT_MODE=local ZUMIBOT_LOCAL_SECRET=$(openssl rand -hex 32) ZUMIBOT_DATA_DIR=$(mktemp -d) node zumi-bot-server/backend/dist/server.mjs` prints `LISTENING <n>`
  - `curl -i http://127.0.0.1:<n>/api/x` gives 401
  - Ctrl+C exits 0
- [ ] **Step 6: Checkpoint.**

---

## Part C — Frontend on the web

### Task 8: RPC client, `ZumiBotApi` over WebSocket, reconnect and resync

**Files:**
- Create: `zumi-bot-server/frontend/src/net/{rpc.ts,api.ts,upload.ts}`, `src/components/ConnectionBar.tsx`
- Modify: `src/api.ts` (export `api = createApi(createRpcClient(...), …)`), `src/App.tsx` (connection status + resync), `src/styles.css` (`.connection-bar`)
- Test: `zumi-bot-server/frontend/tests/net/{rpc,api,upload}.test.ts`

**Interfaces:**
- Consumes: shared `rpc.ts` types, `CLOSE_SIGNED_OUT`.
- Produces:
  ```ts
  export function createRpcClient(o: { url: string; WebSocketImpl?: typeof WebSocket; onSignedOut(): void; backoffMs?: (attempt: number) => number }): RpcClient
  // RpcClient: call(method: string, args: unknown[]): Promise<unknown>; on(event: RpcEvent['event'], cb: (payload: never) => void): () => void; onStatus(cb: (s: ConnectionStatus) => void): () => void; status(): ConnectionStatus
  export type FolderPickerOpener = (start: string) => Promise<string | null> // net/api.ts; Task 9 implements it
  export function createApi(rpc: RpcClient, o: { fetch: typeof fetch; desktop: DesktopBridge | null; openWindow(url: string): void; folderPicker: FolderPickerOpener; filePicker(): Promise<File[]> }): ZumiBotApi
  export function uploadFile(fetchImpl: typeof fetch, name: string, bytes: Uint8Array): Promise<StageResult> // upload.ts
  ```
- Backoff: `min(500 * 2^attempt, 10000)` ms. A `call` made while not connected rejects at once with `Error('Not connected. Reconnecting…')`. Pending calls reject with the same error when the socket drops. A close with code 4401 calls `onSignedOut`, which saves nothing and runs `location.assign('/login')` (drafts already persist through the existing draft storage). Check that `App.tsx`'s draft persistence survives a reload. If it doesn't, persist drafts to `sessionStorage` under `zumibot:drafts` in this task.
- `uploadFile`:
  - 413 (any body) → `{ ok: false, name, error: stageErrors.tooBig(name) }`
  - other non-2xx → `stageErrors.unreadable(name)`
  - 401 → `onSignedOut` path (location to `/login`)
- `createApi` maps every remaining `ZumiBotApi` method to `rpc.call('<channel>', args)` using the old preload's channel names verbatim, with these exceptions:
  - `attachments.open` and `attachments.pick` come in Task 9
  - `app.pickFolder` → Task 9
  - `app.setEditorDirty` / `onSaveBeforeClose` → Task 9
  - `session.*`: `mode` → `app:mode`; `signOut` → `POST /api/logout` then `/login`; `signOutEverywhere` → `POST /api/logout-all` then `/login`
- Resync in `App.tsx`: on `reconnecting` → `connected`, rerun the chat list load, `refreshAgents`, `loadAccount`, and reload the open chat's items (`chats.items`). Rendering `ConnectionBar` ("Reconnecting…") disables send while not connected.

- [ ] **Step 1: Write failing tests** (fake WebSocket class in the test):
  - `rpc.test.ts`:
    - `call resolves with value`
    - `call rejects with server error text`
    - `events reach on() subscribers`
    - `drop → status reconnecting, pending calls reject "Not connected. Reconnecting…"`
    - `reconnects with 500, 1000, 2000 … capped 10000`
    - `close 4401 calls onSignedOut and does not reconnect`
    - `back to connected emits connected once`
  - `upload.test.ts`:
    - `413 with an HTML body maps to "<name> is over 25 MB"`
    - `sends X-File-Name URI-encoded`
    - `500 → "<name> couldn't be read"`
  - `api.test.ts`:
    - `chats.send forwards (chatId, text, ids, replyTo) to "chats:send"`
    - `agents.onChanged subscribes to agents:changed and defaults to []`
    - `session.signOutEverywhere posts /api/logout-all`
- [ ] **Step 2:** Run `npx vitest run --project frontend tests/net`. Expected: FAIL.
- [ ] **Step 3:** Implement. `api.ts` builds the WS URL from `location` (`wss:` on https, else `ws:`, path `/ws`).
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 9: Web replacements in the UI

**Files:**
- Create: `zumi-bot-server/frontend/src/net/folderPicker.ts`, `src/components/FolderPicker.tsx`, `src/theme.ts`
- Modify:
  - `src/net/api.ts` (`app.pickFolder`, `attachments.pick`, `attachments.open`, `app.setEditorDirty`, `app.onSaveBeforeClose`)
  - `src/App.tsx` (`addFiles(key, files, origin)`, drop `addPaths`, theme apply, mount `FolderPicker`)
  - `src/components/{Composer.tsx,ChatView.tsx,NewChatView.tsx,DropZone.tsx}` (drop `onAddPaths` and the `text/uri-list` paste branch, pass origin)
  - `src/components/AccountMenu.tsx` ("Sign out", "Sign out everywhere" when `session.mode() === 'vps'`; "Switch server…" when `api.desktop`)
  - `src/styles.css` (data-theme overrides)
- Test: `zumi-bot-server/frontend/tests/{folderPicker,theme,draftFiles,markdownLinks}.test.ts`

**Interfaces:**
- Consumes: RPC `app:folderStart` → `{ fixed: boolean; path: string }`, `fs:listDirs`, `fs:makeDir` (Task 3). `uploadFile` (Task 8).
- Produces:
  ```ts
  export function folderPickerReducer(s: PickerState, a: PickerAction): PickerState // pure; folderPicker.ts
  export function applyTheme(pref: ThemePref, root?: HTMLElement): void            // theme.ts: sets root.dataset.theme = pref ('system' removes it)
  ```
- `app.pickFolder(agentName)`: calls `app:folderStart`. `fixed` → return `path`. Otherwise it opens `FolderPicker` at `path` and resolves with the chosen folder or `null`. The picker:
  - lists the folders with `fs:listDirs`, with Up and a path breadcrumb
  - has a "Show hidden" toggle, off by default, which hides dot-folders
  - has "New folder" (name field, then `fs:makeDir`, then it navigates into the new folder)
  - has Cancel and "Use this folder"
  - uses the existing `ConfirmDialog` look (spec §11)
- `attachments.pick()`: a hidden `<input type=file multiple>`. Each file goes through `uploadFile` with its own name. Files over `ATTACH_MAX_FILES` come back as `{ ok: false, name, error: stageErrors.TOO_MANY }`, the same as OLD `ipc.ts`.
- `attachments.open(chatId, id)`:
  - `HEAD` the URL; 404 → `false`
  - else desktop bridge → `desktop.openAttachment(url, name)`, otherwise `openWindow(url)`
  - return `true`
  - `SentAttachments` must pass the name, so change `open(chatId, id)` → `open(chatId, id, name)` in `ZumiBotApi` and its one caller.
- `addFiles(key, files, origin: 'paste' | 'drop' | 'pick')`: `paste` → `pastedName(new Date(), file.type)`, others → `file.name`. Pasting `text/uri-list` now pastes as text. *(My call: those paths are on the PC, so the server can't read them.)*
- Links in replies: the `a` renderer in the markdown `components` map renders `target="_blank" rel="noopener noreferrer"` (replacing OLD `shell.openExternal`). In the desktop shell, the popup handler sends those to the system browser.
- Editor dirty: in the browser, set `window.onbeforeunload` while dirty. With `api.desktop`, forward to `desktop.setEditorDirty` / `desktop.onSaveBeforeClose`.
- Theme:
  - On load and after `setTheme`, `applyTheme(t)` and `desktop?.setTheme(t)`.
  - CSS: every `@media (prefers-color-scheme: dark) { :root {…} }` block and the `.bot-img-*` rules become `@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) {…} }` plus `:root[data-theme='dark'] {…}` with the same tokens.
  - `color-scheme` follows: `:root[data-theme='light'] { color-scheme: light }` and `:root[data-theme='dark'] { color-scheme: dark }`.

- [ ] **Step 1: Write failing tests.**
  - `folderPicker.test.ts`:
    - `navigating into a dir sets path and clears selection`
    - `Up from / is disabled`
    - `hidden folders filtered unless showHidden`
    - `New folder with "a/b" shows the server error inline`
    - `Use this folder resolves current path`
  - `theme.test.ts` (jsdom-free: pass a fake `{ dataset: {} }`):
    - `dark sets data-theme=dark`
    - `system removes data-theme`
    - also read `src/styles.css` as text and assert that every `prefers-color-scheme: dark` rule has a matching `[data-theme='dark']` rule (count equal)
  - `draftFiles.test.ts` (extend): `paste origin names the file pasted-YYYYMMDD-HHMMSS.png; drop keeps file.name`
  - `markdownLinks.test.ts`: `renderToStaticMarkup` of an assistant message with `[x](https://example.com)` contains `target="_blank"` and `rel="noopener noreferrer"`
- [ ] **Step 2:** Run `npx vitest run --project frontend`. Expected: the new tests FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run --project frontend && npm run typecheck`. Expected: PASS, exit 0 (Task 3's typecheck errors are gone).
- [ ] **Step 5: Checkpoint.**

### Task 10: Web end-to-end

**Files:**
- Create: `zumi-bot-server/e2e/{harness.mjs,web.e2e.mjs,auth.e2e.mjs,resilience.e2e.mjs}`
- Port: `OLD/e2e/app.e2e.mjs`, `zumiBot.e2e.mjs`, `group.e2e.mjs`, `shot.mjs` → `zumi-bot-server/e2e/`, swapping `launch()` for `harness.start()`
- Modify: root `package.json` scripts: `e2e`, `e2e:auth`, `e2e:resilience`, `e2e:zumi-bot`, `e2e:group`, `shot` (each runs `npm run build` first)

**Interfaces:**
- Produces:
  ```js
  // harness.mjs
  export async function start({ mode = 'local', dataDir, agentsDir, env = {} }) // spawns dist/server.mjs, waits for LISTENING, launches chromium.launch({ channel: 'chrome' }), sets the cb_local cookie (local) or signs in (vps); returns { page, browser, origin, server, errors, newPage(), restartServer(), stop() }
  ```
  - vps-mode e2e runs with `ZUMIBOT_ORIGIN=http://127.0.0.1:<port>`, allowed only when `NODE_ENV=test`. The cookie drops `Secure` only in that case.
  - `stop()` closes the browser and kills the server, always in `finally` (user rule: no stray processes).
- Ported suites keep their hard rules verbatim (a `zumibot-test` agent only, real Haiku, trash never rm). `ZUMIBOT_TEST_PICK_FOLDER` / `ZUMIBOT_TEST_PICK_FILES` become server env (folderStart fixed) and Playwright `setInputFiles` on the hidden input.

- [ ] **Step 1: Write the suites.**
  - `auth.e2e.mjs` (vps mode, fake claude):
    - wrong code shows `Wrong password or code.`
    - right password + `totpAt(secret, Date.now())` reaches the sidebar
    - "Sign out everywhere" in tab A sends tab B to `/login` within 2 s, and B's composer draft is back after signing in again
  - `resilience.e2e.mjs` (local mode, fake claude with a slow script):
    - two tabs show the same streaming text
    - closing the only tab mid-reply, then opening a new one, shows the reply further along or finished (the run kept going). A page reload mid-reply shows the same.
    - an approval answered in tab A shows answered in tab B
    - `restartServer()` mid-reply: both tabs show "Reconnecting…", then the chat shows the `interrupted` notice and no spinner, with send enabled again
    - an upload of 26 MB shows `… is over 25 MB`
    - an uploaded `x.html`, when opened, triggers a download (Playwright `download` event), not a page
    - theme Dark with `colorScheme: 'light'` emulated gives a body background of `rgb(18, 18, 18)`; Light with dark emulated gives `rgb(255, 255, 255)`
  - `web.e2e.mjs` = ported `app.e2e.mjs` steps.
- [ ] **Step 2:** Run `npm run e2e:auth && npm run e2e:resilience`. Expected: every step logs PASS, exit 0. Then `npm run e2e`, `npm run e2e:zumi-bot` and `npm run e2e:group` (real Haiku). Expected: PASS.
- [ ] **Step 3:** Run `pgrep -fa 'chrome|server.mjs'`. Expected: nothing left from the run.
- [ ] **Step 4:** Run `npm run shot` and compare against OLD screenshots of the same fixture (`e2e/fixtures/group-shot`). Expected: same layout, light and dark.
- [ ] **Step 5: Checkpoint.**

---

## Part D — Desktop shell

### Task 11: Electron shell: server choice, local server, window, bridge

**Files:**
- Create: `zumi-bot-desktop/{package.json,electron.vite.config.ts,tsconfig.json,vitest.config.ts}`, `src/main/{index.ts,window.ts,servers.ts,localServer.ts,navigation.ts,attachmentsOpen.ts}`, `src/preload/index.ts`, `src/pages/{picker.html,picker.js,picker.css,error.html,error.js}`, `zumi-bot-server/shared/src/desktop.ts`
- Move: `OLD/src/main/{closeFlow,quitGuard,windowState,desktopTheme}.ts` → `zumi-bot-desktop/src/main/`, and their OLD tests → `zumi-bot-desktop/tests/`
- Test: `zumi-bot-desktop/tests/{servers,localServer,navigation}.test.ts` + moved tests

**Interfaces:**
- Produces (shared/desktop.ts):
  ```ts
  export interface DesktopBridge {
    mode: ServerMode
    switchServer(): void
    setEditorDirty(dirty: boolean): void
    onSaveBeforeClose(cb: () => Promise<boolean>): () => void
    setTheme(t: ThemePref): void
    openAttachment(url: string, name: string): Promise<boolean>
  }
  // exposed as window.zumibotDesktop; the frontend reads it once into api.desktop
  ```
- Produces (desktop):
  ```ts
  export type ServerChoice = { kind: 'local' } | { kind: 'vps'; url: string }
  export function parseServerChoice(raw: unknown): ServerChoice | null         // vps url must be https:// origin only; http only for 127.0.0.1/localhost when !app.isPackaged
  export function loadServerChoice(file: string): ServerChoice | null; export function saveServerChoice(file: string, c: ServerChoice): void // <userData>/server.json
  export function startLocalServer(o: { node: string; entry: string; env: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<{ origin: string; secret: string; stop(): Promise<void>; busy(): Promise<number> }>
  export function isSameOrigin(url: string, origin: string): boolean           // navigation.ts
  ```
- `startLocalServer` details:
  - spawns `process.execPath` with `ELECTRON_RUN_AS_NODE=1`
  - `entry` = `<resources>/server/server.mjs` packaged, or `../zumi-bot-server/backend/dist/server.mjs` in dev
  - env: `ZUMIBOT_MODE=local`, `ZUMIBOT_LOCAL_SECRET=<randomBytes(32) hex>`, `ZUMIBOT_MIGRATE_FROM=<app.getPath('userData')>` (that is, `~/.config/ZumiBot`, where the old app kept its data), and `NODE_ENV=production` when `app.isPackaged`
  - waits up to 15 s for the `LISTENING <port>` line; on a timeout or early exit, rejects with the last 20 stderr lines
  - `busy()` = `queryBusy('<dataDir>/control.sock')`, imported from `@zumibot/backend/control`
  - `stop()` sends SIGTERM and waits for exit, SIGKILL after 10 s
- Startup:
  - single-instance lock
  - `Menu.setApplicationMenu(null)`
  - choice = `loadServerChoice`. Null → load `picker.html` (Local / VPS with URL prefilled `https://zumibot.mhdaljuboori.me`). Its preload bridge `pickServer(choice)` saves and continues.
  - Local → `startLocalServer`, then `session.defaultSession.cookies.set({ url: origin, name: 'cb_local', value: secret, httpOnly: true, sameSite: 'strict' })`, then `loadURL(origin)`
  - VPS → `loadURL(url)`
  - `did-fail-load` on the main frame → `error.html` with Retry (reload the origin) and Switch server (picker)
- Window (`window.ts` = OLD `createWindow`, adapted):
  - keeps the show gate, the window state (`<userData>/window-state.json`, so the old app's saved size carries over), minWidth/minHeight, and `contextIsolation` / `sandbox` / `nodeIntegration: false`
  - `will-navigate` and `setWindowOpenHandler`: same origin → allow navigate / deny popup; other web URLs → `shell.openExternal`; anything else denied
  - close flow:
    - `getState` = `{ editorDirty, runningCount: local ? await busy() : 0 }`. `createCloseFlow`'s `getState` is sync, so the shell caches `busy()`, refreshed every 2 s while Local.
    - `stopAll` = `localServer.stop()`
- Preload:
  - exposes `zumibotDesktop` only when `location.origin` equals the connected origin, passed via `webPreferences.additionalArguments: ['--zumibot-origin=<origin>']`
  - `setTheme` → main sets `nativeTheme.themeSource` and saves the last theme to `<userData>/server.json` (`lastTheme`) so the next start paints in it
- `switchServer`: if Local and `busy() > 0`, show the quit-guard message (`runningMessage(n)`, buttons Cancel / Stop & Switch). Then stop the local server if any, and open the picker.
- `openAttachment(url, name)`: `session.downloadURL` into `app.getPath('temp')/zumibot-<random>/<name>`, then `shell.openPath`. Returns false on HTTP 404.

- [ ] **Step 1: Write failing tests.**
  - `servers.test.ts`:
    - `accepts {kind:'vps', url:'https://zumibot.mhdaljuboori.me'}`
    - `rejects a url with a path`
    - `rejects http://example.com`
    - `rejects garbage → null`
    - `round-trips through the file`
  - `navigation.test.ts`:
    - `same origin true`
    - `different port false`
    - `https vs http false`
    - `javascript: false`
  - `localServer.test.ts` (a tiny fake server script printing `LISTENING 1234`; one exiting early with stderr):
    - `resolves origin http://127.0.0.1:1234 and a 64-hex secret`
    - `rejects with stderr tail on early exit`
    - `rejects after timeoutMs with no LISTENING`
    - `the secret is never in the rejection text`
  - The moved OLD tests pass unchanged.
- [ ] **Step 2:** Add `zumi-bot-desktop` to the root `vitest.config.ts` `test.projects`. Run `npx vitest run --project zumibot`. Expected: the new tests FAIL, the moved ones PASS.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run again. Expected: PASS. Run `npm run typecheck`. Expected: exit 0.
- [ ] **Step 5:** Manual run: `npm run build && npm run dev -w zumibot`. Pick Local, and the sidebar shows chats migrated from `~/.config/ZumiBot` (your real ones; this only copies). Quit with a reply running and the guard asks.
- [ ] **Step 6: Checkpoint.**

### Task 12: Packaging and desktop e2e

**Files:**
- Create: `zumi-bot-desktop/electron-builder.yml`, `zumi-bot-desktop/e2e/local.e2e.mjs`; copy `OLD/build/*` → `zumi-bot-desktop/build/`, `OLD/scripts/make-icon.mjs` → `zumi-bot-desktop/scripts/`
- Modify: `zumi-bot-desktop/package.json` (`version: 1.0.0`, scripts `dist`, `e2e`)

**Interfaces:**
- Consumes: `zumi-bot-server/backend/dist/` (server.mjs, login/, web/).
- `electron-builder.yml`: the OLD values (`appId`, `productName`, `linux.target: deb`, `category`, `icon`, `executableName: zumibot`, `synopsis`, `artifactName: ZumiBot_${version}_${arch}.${ext}`) plus `extraResources: [{ from: ../zumi-bot-server/backend/dist, to: server }]`.

- [ ] **Step 1: Write `local.e2e.mjs`.**
  - It launches the packaged-layout build with `_electron.launch`, a tmp `HOME`-like setup (`ZUMIBOT_DATA_DIR` tmp, `XDG_CONFIG_HOME` tmp) and a pre-written `server.json` `{kind:'local'}`.
  - `userData` is seeded from `OLD/e2e/fixtures/group-shot/userData` as the "old app" data.
  - Asserts:
    - the sidebar shows the fixture's group and single chats (migration)
    - the fixture files are byte-identical after the run
    - "Switch server…" exists in the account menu, and "Sign out" doesn't
    - closing the window ends the server process (pid gone)
- [ ] **Step 2:** Run `npm run e2e -w zumibot`. Expected: PASS, and no leftover `server.mjs` or electron processes (`pgrep -fa`).
- [ ] **Step 3:** Run `npm run dist -w zumibot`. Expected: `zumi-bot-desktop/dist/ZumiBot_1.0.0_amd64.deb`. Run `dpkg-deb -I` on it. Expected: `Package: zumibot`, `Version: 1.0.0`.
- [ ] **Step 4:** Ask the user before installing the `.deb` over the current app (it replaces ZumiBot 0.12.0). If they say yes: `sudo apt install ./…deb`, launch from GNOME, pick Local, and confirm the real chats appear.
- [ ] **Step 5: Checkpoint.**

---

## Part E — VPS

### Task 13: Deploy kit

**Files:**
- Create: `zumi-bot-server/deploy/{deploy.sh,deploy.mjs,deploy.env.example,zumibot.service,nginx-zumibot.conf,Caddyfile,bin/zumibot-server,SETUP-VPS.md}`
- Test: `zumi-bot-server/backend/tests/deploy.test.ts` (imports `deploy.mjs`)

**Interfaces:**
- Produces:
  ```js
  // deploy.mjs
  export async function deploy({ argv, env, run, log }) // run(cmd: string, args: string[], opts?) → { code, stdout, stderr }; injectable for tests
  ```
- `deploy.env` (git-ignored; example committed): `VPS_HOST`, `VPS_USER`, `VPS_DIR` (default `/home/$VPS_USER/zumibot`).
- Steps `deploy()` runs, in order:
  1. `npm run build` locally
  2. `ssh $VPS_USER@$VPS_HOST "$VPS_DIR/bin/zumibot-server busy"`. A number > 0 without `--force` → stop with `N replies running on the VPS. Re-run with --force to interrupt them.` and exit 1. A non-zero exit (no server yet) counts as 0.
  3. `rsync -az --delete zumi-bot-server/backend/dist/ $host:$VPS_DIR/app/` and `rsync deploy/bin/ $host:$VPS_DIR/bin/`
  4. agents, first time only:
     - `ssh … 'ls ~/.claude/agents/*.md 2>/dev/null | wc -l'`
     - if 0: `mkdir -p ~/.claude/agents` remotely, then `rsync` each local `~/.claude/agents/*.md` except `zumi-bot.md`
     - then log `Copied N agents. Set up the MCP servers, skills and plugins they need on the VPS yourself.`
  5. `ssh … sudo systemctl restart zumibot`
  6. poll `zumibot-server busy` for up to 20 s until it answers, else exit 1 with `journalctl -u zumibot -n 50`
  7. log `Deployed to https://zumibot.mhdaljuboori.me`
- `bin/zumibot-server`: `#!/bin/sh` + `exec node "$(dirname "$0")/../app/server.mjs" "$@"`.
- `zumibot.service`:
  - `User=%i`-free, a fixed `User=<VPS_USER>` filled in at setup
  - `Environment=NODE_ENV=production ZUMIBOT_MODE=vps ZUMIBOT_ORIGIN=https://zumibot.mhdaljuboori.me ZUMIBOT_PORT=4317`
  - `ExecStart=<VPS_DIR>/bin/zumibot-server`
  - `Restart=on-failure`, `KillSignal=SIGTERM`, `TimeoutStopSec=15`
  - `NoNewPrivileges=true`, `PrivateTmp=true`
  - `WantedBy=multi-user.target`
- `nginx-zumibot.conf`:
  - `server_name zumibot.mhdaljuboori.me`
  - `client_max_body_size 26m`
  - `proxy_pass http://127.0.0.1:4317`
  - `proxy_http_version 1.1`
  - `proxy_set_header Upgrade $http_upgrade`, `proxy_set_header Connection "upgrade"`, `proxy_set_header Host $host`, `proxy_set_header X-Forwarded-For $remote_addr` (overwrite, single value)
  - `proxy_read_timeout 3600s`
  - `add_header Strict-Transport-Security "max-age=31536000" always`
  - certbot adds the TLS lines
- `Caddyfile`: `zumibot.mhdaljuboori.me { request_body { max_size 26MB } header Strict-Transport-Security "max-age=31536000" reverse_proxy 127.0.0.1:4317 { header_up X-Forwarded-For {remote_host} } }`.
- `SETUP-VPS.md`, the one-time runbook in order. Steps marked **(you)** need the user:
  1. **(you)** DNS A (and AAAA) record `zumibot` → VPS IP
  2. non-root user, if none
  3. Node 22 via NodeSource, plus `rsync`
  4. **(you)** `npm i -g @anthropic-ai/claude-code`, then `claude` and sign in, as that user
  5. `timedatectl` shows the clock synced (TOTP needs it)
  6. `ufw allow OpenSSH, 80, 443; ufw enable`
  7. the proxy: nginx if `systemctl is-active nginx`, else Caddy
  8. install the systemd unit and `systemctl enable`
  9. first `deploy.sh`
  10. **(you)** `zumibot-server set-password`, then **(you)** `zumibot-server setup-2fa` (scan the QR, keep the recovery codes)
  11. `systemctl restart zumibot`
  12. **(you)** clone the repos the agents will work in
  13. check RAM with `free -m`; under 2 GB, tell the user before the first group run

- [ ] **Step 1: Write failing tests** in `deploy.test.ts`, with a fake `run` recording calls:
  - `busy 2 without --force exits 1 with the pinned message and never rsyncs`
  - `busy 2 with --force continues`
  - `remote agent count 0 copies every local .md except zumi-bot.md and logs the reminder`
  - `remote agent count 3 copies none`
  - `failed restart health check exits 1 and prints journal tail`
  - `missing VPS_HOST exits 1 naming deploy.env`
- [ ] **Step 2:** Run `npx vitest run --project backend tests/deploy.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. `deploy.sh` is `#!/usr/bin/env bash` + `set -euo pipefail` + `exec node "$(dirname "$0")/deploy.mjs" "$@"`.
- [ ] **Step 4:** Run again. Expected: PASS. Run `bash -n zumi-bot-server/deploy/deploy.sh` and `nginx -t -c` on a temp config wrapper if nginx is installed locally (otherwise skip and say so).
- [ ] **Step 5: Checkpoint.**

### Task 14: First deploy (with the user)

**Files:** `zumi-bot-server/deploy/deploy.env` (local, git-ignored), the VPS.

- [ ] **Step 1:** Ask the user for `VPS_HOST` and `VPS_USER`, and confirm that `ssh $VPS_USER@$VPS_HOST` works without a password prompt. Write `deploy.env`.
- [ ] **Step 2:** Over SSH, check: `lsb_release -a` (Ubuntu), `node -v`, `systemctl is-active nginx`, `free -m`, `timedatectl`. Report the results, choose nginx or Caddy per §9, and tell the user if RAM is under 2 GB.
- [ ] **Step 3:** Walk `SETUP-VPS.md` in order. Run the non-**(you)** steps over SSH, asking before each `sudo` step. Pause for each **(you)** step.
- [ ] **Step 4:** After the user's `set-password` + `setup-2fa`, restart and verify from the PC:
  - `curl -sI https://zumibot.mhdaljuboori.me/` gives `302 /login` with HSTS and the CSP header
  - `curl -s -o /dev/null -w '%{http_code}' https://zumibot.mhdaljuboori.me/api/x` gives `401`
  - `curl -sI http://zumibot.mhdaljuboori.me/` redirects to https
  - `nc -zv <VPS_IP> 4317` fails from the PC (the port isn't public)
- [ ] **Step 5:** The user signs in at `https://zumibot.mhdaljuboori.me` with password + code. Then: start a chat with an agent in a VPS repo, close the tab mid-reply, reopen it, and check the reply kept going. Then try the desktop shell: Switch server → VPS, sign in, and see the same chats.
- [ ] **Step 6: Checkpoint.** Report the URL, the proxy chosen, the RAM, and anything from the runbook that was skipped.
