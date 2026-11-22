# Dynamic island (desktop shell) — design

Date: 2026-11-12. Status: approved by the user on 2026-11-12.

## Intent

The user works in another app, often on another workspace, and wants something quick from an agent: either a new
question or a follow-up in a chat they already have with it. Today that means finding the ZumiBot window, bringing it
forward and leaving what they were doing. The island removes that trip, the way OpenBot's does: a small strip on the
right edge of the screen, always there on every workspace, showing the agents the user picked; one click opens a compact
chat with that agent beside the strip, over whatever is on screen. ZumiBot's main window never has to come forward.

Because the island has to be there all the time, the shell has to keep running when its main window is closed, so the
app gains a tray icon and starts at login.

Mockups the user approved (the closed strip with live marks, the open popup with its ⋯ menu) are in
`.superpowers/brainstorm/677266-1794438449/content/island.html` (git-ignored; open it in a browser).

## Goals

Decided by the user:

1. **Island.** A strip on the right edge of the screen, always on top of other windows, on every workspace. It shows the
   agents the user picked, one icon each, in the user's order. No **+** button. With no agent picked there is no island
   on screen at all.
2. **Look.** OpenBot's shape (a dark pill hugging the right edge with concave curves where it meets the edge) in
   ZumiBot's own colours and agent icons, as in the mockup.
3. **Popup.** Clicking an agent's icon opens a compact chat popup to the left of the strip. It covers both cases: a
   new question and continuing an existing chat with that agent.
4. **Popup stays.** When the user clicks into another app while waiting for a reply, the popup stays open on top.
5. **Tray.** ZumiBot gets a tray icon. Its menu has **Open** (brings the main window up) and **Quit** (closes the
   whole app). Closing the main window no longer quits the app: the island stays.
6. **Start at login.** An option, on by default.
7. **Same on Local and VPS.** The island works whichever server the shell is connected to.

Proposed during the conversation and accepted by the user ("looks good" to the mockup and the behaviour list):

8. **Live marks** on each icon: a spinning ring while one of that agent's chats is running, an amber count while
   something waits for the user (approval, question or plan cards, handoffs), a blue dot when a reply arrived that the
   user has not read.
9. **Popup layout.** Header: the agent's icon and name, the chat's title, **⋯** and **✕**. Body: the chat's messages,
   tool rows and every card the main chat view answers in place (approval, question, plan, browser and desktop
   handoffs, vault approval). Bottom: the message box, with the mic. The **⋯** menu: **New chat**, that agent's recent
   chats (pick one to switch the popup to it), **Open in ZumiBot** (shows the main window on this chat).
10. **The island never opens by itself.** A reply or a card only changes the icon's mark.
11. **Notifications unchanged.** Desktop notifications keep working as today, and their click still opens the main
    window.
12. **Drag.** The island can be dragged up and down along the right edge, and it remembers where it was left.
13. **Single chats only.** Rooms stay in the main app.
14. **Closing the popup.** Esc, ✕, or clicking the same icon again. Unsent text stays in the box for next time, as the
    main app keeps a chat's draft.
15. **Closing the main window always goes to the tray,** even with no island agent picked (one rule, not two). In Local
    mode the server keeps running, so replies carry on.
16. **Quit asks what closing asks today:** unsaved agent edits (Save / Discard / Cancel) and running replies (Stop &
    Quit / Cancel).
17. **Launching ZumiBot again** while it sits in the tray shows the main window; it never starts a second copy.
18. **Quiet start at login:** the tray icon and the island appear, the main window does not open.
19. **Settings.** A new desktop-only section holds the island's agent picker and the Start at login switch.

## Non-goals

- Rooms on the island (goal 13).
- An island outside the desktop shell (browser tab, phone, home-screen app).
- Wayland. The user runs Ubuntu 24.04, GNOME 46, X11. GNOME on Wayland does not let a client keep a window on top or
  on every workspace; there the island would act as a normal window. Not handled now; the limit goes in CLAUDE.md.
- macOS and Windows: the shell only builds a `.deb`.
- The side panel (Browser, Desktop, Files, Side questions, To-dos, Dispatched agents), Compact, the context meter, the
  cost chip, the model picker and other main-window tools inside the popup. **Open in ZumiBot** is the way to them.
  A message's own actions (copy, reply, edit, resend, fork, versions) stay as they are in the main chat. A card's
  **Show on desktop**, **Open Desktop** or **Open Browser** opens the main window on that chat and view, as the Inbox
  does. (My call: the popup is for a quick exchange; see "My calls".)
- Any change to what notifications send or when.

