# Computer use and agent desktops: design

Date: 2026-11-04. Status: implemented; the real-CLI ask-rule probe (e2e/desktopAskProbe.mjs) passed on Claude Code 2.1.317 on 2026-11-05, with and without an allow rule; the live real-stack demo (plan Task 15) ran on 2026-11-05 (real claude, Xvnc, XFCE, cua-driver: approval cards, Mousepad typing and save with Arabic, live view, Take control, paste; about 640 MiB RSS and 10 processes per desktop; clipboard lingering, MaxCutText and zoom invalidation not checked live). Approved by the user on 2026-11-04; spike passed 2026-11-04 and amended the plan, not the user's decisions (see the plan's Spike amendments). Builder check: done; its one open question (approvals in auto mode) was answered by the user, the rest settled below as my calls.

Built from the user's request, a look at how similar agent tools work, and a short talk. What the user decided or approved is marked **(user)**. Everything else is my call and can be changed.

## Why

Agents can already work in files, in a shell, and in their own app browser. Some work needs a real desktop: native apps, file dialogs, apps with no API, a site that refuses to work in an automated Chromium. The user asked for **computer use through cua-driver, and remote desktop so they can watch and take over the same desktop the agent drives (user)**. They named Sunshine/Moonlight as the remote desktop, then asked to **do it the way similar tools normally do (user)**.

How similar tools do it (researched 2026-11-04):

| Tool | Where the agent works | How the user watches | Take over | Approvals |
|---|---|---|---|---|
| Anthropic computer-use demo | Docker, Xvfb + light WM | noVNC beside the chat | yes | none |
| Bytebot | Docker, XFCE desktop | noVNC inside its web UI | yes | none |
| E2B Desktop, cua sandboxes | VM or container with a VNC server | noVNC page behind a password | yes | none |
| ChatGPT agent | its own cloud VM | small live window in the chat | yes, for sign-ins (agent kept out) | asks before significant actions |
| Claude Code / Desktop computer use | the user's real screen (macOS/Windows only; not Linux, not `-p`) | the user's own monitor | Esc stops | per-app approval, one session at a time |

None of them uses Sunshine/Moonlight: that is game streaming, built around GPU encoding, open UDP ports and native client apps. The browser-based ones all stream VNC into a web page.

## What was decided

1. **Follow the common pattern (user, approved playback).** The agent gets its own virtual desktop, not the user's real screen, on whichever machine runs the ZumiBot server: the PC in Local mode, the VPS in VPS mode. Same design in both modes.
2. **cua-driver drives that desktop (user).** Agents see it with screenshots and accessibility trees and act with clicks, typing, keys and app launches.
3. **Actions always ask (user).** Clicks, typing, keys, drags, scrolls and app launches always show ZumiBot's approval card, even though the CLI runs in auto mode; looking (screenshots, window lists) does not. "Allow for this chat" and "Allow always for this agent" work as they do for other tools.
4. **The user watches it in the app (user, approved playback):** an **Open Desktop** view in the right side panel next to Open Browser, Open Files and Open Side questions. The stream goes through ZumiBot's own sign-in and origin checks. No new public ports, no third-party web app.
5. **Take control (user, approved playback):** off by default. While on, the agent is paused and the user's mouse and keyboard reach the desktop. Same rules as the agent browser's Take control.
6. **The agent can ask for help (user, approved playback):** a handoff card ("sign in here, then press I'm done"), like the browser's action-required card.
7. **One desktop per agent (user).** Each agent has its own display and its own home folder, so apps, settings and sign-ins of one agent are never visible to another. This matches the agent browser's per-agent profiles.
8. **Sunshine/Moonlight is not in this version (user, approved playback).** It can come later as an optional "Open in Moonlight" for a native client over the LAN or Tailscale.

## Goals

- An agent with computer use turned on can see and control its own desktop from single chats, group rooms and routine runs.
- The user can open that desktop live, from any device that reaches ZumiBot (desktop shell, browser, phone), watch the agent, take control and hand it back.
- Nothing about the desktop is reachable except through ZumiBot's authenticated server.
- Text-only chats and agents without computer use pay nothing: no X server, no VNC, no cua-driver process.
- The whole feature can be tested without installing anything, with fakes (fake claude, fake cua-driver, fake VNC server), and costs no quota.

## Non-goals

