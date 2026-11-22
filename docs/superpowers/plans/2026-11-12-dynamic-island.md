# Dynamic Island Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An always-on-top strip of the user's picked agents on the right edge of every workspace, opening a compact chat popup, with the shell living in the tray and starting at login.

**Architecture:** The shell gets a second frameless, transparent `BrowserWindow` that loads `<server origin>/island` (the SPA already serves any path) with its own narrow preload bridge, `zumibotIsland`. The frontend's `App` renders an island layout when it runs at `/island` with that bridge, reusing its own chat wiring and `ChatView` in a new `compact` mode. The main process owns placement (pure geometry, `setBounds` plus `setShape` so the gaps stay click-through), the tray, hide-on-close, the quit flow, the autostart entry and a quiet start that retries.

**Tech Stack:** Electron 45 (`Tray`, `BrowserWindow.setShape`, `setVisibleOnAllWorkspaces`), React 19, TypeScript, vitest, playwright-core's `_electron` for the desktop e2e.

**Spec:** `docs/superpowers/specs/2026-11-12-dynamic-island-design.md` (read it first; "My calls" there are binding).

## Global Constraints

- Never commit. The user's global rule: no git commit unless they ask. There are no commit steps; leave changes in the working tree.
- Worktree: before typecheck or build, the worktree needs `node_modules` linked to the main checkout (memory note "worktree build links"); check `ls node_modules` at the repo root first.
- Run commands from the repo root. Tests: `npx vitest run <file>`; all: `npm test`; types: `npm run typecheck`.
- No `+` button on the island. No island at all when no valid agent is picked.
- Single chats only; an agent's island chats exclude archived, A→B (`asked`) and workflow (`workflow`, `workflowTest`) chats. Routine chats count.
- Island agents at most 10 (`ISLAND_AGENTS_MAX`), recent chats in ⋯ at most 8 (`RECENT_MAX`).
- Quiet start retries every 10 s (`QUIET_RETRY_MS = 10_000`) for up to 2 minutes (`QUIET_WINDOW_MS = 120_000`), then shows the main window; a `/login` page shows it at once.
- Start at login defaults on; the autostart entry is only written by a packaged app (`app.isPackaged`), at `$XDG_CONFIG_HOME/autostart/zumibot.desktop` (default `~/.config`), with `Exec` ending in ` --hidden`.
- Security: the island page never gets `zumibotDesktop`; every island IPC checks the sender is the island window's main frame on the connected origin; same navigation lock and window-open denial as the main window.
- The island window never takes focus by itself: it appears with `showInactive()`.
- Every Electron-only behaviour that unit tests cannot reach is checked in `zumi-bot-desktop/e2e/local.e2e.mjs` or by the manual pass in Task 8.
- Comments short, saying why (repo convention). Dependencies unchanged.

## Review Focus

1. **Server switch, local server stop, picker or error page while the island is up** → the island window goes away, never a dead page on screen. Pinned by `islandWanted` tests (Task 4).
2. **Every picked agent deleted or broken** → no empty pill: the page reports 0 icons and the shell hides. Pinned by `islandAgents` (Task 5) and `islandWanted` with `icons: 0` (Task 4).
3. **Screen resolution or monitor change** with a saved `top` past the new work area → island clamped back on screen. Pinned by an `islandBounds` test and the `display-metrics-changed` hook (Tasks 2, 4).
4. **Esc inside the popup's `/` command menu** → closes the menu, not the popup. Pinned in the e2e (Task 8).
5. **Island appearing steals focus** from the app the user types in → it must not. Pinned in the e2e: `isFocused()` false right after it shows (Task 8).

---

### Task 1: Shared island contract and the shell's prefs file

**Files:**
- Create: `zumi-bot-server/shared/src/island.ts`
- Modify: `zumi-bot-server/shared/src/desktop.ts` (two optional members on `DesktopBridge`)
- Create: `zumi-bot-desktop/src/main/islandPrefs.ts`
- Test: `zumi-bot-server/shared/tests/island.test.ts` (check where shared tests live: `ls zumi-bot-server/shared`), `zumi-bot-desktop/tests/islandPrefs.test.ts`

**Interfaces:**
- Produces (`@zumibot/shared/island`):
  - `ISLAND_PATH = '/island'`, `ISLAND_AGENTS_MAX = 10`
  - `interface IslandRect { x: number; y: number; width: number; height: number }`
  - `interface IslandLayout { strip: IslandRect; popup: IslandRect | null }` (window coordinates, CSS px)
  - `type IslandLive = { kind: 'desktop'; agent: string; point: { x: number; y: number } | null } | { kind: 'handoff'; surface: 'desktop' | 'browser'; target: { agent: string; chatId: string; requestId: string } }`
  - `interface IslandOpenTarget { chatId: string | null; live: IslandLive | null }`
  - `interface IslandSettings { agents: string[]; startAtLogin: boolean }`
  - `interface IslandBridge { ready(): void; agents(): Promise<string[]>; onAgents(cb: (a: string[]) => void): () => void; setShape(icons: number, open: boolean): void; onLayout(cb: (l: IslandLayout) => void): () => void; drag(phase: 'start' | 'move' | 'end', screenY: number): void; openMain(t: IslandOpenTarget): void; openAttachment(url: string, name: string): Promise<boolean> }`
  - `interface IslandSettingsBridge { get(): Promise<IslandSettings>; set(patch: Partial<IslandSettings>): Promise<IslandSettings>; renameAgent(from: string, to: string): void }`
  - `cleanAgentList(v: unknown): string[] | null` — null unless an array; keeps strings of 1–100 chars with no control characters, first occurrence of each, at most `ISLAND_AGENTS_MAX`.
  - `parseIslandOpenTarget(v: unknown): IslandOpenTarget | null` — exact keys only; ids and names strings ≤ 200 chars; point coordinates finite numbers; anything else null.
  - `DesktopBridge.island?: IslandSettingsBridge` and `DesktopBridge.onIslandOpen?(cb: (t: IslandOpenTarget) => void): () => void` (optional, like `sync`).
