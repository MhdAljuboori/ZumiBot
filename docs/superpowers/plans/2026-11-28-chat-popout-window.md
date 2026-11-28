# Chat popout window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ctrl/Cmd+click or middle-click a chat or room row (or its menu's Open in new window) opens that chat alone in
its own window, in the desktop shell and in a browser.

**Architecture:** The same page at `/chat/<id>?popout=1` runs `App.tsx` in popout mode (no rail, sidebar, palette or
history; a `PopoutHeader`; presence-only notifications; other chats and in-app links go to the main window). The desktop
shell makes popouts itself (`popouts.ts`, one window per chat, Window Controls Overlay title bar) with a small
`zumibotPopout` preload bridge; the main window asks for one through `zumibotDesktop.openChatWindow`.

**Tech Stack:** React 19, Electron 45, vitest.

**Spec:** `docs/superpowers/specs/2026-11-28-chat-popout-window-design.md`

## Global Constraints

- Never commit (user rule); leave changes in the worktree.
- A popout never gets `zumibotDesktop`; `api.desktop` is null there.
- Every shell IPC handler checks its sender and re-validates args.
- Comments short, saying why. Exact-version deps only (none added).
- Docs updated in the same change: `desktop-shell.md`, `ui.md`, user docs `chats-and-composer.mdx`.

## Review Focus

- Chat deleted or archived while its popout is open → popout shows "This chat is gone", no crash, no new-chat screen.
- Fork / ask card / dispatched-chat link inside a popout → opens in the main window, popout stays on its chat.
- Server switch, picker or quit with popouts open → all popouts close, quit flow unchanged.
- Old shell (no `openChatWindow`) → Ctrl+click opens the chat in place.
- Middle-click on Linux → no autoscroll or primary-selection paste side effects; opens the popout.

---

### Task 1: Shared popout contract

**Files:**
- Create: `zumi-bot-server/shared/src/popout.ts`
- Test: `zumi-bot-server/shared/tests/popout.test.ts`

**Interfaces:**
- Produces:
  - `POPOUT_PARAM = 'popout'`
  - `popoutPath(chatId: string): string` → `/chat/<encoded>?popout=1`
  - `popoutChatFrom(pathname: string, search: string): string | null` (chat id only when `popout=1` and a chat path)
  - `cleanChatId(v: unknown): string | null` (string, 1–200 chars, no control chars)
  - `cleanHexColor(v: unknown): string | null` (`#rrggbb`)
  - `interface PopoutBridge { chatId: string; pin(on: boolean): Promise<boolean>; openMain(chatId: string | null): void; openAttachment(url: string, name: string): Promise<boolean>; setTitleBarColors(bg: string, fg: string): void }`
  - `DesktopBridge.openChatWindow?(chatId: string): void` (added to `shared/src/desktop.ts`)

- [ ] Tests: `popoutPath('a b')` = `/chat/a%20b?popout=1`; `popoutChatFrom('/chat/x', '?popout=1')` = `'x'`; `?popout=0`, `/archived/x`, `/` → null; `cleanChatId('')`, 201 chars, `'a\nb'`, `5` → null; `cleanHexColor('#A0b1C2')` ok, `'red'` null.
- [ ] Implement, run `npx vitest run zumi-bot-server/shared/tests/popout.test.ts`.

### Task 2: Desktop shell popouts

**Files:**
- Create: `zumi-bot-desktop/src/main/popouts.ts`, `zumi-bot-desktop/tests/popouts.test.ts`
- Modify: `window.ts` (export `windowBackground`), `index.ts`, `preload/index.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces (pure, tested): `loadPopoutSize(file): {width, height}` (default 900×700, lenient, clamped ≥ 480×360),
  `savePopoutSize(file, size)`, `popoutBounds(size, anchor: Rectangle | null, n: number, area: Rectangle): Rectangle`
  (cascade 32 px per open popout from the anchor's top-left, kept inside `area`).
- `createPopouts(deps)` → `{ open(origin, mode, chatId), closeAll(), find(wc): {win, chatId} | null }`.
- IPC: `desktop:openChatWindow` (fromAppMain), `popout:pin` (invoke → boolean), `popout:openMain`,
  `popout:openAttachment`, `popout:titleBar`; popout senders = a popout window's main frame on the connected origin.

- [ ] Tests for the three pure functions (defaults, broken file, clamp, cascade wraps inside area).
- [ ] Window: `titleBarStyle: 'hidden'`, `titleBarOverlay: { color, symbolColor, height: 40 }`, `trafficLightPosition`
  on a Mac, same `webPreferences` as main plus `--zumibot-popout=1`, `lockToOrigin`, shown on `ready-to-show` via
  `whenRealScreen`, size saved on `close`. Existing chat → `restore` + `focus`.
- [ ] Preload branch: only when `popout=1` arg and `popoutChatFrom(location)` names a chat on `origin`.
- [ ] `index.ts`: `openMainAt(t)` shared by island and popouts; `closeAll()` in `newWindow`, `showPage`, `will-quit`.

### Task 3: Frontend trigger

**Files:**
- Create: `zumi-bot-server/frontend/src/state/popout.ts`, `frontend/src/net/popout.ts`, tests `frontend/tests/state/popout.test.ts`
- Modify: `components/Sidebar.tsx`, `components/ArchivedNav.tsx`, `App.tsx`, `net/api.ts`, `api.ts`

**Interfaces:**
- `popoutClick(e: {button, ctrlKey, metaKey}): boolean` (button 0 with Ctrl or Cmd, or button 1)
- `cssColorToHex(css: string): string | null` (`rgb(…)`/`rgba(…)`/`#rgb`/`#rrggbb` → `#rrggbb`)
- `net/popout.ts`: `popoutChatId: string | null`, `popoutBridge: PopoutBridge | null`, `openChatWindow(chatId): boolean`
- Sidebar/ArchivedNav prop `onPopoutChat(chatId: string)`; row `onClick` / `onAuxClick` / middle `onMouseDown` preventDefault; chat menu item **Open in new window** (`data-testid="chat-menu-popout"`).
- `createApi` option `island` renamed `attachments` typed `{ openAttachment(url, name): Promise<boolean> } | null`.

- [ ] Tests: `popoutClick` matrix; `cssColorToHex` cases.
- [ ] App: `popoutChat(id)` = `openChatWindow(id) || open in place`.

### Task 4: Popout mode in App

**Files:**
- Create: `components/PopoutHeader.tsx`
- Modify: `App.tsx`, `styles/*.css`

- [ ] `popout` flag: no Rail, nav, backdrop, MobileBar, TabBar, UpdateHost, palette key; history and popstate skipped;
  theme follows `storage`; `useNotifications` `presenceOnly`; `openChat` for another chat → main window;
  `AppLinkContext` → main window (desktop) or a new tab (browser); `document.title` = chat title; gone note.
- [ ] Header: title, process mark, side-panel toggle, Open in main window + Pin (desktop only), drag region via
  `env(titlebar-area-*)`; sends header colors to `setTitleBarColors` on theme/accent change.

### Task 5: Docs and verification

- [ ] `desktop-shell.md` popouts paragraph + `popout-state.json`; `ui.md` popout mode; user docs `chats-and-composer.mdx`.
- [ ] `npm run typecheck`, `npm test`, `npm run build:server`; browser check of `/chat/<id>?popout=1` layout.