- Driving the user's real screen or real session. (Claude's own computer use does that on macOS/Windows; it is out of scope here.)
- Sunshine, Moonlight, WebRTC streaming, audio, game controllers.
- Sharing one desktop between agents, or syncing desktops between the PC and the VPS.
- A security boundary against the agent's other tools. The forced approval card covers the `zumibot_desktop` MCP path only. The bridge's capability and IPC path live in the CLI's environment (that is how the `${VAR}` expansion works, as for the browser), so a Bash command that is approved (by the user, or by the auto-mode classifier) could reach the desktop's sockets or drive it directly (`cua-driver`, `xdotool`). Bash approval is the real boundary there. (Reviewer note, Task 8.)
- A security boundary against the agent itself: an agent with Bash already runs as the same OS user and can reach anything that user can, the desktop included. The desktop separates agents' app state and gives the user visibility and control; it is not a sandbox. (Docker isolation is a possible later step; there is no Docker on the PC today.)
- Recording or replaying sessions.

## Anti-goals (would make it a failure even if it works)

- A desktop, VNC port or X display reachable from the network, or a VNC password or capability token in a URL, log, error message or the UI.
- The agent acting while the user has control, or agent and user input interleaving.
- Streaming starting by itself (opening a chat, an agent turn or a handoff card must not start a stream).
- Desktops piling up and eating the VPS: they must start only when needed and stop when idle.
- User keystrokes or the stream ending up in chat items, logs or usage records.
- `--dangerously-skip-permissions`, `bypassPermissions`, or cua-driver's `unrestricted` mode.

## How it behaves

### Turning it on