## Anti-goals (a failure even if everything else works)

- The island takes keyboard focus, or opens, on its own while the user types somewhere else.
- An invisible part of the island's window blocks clicks to the app underneath it.
- A second app instance, or a second local server on the same data.
- Quit (from the tray or anywhere) loses unsaved agent edits or stops running replies without asking.
- An island on screen when no agent is picked, or while the shell shows its picker or error page.
- The island page getting more of the shell than it needs (see Constraints › Security).

## Constraints

- **Stack.** Electron 45 shell in `zumi-bot-desktop` (main process `src/main/`, preload `src/preload/index.ts`,
  shell pages `src/pages/`), the React 19 frontend in `zumi-bot-server/frontend`, shared types in
  `zumi-bot-server/shared`. The shell never bundles the UI: every page except the picker, error and sync pages comes
  from the connected server.
- **Window manager facts (X11, GNOME 46).** `setAlwaysOnTop`, `setVisibleOnAllWorkspaces`, `skipTaskbar` and a
  frameless `transparent` window all work under X11 Mutter. On Linux, `setIgnoreMouseEvents` cannot forward mouse
  events, so a transparent window region would swallow clicks: the island's window(s) must only cover what is drawn
  (the strip; the strip plus the popup while open), never a large transparent overlay.
- **The island is its own app to GNOME Shell (found 2026-11-12).** GNOME Shell files a window under a `.desktop` entry
  by its `WM_CLASS`; a skip-taskbar window still belongs to the app, it just does not count as running. With the main
  window hidden, ZumiBot then had one window, the island, and Ubuntu Dock's click on an app with no counted window
  activates the app's first window, so it focused the island and never launched the second instance that shows the main
  window (tray Open still worked). The island therefore gets its own `WM_CLASS`, `zumibot-island` (Electron reads
  `CHROME_DESKTOP` per window, so the shell swaps it while the island window is made), matched by a hidden
  `zumibot-island.desktop` that the `.deb` installs. ZumiBot's entry then has no window while the main window is
  hidden, and the dock launches it.
- **Tray.** Electron's `Tray` uses StatusNotifierItem/AppIndicator on Linux; Ubuntu 24.04 shows those in the top bar
  through its built-in AppIndicator extension. On Ubuntu a left click also opens the menu.
- **Start at login on Linux.** `app.setLoginItemSettings` does nothing on Linux; an XDG autostart entry
  (`~/.config/autostart/<name>.desktop`) is the way.
- **Security model (keep it).** The preload exposes `zumibotDesktop` only to the connected server's origin, and every
  IPC handler checks the sender frame (`fromApp`, `fromPage` in `src/main/index.ts`). The island window is another
  sender: it needs its own checks, its own narrow bridge for the island's own operations, the same navigation lock,
  window-open denial and permission handler (the mic for dictation, as `isPermissionAllowed` allows today). It must
  not get `setEditorDirty`, `onSaveBeforeClose`, `switchServer`, `sync` or notification calls.
- **One local server.** The single-instance lock and `createLocalHost` stay the only way a local server starts.
- **Version skew.** A newer shell may connect to an older VPS server whose UI has no island page. The island must then
  stay hidden (for example: the shell shows the island only once the page in it reports ready through its bridge), and
  the Settings section only appears in a UI that knows the island.
- **Data the island shows comes from the existing RPCs** (chat list pushes, items feed, approvals counts, unread marks,
  presence). No new server state is needed for the island itself.
- **Testing rules of this repo.** Frontend tests cover only pure modules in `src/state/` and `src/net/`, so the island's
  rules (which icon shows which mark, which chat a click opens, the recent list) live in pure modules with tests; the
  shell's rules (placement, drag clamping, autostart file text, tray menu) too, under `zumi-bot-desktop/tests`.
  `npm run e2e:desktop` packages the shell; extend it for the tray, the hidden start and the island window.
- **Docs.** CLAUDE.md gets a section on the island, the tray and start at login, like the other features.

## My calls (made in the design, open to the user's correction)

- **Where the picks live.** In the shell's userData (`island.json` or similar), keyed by server origin, because the
  island is one machine's and agents differ per server. The Settings section reads and writes them through the island
  bridge. An agent picked but missing, broken or renamed away is skipped silently (an agent rename on the server
  should carry the pick; if that is hard, the user re-picks). Zumi Bot and Codex agents can be picked like any other.
- **"Its chats".** An agent's chats on the island are its single chats that are not archived, not A→B (read-only)
  chats and not workflow chats (`ChatMeta.workflow` or `workflowTest`). Routine chats count: they carry no marker
  today and excluding them would need new server state; a routine's run spinning the icon, or its card showing the
  amber count, is fine.
