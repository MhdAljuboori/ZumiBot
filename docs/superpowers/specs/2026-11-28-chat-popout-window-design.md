# Chat popout window (Ctrl+click a chat or room)

## Why

The user wants to watch and drive two chats side by side: one in the main window, one in its own OS window they can
move to another monitor or pin on top. Reference look: Claude desktop's popped-out session window (chat title on the
left, side-panel toggle, back-to-main, pin, min/max/close on the right, full composer, side panel beside the chat).

## Goals

- Ctrl+click (Cmd+click on a Mac) or middle-click a chat or room row opens it in a new window; the main window stays
  where it was.
- The row's right-click menu gets **Open in new window** (discoverable; works on touch via long press).
- Archived chat rows get the same.
- The popout is the chat only: header + `ChatView` (full, not `compact`) + the side panel (files, changes, `/btw`,
  to-dos, processes, browser/desktop), no rail, no sidebar.
- Works in the desktop shell and in a browser tab.

## Non-goals

- Popping out anything but a chat or room (agents, routines, workflows, Settings, Inbox, To-dos).
- Moving between chats inside a popout. A popout shows one chat for its whole life.
- Restoring popouts after a restart.
- The island.

## Anti-goals

- A popout must never become a second notification device, a second save-before-close target or a second quit flow.
- A popout must never get the full `zumibotDesktop` bridge (no Switch server, Sync, island settings).
- No custom-drawn window frame that breaks WM resize or touches the Mutter maximize crash path.

## Approaches

- **A. Popout mode of the existing app (picked).** Same page at `/chat/<id>?popout=1`; `App.tsx` reads the flag
  once and renders only the main area with a popout header. The side panel and every card work, being the same code.
  Cost: each popout runs the app's hooks (a few more WebSocket subscriptions).
- B. Lean entry like the island (only `ChatView`). Lighter, but no side panel, which the reference look has. Rejected.
- C. In-app floating panel inside the main window. Cannot go to another monitor. Rejected.

## Design

**Trigger (frontend).** `Sidebar.tsx`'s `chatHandlers` and `ArchivedNav.tsx`'s open button: a click that is not
`plainClick` with Ctrl/Cmd, or an `auxclick` with button 1, calls `onPopoutChat(id)` instead of `onOpenChat`. A pure
helper in `state/` decides (`popoutClick(e, isMac)`), unit-tested. Shift+click keeps its current meaning where it has
one (Archived multi-pick).

**Opening.** `openChatWindow(id)` in `net/` or `state/`:
- Desktop shell with the new bridge method → `zumibotDesktop.openChatWindow(chatId)`.
- Otherwise → `window.open('/chat/<id>?popout=1', 'zumibot-chat-<id>', 'popup,width=W,height=H')`. The name makes a
  second Ctrl+click on the same chat reuse and focus that window; `popup` makes browsers open a real window, not a tab.

**Popout page.** `popoutFromUrl()` (pure, in `state/route.ts`) reads `/chat/<id>?popout=1` at load. In popout mode:
- No `Rail`, no `Sidebar`, no `MobileBar`; a `PopoutHeader` instead: chat title (live, rename follows), side-panel
  toggle, **Open in main window** (desktop only), **Pin on top** (desktop only, toggles), and on the desktop the
  window's drag region.
- History is not walked and the address is not rewritten (like the island).
- In-app links (Markdown, `AppLink`, run links) open in the main window on the desktop (`openMain`); in a browser
  popup they open in a new tab (the popout's own address never changes).
- Presence only for notifications (`useNotifications` `presenceOnly`, as the island): while the popout is focused its
  chat counts as looked at (read marks, no notification for it). It never registers as the notification device.
- A deleted or archived-away chat shows a short "This chat is gone" note with Close.
- `document.title` = chat title, so the taskbar and Alt+Tab show it.
- Theme follows the main window through the `storage` event, as the island does.

**Desktop shell.**
- New `popouts.ts`: a `Map<chatId, BrowserWindow>`. `open(chatId)` focuses an existing one, else creates one.
  `closeAll()` on server switch, picker/error page and quit.
- Window: `titleBarStyle: 'hidden'` + `titleBarOverlay` (Chromium draws min/max/close in the app's colors, WM keeps
  resize), traffic lights on a Mac. `lockToOrigin`, the same permission handler, zoom keys. Shown through
  `whenRealScreen`. Default 900×700, cascaded off the main window; last size kept in `popout-state.json`.
- Preload branch `--zumibot-popout=1`, only for `/chat/<id>` with `popout=1` on the connected origin: a small
  `zumibotPopout` bridge (`pin(on)`, `openMain(chatId)`, `openAttachment`, `setOverlayColors`). Every handler checks
  the sender is that popout's main frame and re-validates args.
- `openChatWindow` on `zumibotDesktop` (main window only, `fromAppMain`), validates the chat id shape.
- `lockToOrigin`'s window-open handler keeps denying everything; popouts are made only by the shell.
- Close really closes (no hide to tray). The main window's close flow and `shouldHide` are unchanged.
- `openMain(chatId)` reuses the island's path (`desktop:islandOpen`-style message to the main window, then `showMain`).

**Compatibility.** A new page on an old shell: no `openChatWindow`, so `window.open` runs and the old shell denies it;
the click then falls back to opening in place. An old page on a new shell: nothing changes.

## Left to the builder

- Exact header layout and icons (reuse `MenuIcon` and existing icon buttons).
- How `App.tsx` gates the hooks a popout doesn't need (workflows, board, inbox loaders), as the island gates them.
- Overlay colors per theme, and the cascade offset.
- Tests: pure helpers (`popoutClick`, `popoutFromUrl`, popout window bookkeeping); an `e2e:desktop` check if cheap.
- Docs: `desktop-shell.md` (popouts), `ui.md` (popout mode), user docs page for chats.