- Computer use is **opt-in per agent**: a "Computer use" toggle in Agent Studio, stored as `computerUse: true` in the agent file's frontmatter (a new known key in `shared/src/frontmatter.ts`, like `memory`). Off by default. Zumi Bot never gets it. The group moderator and the room summary call never get desktop tools. A `/btw` side run of a computer-use agent gets the same `zumibot_desktop` server args as the main run (the `/btw` design requires identical MCP args for prompt-cache reuse), with its own capability that adds no handoff cards; its deny-all hook already blocks every tool, so it never acts. *(my call: a desktop costs memory and acts on real apps, so it should not appear for every agent the way the browser does)*
- Agent Studio's section for it mirrors the browser's: **Open Desktop** and **Clear desktop data** (confirm dialog; stops that agent's desktop and deletes its home folder, then the next start is a fresh one).
- When the server cannot run desktops (a missing program, see Setup), the toggle still saves, Agent Studio and the Desktop view say "Desktop unavailable on this server" with what is missing, and the agent's turns get a short prompt saying the desktop is unavailable (as the browser does). Chats work as before.

### What the agent can do

ZumiBot gives each turn of a computer-use agent an app-owned MCP server, `zumibot_desktop`, with a short curated tool list. The agent never talks to cua-driver directly. *(my call: cua-driver exposes 67 tools, including `run_script`, `kill_app`, `set_config`, installers and its own browser tools; a curated list keeps the surface small and stable across cua-driver updates, and gives ZumiBot one place to enforce leases, Take control, idle stop and output limits)*

Tools (names as the agent sees them, `mcp__zumibot_desktop__<name>`):

| Tool | What it does | cua-driver underneath |
|---|---|---|
| `desktop_screenshot` | Whole-screen PNG | `get_desktop_state` |
| `desktop_windows` | Open windows (title, app, pid, window id, bounds) | `list_windows` |
| `desktop_apps` | Running and installed apps | `list_apps` |
| `desktop_window_state` | One window's accessibility tree (element tokens) plus its screenshot | `get_window_state` |
| `desktop_zoom` | Cropped close-up of a region | `zoom` |
| `desktop_click` | Click by element token or by screen x,y; left/right/middle, single/double, modifiers | `click` / `double_click` / `right_click` |
| `desktop_drag` | Drag from one point to another | `drag` |
| `desktop_scroll` | Scroll at a point or element | `scroll` |
| `desktop_move` | Move the pointer (hover) | `move_cursor` |
| `desktop_type` | Type text into the focused element or an element token | `type_text` |
| `desktop_key` | One key or a combination | `press_key` / `hotkey` |
| `desktop_launch` | Start an installed app by the name `desktop_apps` gave | `launch_app` |
| `desktop_focus` | Bring a window to the front | `bring_to_front` |
| `desktop_request_user_action` | Ask the user for help (handoff card); waits for I'm done, Cancel or expiry | ZumiBot only |
| `desktop_release` | Release this turn's hold on the desktop | ZumiBot only |

Left out on purpose: `run_script`, `run_steps` (one approval would cover many actions), `kill_app`, `clipboard_read`/`clipboard_write`, `set_value`, `invoke_menu`, `set_window_frame`, sessions, recording, config, update and extension tools, and all of cua-driver's `browser_*` tools (the agent browser is for websites). Any of these can be added later by adding a row.

- **Stale actions are refused by the server, as in the browser (follows decision 5).** `desktop_screenshot` and `desktop_window_state` return a stamp (desktop generation, lease epoch, observation id); `desktop_zoom` returns none, since it takes a `windowId` and window-local pixels and replaces no observation (amended after the spike, see the verification doc). Every action tool requires the latest stamp. Element tokens are ZumiBot-issued wrappers around cua-driver's, tied to that observation. A stamp is void after the user had control, after the lease was lost and taken again, after the desktop restarted, or once a newer observation was taken. A void stamp gets a "stale, take a new screenshot" result and nothing reaches the desktop. So a click approved long after its screenshot, or after another chat used the same agent's desktop in between, cannot land on the wrong thing. *(my call)*
- Coordinates are screen pixels of the screenshot the agent last got. The default desktop is **1280 × 800** *(my call)*, and screenshots are sent at that size, so screenshot pixels and screen pixels are the same. Screenshots are always full-size PNG, never scaled (cua-driver's `max_image_dimension` is never used), so on a larger configured desktop the screenshot, element frames and coordinates still share one pixel space (amended after the spike, see the verification doc).
- Screenshots and tool output are bounded like the browser's (`INLINE_IMAGE_MAX_BYTES`, a text cap); an image that cannot fit is an error result, never a silent truncation.
- The appended prompt (`desktopPrompt`, separate from house style, like `browserPrompt`) tells the agent: use the app browser for websites and the desktop only for what needs a desktop; screenshot before acting and again after; never type passwords or codes (ask with `desktop_request_user_action`); release when done; after the user had control, look again before acting.

### Approvals

- **Actions always ask (user).** Production runs the CLI in `--permission-mode auto`, where the CLI's classifier lets many tool calls through without asking ZumiBot. For desktop **actions** (`desktop_click`, `desktop_drag`, `desktop_scroll`, `desktop_move`, `desktop_type`, `desktop_key`, `desktop_launch`, `desktop_focus`) that is not enough: each call must reach ZumiBot's permission handler and show a card, unless the user's own "Allow for this chat" or "Allow always for this agent" covers it (ZumiBot answers those itself, as today). **Looking** (`desktop_screenshot`, `desktop_windows`, `desktop_apps`, `desktop_window_state`, `desktop_zoom`) and `desktop_release`/`desktop_request_user_action` follow the normal mode and never need a forced card.
- How to force it: explicit `ask` rules override auto mode (Claude Code docs, permission modes: "Explicit ask rules still force a prompt"), and MCP tools marked `requiresUserInteraction` prompt even when an allow rule matches. The builder picks one (an `ask` rule list passed with `--settings`, merged with any other `--settings` the run has, or the bridge's tool annotation) and **proves it with a probe against the real CLI in auto mode** (in `npm run e2e`, like `probeSideRun`), because a CLI update could change it. If no mechanism forces the card, stop and tell the user; never fall back to letting actions run unasked.
- Nothing in this feature adds an allow rule by itself.
- Unlike the browser cards (which hide their input), desktop cards **show what the agent wants to do** in plain words: "Click at 412, 300 (double, right button)", "Type: `hello world`", "Press Ctrl+S", "Launch Firefox". *(my call: a desktop click is meaningless to approve without seeing it)*
- A pending pointer card has **Show on desktop**: it opens the Desktop view for that agent (watching, not controlling) and marks the target point on the live picture. *(my call)* Opening it is the user's choice; the card itself never starts a stream.
- "Allow always for this agent" matches by tool name, as today: allowing `desktop_screenshot` once is the expected way to stop being asked for every look. The remembered-approvals list in Agent Studio shows them.
- The risk hint (Jev) runs on desktop cards as on other cards.
- Tool rows in the chat show the action summary; results show "Desktop command completed/failed" and never store screenshots in the chat JSON (they would bloat it and the items feed). *(my call, same as the browser)*

### Watching and taking control

- **Open Desktop** sits in the side panel list (with a member picker in a room), in Agent Studio, and on handoff and approval cards. The Desktop view shows the agent's name, a status line (Starting…, Agent working, Waiting for approval, Idle, You have control, Controlled in another window, Unavailable) and a **Take control** toggle, plus Back/✕ like the other side views.
- The picture scales to fit the panel (and a full-screen sheet on a phone, where touch acts as mouse while in control). The desktop's own size does not change with the panel, so the agent's coordinates stay valid.
- Opening the view of a stopped desktop starts it (subject to the cap), showing Starting… meanwhile.
- **Streaming happens only while a Desktop view is open and visible.** Closing it, switching away, hiding the tab or disconnecting stops that viewer's stream. Reopening starts with Take control off.
- **Take control on:** the server marks this connection as the controller of that agent's desktop, waits for the agent's in-flight desktop command to finish ("Pausing agent…"), then shows "You have control". From then on every agent desktop call waits (not fails) until control is released. Watching viewers on other devices see "Controlled in another window"; control is never stolen silently.
- **Take control off**, closing the view, disconnecting, sign-out or a missed heartbeat releases control. The agent's waiting call continues, and the prompt tells the agent to look again first.
- Watching never grants input. The server enforces it, not the UI: input from a connection that does not hold control is dropped at the server.
- The user's keys, pointer moves and clipboard pastes are stream input only: never chat items, tool arguments, logs or usage.

### Handoffs

- `desktop_request_user_action {reason}` adds a **desktop action** card to the chat, tied to the agent, chat, turn, desktop generation and request id, with the reason, **Open Desktop**, **I'm done** and **Cancel** (the same item shape and rules as `browser-action`; ideally the same card component with a kind). No live picture until the user opens it.
- The tool waits without polling (MCP progress notifications keep it alive, as the browser's does). **I'm done** releases control and returns success (the agent must look to check, it is not told the step worked); **Cancel** returns cancelled; no viewer for 10 minutes expires it.
- A pending handoff counts as "waiting" for notifications and for routine runs, like a pending approval.
- After a server restart an old pending handoff shows as interrupted.

### Group rooms

Each member with computer use has its own desktop. Members work on their own desktops in parallel within the cap. The Desktop view in a room has a member picker, like Open Browser.

## Desktops: processes, lifetime and limits

### What one desktop is

For each agent, under `ZUMIBOT_DATA_DIR/desktops/<profileId>/` (opaque id mapped to the agent, like browser profiles; names are never paths), only:

- `home/`: the agent's desktop home (`HOME` and XDG dirs for the session), so app settings and sign-ins persist across restarts.

Each running desktop also gets a short runtime dir (0700), `${XDG_RUNTIME_DIR or tmpdir}/zumibot-<uid>/<hash of the desktops folder>/<id>`, for the X auth cookie (0600), the VNC and other unix sockets and `desktop.json`. It is short because a unix socket path is limited to 108 bytes (amended after the spike, see the verification doc).

Running, one desktop is:

1. **Xvnc** (TigerVNC) on a free display number `:N`, size 1280×800×24, `-nolisten tcp`, `-rfbport -1` (no TCP VNC port at all), `-rfbunixpath <runtime>/vnc.sock` with mode 0600, `-auth <runtime>/Xauthority`, `-SecurityTypes None`. *(my call: one process gives both the X server and VNC; a unix socket in a 0700 folder is reachable only by the server's own user, who is inside the trust boundary anyway, so a VNC password would add a secret to manage for no gain)*
2. **A light desktop session** on its own D-Bus session bus (`dbus-daemon`, so AT-SPI, needed by cua-driver, has a bus). XFCE components without `xfce4-session` (`xfsettingsd`, `xfwm4`, `xfce4-panel`, `xfdesktop`; the full `startxfce4` autostarts unrelated host services) with Firefox installed; the command is configurable (`ZUMIBOT_DESKTOP_SESSION`). Exact commands, env and the short runtime folder (unix socket paths are limited to 108 bytes) come from the spike: `docs/superpowers/verification/2026-11-04-computer-use-spike.md`. *(my call)*
3. **cua-driver** (`cua-driver mcp`, its default `standard` mode, never `unrestricted`) started by the server as an MCP client child, inside the same session environment (`DISPLAY`, `HOME`, `DBUS_SESSION_BUS_ADDRESS`). Only the server talks to it.

The server owns and reaps all three (process group per desktop); a crash of any one marks the desktop failed and stops the rest. Restart recovery cleans up leftovers of its own desktops (by pid files in the runtime dir) and never touches other X servers.

### When desktops run

| Setting (env `ZUMIBOT_DESKTOP_*`) | Default | Meaning |
|---|---|---|
| `MAX` | 2 | Running desktops at once, server-wide (starting and stopping ones count) |
| `IDLE_MS` | 15 minutes | Stop a desktop with no viewer, no lease and no pending handoff for this long |
| `LEASE_IDLE_MS` | 2 minutes | A turn holding the desktop without using it loses the hold |
| `HANDOFF_IDLE_MS` | 10 minutes | Unwatched handoff expires |
| `COMMAND_MS` | 30 seconds | One desktop command's limit |
| `QUEUE_MS` | 2 minutes | Waiting for a free slot or the lease; then a recoverable "desktop busy" result |
| `WIDTH`/`HEIGHT` | 1280/800 | Desktop size (max 1920×1080) |

*(my call: idle is longer than the browser's 2 minutes because stopping a desktop closes the agent's open apps; files and sign-ins in its home survive, unsaved work in an open app does not)*

- No desktop starts at server start, on agent listing, or for a text-only turn. One starts on an agent's first desktop tool call in a turn or an explicit Open Desktop.
- At the cap, a safely idle desktop (no viewer, lease or handoff) is stopped first; otherwise the request waits in a fair queue with a visible "waiting for a desktop" status, then gets "desktop busy".
- **Lease:** one turn at a time per agent desktop. The same agent in two chats queues, so one chat cannot click between the other's screenshot and click. Released at turn end, Stop, `desktop_release`, or lease idle. A pending handoff keeps it.
- Clean shutdown stops desktops before the data lock is released.

### Rename and delete

Same as browser profiles and remembered approvals: rename keeps the profile id (moved synchronously before the agents-folder watcher's removal pass, in both `agents:save` and `agentsSync.ts`); a deleted agent's desktop stops at once and its mapping is detached; its folder stays until **Clear desktop data**, and recreating the name gets a fresh profile. A parse error is not a delete.

## Architecture

Model it on the agent browser (`core/browser/`), reusing its pieces where they fit rather than copying them.

- **Backend `core/desktop/`:** a `DesktopManager` (profiles, lazy start, cap and queue, leases, control, handoffs, idle stop, generations), a `DesktopProcess` adapter (Xvnc + session + cua-driver; injectable so tests use fakes), a cua-driver client (MCP SDK client over the child's stdio, mapping the curated tools), and `desktopApplication.ts` wiring like `createBrowserApplication`.
- **Per-turn bridge:** a stdio MCP server entry (`desktopBridge`, like `browserBridge.ts`) passed to the CLI with `--mcp-config` next to the browser's, authorized by a per-turn capability in env (never argv), talking to the backend over a private 0600 unix-socket IPC. The capability is bound to chat, agent, profile and turn and is revoked at turn end. If the browser's IPC/capability code can be shared by both, share it. `ChatService` and `GroupService` add the desktop args, env and prompt only for agents with `computerUse: true`.
- **Viewer transport:** a dedicated authenticated WebSocket (`/ws/desktop`) behind `createGate` and the Origin check, like `/ws/browser`. A viewer sends `watch {agent, chatId?}`; the server attaches it to that desktop's VNC unix socket and relays RFB bytes both ways.
  - The relay parses the client-to-server RFB stream (handshake, then each message by type and length) and **drops** KeyEvent, PointerEvent and ClientCutText unless this connection holds control. SetDesktopSize is dropped too. An unknown or malformed message closes the viewer. This parser is a pure module with its own tests.
  - Control, heartbeat and status messages go on the same socket in a small JSON side channel (or a second socket); the builder picks the framing. Caller identity comes only from the authenticated upgrade.
  - Backpressure: above 4 MiB buffered for a viewer, the relay pauses reading that viewer's unix socket; if that lasts 10 s, the viewer is closed with 1008.
- **Frontend:** `DesktopPanel.tsx` with noVNC (`@novnc/novnc`, MPL-2.0, pinned exact) as the RFB client, bundled into the frontend (no iframe, no third-party page, no CDN). `frontend/src/state/sidePanel.ts` gains a `'desktop'` view; its rules (one view at a time, a desktop waiting behind a chat view, Esc/✕/Back) follow the browser's and live in pure modules. Status, control and marker logic go in `state/` modules so vitest covers them.
- **Shared:** `ZumiBotApi` gains `desktops:status` and `desktops:clear`, touching `types.ts`, `rpc/handlers.ts` and `net/api.ts`. Handoff answers (I'm done, Cancel) go through the viewer socket's `answer` op, not RPCs. A handoff is a `browser-action` chat item with `surface: 'desktop'`.
- **CSP and headers stay as they are** (`connect-src 'self'` already allows the same-origin WebSocket; canvas needs nothing). The e2e must load noVNC under the real CSP to prove it.
- **Electron shell:** no new permissions. noVNC needs no camera, mic, clipboard-read or pointer lock. Keyboard shortcuts the shell owns (`Ctrl+Shift+S`) keep working.
- **Sync:** `sync.mjs` excludes `desktops/` the way it excludes `browsers/`: desktops stay on their machine.

## Setup and packaging

- Needs on the server machine: TigerVNC's `Xvnc` (`tigervnc-standalone-server`), `dbus-daemon` (the session runs its own, not `dbus-run-session`), AT-SPI (`at-spi2-core`), the XFCE parts `xfsettingsd`, `xfwm4`, `xfce4-panel` and `xfdesktop` (not `xfce4-session`; amended after the spike, see the verification doc) and Firefox as a deb, not a snap (a snap Firefox does not run cleanly under a custom `HOME` in an Xvnc session), plus cua-driver (installed per user without sudo by its install script, into `~/.cua-driver`).
- Paths come from `PATH` or overrides: `ZUMIBOT_DESKTOP_XVNC`, `ZUMIBOT_DESKTOP_DBUS_DAEMON`, `ZUMIBOT_DESKTOP_SESSION`, `ZUMIBOT_CUA_DRIVER`.
- `zumibot-server desktop-check` (a new `cli.ts` command) lists what is found and missing and the cua-driver version. Ordinary startup never installs anything and never needs sudo.
- A runbook section in `deploy/SETUP-VPS.md` (and a short note for Local mode) lists the packages and the cua-driver install. Installing them on the PC or the VPS is done only with the user's go-ahead, as the repo's rules say.
- cua-driver's Linux support is marked pre-release upstream. **The first build step is a spike on this PC** (after the user approves installing the packages): Xvnc + XFCE + cua-driver, check that screenshots, clicks, typing and element tokens land. If cua-driver cannot drive an Xvnc desktop, stop and report to the user; do not swap in xdotool or another driver silently.
- **Arabic text** *(my call)*: the package list includes Arabic-capable fonts (Noto), and the spike checks that `desktop_type` and the user's own typing under Take control both put Arabic into a text editor. If cua-driver cannot type Arabic, that is reported to the user as a known limit, not a stop.

## Testing

- **Unit (vitest):** manager (lazy start, cap and queue, idle stop, leases across chats, control waits for in-flight then blocks, release resumes, handoff done/cancel/expiry, generations, rename/delete/clear, shutdown), the RFB client-message parser and filter (every message type, split reads, drops input without control, closes on unknown), tool mapping and bounding, capability scoping, frontmatter key, side panel rules, viewer status and marker logic.
- **Fakes:** `fake-cua-driver.mjs` (an MCP stdio server answering the mapped tools with a fixed image, logging calls to a file), a fake Xvnc (a small Node RFB server on the unix socket with a fixed framebuffer, logging input it receives) and a fake session command. The process adapter takes their paths from dev hooks read through `devEnv()`.
- **`npm run e2e:computer`** (built server, headless Chrome via `playwright-core`, fake claude, fakes above, no quota): turn computer use on for an agent; a fake reply calls `desktop_screenshot` then `desktop_click`; the approval card shows the action; Allow; the fake cua-driver log shows the click. Open Desktop shows the canvas (noVNC under the real CSP); pointer input without control never reaches the fake Xvnc; with Take control it does; a second browser context sees "Controlled in another window"; a handoff card's I'm done resumes the turn. A hostile Origin and a signed-out socket are refused. (`e2e:desktop` is taken by the desktop shell suite.)
- **Real CLI probe** in `npm run e2e` (it already drives the real `claude`): in auto mode, a desktop action tool of a stub MCP server reaches `can_use_tool`, and a looking tool does not need to. This guards the "actions always ask" rule across CLI updates.
- A manual check on the real stack after the spike, shown to the user.

## Left to the builder

File and component boundaries; the exact JSON framing on `/ws/desktop`; whether the browser's IPC, capability and bridge transport code is generalized or reused as is; noVNC settings (scaling, quality, compression); the exact cua-driver argument mapping (delivery mode, coordinate frame) once the spike shows what lands on Xvnc; display-number allocation; the session's exact command and Firefox source. Changing any decision marked **(user)** needs the user.
