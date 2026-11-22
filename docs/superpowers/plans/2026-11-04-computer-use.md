# Computer Use and Agent Desktops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents with `computerUse: true` see and control their own per-agent virtual desktop through cua-driver, with forced approval cards for actions, and the user watches and takes control in an in-app noVNC view.

**Architecture:** A backend `DesktopManager` (modeled on `BrowserManager`, reusing `BrowserLeases`, `BrowserHandoffs`, `BrowserCapabilities` and the profile store) owns one Xvnc + desktop session + cua-driver process tree per agent. Each turn gets an app-owned stdio MCP bridge (`zumibot_desktop`) over a private IPC socket, plus a `--settings` ask list that forces cards for action tools. Viewers attach over an authenticated `/ws/desktop` socket that relays RFB bytes to the desktop's VNC unix socket, with a pure RFB filter dropping input from anyone not holding control.

**Tech Stack:** TypeScript, Node 22, `@modelcontextprotocol/sdk` 1.32.2 (already a backend dep), `ws` 8.22.0, TigerVNC `Xvnc`, cua-driver, `@novnc/novnc` 1.7.0 (new, frontend), vitest, playwright-core e2e.

**Spec:** `docs/superpowers/specs/2026-11-04-computer-use-design.md` (approved 2026-11-04). Read it with this plan.

## Global Constraints

- **No commits, pushes or PRs** unless the user says so in this session (user rule). Steps end at "tests pass"; there are no commit steps.
- Ask the user before installing system packages, using sudo, installing the `.deb`, touching the VPS, or opening ports. Installing TigerVNC, XFCE, fonts, Firefox or cua-driver on this PC counts.
- Never `--dangerously-skip-permissions`, `bypassPermissions`, or cua-driver `unrestricted` / `--dangerously-bypass-approvals`.
- Secrets (capability tokens, IPC paths, X cookies) never in logs, URLs, error messages or the UI; files holding them 0600, their folders 0700.
- Dependencies pinned to exact versions (`@novnc/novnc` `1.7.0`). Every workspace keeps one version number; no bump in this plan.
- Logic in pure modules (`frontend/src/state/`, `shared/src/`, backend `core/`) so vitest covers it; the frontend has no DOM tests.
- Tool names exactly: `desktop_screenshot`, `desktop_windows`, `desktop_apps`, `desktop_window_state`, `desktop_zoom`, `desktop_click`, `desktop_drag`, `desktop_scroll`, `desktop_move`, `desktop_type`, `desktop_key`, `desktop_launch`, `desktop_focus`, `desktop_request_user_action`, `desktop_release`; MCP server name `zumibot_desktop`; CLI-visible names `mcp__zumibot_desktop__<name>`.
- Action tools (forced card): click, drag, scroll, move, type, key, launch, focus. Looking tools: screenshot, windows, apps, window_state, zoom.
- Defaults: `ZUMIBOT_DESKTOP_MAX=2`, `IDLE_MS=900000`, `LEASE_IDLE_MS=120000`, `HANDOFF_IDLE_MS=600000`, `COMMAND_MS=30000`, `QUEUE_MS=120000`, `WIDTH=1280`, `HEIGHT=800` (max 1920×1080).
- Data: `ZUMIBOT_DATA_DIR/desktops/` (profiles.json + `<profileId>/home`, `<profileId>/run`); never synced.
- Agent frontmatter key `computerUse: true`; absent = off; Zumi Bot never gets it.
- Comments short and say *why*. Keep the existing style of each file you touch.
- `e2e:desktop` is taken (desktop shell); the new suite is `e2e:computer`.

## Spike amendments (binding; Task 1 passed, GATE: PASS)

Source of truth for exact commands, argument shapes and result shapes: `docs/superpowers/verification/2026-11-04-computer-use-spike.md` (read its sections 1-6 and 10). Where it conflicts with Task 5, Task 6 or Task 7 below, it wins. Summary of what changed:

- **Input route:** keyboard and pointer work on Xvnc only in desktop scope (XTest): `click/drag/scroll/move_cursor/type_text/press_key/hotkey {scope:"desktop", ...}`. Background scope fails (`background_unavailable`). `double_click`/`right_click` refuse desktop targets: use `click` with `count`/`button`. Never `type_text {element_token}` (it truncates multibyte text and still reports success): `desktop_type` with an element clicks it first (foreground retry on `background_unavailable`), then types in desktop scope. `cuaRequest` therefore returns a list of calls, not one.
- **No coordinate scaling.** Screenshots are always full-size PNG (`get_desktop_state {}`, image MIME `image/png`); never pass `max_image_dimension` (it makes cua's frame scale sticky). Agent coordinates, element frames and the desktop size are one pixel space. The observation has no `scale`.
- **Zoom is window-only in cua.** `desktop_zoom` takes `{stamp?, windowId, x1, y1, x2, y2}` in window-local pixels (Task 6 changes `shared/src/desktop.ts` and its test accordingly); the bridge refreshes `get_window_state {pid, window_id, include_accessibility_tree:false}` then calls `zoom`.
- **Window ids:** tools take our `windowId` only; the manager keeps a `windowId → {pid, bounds}` map from the latest `list_windows` (refreshing it itself when an id is unknown) and fills `pid`.
- **Apps:** `desktop_apps` returns only `kind:"desktop"` entries `{name, running}`; never the host `processes[]` (165 KB). `desktop_launch` accepts only an exact name from that filtered list, then `launch_app {name}` or `{launch_path}`; never free text.
- **Process layout (Task 5):** Xvnc (+ `-desktop ZumiBot -nolisten local`), a separate `dbus-daemon --session --nofork --nopidfile --nosyslog --address=unix:path=<run>/xdg/bus`, the session `sh -c 'xfsettingsd & xfwm4 & xfce4-panel & exec xfdesktop'` (NOT `startxfce4`, NOT `dbus-run-session`), and `cua-driver mcp`, each spawned `detached` in its own process group with pid files; only cua-driver gets piped stdio; wait for `xdg/bus` before the session and cua-driver. `runtime.dbusRun` becomes `dbusDaemon` (`'D-Bus (dbus-daemon)'`), session `missing` name `'desktop session (xfwm4)'`. cua-driver is started by the adapter itself and wrapped with a small `Transport` over `ReadBuffer`/`serializeMessage` from `@modelcontextprotocol/sdk/shared/stdio.js` (the SDK's `StdioClientTransport` cannot start the child detached); unparsable lines are skipped and logged. Env per spike section 1 (`DBUS_SESSION_BUS_ADDRESS`, GIO trio `GIO_USE_VFS=local GIO_USE_VOLUME_MONITOR=unix GVFS_DISABLE_FUSE=1`; cua env vars only for cua-driver). cua-driver fallback path `~/.cua-driver/packages/current/cua-driver`.
- **Runtime dir:** short, `${XDG_RUNTIME_DIR||os.tmpdir()}/zumibot-<uid>/<8-char id>` (0700); unix socket paths max 108 bytes, so fail clearly above ~100. `<data>/desktops/<uuid>/` keeps only `home/` (and profiles.json). `recoverDesktops` scans the short root.
- **Crash handling:** Xvnc exit alone closes the desktop (cua-driver and the bus survive it, kill them); on Xvnc exit and in `recoverDesktops` unlink `/tmp/.X<N>-lock` and `/tmp/.X11-unix/X<N>` when the lock's pid is our dead Xvnc. `close()`: end cua-driver stdin, SIGTERM every group, SIGKILL after 3 s.
- **Prompt (Task 6):** tell the agent to click into a field before typing, and to use `desktop_windows` ids.
- Fakes (Task 5) follow the real result shapes in spike sections 3-6 (PNG image block + text + structuredContent, `window_id` integer, `app_name`, `bounds{x,y,width,height}`, element tokens like `s00000001:3`, errors `isError:true` + `structuredContent.code`).

## Review Focus

1. The desktop dies mid-turn (Xvnc or session crashes): the agent's next call gets `desktop_restarted` ("take a new screenshot"), viewers get a new generation and reconnect, the next call starts a fresh desktop. → Task 7 test `crashed desktop restarts on next call and voids stamps`.
2. An approval card left pending longer than `LEASE_IDLE_MS` while the same agent works in another chat: the late-approved click must be refused as stale, never land. → Task 7 test `lease lost while card pending voids the stamp`.
3. The user holds control for longer than `QUEUE_MS`: the agent's call keeps waiting and runs after release instead of failing busy. → Task 7 test `control wait does not hit the queue timeout`.
4. A display number already taken (the user's own `:1`, a stale lock): allocation skips it and the desktop still starts. → Task 5 test `skips taken display numbers`.
5. A slow phone viewer stops reading: the relay drops that viewer after sustained backpressure without stalling the desktop or other viewers. → Task 10 test `stalled viewer is dropped, others keep streaming`.

---

### Task 1: Spike on the real stack (gate)

Not TDD: this proves cua-driver can drive an Xvnc desktop and pins the exact cua-driver argument shapes later tasks map to. **Stop and report to the user if it fails** (spec: no silent swap to xdotool).

**Files:**
- Create: `docs/superpowers/verification/2026-11-04-computer-use-spike.md`
- Scratch scripts only in the session scratchpad, never in the repo.

- [ ] **Step 1: Ask the user to approve installing** (they run the sudo part in a Terminal tab): `sudo apt-get install -y tigervnc-standalone-server xfce4-session xfwm4 xfce4-panel xfdesktop4 xfce4-terminal mousepad dbus-x11 at-spi2-core fonts-noto-core` and the per-user cua-driver install `/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"` (read the script before running). Firefox deb from Mozilla's apt repo is optional for the spike.
- [ ] **Step 2: Start one desktop by hand** in a scratch dir: write an Xauthority with a FamilyWild cookie, run `Xvnc :90 -geometry 1280x800 -depth 24 -rfbport -1 -rfbunixpath <run>/vnc.sock -rfbunixmode 0600 -SecurityTypes None -nolisten tcp -auth <run>/Xauthority -AlwaysShared -AcceptSetDesktopSize=0`, then `dbus-run-session -- sh -c '"$0" & exec "$@"' startxfce4 cua-driver mcp` with `DISPLAY=:90 XAUTHORITY=<run>/Xauthority HOME=<scratch>/home`.
- [ ] **Step 3: Drive it over MCP** with a scratch Node script (SDK `Client` + `StdioClientTransport` spawning the Step 2 command): `tools/list`; `get_desktop_state`; `launch_app` mousepad; `list_windows`; `get_window_state`; `click` by element token and by desktop coordinates; `type_text` "hello" and "مرحبا"; `press_key`/`hotkey` ctrl+s; `drag`; `scroll`; `move_cursor`; `bring_to_front`; `zoom`. Watch with `vncviewer <run>/vnc.sock` or noVNC if handy.
- [ ] **Step 4: Record in the verification doc:** exact tool names and argument shapes that landed (target form, `delivery_mode` that works on Xvnc, coordinate frame, key name syntax), the image format and size `get_desktop_state` returns (MIME, dimensions, whether it downscales), the element token field names, the env needed for AT-SPI (e.g. `GTK_MODULES`, `NO_AT_BRIDGE`), whether Arabic typed correctly, the cua-driver version (`cua-driver --version`), RSS of the process tree idle and busy.
- [ ] **Step 5: Gate.** Screenshot, launch, pixel click, element click, typing and keys all land → continue. Otherwise stop and report to the user with the doc.

### Task 2: Shared desktop contract

**Files:**
- Create: `zumi-bot-server/shared/src/desktop.ts`
- Modify: `zumi-bot-server/shared/src/types.ts` (ChatItem `browser-action` gets `surface?: 'desktop'`; `ZumiBotApi.desktops`; `AgentSummary.computerUse?: true`)
- Test: `zumi-bot-server/shared/tests/desktop.test.ts`

**Interfaces:**
- Produces (all exported from `@zumibot/shared/desktop`):
  - `type DesktopTarget = { agent: string; chatId?: string; requestId?: string }`
  - `type DesktopOwner = { profileId: string; chatId: string; turnId: string }`
  - `type DesktopStamp = { generation: string; epoch: number; observationId: string }`
  - `type DesktopModifier = 'ctrl' | 'alt' | 'shift' | 'super'`
  - `type DesktopCommand` union (ops): `screenshot`, `windows`, `apps`, `windowState {windowId}`, `zoom {x1,y1,x2,y2}`, `click {stamp, x?, y?, element?, button?: 'left'|'right'|'middle', count?: 1|2, modifiers?: DesktopModifier[]}` (exactly one of x+y or element), `drag {stamp, fromX, fromY, toX, toY}`, `scroll {stamp, x, y, direction: 'up'|'down'|'left'|'right', amount?: number}`, `move {stamp, x, y}`, `type {stamp, text, element?}`, `key {stamp, keys: string[]}`, `launch {stamp, name}`, `focus {stamp, windowId}`, `requestUserAction {reason}`, `release`
  - `type DesktopResult = { ok: true; data: unknown } | { ok: false; code: string; message: string }`
  - `interface DesktopStatus { agent: string; profileId: string; generation: string; state: 'off'|'stopped'|'queued'|'starting'|'ready'|'closing'|'unavailable'; control: 'agent'|'pausing'|'you'|'other'; pendingRequestId: string|null; error: string|null; width: number; height: number; missing?: string[] }`
  - `type DesktopHandoff = import('./browser').BrowserHandoff`
  - `interface DesktopConfig { max: number; idleMs: number; leaseIdleMs: number; handoffIdleMs: number; commandMs: number; queueMs: number; width: number; height: number }`
  - `const DESKTOP_SERVER = 'zumibot_desktop'`, `DESKTOP_ACTION_TOOLS: readonly string[]` (the 8 action names), `DESKTOP_LOOK_TOOLS: readonly string[]`, `desktopToolName(name: string): string` → `mcp__zumibot_desktop__${name}`
  - `parseDesktopCommand(value: unknown): DesktopCommand` (throws `Invalid desktop message`; rejects extra fields like `parseBrowserCommand`)
  - `type DesktopRequest = { id: number } & ({op:'watch'; target: DesktopTarget} | {op:'unwatch'} | {op:'takeControl'} | {op:'releaseControl'} | {op:'answer'; target: DesktopTarget; requestId: string; decision: 'done'|'cancel'})`, `parseDesktopRequest(value: unknown): DesktopRequest`
  - `type DesktopServerMessage = {type:'response'; id: number; ok: true; value: unknown} | {type:'response'; id: number; ok: false; error: string} | {type:'status'; status: DesktopStatus} | {type:'rfb'; state:'open'|'closed'; generation: string}`
  - `boundDesktopStatus(s: DesktopStatus): DesktopStatus`
  - `desktopActionSummary(toolName: string, input: unknown): string | null` (null for non-desktop or looking tools)
  - `desktopPoint(toolName: string, input: unknown): {x: number; y: number} | null` (target point for Show on desktop: click/move/scroll use x,y; drag uses fromX,fromY; else null)
  - `ZumiBotApi.desktops: { status(agent: string): Promise<DesktopStatus>; clear(agent: string): Promise<void> }`

- [ ] **Step 1: Write the failing tests** in `shared/tests/desktop.test.ts`:
  - `parseDesktopCommand accepts each op` — one valid example per op round-trips equal.
  - `click needs exactly one of a point or an element` — `{op:'click', stamp, x:1}` throws; `{…, x:1, y:2, element:'e1'}` throws; `{…, element:'e1'}` passes.
  - `coordinates are bounded` — x or y `< 0`, `>= 1920` (x) / `>= 1080` (y), or non-finite throws.
  - `type text limit` — 16384 chars passes, 16385 throws; Arabic `'مرحبا'` passes unchanged.
  - `key accepts 1 to 5 keys of 1..32 chars`.
  - `extra fields rejected` — `{op:'screenshot', x:1}` throws.
  - `parseDesktopRequest` — each op valid; unknown op throws; `answer` with decision `'maybe'` throws.
  - `desktopActionSummary`: `('mcp__zumibot_desktop__desktop_click', {x:412,y:300,count:2,button:'right'})` → `'Click at 412, 300 (double, right button)'`; element click → `'Click element e4'`; type → `'Type: hello world'`, text over 200 chars cut with `'…'`; key `['ctrl','s']` → `'Press Ctrl+S'`; launch → `'Launch firefox'`; drag → `'Drag from 10, 10 to 200, 200'`; scroll → `'Scroll down 3 at 400, 300'` (amount default 3); move → `'Move pointer to 5, 5'`; focus → `'Bring window w12 to front'`; screenshot → `null`; `('Bash', {})` → `null`.
  - `desktopPoint` for click/move/scroll/drag and null for type.
  - `boundDesktopStatus` clips agent to 128, error to 512, missing to 10 items of 64 chars.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/shared/tests/desktop.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** `shared/src/desktop.ts` with the helpers style of `shared/src/browser.ts` (`object`, `fields`, `string`, `id`). Stamp `generation`/`observationId` are ids (`/^[a-zA-Z0-9_-]+$/`, ≤128), `epoch` a non-negative safe integer. `scroll.amount` integer 1..20. Add the `types.ts` changes.
- [ ] **Step 4: Run** the test → PASS, then `npm run typecheck -w @zumibot/shared` → no errors.

### Task 3: `computerUse` frontmatter key

**Files:**
- Modify: `zumi-bot-server/shared/src/frontmatter.ts` (`AgentFields.computerUse: boolean | null`, parse, `serializeAgent`, equality check)
- Modify: `zumi-bot-server/backend/src/core/agents/agentStore.ts:199-202` (`AgentSummary.computerUse` when true)
- Modify: `zumi-bot-server/backend/src/core/agents/zumiBot.ts` only if its summary is built by hand (it must never have `computerUse`)
- Test: `zumi-bot-server/shared/tests/frontmatter.test.ts`, `zumi-bot-server/backend/tests/core/agentStore.test.ts`

**Interfaces:**
- Produces: `AgentFields.computerUse: boolean | null` (null = key absent; `true` only for YAML `true`; any other value parses as `false`); `AgentSummary.computerUse?: true`.

- [ ] **Step 1: Failing tests:** `parses computerUse: true` → `true`; absent → `null`; `computerUse: "yes"` → `false`; `serializeAgent` with `{computerUse: true}` on a file without it adds `computerUse: true`; with `null` deletes the key; unchanged fields still splice the original head verbatim. In agentStore: an agent file with `computerUse: true` lists with `computerUse: true`; without it, the property is absent.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/shared/tests/frontmatter.test.ts zumi-bot-server/backend/tests/core/agentStore.test.ts` → FAIL.
- [ ] **Step 3: Implement** like `memoryLimit` (its own `if (before.computerUse !== fields.computerUse)` block).
- [ ] **Step 4: Run** → PASS.

### Task 4: RFB client filter (pure)

**Files:**
- Create: `zumi-bot-server/backend/src/core/desktop/rfbFilter.ts`
- Test: `zumi-bot-server/backend/tests/core/desktop/rfbFilter.test.ts`

**Interfaces:**
- Produces: `class RfbClientFilter { constructor(o: { canInput(): boolean; maxCutText?: number }); push(chunk: Uint8Array): { forward: Uint8Array[]; close: boolean } }`

The filter reads the client→server byte stream of one RFB session in order: ProtocolVersion (12 bytes, must match `/^RFB 003\.00[378]\n$/`), the 1-byte security choice (must be 1 = None), ClientInit (1 byte, **rewritten to 1** so a viewer cannot ask for exclusive access), then messages. Message lengths: 0 SetPixelFormat 20; 2 SetEncodings 4+4n (n u16 at 2, n ≤ 64); 3 FramebufferUpdateRequest 10; 4 KeyEvent 8 (input); 5 PointerEvent 6 (input); 6 ClientCutText 8+len (u32 at 4; high bit = extended, use its absolute value; ≤ `maxCutText`, default 1 MiB) (input); 150 EnableContinuousUpdates 10; 248 ClientFence 9+len (u8 at 8, ≤ 64); 251 SetDesktopSize 8+16n (n u8 at 6) dropped always; 250 xvp 4 dropped always; 255 QEMU with subtype 0 = extended key event 12 (input), other subtypes close. Unknown type, bad version or security → `close: true`. Input messages are forwarded only when `canInput()` is true at the moment the whole message is complete. Partial messages are buffered across pushes (max one message, ≤ 1 MiB + 8).

- [ ] **Step 1: Failing tests:** `passes handshake and forces shared flag` (ClientInit 0 forwarded as 1); `forwards FramebufferUpdateRequest split across three pushes as one 10-byte chunk`; `drops KeyEvent and PointerEvent without input`; `forwards them with input`; `canInput is checked when the message completes` (flip between pushes of one PointerEvent); `drops SetDesktopSize and xvp always`; `ClientCutText length bound` (len 2 MiB → close); `extended clipboard length uses absolute value`; `QEMU extended key event is input`; `unknown type 77 closes`; `bad protocol version closes`; `security type 2 closes`.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/desktop/rfbFilter.test.ts` → FAIL.
- [ ] **Step 3: Implement** as a small state machine (`'version' | 'security' | 'init' | 'messages'`), copying forwarded bytes out of the buffer.
- [ ] **Step 4: Run** → PASS.

### Task 5: Config, profiles, runtime and the process adapter

**Files:**
- Create: `zumi-bot-server/backend/src/core/desktop/config.ts`, `desktopRuntime.ts`, `xauth.ts`, `desktopProcess.ts`, `types.ts`
- Modify: `zumi-bot-server/backend/src/core/browser/profileStore.ts` (constructor gets `folder = 'browsers'`; error texts stay)
- Create fixtures: `zumi-bot-server/backend/tests/fixtures/fake-xvnc.mjs`, `fake-cua-driver.mjs`, `fake-dbus-run.mjs`
- Test: `zumi-bot-server/backend/tests/core/desktop/config.test.ts`, `xauth.test.ts`, `desktopProcess.test.ts`, existing `browserProfileStore.test.ts` still passes

**Interfaces:**
- Produces:
  - `loadDesktopConfig(env: NodeJS.ProcessEnv): DesktopConfig` (vars `ZUMIBOT_DESKTOP_MAX` ≤ 8, `IDLE_MS`, `LEASE_IDLE_MS`, `HANDOFF_IDLE_MS`, `COMMAND_MS`, `QUEUE_MS` ≤ 86400000, `WIDTH` 640..1920, `HEIGHT` 480..1080; error names the variable, never the value)
  - `interface DesktopRuntime { xvnc: string | null; dbusRun: string | null; session: string[] | null; cuaDriver: string | null; node: string; bridgeEntry: string; electronNode: boolean; missing: string[] }`, `resolveDesktopRuntime(env?: NodeJS.ProcessEnv, moduleUrl?: string): DesktopRuntime` — overrides `ZUMIBOT_DESKTOP_XVNC`, `ZUMIBOT_DESKTOP_DBUS_RUN`, `ZUMIBOT_DESKTOP_SESSION` (a command line split on spaces, absolute first word), `ZUMIBOT_CUA_DRIVER`; else `PATH` lookup of `Xvnc`, `dbus-run-session`, `startxfce4`, `cua-driver`, then `~/.cua-driver/packages/current/bin/cua-driver` (exact path from the spike); `missing` lists human names (`'TigerVNC (Xvnc)'`, `'dbus-run-session'`, `'desktop session (startxfce4)'`, `'cua-driver'`).
  - `xauthEntry(display: number, cookie: Uint8Array): Uint8Array` (FamilyWild 0xFFFF, empty address, display number as decimal string, `MIT-MAGIC-COOKIE-1`, 16-byte cookie; each field u16 big-endian length prefixed)
  - `type CuaContent = { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string }`
  - `interface DesktopInstance { readonly generation: string; readonly vncSocket: string; readonly display: number; call(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<{ content: CuaContent[]; isError: boolean }>; isClosed(): boolean; onExit(cb: () => void): () => void; close(): Promise<void> }`
  - `interface DesktopAdapter { launch(dir: string, config: DesktopConfig, signal: AbortSignal): Promise<DesktopInstance> }`
  - `createProcessAdapter(runtime: DesktopRuntime, o?: { displays?: [number, number]; x11Dir?: string }): DesktopAdapter` (defaults `[90, 199]`, `/tmp/.X11-unix`)
  - `BrowserProfileStore(dataDir, newId?, folder?)`; desktop uses `new BrowserProfileStore(dataDir, randomUUID, 'desktops')`.
  - `class DesktopUnavailableError extends Error { constructor(readonly missing: string[]) }` in `types.ts` (thrown by `launch` when the runtime lacks a program)
  - `recoverDesktops(root: string): Promise<void>` in `desktopProcess.ts` (kills leftovers of this data dir's desktops only)

`launch(dir, …)`: makes `dir/home` and `dir/run` (0700), picks the lowest display N whose `<x11Dir>/X<N>` and `/tmp/.X<N>-lock` are both absent, writes `run/Xauthority` (0600) from `xauthEntry`, spawns Xvnc with the Task 1 args (detached, own process group), waits up to 10 s for `run/vnc.sock` to accept a connection (Xvnc exiting early with "server already active" → next display, at most 5 tries), then spawns `dbusRun -- sh -c '"$0" & exec "$@"' <session…> <cuaDriver> mcp` (detached) with env `{ PATH, LANG, DISPLAY: ':N', XAUTHORITY, HOME: dir/home, XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_CACHE_HOME, XDG_RUNTIME_DIR: dir/run/xdg (0700), …AT-SPI vars from the spike }` (never the server's `ZUMIBOT_*` vars), connects an SDK `Client` over that child's stdio, and calls `tools/list` once as a health check. `generation` is a fresh random id. `close()` closes the client, then `SIGTERM` both process groups, `SIGKILL` after 3 s, removes `vnc.sock` and `Xauthority`, resolves when both exited. A child exit fires `onExit` callbacks and makes `isClosed()` true. pid files in `run/` let a later `recoverDesktops(root)` kill only its own leftovers (verify `/proc/<pid>/cmdline` contains the run dir before killing).

**cua-driver environment (from the spike prep; binding for Task 5 and the spike).** cua-driver 0.38.0 sends product telemetry (PostHog) by default and its "disabled" setting is stored per `HOME`, so a per-agent home resets it. Every cua-driver process ZumiBot starts gets exactly these on top of the base env: `DO_NOT_TRACK=1`, `CUA_DRIVER_RS_TELEMETRY_ENABLED=0`, `CUA_TELEMETRY_ENABLED=0`, `CUA_DRIVER_RS_UPDATE_CHECK=0`, `CUA_DRIVER_PERMISSION_MODE=standard`, `CUA_DRIVER_DISABLE_RUN_SCRIPT=1`, `CUA_DRIVER_DISABLE_UNRESTRICTED=1`, and never `CUA_DRIVER_DANGEROUSLY_BYPASS_APPROVALS`. Test: `cua env disables telemetry and unrestricted mode` (fake cua logs its env keys). The spike verifies with `cua-driver telemetry status` under the per-agent HOME that telemetry reads disabled from the env.

Fakes: `fake-xvnc.mjs` parses `:N`, `-geometry`, `-rfbunixpath`, serves RFB 3.8 security None with a solid 1280×800 framebuffer (Raw encoding) on the unix socket, appends `{type:'key'|'pointer'|'cut', …}` JSON lines to `FAKE_XVNC_LOG`, exits with "server already active" if `FAKE_XVNC_BUSY` lists N. `fake-dbus-run.mjs` drops `--` and runs the rest (so the `sh -c` trick still runs). `fake-cua-driver.mjs` is a stdio MCP server (hand-rolled like `e2e/fixtures/probe-mcp.mjs`) answering the tools Task 1 recorded: `get_desktop_state` → a constant tiny JPEG plus text `{"width":1280,"height":800}`; `list_windows` → one window `{window_id:'w1', pid:1, title:'Mousepad', app:'mousepad', bounds}`; `get_window_state` → elements with tokens `t1`,`t2`; `list_apps` → `[{name:'mousepad'}]`; every action → ok; appends `{tool, args}` to `FAKE_CUA_LOG`. A fake session command is `/bin/true` (the trick backgrounds it).

- [ ] **Step 1: Failing tests:** config defaults and each bound (`ZUMIBOT_DESKTOP_WIDTH=4000` throws naming the var); `xauthEntry` exact bytes for display 90 and a fixed cookie; runtime `missing` lists all four with an empty PATH and none with overrides to the fakes; `launch` with fakes: starts, `call('get_desktop_state')` returns an image, `skips taken display numbers` (fake X socket files for 90 and 91 in a temp `x11Dir` → display 92), `retries when Xvnc says busy`, `close kills both groups and removes the socket`, `child exit fires onExit`, `Xauthority is 0600 and run dir 0700`, `server ZUMIBOT_ vars do not reach the children` (fake cua writes its env keys to the log), `launch throws DesktopUnavailableError listing missing programs`, `recoverDesktops kills a leftover whose cmdline names its run dir and leaves an unrelated pid alone`, profile store with `folder: 'desktops'` writes `desktops/profiles.json`.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/desktop/ zumi-bot-server/backend/tests/core/browserProfileStore.test.ts` → FAIL.
- [ ] **Step 3: Implement** the files above.
- [ ] **Step 4: Run** → PASS.

### Task 6: Tool definitions, cua mapping and result bounding

**Files:**
- Create: `zumi-bot-server/backend/src/core/desktop/desktopTools.ts`, `desktopPrompt.ts`
- Test: `zumi-bot-server/backend/tests/core/desktop/desktopTools.test.ts`

**Interfaces:**
- Consumes: `parseDesktopCommand`, `DesktopCommand`, `DesktopResult` (Task 2); `CuaContent` (Task 5).
- Produces:
  - `desktopTools: { name: string; description: string; inputSchema: object }[]` (15 tools, `additionalProperties: false`; action tools require `stamp`; descriptions say coordinates are screen pixels of `desktop_screenshot`, element tokens come from `desktop_window_state`, and never to type passwords)
  - `desktopToolCommand(name: string, args: unknown): DesktopCommand`
  - `cuaRequest(command: DesktopCommand, resolved: { element?: string; scale: number }): { tool: string; args: Record<string, unknown> } | null` (null for `requestUserAction`/`release`; points multiplied by `scale` = screen px per screenshot px and rounded; argument shapes exactly as Task 1 recorded)
  - `boundDesktopResult(result: DesktopResult): DesktopResult` (text ≤ 48000 chars; image base64 ≤ `Math.ceil(INLINE_IMAGE_MAX_BYTES / 3) * 4`, MIME `image/jpeg` or `image/png`, else `{ok:false, code:'image_limit'}`; elements ≤ 256)
  - `desktopToolResult(result: DesktopResult): { content: CuaContent[]; isError?: boolean }` (observation data `{stamp, width, height, image?, elements?}` → a text block with everything but the image, then the image block)
  - `desktopPrompt: string` and `desktopUnavailablePrompt: string` (spec "What the agent can do" last bullet; unavailable text tells the agent the desktop is unavailable and not to fall back to other screen control)

- [ ] **Step 1: Failing tests:** tool list has exactly the 15 Global Constraints names; every action schema requires `stamp`; `desktopToolCommand('desktop_click', {stamp, x:1, y:2})` → `{op:'click', …}`; unknown name throws; args containing `op` throw; `cuaRequest` for each op matches the spike's shapes (one assertion per op), with `scale: 2` doubling points; Arabic text passes to `type_text` byte-identical; `boundDesktopResult` rejects a 6 MiB image and a `image/gif`; `desktopToolResult` puts text first and image second.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/desktop/desktopTools.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.

### Task 7: DesktopManager

**Files:**
- Create: `zumi-bot-server/backend/src/core/desktop/desktopManager.ts`
- Test: `zumi-bot-server/backend/tests/core/desktop/desktopManager.test.ts` (fake `DesktopAdapter` in the test file, fake timers via `BrowserTimers`)

**Interfaces:**
- Consumes: `BrowserLeases`, `browserTimers`/`BrowserTimers` (`core/browser/browserLeases.ts`), `BrowserHandoffs` (`core/browser/browserHandoffs.ts`, `site` passed as `''`), `BrowserProfileStore` (Task 5), `DesktopAdapter`/`DesktopInstance` (Task 5), `cuaRequest`, `boundDesktopResult` (Task 6).
- Produces:
  - `interface DesktopViewer { id: string; sessionKey: string; signal?: AbortSignal; sendStatus(status: DesktopStatus): void; attach(vncSocket: string, generation: string): void; detach(): void }`
  - `class DesktopManager { constructor(d: { profiles: BrowserProfileStore; adapter: DesktopAdapter; config: DesktopConfig; now(): number; newId(): string; resolveTarget(t: DesktopTarget): Promise<{ id: string; dir: string; agent: string }>; onHandoff(h: DesktopHandoff): Promise<void>; timers?: BrowserTimers })`
    - `registerTurn(turnId: string, cb: (h: DesktopHandoff) => Promise<void>): () => void`
    - `status(agent: string): Promise<DesktopStatus>`
    - `run(owner: DesktopOwner, command: DesktopCommand, signal: AbortSignal): Promise<DesktopResult>`
    - `watch(target: DesktopTarget, viewer: DesktopViewer): Promise<{ close(): Promise<void> }>`
    - `canInput(viewerId: string): boolean` (true only for the controller after pausing finished)
    - `takeControl(viewerId: string): Promise<void>`, `releaseControl(viewerId: string): Promise<void>`
    - `answer(viewerId: string, requestId: string, decision: 'done' | 'cancel'): Promise<void>`
    - `endTurn(turnId: string): Promise<void>`, `clear(agent: string): Promise<void>`, `renameAgent(from: string, to: string): Promise<void>`, `removeAgents(names: readonly string[]): Promise<void>`, `close(): Promise<void>`

Behavior, all from the spec: lazy start (first `run` or `watch`), cap `max` counting starting/ready/closing, evict a safely idle desktop first (no viewer, lease, handoff, busy), fair queue with `queueMs`; idle stop after `idleMs` with no viewer, lease or pending handoff; lease per profile (one turn at a time); a desktop exit sets state `stopped`, bumps nothing until the next start, calls `viewer.detach()` and voids the observation; `run` for looking ops takes the lease then calls cua; `screenshot` and `windowState` create the observation `{id: newId(), epoch: lease.epoch, generation, tokens: Map<ourToken, cuaToken>, scale}` and return its stamp (`windowState` tokens become `e1…eN`; `screenshot` scale = desktop width / image width); `zoom`, `windows`, `apps` do not replace it; action ops check the stamp equals the current observation (generation, epoch, id) and that no control was taken since, else return `{ok:false, code:'stale', message:'The desktop changed; take a new screenshot'}` without calling cua; `element` resolves through the observation's token map (unknown → `stale`); while a viewer holds or is taking control, `run` waits **without** the `queueMs` timeout (only Stop, turn end, or release end the wait); `takeControl` refuses if another viewer controls, waits for the in-flight call to settle, then `canInput` becomes true; release voids the observation; `requestUserAction` goes through `BrowserHandoffs.request(owner, generation, '', reason, signal)` while protecting the lease; `answer` releases control then resolves the handoff; `status` reports `state:'unavailable'` with `missing` when the adapter cannot launch for lack of programs (adapter throws `DesktopUnavailableError(missing: string[])`, export it from `types.ts`); `clear` invalidates, replaces the profile and removes its dir; `removeAgents` invalidates without deleting data; `close` invalidates all and stops every desktop.

- [ ] **Step 1: Failing tests** (fake adapter counting launches/closes; fake timers):
  - `no desktop starts without a call or a viewer`
  - `first call starts once for concurrent calls`
  - `cap queues the third agent and evicts an idle desktop first`
  - `queue times out with a busy result`
  - `idle stop after idleMs, not while a viewer watches`
  - `screenshot returns a stamp; click with it calls cua once`
  - `click with an older observation id is stale and never reaches cua`
  - `lease lost while card pending voids the stamp` (turn A screenshots, lease idles out, turn B in another chat runs, turn A's click → `stale`)
  - `control wait does not hit the queue timeout` (advance timers past `queueMs` while controlled; call resolves after release)
  - `takeControl waits for the in-flight call` (`canInput` false until the fake cua call resolves)
  - `second viewer cannot take control while the first holds it`
  - `release voids the observation`
  - `crashed desktop restarts on next call and voids stamps` (fake instance fires exit; viewer.detach called; next screenshot launches generation 2; an old stamp is stale)
  - `element token maps to the cua token of the latest window state`
  - `handoff pending blocks other calls with waiting_for_user; done resolves the tool`
  - `rename keeps the desktop; removeAgents stops it; clear deletes the dir`
  - `unavailable runtime gives state unavailable with missing list and a failed result`
  - `close stops all desktops`
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/desktop/desktopManager.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Follow `BrowserManager`'s structure (entries, demands, pump, bounded with `commandMs`) without its tabs, viewport, frames and files parts. If `BrowserLeases` cannot wait on a pause without its queue timer, add an option there (`acquire(owner, signal, { untimedWhilePaused: true })`) and keep browser behavior unchanged (its tests must still pass).
- [ ] **Step 4: Run** `npx vitest run zumi-bot-server/backend/tests/core/desktop/ zumi-bot-server/backend/tests/core/browserLeases.test.ts zumi-bot-server/backend/tests/core/browserManager.test.ts` → PASS.

### Task 8: IPC, bridge and per-turn args

**Files:**
- Create: `zumi-bot-server/backend/src/core/ipc/lineIpc.ts` (moved `send`, `readLines`, and the client class from `browserIpc.ts`, made generic), `zumi-bot-server/backend/src/core/ipc/stdioTransport.ts` (moved `BrowserStdioTransport` from `browserBridge.ts` as `BoundedStdioTransport`)
- Modify: `zumi-bot-server/backend/src/core/browser/browserIpc.ts`, `browserBridge.ts` (import the moved code; behavior unchanged)
- Create: `zumi-bot-server/backend/src/core/desktop/desktopIpc.ts`, `desktopBridge.ts`
- Modify: `zumi-bot-server/backend/vite.config.ts` (input `desktopBridge: src/core/desktop/desktopBridge.ts`)
- Test: `zumi-bot-server/backend/tests/core/desktop/desktopIpc.test.ts`, `desktopBridge.test.ts`; existing `browserIpc.test.ts`, `browserBridge.test.ts`, `browserPackaging.test.ts` still pass

**Interfaces:**
- Consumes: `BrowserCapabilities` (owner type is structurally `DesktopOwner`), `DesktopManager.run/endTurn/registerTurn` (Task 7), `desktopToolCommand`, `desktopTools`, `desktopToolResult`, `boundDesktopResult`, `desktopPrompt` (Task 6), `resolveDesktopRuntime` (Task 5).
- Produces:
  - `interface DesktopTurn { args: string[]; env: NodeJS.ProcessEnv; prompt: string; dispose(): Promise<void> }`
  - `serveDesktopIpc(o: { manager: Pick<DesktopManager, 'run' | 'endTurn' | 'registerTurn'>; capabilities: BrowserCapabilities; runtime?: Pick<DesktopRuntime, 'node' | 'bridgeEntry' | 'electronNode'> }): Promise<{ socketPath: string; createDesktopTurn(owner: DesktopOwner, onHandoff: (h: DesktopHandoff) => Promise<void>, o?: { side?: boolean }): Promise<DesktopTurn>; close(): Promise<void> }>`
  - `DESKTOP_ASK_SETTINGS: string` = `JSON.stringify({ permissions: { ask: DESKTOP_ACTION_TOOLS.map(desktopToolName) } })`
  - Main turn args: `['--mcp-config', JSON.stringify({ mcpServers: { zumibot_desktop: { type: 'stdio', command: node, args: [bridgeEntry], timeout: 86400000, env: { ZUMIBOT_DESKTOP_CAPABILITY: '${ZUMIBOT_DESKTOP_CAPABILITY}', ZUMIBOT_DESKTOP_IPC: '${ZUMIBOT_DESKTOP_IPC}', …(electronNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}) } } } }), '--settings', DESKTOP_ASK_SETTINGS]`; side turns (`o.side`) omit the `--settings` pair (the side run already passes its guard with `--settings`, and its deny hook blocks every tool). Env: `{ ZUMIBOT_DESKTOP_CAPABILITY: token, ZUMIBOT_DESKTOP_IPC: socketPath }`. Socket dir from `mkdtemp('/tmp/cb-d-')`, 0700, socket 0600.

- [ ] **Step 1: Failing tests:** IPC: `unauthenticated socket is dropped`; `capability scopes the owner` (a run reaches `manager.run` with the issued owner, never a caller field); `revoked capability drops the socket and aborts in-flight`; `invalid command gets an error result`; `results are bounded`; `turn ids are single use`; `main turn args carry the ask settings, side turn args do not`; `capability and IPC path never appear in args`. Bridge (spawned with the fake IPC server from the test): `tools/list returns the 15 tools`; `tools/call maps to an IPC run and returns text then image`; `requestUserAction keeps progress notifications`. Browser tests unchanged and passing.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/desktop/desktopIpc.test.ts zumi-bot-server/backend/tests/core/desktop/desktopBridge.test.ts zumi-bot-server/backend/tests/core/browserIpc.test.ts zumi-bot-server/backend/tests/core/browserBridge.test.ts` → FAIL (desktop) / PASS (browser).
- [ ] **Step 3: Implement** the moves first (browser tests green), then the desktop files.
- [ ] **Step 4: Run** the same command plus `npx vitest run zumi-bot-server/backend/tests/browserPackaging.test.ts` → all PASS; `npm run build -w @zumibot/backend` emits `dist/desktopBridge.mjs`.

### Task 9: Application wiring and turns

**Files:**
- Create: `zumi-bot-server/backend/src/core/desktop/desktopApplication.ts`
- Modify: `zumi-bot-server/backend/src/core/chat/chatService.ts` (deps `desktopTurns`; attempt wiring next to `browserTurns`; `desktopTool` predicate; tool row/approval handling; `sideDesktop`), `zumi-bot-server/backend/src/core/btw/sideQuestions.ts` + `sideRun.ts` (side desktop args), `zumi-bot-server/backend/src/core/browser/browserApplication.ts` (a `browser-action` item with `surface: 'desktop'` is never a browser request), `zumi-bot-server/backend/src/core/store/chatStore.ts` (nothing if the existing `browser-action` paths already cover it; check rename and restart-interrupt), `zumi-bot-server/backend/src/app.ts` (create, wire, rename/remove hooks, shutdown order), `zumi-bot-server/backend/src/rpc/handlers.ts` (`agents:save` rename/delete calls `desktops.renameAgent/removeAgents` next to the browser's), `zumi-bot-server/backend/src/core/agents/agentsSync.ts` (same, via app.ts callbacks)
- Test: `zumi-bot-server/backend/tests/core/chatService.test.ts`, `zumi-bot-server/backend/tests/core/desktop/desktopApplication.test.ts`, `zumi-bot-server/backend/tests/app.test.ts`

**Interfaces:**
- Consumes: Tasks 5–8.
- Produces:
  - `type DesktopPlan = 'off' | 'unavailable' | { profileId: string }`
  - `createDesktopApplication(d: { dataDir: string; agents: Pick<AgentStore, 'list'>; chats: Pick<ChatStore, 'get' | 'loadItems'>; feed: ItemsFeed; adapter?: DesktopAdapter; runtime?: DesktopRuntime }): Promise<{ manager: DesktopManager; turns: { plan(agent: string, chatId: string): Promise<DesktopPlan>; create(owner: DesktopOwner, onHandoff: (h: DesktopHandoff) => Promise<void>, o?: { side?: boolean }): Promise<DesktopTurn> }; status(agent: string): Promise<DesktopStatus>; clear(agent: string): Promise<void>; renameAgent(from: string, to: string): Promise<void>; removeAgents(names: readonly string[]): Promise<void>; agents(): string[]; close(): Promise<void> }>`
  - `plan` → `'off'` unless the agent's summary has `computerUse: true` and no load error (Zumi Bot always `'off'`); `'unavailable'` when the runtime has `missing` or profiles failed to load.
  - `status` for an agent without computer use → `state: 'off'`.
  - `resolveTarget` validation as in `browserApplication.ts`, but a `requestId` must match a pending `browser-action` item with `surface: 'desktop'`.
  - `ChatServiceDeps.desktopTurns?: { plan(agent: string, chatId: string): Promise<DesktopPlan>; create(owner: DesktopOwner, onHandoff: (h: DesktopHandoff) => Promise<void>, o?: { side?: boolean }): Promise<DesktopTurn> }`
  - `ChatService.sideDesktop(chatId: string, agent: string): Promise<DesktopTurn | null>` (like `sideBrowser`; `o.side: true`; no cards)

ChatService rules: per attempt, `plan` once per logical turn (like `browserProfileId`); `'off'` adds nothing; `'unavailable'` adds only `desktopUnavailablePrompt` to the appended prompt; otherwise `args` go after the browser's in `extraArgs`, `env` merges with the browser's env, `prompt` joins the appended prompt, the capability and IPC path join the redaction set (`browserSecrets`), `dispose` runs in the attempt's `finally`. Handoff cards are `{ type: 'browser-action', surface: 'desktop', … }` and use `slot.browserPending` (so pending counts, notifications and routine waiting work unchanged). `desktopTool(name)` = `name.startsWith('mcp__zumibot_desktop__')`: tool rows and approval cards **keep** input, description and reason (unlike browser); the tool result is replaced with `'Desktop command completed.'` / `'Desktop command failed.'` (no images stored); the Jev risk hint runs for them.

- [ ] **Step 1: Failing tests:** chatService: `agent without computerUse gets no desktop args`; `computerUse agent gets mcp-config and ask settings and the desktop prompt`; `unavailable adds only the unavailable prompt`; `desktop approval card keeps its input`; `desktop tool result is summarized and has no image`; `desktop handoff adds a browser-action card with surface desktop and counts as pending`; `capability value is redacted from errors`. desktopApplication: `plan is off for Zumi Bot and for agents without the key`; `a browser handoff id is not accepted as a desktop request and vice versa` (also in `browserApplication.test.ts`). app.test: `rename moves the desktop profile before the watcher removal pass` (same pattern as the existing browser rename test).
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/chatService.test.ts zumi-bot-server/backend/tests/core/desktop/desktopApplication.test.ts zumi-bot-server/backend/tests/core/browserApplication.test.ts zumi-bot-server/backend/tests/app.test.ts` → FAIL.
- [ ] **Step 3: Implement.** In `app.ts`, create desktops after browsers, push `desktops.close()` onto `undo`, close it in the shutdown path alongside `browsers.close()` before the lock is released.
- [ ] **Step 4: Run** → PASS, then `npm test` → all PASS.

### Task 10: `/ws/desktop` viewer socket

**Files:**
- Create: `zumi-bot-server/backend/src/http/desktopSocket.ts`
- Modify: `zumi-bot-server/backend/src/http/server.ts` (route `/ws/desktop` like `/ws/browser`, its own `WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })`), `zumi-bot-server/backend/src/app.ts` (create the hub; drain/closeAll/dispose with the browser hub; `closeSession` on sign-out like the browser hub)
- Test: `zumi-bot-server/backend/tests/http/desktopSocket.test.ts` (with `tests/http/helpers.ts` and the fake Xvnc from Task 5)

**Interfaces:**
- Consumes: `DesktopManager.watch/takeControl/releaseControl/canInput/answer` (Task 7), `RfbClientFilter` (Task 4), `parseDesktopRequest`, `DesktopServerMessage`, `boundDesktopStatus` (Task 2).
- Produces: `createDesktopHub(o: { manager: DesktopManager; isValid(key: string): Promise<boolean>; now?: () => number; pingMs?: number }): { attach(ws: WebSocket, sessionKey: string): void; closeSession(key: string | 'all'): void; drain(): void; closeAll(code: number): void; dispose(): void }`

Wire: text frames are JSON `DesktopRequest` (≤ 64 KiB) answered by `DesktopServerMessage` responses; binary frames from the client are RFB bytes for the current RFB leg, passed through a fresh `RfbClientFilter({ canInput: () => manager.canInput(viewerId) })` per leg; when the manager calls `viewer.attach(sock, generation)` the hub opens a unix-socket connection, sends `{type:'rfb', state:'open', generation}` and pipes server bytes as binary frames; `detach()` or the unix socket closing sends `{type:'rfb', state:'closed', generation}`. One watch per socket (a new `watch` replaces the old). Client `rfb` bytes with no open leg are dropped. Backpressure: if `ws.bufferedAmount` > 4 MiB, pause the unix socket; if it stays above for 10 s, close the viewer with 1008 (like the browser hub). Heartbeat with `ws.ping` every `pingMs` (default 15000), two misses close. Session validity re-checked like the browser hub; sign-out closes with `CLOSE_SIGNED_OUT`.

- [ ] **Step 1: Failing tests:** `hostile Origin and missing session are refused with 4401` (via server routing); `watch starts the desktop and opens an rfb leg`; `RFB bytes flow both ways`; `pointer input without control never reaches the fake Xvnc log`; `with takeControl it does`; `second socket sees control other and its input is dropped`; `closing the socket releases control`; `desktop restart sends rfb closed then open with the new generation`; `answer done resolves the handoff`; `stalled viewer is dropped, others keep streaming` (one client never reads; after 10 s of fake time it is closed and the other still receives bytes).
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/http/desktopSocket.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.

### Task 11: RPCs, CLI check, sync and runbook

**Files:**
- Modify: `zumi-bot-server/backend/src/rpc/handlers.ts` (`'desktops:status'`, `'desktops:clear'`, args checked with `str()`), `zumi-bot-server/frontend/src/net/api.ts` (`desktops: { status, clear }`), `zumi-bot-server/backend/src/cli.ts` (`desktop-check`), `zumi-bot-server/deploy/sync.mjs` (exclude `desktops`), `zumi-bot-server/deploy/SETUP-VPS.md` (desktop section), root `package.json` (`"desktop:check": "node zumi-bot-server/backend/dist/server.mjs desktop-check"`)
- Test: `zumi-bot-server/backend/tests/rpc/handlers.test.ts` (or the file that covers `browsers:*`), `zumi-bot-server/backend/tests/cli.test.ts`, `zumi-bot-server/backend/tests/sync.test.ts`, `zumi-bot-server/frontend/tests/net/api.test.ts`

**Interfaces:**
- Produces: `desktop-check` prints one line per program `found <path>` / `missing <name>` plus `cua-driver <version>` (from `cua-driver --version`), exits 1 when anything is missing; never installs, never needs sudo.

- [ ] **Step 1: Failing tests:** `desktops:status` returns the application's status and rejects a non-string agent; `desktops:clear` calls clear; api maps both; `desktop-check exits 1 listing missing programs` (empty PATH env) and `0 with the fakes`; sync: a `desktops/` folder in the data dir is neither pulled nor pushed.
- [ ] **Step 2: Run** the four test files → FAIL.
- [ ] **Step 3: Implement**; write the SETUP-VPS section: packages (`tigervnc-standalone-server`, `xfce4-session xfwm4 xfce4-panel xfdesktop4 xfce4-terminal mousepad`, `dbus-x11`, `at-spi2-core`, `fonts-noto-core`), Firefox from Mozilla's apt repo (not the snap) with the steps to read before running, the per-user cua-driver install, `npm run desktop:check`, and that nothing opens a port. Add a short Local-mode note.
- [ ] **Step 4: Run** → PASS.

### Task 12: Frontend state (pure)

**Files:**
- Modify: `zumi-bot-server/frontend/src/state/sidePanel.ts`
- Create: `zumi-bot-server/frontend/src/state/desktopView.ts`
- Test: `zumi-bot-server/frontend/tests/sidePanel.test.ts` (existing), `zumi-bot-server/frontend/tests/desktopView.test.ts`

**Interfaces:**
- Produces:
  - `SideView = 'menu' | 'files' | 'btw' | 'browser' | 'desktop'`; `type LiveView = 'browser' | 'desktop'`; `closeSide(side: SideState, live: LiveView | null): SideState` (a chat view closes back to the live view waiting behind it); `liveMoved(side: SideState, kind: LiveView, wasOpen: boolean, open: boolean, inPanel: boolean): SideState` (generalizes `browserMoved`; keep `browserMoved` as a wrapper so callers compile); `shownSide(side, onChat, liveInPanel: LiveView | null)`; `isOpenDesktop(open: boolean, target: DesktopTarget | null | undefined, agent: string, chatId: string): boolean`. Opening one live view closes the other (`App` calls the other hook's `close()`).
  - `interface DesktopViewState { open: boolean; visible: boolean; target: DesktopTarget | null; status: DesktopStatus | null; control: boolean; controlPending: boolean; rfb: { generation: string; n: number } | null; marker: { x: number; y: number } | null; error: string | null }`
  - `initialDesktopView: DesktopViewState`; `reduceDesktopView(s: DesktopViewState, e: DesktopViewEvent): DesktopViewState` with events `open {target, marker?}`, `close`, `visible {visible}`, `status {status}`, `rfb {state, generation}`, `controlRequested`, `controlReleased`, `error {error}`, `disconnect`.
  - `desktopStatusLine(s: DesktopViewState): string` — exact texts: `'Starting…'`, `'Waiting for a desktop…'`, `'Agent working'`, `'Waiting for you'` (pending handoff), `'Idle'`, `'Pausing agent…'`, `'You have control'`, `'Controlled in another window'`, `'Desktop unavailable on this server'` (+ `' (missing: a, b)'`), `'Computer use is off for this agent'`, `'Disconnected'`.
  - `markerPosition(marker: {x,y}, desktop: {width,height}, box: {width,height}): {left: number; top: number} | null` (scale-to-fit letterboxing, null when outside).

- [ ] **Step 1: Failing tests:** sidePanel: existing browser cases unchanged; `desktop takes the slot when opened in the panel`; `chat view closes back to a desktop behind it`; `closing the desktop that was shown closes the panel`. desktopView: `open sets target and clears control`; `status other drops local control`; `rfb open bumps n` (so the panel remounts noVNC per leg); `generation change while controlling sends releaseControl intent` (reducer sets `control:false`); `visible false keeps target but marks hidden`; each `desktopStatusLine` text; `markerPosition` for a 1280×800 desktop in a 640×600 box → letterboxed coordinates, and null outside.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/frontend/tests/sidePanel.test.ts zumi-bot-server/frontend/tests/desktopView.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.

### Task 13: Frontend client, panel, cards and Agent Studio

**Files:**
- Modify: `zumi-bot-server/frontend/package.json` (`"@novnc/novnc": "1.7.0"`), root `package-lock.json` via `npm install`
- Create: `zumi-bot-server/frontend/src/net/desktop.ts`, `zumi-bot-server/frontend/src/useAgentDesktop.ts`, `zumi-bot-server/frontend/src/components/DesktopPanel.tsx`, `zumi-bot-server/frontend/src/components/AgentDesktop.tsx`
- Modify: `zumi-bot-server/frontend/src/App.tsx` (provider, side slot, Esc, open-one-closes-other, Show on desktop; `pendingBrowserCard` must only match cards without `surface`), `components/SidePanelMenu.tsx` (Open Desktop row with member picker, disabled unless the member has `computerUse`), `components/BrowserActionCard.tsx` (surface desktop: Open Desktop / I'm done / Cancel through the desktop client), `components/ApprovalCard.tsx` and `components/ToolCallRow.tsx` (desktop summary line; Show on desktop when `desktopPoint` is non-null), `components/AgentEditor.tsx` (mount `AgentDesktop` next to the browser section), `src/styles.css`, `src/globals.d.ts` (module declaration for `@novnc/novnc/lib/rfb` if it ships no types)
- Test: `zumi-bot-server/frontend/tests/net/desktop.test.ts` (with `tests/net/fakeSocket.ts`)

**Interfaces:**
- Consumes: Task 2 types and helpers, Task 12 state, `api.desktops`.
- Produces:
  - `createDesktopClient(o: { url: string; socket?: (url: string) => WebSocket }): DesktopClient` with `watch(target): Promise<void>`, `unwatch(): void`, `takeControl(on: boolean): Promise<void>`, `answer(target, requestId, decision): Promise<void>`, `onStatus(cb)`, `onRfb(cb: (state: 'open'|'closed', generation: string) => void)`, `channel(): RfbChannel`, `close(): void`
  - `interface RfbChannel` — the WebSocket-like object noVNC's `RFB` constructor accepts as its channel (`binaryType`, `readyState`, `protocol`, `onopen`, `onmessage`, `onclose`, `onerror`, `send(data)`, `close()`): one per RFB leg; delivers only binary frames; `send` writes binary to the socket; `close()` from noVNC unwatches; the leg closing fires `onclose` once.
  - `useAgentDesktop(scope: string)` + `AgentDesktopContext`/`useDesktop()`, mirroring `useAgentBrowser`: mounting never connects; `open(target, marker?)`, `close()`, `takeControl(on)`, `answer(...)`, `state`.

UI rules from the spec: header with agent name, status line (`desktopStatusLine`), **Take control** toggle (off on every open), Back/✕; noVNC `RFB` created on each `rfb open` with `scaleViewport: true`, `resizeSession: false`, `viewOnly: !control`, `clipViewport: false`, `showDotCursor: true`; destroyed on `rfb closed`, close, hide; marker overlay at `markerPosition` while set, cleared when control is taken; the view unwatches when the document is hidden and re-watches when visible again only if still open. Agent Studio `AgentDesktop`: "Computer use" toggle (`onFields({ computerUse: on ? true : null })`), Open Desktop, Clear desktop data (ConfirmDialog: "This stops <agent>'s desktop and deletes its desktop home folder (apps' settings and sign-ins) on this server."), and the unavailable line with `missing`.

- [ ] **Step 1: Failing tests** (net/desktop.test.ts with the fake socket): `watch sends a watch request and resolves on ok`; `status messages reach onStatus`; `rfb open creates a channel that is OPEN and receives only binary`; `channel.send writes binary`; `rfb closed fires the channel's onclose once`; `noVNC closing the channel unwatches`; `takeControl(false) after a closed socket resolves without throwing`; `responses with unknown ids are ignored`.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/frontend/tests/net/desktop.test.ts` → FAIL.
- [ ] **Step 3: Implement** the client, then the hook and components. Install `@novnc/novnc@1.7.0` with `npm install -w @zumibot/frontend --save-exact @novnc/novnc@1.7.0`.
- [ ] **Step 4: Run** → PASS; `npm run typecheck` → no errors; `npm run build:server` → builds.

### Task 14: `e2e:computer` suite, real-CLI ask probe, docs

**Files:**
- Create: `zumi-bot-server/backend/tests/fixtures/fake-desktop-claude.mjs`, `zumi-bot-server/e2e/computer.e2e.mjs`, `zumi-bot-server/e2e/desktopAskProbe.mjs`
- Modify: root `package.json` (`"e2e:computer": "npm run build && node zumi-bot-server/e2e/computer.e2e.mjs"`; `e2e` script also runs `node zumi-bot-server/e2e/desktopAskProbe.mjs` after `web.e2e.mjs`), `CLAUDE.md` (Commands list and an architecture paragraph), `docs/superpowers/specs/2026-11-04-computer-use-design.md` (status line: implemented)

**Interfaces:**
- Consumes: everything above; e2e harness `start({ env, fake })`, `signIn`.

`fake-desktop-claude.mjs` (from `fake-browser-claude.mjs`): reads a `DESKTOP_SCENARIO:<base64>` plan from the first stdin line, asserts it got `--mcp-config` with `zumibot_desktop` and `--settings` containing the 8 ask names, spawns the bridge, and for each step: for an action tool (or any tool the step marks `ask: true`) it first emits a `control_request` `can_use_tool` for `mcp__zumibot_desktop__<tool>` with the input and waits for the `control_response`; allow → `tools/call`; deny → logs `denied`. Steps can `$stamp` from saved observations and `wait` on a file gate, like the browser fake.

- [ ] **Step 1: Write `computer.e2e.mjs`** (fake claude + fake Xvnc + fake dbus-run + fake cua-driver + `/bin/true` session via the `ZUMIBOT_DESKTOP_*`/`ZUMIBOT_CUA_DRIVER` env, Local mode, no quota), checks in order:
  1. Agent Studio toggles Computer use on; the agent file gets `computerUse: true`.
  2. Send a message; the fake screenshots (no card) then clicks: an approval card shows `Click at 412, 300`; **Show on desktop** opens the Desktop view with the marker; Allow; `FAKE_CUA_LOG` has exactly one `click` after one `get_desktop_state`.
  3. The Desktop view shows a canvas painted by noVNC under the real CSP (no CSP violation in the console); status `Agent working` / `Idle`.
  4. A mouse click on the canvas with Take control off adds no pointer line to `FAKE_XVNC_LOG`; with Take control on it does.
  5. A second browser context watching the same agent shows `Controlled in another window`, and its clicks add nothing.
  6. A scenario calling `desktop_request_user_action` shows the card; I'm done resumes; the fake logs the done result.
  7. A stale click (scenario screenshots, the test takes and releases control, then the click runs) is refused: no `click` line, the fake logs `stale`.
  8. Raw `/ws/desktop` with a hostile Origin and with no cookie both close 4401.
  9. Closing the panel stops RFB traffic (no new bytes for 2 s).
- [ ] **Step 2: Run** `npm run e2e:computer` → FAIL until the pieces work; fix bugs in the owning task's files with a unit test first.
- [ ] **Step 3: Write `desktopAskProbe.mjs`** (real `claude`, Haiku, a few cents, like `btwProbe.mjs`): a stub MCP server named `zumibot_desktop` (from `e2e/fixtures/probe-mcp.mjs`) offering `desktop_click` and `desktop_screenshot`; run `claude -p --permission-mode auto --permission-prompt-tool stdio --mcp-config … --settings <DESKTOP_ASK_SETTINGS> --input-format stream-json --output-format stream-json --verbose` asking it to call both; answer every `can_use_tool` with allow and record which tools asked. Pass = `desktop_click` asked; `desktop_screenshot` may or may not. Fail prints the CLI version and exits 1. If it fails, stop and tell the user (spec: never let actions run unasked).
- [ ] **Step 4: Run** `node zumi-bot-server/e2e/desktopAskProbe.mjs` → PASS (needs the user's quota; say so before running).
- [ ] **Step 5: Docs.** `CLAUDE.md`: add `e2e:computer` to the e2e paragraph (fake claude, fake Xvnc, fake cua-driver; no quota) and `npm run desktop:check`; add an architecture paragraph **Computer use (`core/desktop/`)** covering: opt-in `computerUse: true`; per-agent desktop (Xvnc on a unix socket only, XFCE session under `dbus-run-session`, cua-driver as MCP child) under `desktops/<profileId>`; `DesktopManager` reuses browser leases/handoffs/capabilities; curated `zumibot_desktop` tools; stamps void after control, lease change or restart; actions forced to cards with `--settings` ask rules even in auto mode (probe in `npm run e2e`); `/ws/desktop` RFB relay with `RfbClientFilter`; noVNC panel; not synced; limits and env vars; design link.
- [ ] **Step 6: Run** `npm test`, `npm run typecheck`, `npm run e2e:computer`, `npm run e2e:browser` (regression for the moved IPC code) → all PASS.

### Task 15: Real-stack check and show the user

Needs Task 1's installed packages.

- [ ] **Step 1:** Build (`npm run build:server`), start the server in Local-style mode against a temp data dir with one `computerUse: true` agent and the real `claude` (use the `run` skill). Ask the agent to open Mousepad, type a line in Arabic and English, and save it to the home folder. Approve the cards.
- [ ] **Step 2:** Open Desktop, watch, Take control, type yourself, release; confirm the agent's next action re-screenshots (stale refusal or a new screenshot in the tool rows).
- [ ] **Step 3:** Screenshots of the panel, the approval card with Show on desktop, and Agent Studio; record RSS and process count with one running desktop and after idle stop in the verification doc.
- [ ] **Step 4:** Kill every process you started (server, desktops, browsers), then show the user the screenshots.