- **Which chat a click opens.** The island remembers, per agent, the chat its popup last showed (or that it was on
  ⋯ › New chat). A click opens, in order: the agent's oldest chat with something waiting for the user (so the amber
  count always leads to its card); else the remembered chat or new-chat state, while it is still one of its chats;
  else its newest unread chat; else its newest chat; else a new chat. This keeps unsent text where the user left it.
  The memory lives in the island page (lost on restart, which is fine).
- **New chat.** The popup's new-chat state is empty with the message box; the first message creates an ordinary chat
  (it shows in the sidebar like any other). Its folder: see "Folder of a chat started from the island" below.
- **Marks** follow the sidebar's rules for the agent's chats: running, the pending count (the `approvals` push, the
  same number as the sidebar badge), unread (`shared/src/unread.ts`).
- **Recent chats in ⋯:** the agent's newest 8 chats, newest first, with a relative time and the same marks per row.
- **Drafts.** The island keeps its own unsent text and staged files per chat (and per agent's new-chat state) in the
  island page's memory: they survive closing and reopening the popup, not a restart. They are not shared with the main
  window, which has no cross-window draft store today; live sharing is not worth the plumbing for a quick box.
- **Presence.** While the popup shows a chat and the island window has focus, it reports looking at that chat like a
  main-window page does (so a reply read there is read, and other devices are not notified). An open popup without focus
  is not looking, the same rule as a page that is visible but not focused.
- **Notifications.** Only the main window's page registers as the desktop notification device. Closing the main window
  hides it (it stays loaded), so notifications keep flowing while it sits in the tray.
- **Hidden start** creates the main window and loads its page, but does not show it.
- **Hidden start that cannot connect.** At login the network may not be up yet, so a failed connect (VPS unreachable,
  local server failed) is retried quietly every 10 s for up to 2 minutes; if it still fails, the main window shows
  with today's error page. A server that answers with its sign-in page (expired VPS session) shows the main window at
  once, since only the user can sign in. Until connected there is no island.
- **Showing the main window** from the island (Open in ZumiBot, a card's desktop or browser button) brings it to the
  workspace the user is on, raised and focused, rather than switching the user to the workspace it was on: the whole
  point is that the user stays where they work. A relaunch (the dock icon), tray Open and a notification click go to
  the window instead, switching the user to its workspace as other apps do (changed 2026-11-12 at the user's request:
  the dock icon pulled the window over, and the hide and show that did it lost its maximized size). A window closed to
  the tray while maximized comes back maximized, at the size it had: it is mapped at its normal size and maximized once
  placed, as on the first show, since mapped maximized Mutter took the maximize and dropped it about 100 ms later
  (found 2026-11-12, watching `_NET_WM_STATE` and the geometry with `xprop -spy` across a close and a dock reopen).
- **Start at login default on** means: on the first start of the version that has this feature, the shell writes the
  autostart entry unless the user turned the switch off; turning it off removes the entry. An unpackaged dev run never
  writes it.
- **Theme.** The island and popup follow the app's theme (light or dark), as the main window does. The mockup is the
  dark one.
- **Size and place.** Popup about 360×520, to the left of the strip, kept inside the screen's work area. The island
  sits on the right edge of the primary display unless the user dragged it; its vertical position is remembered per
  machine.
- **Focus.** A click on an icon is the user's own action, so the popup may take focus and put the caret in the message
  box. Nothing else gives the island focus.
- **The message box** behaves as the main one does (`/` commands, `@` asks, attachments, the mic).
- **While the shell shows its picker or error page, switches server, or the local server stopped:** no island. After a
  server switch it shows that server's picks.

## Folder of a chat started from the island

The user approved the design with this question open, so this is my call: the agent's last folder
(`app:lastFolder`), else the home folder. The new-chat state shows the folder as one dim line ("Runs in ~/…") so the
user sees it before sending; there is no folder picker in the popup, and a different folder is chosen in the main app.

## Left to the builder

- One window that resizes between strip and strip-plus-popup, or two windows (strip and popup).
- How the island page is built: a lean island entry that reuses the chat hooks and components, or the full `App` in an
  island layout. `App.tsx` holds most chat wiring today, and `ChatView` already has a reduced mode for the To-dos page
  (`exchange`), which is a hint, not a requirement.
- How drag works, exact sizes, animations, the tray icon file.
- IPC channel names, the bridge's shape, the settings file's shape.
- Splitting the work into steps and their order.