- Produces (`zumi-bot-desktop/src/main/islandPrefs.ts`):
  - `interface IslandPrefs { v: 1; startAtLogin: boolean; top: number | null; agents: Record<string, string[]> }` (agents keyed by server origin)
  - `DEFAULT_ISLAND_PREFS: IslandPrefs` (`startAtLogin: true`, `top: null`, `agents: {}`)
  - `parseIslandPrefs(raw: unknown): IslandPrefs` — lenient: each bad field falls back to its default; each origin's list through `cleanAgentList`
  - `loadIslandPrefs(file: string): IslandPrefs` (missing or unreadable → defaults), `saveIslandPrefs(file: string, p: IslandPrefs): void` (0600, write to temp then rename, as `servers.ts` saves)
  - `agentsFor(p: IslandPrefs, origin: string): string[]`, `withAgents(p, origin, list: string[]): IslandPrefs`, `renameAgentIn(p, origin, from, to): IslandPrefs` (renames in place keeping order; drops `to`'s duplicate)

- [ ] **Step 1: Write the failing tests**

```ts
// shared island.test.ts
expect(cleanAgentList(['a', 'b', 'a', '', 'x\u0007'])).toEqual(['a', 'b'])
expect(cleanAgentList(Array.from({ length: 12 }, (_, i) => `a${i}`))).toHaveLength(10)
expect(cleanAgentList('a')).toBeNull()
expect(parseIslandOpenTarget({ chatId: 'c1', live: null })).toEqual({ chatId: 'c1', live: null })
expect(parseIslandOpenTarget({ chatId: 'c1', live: { kind: 'desktop', agent: 'a', point: { x: 1, y: 2 } } })?.live?.kind).toBe('desktop')
expect(parseIslandOpenTarget({ chatId: 'c1', live: null, extra: 1 })).toBeNull()
expect(parseIslandOpenTarget({ chatId: 'c1', live: { kind: 'desktop', agent: 'a', point: { x: NaN, y: 0 } } })).toBeNull()

// islandPrefs.test.ts
expect(parseIslandPrefs(null)).toEqual(DEFAULT_ISLAND_PREFS)
expect(parseIslandPrefs({ v: 1, startAtLogin: false, top: 'x', agents: { 'http://127.0.0.1:4318': ['a', 'a'] } }))
  .toEqual({ v: 1, startAtLogin: false, top: null, agents: { 'http://127.0.0.1:4318': ['a'] } })
// round trip through a temp file, mode 0600
// agentsFor on an unknown origin → []
// renameAgentIn(p, o, 'a', 'b') on ['a','c'] → ['b','c']; on ['a','b'] → ['b']
```

- [ ] **Step 2: Run them, expect failures** — `npx vitest run zumi-bot-server/shared/tests/island.test.ts zumi-bot-desktop/tests/islandPrefs.test.ts` → FAIL (modules missing).
- [ ] **Step 3: Implement both modules and the `DesktopBridge` members.**
- [ ] **Step 4: Run the tests and `npm run typecheck`** → PASS, no type errors.

---

### Task 2: Shell pure helpers: geometry, autostart, quiet start, tray menu, flags

**Files:**
- Create: `zumi-bot-desktop/src/main/islandLayout.ts`, `zumi-bot-desktop/src/main/autostart.ts`, `zumi-bot-desktop/src/main/quietStart.ts`, `zumi-bot-desktop/src/main/tray.ts`
- Modify: `zumi-bot-desktop/src/main/closeFlow.ts` (two optional deps)
- Test: `zumi-bot-desktop/tests/islandLayout.test.ts`, `autostart.test.ts`, `quietStart.test.ts`, `tray.test.ts`, extend `closeFlow.test.ts`

**Interfaces:**
- Consumes: `IslandRect`, `IslandLayout` (Task 1).
- Produces:
  - `islandLayout.ts`: constants `STRIP_WIDTH = 58`, `ICON = 38`, `ICON_GAP = 12`, `STRIP_PAD = 12`, `CURVE = 22`, `POPUP_WIDTH = 360`, `POPUP_HEIGHT = 520`, `POPUP_GAP = 12`; `stripHeight(icons: number): number` = `2*CURVE + 2*STRIP_PAD + icons*ICON + (icons-1)*ICON_GAP`; `clampTop(top: number | null, height: number, area: IslandRect): number` (null → vertically centred); `islandBounds(o: { area: IslandRect; top: number | null; icons: number; open: boolean }): { window: IslandRect; layout: IslandLayout; top: number }` — closed: window = the strip at the right edge of `area`; open: the popup sits `POPUP_GAP` left of the strip, its centre level with the strip's, clamped into `area` (its height capped at `area.height`), and the window is the union. `layout` rects are relative to `window`.
  - `autostart.ts`: `autostartFile(env: NodeJS.ProcessEnv, home: string): string` (`$XDG_CONFIG_HOME` or `<home>/.config`, then `autostart/zumibot.desktop`); `autostartEntry(exec: string): string` — the desktop entry below, `exec` quoted per the Desktop Entry spec when it holds a space or one of `"`, `` ` ``, `$`, `\` (those escaped with `\`); `syncAutostart(o: { on: boolean; packaged: boolean; file: string; exec: string }, fs?: {...}): 'written' | 'removed' | 'skipped'` (not packaged → skipped; writes only when the content differs; removes a missing file quietly); `wantsHidden(argv: readonly string[]): boolean`.
  - `quietStart.ts`: `QUIET_RETRY_MS`, `QUIET_WINDOW_MS`; `quietStep(now: number, startedAt: number): 'retry' | 'show'` (`'retry'` while `now - startedAt + QUIET_RETRY_MS <= QUIET_WINDOW_MS`); `isLoginUrl(url: string, origin: string): boolean` (same origin and path `/login` or under it).
  - `tray.ts`: `trayMenuTemplate(a: { open(): void; quit(): void }): Electron.MenuItemConstructorOptions[]` → `[{ label: 'Open', click: open }, { type: 'separator' }, { label: 'Quit', click: quit }]`.
  - `closeFlow.ts`: `CloseFlowDeps.onAsk?(): void` (called right before `askUnsaved` or `askRunning`), `CloseFlowDeps.onStay?(): void` (called when a run ends `'stay'`).

Autostart entry text (exact):

```
[Desktop Entry]
Type=Application
Name=ZumiBot
Comment=Start ZumiBot in the tray
Exec=<exec> --hidden
Icon=zumibot
Terminal=false
X-GNOME-Autostart-enabled=true
```

- [ ] **Step 1: Write the failing tests**

```ts
const area = { x: 0, y: 27, width: 1920, height: 1053 }
const closed = islandBounds({ area, top: null, icons: 3, open: false })
expect(closed.window.x + closed.window.width).toBe(1920)
expect(closed.window.width).toBe(STRIP_WIDTH)
expect(closed.window.height).toBe(stripHeight(3))
expect(closed.layout.popup).toBeNull()
expect(islandBounds({ area, top: 5000, icons: 3, open: false }).window.y).toBe(27 + 1053 - stripHeight(3)) // clamped (Review Focus 3)
const open = islandBounds({ area, top: 400, icons: 3, open: true })
expect(open.layout.popup).toEqual({ x: 0, y: expect.any(Number), width: POPUP_WIDTH, height: POPUP_HEIGHT })
expect(open.layout.strip.x).toBe(POPUP_WIDTH + POPUP_GAP)
expect(open.window.y).toBeGreaterThanOrEqual(27)
expect(islandBounds({ area: { x: 0, y: 0, width: 800, height: 400 }, top: 0, icons: 1, open: true }).layout.popup!.height).toBe(400)

expect(autostartEntry('/opt/ZumiBot/zumibot')).toContain('\nExec=/opt/ZumiBot/zumibot --hidden\n')
expect(autostartEntry('/opt/Zumi Bot/zumibot')).toContain('Exec="/opt/Zumi Bot/zumibot" --hidden')
expect(autostartFile({ XDG_CONFIG_HOME: '/x' }, '/h')).toBe('/x/autostart/zumibot.desktop')
expect(autostartFile({}, '/h')).toBe('/h/.config/autostart/zumibot.desktop')
// syncAutostart with a fake fs: unpackaged → 'skipped' and no write; on → 'written' then a second call writes nothing; off → 'removed'
expect(wantsHidden(['zumibot', '--hidden'])).toBe(true)

expect(quietStep(1_000 + 100_000, 1_000)).toBe('retry')
expect(quietStep(1_000 + 115_000, 1_000)).toBe('show')
expect(isLoginUrl('https://h.example/login?next=/', 'https://h.example')).toBe(true)
expect(isLoginUrl('https://h.example/chat/x', 'https://h.example')).toBe(false)

expect(trayMenuTemplate({ open() {}, quit() {} }).map((i) => i.label ?? i.type)).toEqual(['Open', 'separator', 'Quit'])
// closeFlow: onAsk runs before askUnsaved; Cancel calls onStay once; a clean close calls neither
```

- [ ] **Step 2: Run them, expect failures** — `npx vitest run zumi-bot-desktop/tests` → the new files FAIL.
- [ ] **Step 3: Implement the four modules and the two `closeFlow` hooks.**
- [ ] **Step 4: Run** `npx vitest run zumi-bot-desktop/tests` → all PASS.

---

### Task 3: Living in the tray: hide on close, Quit, show on the current workspace, start at login, quiet start

**Files:**
- Modify: `zumi-bot-desktop/src/main/index.ts`, `zumi-bot-desktop/src/main/window.ts`
- Modify: `zumi-bot-desktop/electron.vite.config.ts` (`shipPages` also copies `build/icon.png` to `out/main/tray.png`)
- Modify: `zumi-bot-desktop/e2e/local.e2e.mjs`

**Interfaces:**
- Consumes: Task 2's `trayMenuTemplate`, `autostartFile`, `autostartEntry`, `syncAutostart`, `wantsHidden`, `quietStep`, `isLoginUrl`, `onAsk`/`onStay`; Task 1's `loadIslandPrefs`.
- Produces (in `index.ts`, used by Task 4): `showMain(): void` and `requestQuit(): void`.
- `WindowOptions` gains `startHidden: boolean` (the show gate never shows it), `shouldHide(): boolean` (true unless a quit was asked), `onQuitCancelled(): void`; `onNavigated(w, url: string)` gets the URL.

Behaviour to build:
- `window.ts` close handler: `if (o.shouldHide()) { e.preventDefault(); windowState.flush(); w.hide(); return }` before the existing flow. The flow gets `onAsk: () => { w.show(); w.focus() }` (a dialog over a hidden window would be invisible) and `onStay: o.onQuitCancelled`.
- `index.ts`: `quitRequested` flag. `requestQuit()` sets it and closes the main window (the flow asks as today), or calls `app.quit()` when there is none. `onQuitCancelled` clears it. The main window's `closed` while `quitRequested` → `app.quit()`. `before-quit` (after the sync check): when the flag is off, set it, `preventDefault()` and route through the main window's close, so logout or `app.quit()` from anywhere still asks. `window-all-closed` quits only when `quitRequested`.
- `showMain()`: restore if minimised; if visible but not focused, `hide()` first so `show()` maps it on the user's current workspace; then `show()`, `focus()`. Used by tray Open, second instance (unless its argv `wantsHidden`), notification clicks (replace their `show()`/`focus()`), and Task 4's Open in ZumiBot.
- Tray after `whenReady`: `new Tray(nativeImage.createFromPath(<out/main/tray.png>).resize({ width: 24, height: 24 }))`, tooltip `ZumiBot`, context menu from `trayMenuTemplate({ open: showMain, quit: requestQuit })`; destroyed in `will-quit`.
- Start at login: at startup `syncAutostart({ on: prefs.startAtLogin, packaged: app.isPackaged, file: autostartFile(process.env, app.getPath('home')), exec: process.env.APPIMAGE ?? process.execPath })`; a failure is logged, never fatal.
- Hidden start (`wantsHidden(process.argv)`): every main window created while the quiet start is on gets `startHidden: true`. The quiet start ends (window shown) when: the picker would show (no saved server); `showError` and `quietStep(Date.now(), startedAt) === 'show'`; or `onNavigated` lands on `isLoginUrl`. While `quietStep` says `'retry'`, `showError` keeps the window hidden and schedules `connect(choice)` after `QUIET_RETRY_MS`. It also ends, quietly, at the first navigation to the origin that is not the login page.

- [ ] **Step 1: Update the e2e to the new lifecycle (it fails against today's shell)**

Replace the "Closing the window ends the app" block with:

```js
// Closing the window hides it: app and server stay (tray).
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().endsWith('/island'))?.close())
await new Promise((r) => setTimeout(r, 1000))
assert(alive(electronPid) && alive(serverPid), 'closing the main window ended the app')
assert(!(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => !w.webContents.getURL().endsWith('/island') && w.isVisible()))), 'main window still visible after close')
ok('closing the main window hides it; app and server keep running')
// Autostart: packaged writes the entry, unpacked never does.
const entry = await readFile(join(xdgConfig, 'autostart/zumibot.desktop'), 'utf8').catch(() => null)
assert(exe ? entry?.includes(' --hidden') : entry === null, `autostart entry: ${entry}`)
ok('start at login entry matches the build kind')
// Quit ends everything (the existing exit, server and browser-process checks follow, unchanged).
const exited = new Promise((resolve) => app.process().once('exit', resolve))
await app.evaluate(({ app: a }) => a.quit())
```

Then a second launch with `args: [...launchOpts.args, '--hidden']` (reuse `env`, same userData): wait for the server child, assert via `app.evaluate` that the main window exists, has loaded the origin and `isVisible()` is false; quit it the same way. Raise `OVERALL_TIMEOUT` to `180_000`.

- [ ] **Step 2: Run** `npm run e2e:desktop` → FAIL at the hide check (the app exits today).
- [ ] **Step 3: Implement the behaviour above.**
- [ ] **Step 4: Run** `npx vitest run zumi-bot-desktop/tests`, `npm run typecheck`, `npm run e2e:desktop` → PASS.

---

### Task 4: The island window, its bridge and the settings bridge

**Files:**
- Create: `zumi-bot-desktop/src/main/island.ts`
- Modify: `zumi-bot-desktop/src/main/index.ts`, `zumi-bot-desktop/src/preload/index.ts`
- Test: `zumi-bot-desktop/tests/island.test.ts`

**Interfaces:**
- Consumes: Task 1 prefs and contract; Task 2 `islandBounds`, `clampTop`; Task 3 `showMain`, `onNavigated(w, url)`; `isSameOrigin`, `isPermissionAllowed` (unchanged: the island shares the origin, so the mic works).
- Produces:
  - Pure: `islandWanted(s: { origin: string | null; picked: number; ready: boolean; icons: number }): 'none' | 'hidden' | 'shown'` — `'none'` (no window) when `origin === null` or `picked === 0`; `'hidden'` until `ready` and while `icons === 0`; else `'shown'`.
  - `createIslandHost(d: { prefsFile: string; preload: string; area(): IslandRect; openMain(t: IslandOpenTarget): void; openAttachment(url: string, name: string, origin: string): Promise<boolean> }): IslandHost` with `IslandHost = { setOrigin(origin: string | null): void; agentsChanged(): void; displayChanged(): void; isSender(e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean; dispose(): void }`.
  - IPC from the island (each checked by `isSender`: sender is the island's webContents, `senderFrame === mainFrame`, frame URL same origin): `island:ready` (send), `island:agents` (invoke → `string[]`), `island:shape` (send `icons: integer 0..10, open: boolean`), `island:drag` (send `phase`, finite `screenY`), `island:openMain` (send, through `parseIslandOpenTarget`), `island:openAttachment` (invoke). To the island: `island:agents` (`string[]`), `island:layout` (`IslandLayout`).
  - IPC from the main page (each checked by `fromApp`): `desktop:islandGet` (invoke → `IslandSettings` for `shell.origin`), `desktop:islandSet` (invoke, patch: `agents` through `cleanAgentList`, `startAtLogin` boolean; saves, then `syncAutostart` when `startAtLogin` changed, then `island.agentsChanged()`), `desktop:islandRename` (send, two names ≤ 100 chars). To the main page: `desktop:islandOpen` (`IslandOpenTarget`).
  - Preload: with `--zumibot-island=1` in argv and `location.origin === origin` and path `/island`, expose `zumibotIsland: IslandBridge` and nothing else; the main page's `zumibotDesktop` gains `island` and `onIslandOpen` over the channels above.

Behaviour to build:
- Window options: `frame: false`, `transparent: true`, `backgroundColor: '#00000000'`, `resizable`, `movable`, `minimizable`, `maximizable`, `fullscreenable` all false, `skipTaskbar: true`, `alwaysOnTop: true`, `hasShadow: false`, `show: false`, same `webPreferences` as the main window plus `--zumibot-island=1`; then `setAlwaysOnTop(true, 'floating')`, `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`. Same `setWindowOpenHandler` deny, `will-navigate` lock, `will-attach-webview` block and context menu as `window.ts` (extract the shared bits there rather than copy them).
- Placement: every shape, drag move or display change → `islandBounds` with the primary display's `workArea`, `setBounds(window)`, `setShape([strip, popup])` (rects in window coordinates, so the transparent rest is click-through on X11), then send `island:layout`. Drag end saves `top` to the prefs. Listen to `screen` `display-metrics-changed`, `display-added`, `display-removed` → `displayChanged()`.
- Lifecycle by `islandWanted`: create the window and load `${origin}${ISLAND_PATH}` when it leaves `'none'`; `showInactive()` on `'shown'`; `hide()` on `'hidden'`; `destroy()` on `'none'`. `ready` resets on every main-frame navigation; a navigation to a path other than `/island` (a login redirect) counts as not ready. `index.ts` calls `setOrigin(origin)` from `onNavigated` when the main window lands on its origin outside the login page, and `setOrigin(null)` in `showPage` (picker, error), `stopLocal`, and before a server switch replaces the window.
- `openMain(t)`: `showMain()`, then send `desktop:islandOpen` to the main page when `t.chatId` is set.

- [ ] **Step 1: Write the failing tests**

```ts
expect(islandWanted({ origin: null, picked: 2, ready: true, icons: 2 })).toBe('none') // Review Focus 1
expect(islandWanted({ origin: 'http://127.0.0.1:4318', picked: 0, ready: true, icons: 0 })).toBe('none')
expect(islandWanted({ origin: 'http://127.0.0.1:4318', picked: 2, ready: false, icons: 2 })).toBe('hidden')
expect(islandWanted({ origin: 'http://127.0.0.1:4318', picked: 2, ready: true, icons: 0 })).toBe('hidden') // Review Focus 2
expect(islandWanted({ origin: 'http://127.0.0.1:4318', picked: 2, ready: true, icons: 2 })).toBe('shown')
```

- [ ] **Step 2: Run** `npx vitest run zumi-bot-desktop/tests/island.test.ts` → FAIL.
- [ ] **Step 3: Implement `island.ts`, the IPC in `index.ts` and the preload bridges.**
- [ ] **Step 4: Run** the shell tests and `npm run typecheck` → PASS. (Task 8's e2e covers the window itself.)

---

### Task 5: Frontend island rules and the new-chat folder

**Files:**
- Create: `zumi-bot-server/frontend/src/state/island.ts`, `zumi-bot-server/frontend/src/state/islandSettings.ts`
- Modify: `zumi-bot-server/shared/src/types.ts` (`ZumiBotApi.app.newChatFolder`), `zumi-bot-server/frontend/src/net/api.ts`
- Test: `zumi-bot-server/frontend/tests/island.test.ts`, `zumi-bot-server/frontend/tests/islandSettings.test.ts`

**Interfaces:**
- Produces (`state/island.ts`):
  - `RECENT_MAX = 8`
  - `islandChats(chats: ChatMeta[], agent: string): ChatMeta[]` — single chats (`!isGroup`) of that agent, not `isArchived`, not `asked`, not `workflow`, not `workflowTest`; newest `updatedAt` first.
  - `interface IslandMarks { working: boolean; waiting: number; unread: boolean }`; `islandMarks(chats, agent, approvals: Record<string, number>): IslandMarks` (`working` any `inFlight`, `waiting` the sum of `approvals`, `unread` any `isUnread`).
  - `type IslandTarget = { kind: 'chat'; chatId: string } | { kind: 'new' }`
  - `chatToOpen(chats, agent, approvals, remembered: IslandTarget | undefined): IslandTarget` — the island chat with `approvals > 0` and the oldest `updatedAt`; else `remembered` when it is `new` or still among `islandChats`; else the newest unread; else the newest; else `{ kind: 'new' }`.
  - `recentChats(chats, agent): ChatMeta[]` — the first `RECENT_MAX` of `islandChats`.
  - `islandAgents(picks: string[], agents: AgentSummary[]): AgentSummary[]` — pick order, only agents found by name with `error === null`.
- Produces (`state/islandSettings.ts`): `togglePick(picks: string[], name: string): string[]` (appends, or removes; never past `ISLAND_AGENTS_MAX`), `movePick(picks: string[], name: string, by: -1 | 1): string[]`, `pickRows(picks: string[], agents: AgentSummary[]): { agent: AgentSummary; picked: boolean; index: number | null; disabled: boolean }[]` (picked first in pick order, then the rest by display name; a broken agent is `disabled` unless already picked).
- Produces (API): `ZumiBotApi.app.newChatFolder(agentName: string): Promise<string>` — in `api.ts` it calls the existing `app:folderStart` RPC and returns `.path` (the agent's last folder if it still exists, else the server's home; no server change).

- [ ] **Step 1: Write the failing tests**

```ts
const c = (id: string, extra: Partial<ChatMeta> = {}): ChatMeta => ({ ...baseChat, id, agentName: 'w', updatedAt: Number(id.slice(1)), ...extra })
const chats = [c('c1'), c('c2', { replyAt: 5, seenAt: 1 }), c('c3', { archivedAt: 9 }), c('c4', { asked: askedStub }), c('c5', { workflow: wfStub }), c('c6', { inFlight: true })]
expect(islandChats(chats, 'w').map((x) => x.id)).toEqual(['c6', 'c2', 'c1'])
expect(islandMarks(chats, 'w', { c1: 2, c3: 4 })).toEqual({ working: true, waiting: 2, unread: true })
expect(chatToOpen(chats, 'w', { c1: 1, c6: 1 }, undefined)).toEqual({ kind: 'chat', chatId: 'c1' }) // oldest waiting
expect(chatToOpen(chats, 'w', {}, { kind: 'chat', chatId: 'c1' })).toEqual({ kind: 'chat', chatId: 'c1' })
expect(chatToOpen(chats, 'w', {}, { kind: 'chat', chatId: 'c3' })).toEqual({ kind: 'chat', chatId: 'c2' }) // archived → newest unread
expect(chatToOpen(chats, 'w', {}, { kind: 'new' })).toEqual({ kind: 'new' })
expect(chatToOpen([], 'w', {}, undefined)).toEqual({ kind: 'new' })
expect(islandAgents(['gone', 'w', 'broken'], [agent('w'), agent('broken', 'bad yaml')]).map((a) => a.name)).toEqual(['w'])

expect(togglePick(['a'], 'b')).toEqual(['a', 'b'])
expect(togglePick(['a', 'b'], 'a')).toEqual(['b'])
expect(movePick(['a', 'b', 'c'], 'c', -1)).toEqual(['a', 'c', 'b'])
expect(movePick(['a', 'b'], 'a', -1)).toEqual(['a', 'b'])
expect(pickRows(['b'], [agent('a'), agent('b')]).map((r) => r.agent.name)).toEqual(['b', 'a'])
```

(Use the existing chat and agent fixtures of `frontend/tests` if there are some; `ls zumi-bot-server/frontend/tests`.)

- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/frontend/tests/island.test.ts zumi-bot-server/frontend/tests/islandSettings.test.ts` → FAIL.
- [ ] **Step 3: Implement the two modules and the API method.**
- [ ] **Step 4: Run them and `npm run typecheck`** → PASS.

---

### Task 6: The island page

**Files:**
- Create: `zumi-bot-server/frontend/src/net/island.ts`, `zumi-bot-server/frontend/src/components/IslandView.tsx`
- Modify: `zumi-bot-server/frontend/src/App.tsx`, `zumi-bot-server/frontend/src/api.ts`, `zumi-bot-server/frontend/src/net/api.ts` (`createApi` option `island`), `zumi-bot-server/frontend/src/useNotifications.ts`, `zumi-bot-server/frontend/src/components/ChatView.tsx`, `zumi-bot-server/frontend/src/styles.css`

**Interfaces:**
- Consumes: Task 1 `IslandBridge`, `IslandLayout`, `IslandOpenTarget`, `ISLAND_PATH`; Task 5 rules and `api.app.newChatFolder`.
- Produces:
  - `net/island.ts`: `islandBridge: IslandBridge | null` — the bridge only when `location.pathname === ISLAND_PATH`, else null.
  - `api.ts`: `desktop` is null on the island page; `createApi(rpc, { ..., island })` opens attachments through `o.island.openAttachment` when there is no `desktop`.
  - `useNotifications` option `presenceOnly?: boolean`: when true only the presence effect runs (no device setup, no title or favicon, no delivery or click handling).
  - `ChatView` prop `compact?: boolean`: no top bar, no side chips (`NO_SIDES`), no `onOpenTodos`, no pickers row under the composer, no `ColdNotice`, no `WorkflowChatBar`; history, older pages and the New line stay.
  - `IslandView` (`components/IslandView.tsx`) draws the strip and popup at the rects of the latest `island:layout`. Test ids: `island-strip`, `island-agent` (attributes `data-agent-name`, `data-working`, `data-waiting`, `data-unread`, `aria-pressed` when its popup is open), `island-popup`, `island-title`, `island-menu-open`, `island-menu`, `island-new-chat`, `island-recent` (`data-chat-id`), `island-open-main`, `island-close`, `island-folder`.

Behaviour to build in `App.tsx` (island mode = `islandBridge !== null`):
- State: `islandPicks` (from `bridge.agents()` and `onAgents`), `islandAgent: string | null` (popup's agent, null = closed), `islandLast: Record<string, IslandTarget>`; the popup shows `view` when it is a chat, else that agent's new-chat state. Opening an icon: `chatToOpen(...)`; a chat → `openChat(id)`; `new` → `setView({ kind: 'empty' })`. Clicking the open agent's icon again closes. Remember the target whenever the popup shows one (a fork's new chat too).
- `bridge.setShape(islandAgents(picks, agents).length, islandAgent !== null)` on every change; `bridge.ready()` once the first agents and chats have loaded; `document.documentElement.classList.add('island-page')`.
- New chat: drafts and files keyed `island-new:<agent>`; on send, `cwd = await api.app.newChatFolder(agent)`, `newChat(agent, { cwd })`, then send as `startChat` does; the `island-folder` line reads `Runs in <folderName(cwd)>` (fetched when the new-chat state shows).
- ⋯ menu: New chat, `recentChats` rows (title, relative time, marks), Open in ZumiBot (`bridge.openMain({ chatId: <shown chat or null>, live: null })`).
- Esc: a window `keydown` listener in the bubble phase that closes the popup only when `!e.defaultPrevented` and no island menu is open (the composer's menus handle Esc first).
- Drag: pointer down on the strip's background (not an icon) → `setPointerCapture`, `bridge.drag('start' | 'move' | 'end', e.screenY)`.
- Live views: wrap the popup in `DesktopShowContext` = `(agent, point) => bridge.openMain({ chatId, live: { kind: 'desktop', agent: agent ?? chat.agentName, point } })` and an `AgentDesktopContext` value equal to the desktop hook with `open` replaced by `bridge.openMain({ chatId, live: { kind: 'handoff', surface: 'desktop', target } })` when the target has a `requestId`; a browser handoff stays inline in its card, as in the main app.
- Gates: skip the address effect and popstate handling; `useWorkflows(connected && !island)`; `useNotifications({ ..., presenceOnly: island, viewChatId: islandAgent !== null && view.kind === 'chat' ? view.chatId : null })`; gate other page-wide fetches (to-dos overview, inbox messages, workflow approvals, account polling) where a flag is a one-line change.
- Render: in island mode return the providers around `<IslandView … chatView={<ChatView {...chatViewProps(chat, agent)} compact />} />` instead of the shell.
- Main window side: `api.desktop?.onIslandOpen?.((t) => …)` → `openFromInbox(t.chatId, live)` with `live` mapped to the existing `LiveAsk` (`chatId` added); after an agent rename is applied (both `applyAgentRenames` call sites), `api.desktop?.island?.renameAgent(from, to)`.
- CSS (`styles.css`, existing tokens only, light and dark): `.island-page` html and body transparent; the strip as in the approved mockup (`.superpowers/brainstorm/677266-1794438449/content/island.html`): dark pill, `border-radius: 22px 0 0 22px`, concave `CURVE` corners above and below, 38 px icons with 12 px gaps, spinner ring, amber count, blue dot; the popup 18 px radius with a border, header, list, composer.

- [ ] **Step 1: Implement the pieces above.**
- [ ] **Step 2: Run** `npm run typecheck` and `npm test` → PASS (Task 5's rules carry the logic tests; Task 8's e2e drives the page).
- [ ] **Step 3: Run** `npm run build:server` → builds.

---

### Task 7: Settings › Island & startup

**Files:**
- Create: `zumi-bot-server/frontend/src/components/IslandSettings.tsx`
- Modify: `zumi-bot-server/frontend/src/state/route.ts` (`'island'` in `SETTINGS_SECTIONS` after `'sync'`), `zumi-bot-server/frontend/src/state/settings.ts`, `zumi-bot-server/frontend/src/components/Settings.tsx`, `zumi-bot-server/frontend/src/App.tsx` (the `visibleSections` call)
- Test: extend the existing settings test file (`grep -rl visibleSections zumi-bot-server/frontend/tests`)

**Interfaces:**
- Consumes: `IslandSettingsBridge` via `api.desktop?.island`; Task 5 `togglePick`, `movePick`, `pickRows`.
- Produces: `LABELS.island = 'Island & startup'`; `visibleSections(vps: boolean, island: boolean)` lists `'island'` only when `island`; `/settings/island` in a UI without it falls back to `general`.
- The section: a Start at login switch (`island-start-at-login`); the agent list (`island-pick`, `data-agent-name`, a checkbox, Move up / Move down for picked rows, a broken agent disabled); a note that with none picked there is no island. Each change calls `island.set(...)` and shows the saved result; a failure shows the error under the list.

- [ ] **Step 1: Write the failing test** — `expect(visibleSections(false, false)).not.toContain('island')`, `expect(visibleSections(false, true)).toContain('island')`, `expect(settingsLabel('island', true)).toBe('Island & startup')`.
- [ ] **Step 2: Run it** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test, `npm run typecheck` → PASS.

---

### Task 8: Island e2e, docs and the manual pass on the real desktop

**Files:**
- Modify: `zumi-bot-desktop/e2e/local.e2e.mjs`, `CLAUDE.md`

- [ ] **Step 1: Extend the e2e** (before the close and quit block of Task 3). Before launch, write `island.json` in `userData`: `{ v: 1, startAtLogin: true, top: null, agents: { 'http://127.0.0.1:<port>': ['icon-agent'] } }`. Then:

```js
const islandPage = await waitForWindow(app, (p) => p.url().endsWith('/island'))
await islandPage.locator('[data-testid="island-agent"][data-agent-name="icon-agent"]').waitFor({ timeout: 20_000 })
const flags = await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('/island'))
  return { top: w.isAlwaysOnTop(), all: w.isVisibleOnAllWorkspaces(), shown: w.isVisible(), focused: w.isFocused() }
})
assert(flags.top && flags.all && flags.shown && !flags.focused, `island flags ${JSON.stringify(flags)}`) // Review Focus 5
await islandPage.locator('[data-testid="island-agent"][data-agent-name="icon-agent"]').click()
await islandPage.locator('[data-testid="island-popup"]').waitFor()
assert((await islandPage.locator('[data-testid="island-title"]').textContent()).includes('Icon ideas'), 'popup did not open the agent chat')
await islandPage.locator('[data-testid="island-popup"] [contenteditable="true"]').click()
await islandPage.keyboard.type('/')
await islandPage.keyboard.press('Escape')
assert(await islandPage.locator('[data-testid="island-popup"]').isVisible(), 'Esc in the / menu closed the popup') // Review Focus 4
await islandPage.keyboard.press('Escape')
await islandPage.locator('[data-testid="island-popup"]').waitFor({ state: 'detached' })
ok('island: on top, every workspace, no focus taken; popup opens the agent chat; Esc closes the menu, then the popup')
// Settings: unticking the only agent removes the island; ticking brings it back.
await page.locator('[data-testid="settings-open"]').click()
await page.locator('[data-testid="settings-nav-island"]').click()
await page.locator('[data-testid="island-pick"][data-agent-name="icon-agent"] input').uncheck()
await waitUntil(async () => !(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.webContents.getURL().endsWith('/island')))))
await page.locator('[data-testid="island-pick"][data-agent-name="icon-agent"] input').check()
await waitForWindow(app, (p) => p.url().endsWith('/island'))
ok('Settings › Island & startup adds and removes the island')
```

(`waitForWindow` and `waitUntil` are small polling helpers written in the e2e file.) In Task 3's hidden relaunch, also assert the island window is visible.

- [ ] **Step 2: Run** `npm run e2e:desktop` → PASS. If the island's background renders black instead of transparent, add `app.commandLine.appendSwitch('enable-transparent-visuals')` before `whenReady` in `index.ts` and rerun.
- [ ] **Step 3: CLAUDE.md** — a `**Dynamic island and tray (desktop shell).**` paragraph in Architecture (island window and bridge, `island.json`, placement with `setShape`, presence-only page, `compact` ChatView, tray and quit flow, hidden and quiet start, autostart entry, the Wayland limit), the new `npm run e2e:desktop` coverage in Commands, and `island.json` in the desktop shell's userData list.
- [ ] **Step 4: Manual pass on the user's X11 GNOME desktop** with `npm run dev` and a picked agent: the pill shows on the right edge in light and dark; it stays over a maximised app and on every workspace (switch with Super+PageDown); the gaps beside the strip pass clicks to the app under them; drag moves it and it stays there after a restart; the popup stays open when another app is clicked; a reply spins the icon and the blue dot appears; tray Open brings the main window onto the current workspace; tray Quit with a reply running asks Stop & Quit. Take screen captures with `import -window root <scratchpad>/island-N.png` and look at them. Kill every process the pass started.
- [ ] **Step 5: Run everything** — `npm test`, `npm run typecheck`, `npm run e2e:desktop` → PASS. Report what was checked by hand and what was not.
