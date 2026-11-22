# Computer use

**Computer use (`core/desktop/`, `shared/src/desktop.ts`).** Opt-in per agent: `computerUse: true` in the frontmatter (a known key, absent = off). Agent Studio's **Computer use** switch (`AgentDesktop.tsx`) writes `true` or removes the key, never `false`; Zumi Bot and built-ins never get it, and the moderator and room summary never get desktop tools. Each such agent has its own desktop under `<data>/desktops/<profileId>/home` (`profiles.json` maps agents to opaque ids through `BrowserProfileStore` with folder `desktops`; rename keeps the id, a deleted agent's desktop stops and its folder stays until **Clear desktop data**). The process adapter (`desktopProcess.ts`, programs from `desktopRuntime.ts`) spawns four processes itself, each `detached` in its own process group with a pid file: TigerVNC `Xvnc` on a free display (from `:90`) with no TCP port at all (`-rfbport -1 -nolisten tcp -nolisten local`, `-rfbunixpath <run>/vnc.sock` 0600, `-SecurityTypes None`), its own `dbus-daemon --session`, an XFCE parts session (`xfsettingsd`, `xfwm4`, `xfce4-panel`, `xfdesktop`, never `startxfce4`) and `cua-driver mcp` as the only piped child, reached through `cuaTransport.ts` with the MCP SDK client; cua-driver gets `CUA_ENV` (telemetry and update checks off, `standard` permission mode, run_script and unrestricted mode disabled) and no `ZUMIBOT_*` var reaches any child. The run folder is short (`${XDG_RUNTIME_DIR or tmpdir}/zumibot-<uid>/<data-dir hash>/<id>`, 0700, unix socket paths stay under 100 bytes) and holds the Xauthority cookie, the sockets and `desktop.json`; any of the four exiting closes the desktop, `close()` ends cua's stdin, SIGTERMs every group and SIGKILLs after 3 s, and `recoverDesktops` at startup kills only its own leftovers (pid plus start time plus the env marker) and clears their X locks. `DesktopManager` (`desktopManager.ts`, modelled on `BrowserManager`) reuses `BrowserLeases` (one turn at a time per desktop, released at turn end, Stop, `desktop_release` or lease idle), `BrowserHandoffs` and its own `BrowserCapabilities` instance: lazy start, the server-wide cap with a fair queue that stops a safely idle desktop first, idle stop, Take control (waits for the agent's in-flight call, then every agent call waits until release), and crash restarts (`desktop_restarted`). The agent gets 15 curated tools (`desktopTools.ts`: `desktop_screenshot`, `_windows`, `_apps`, `_window_state`, `_zoom` look; `_click`, `_drag`, `_scroll`, `_move`, `_type`, `_key`, `_launch`, `_focus` act; plus `_request_user_action` and `_release`) from the per-turn stdio bridge `desktopBridge.mjs` (server `zumibot_desktop`), which talks to the server over a private IPC socket (`desktopIpc.ts`, `/tmp/cb-d-*/s` 0600, line protocol shared with the browser in `core/ipc/`) with a per-turn capability in env (`ZUMIBOT_DESKTOP_CAPABILITY`/`_IPC`, redacted from errors). Input is desktop scope only (XTest): typing into an element clicks it first, then types; zoom is window-only and window ids map to pids from the latest list; launch takes only an exact name from `desktop_apps`. Screenshots and window states return a stamp (generation, lease epoch, observation id) that every action needs; it is void after the user had control, after the lease changed hands, after a restart or once a newer observation exists, and a void stamp gets `stale` with nothing reaching cua. Actions are forced to approval cards even in auto mode: the turn adds `--mcp-config` after the browser's and `--settings DESKTOP_ASK_SETTINGS` (ask rules for the 8 action tools), and `claudeRunner.buildArgs` merges every `--settings` into exactly one (`oneSettings`); a `/btw` side run gets the same server with its own capability and no cards, its ask rules merged into the side guard. A Codex agent gets no desktop: Codex has no setting that forces a client approval for an MCP tool in auto mode (`approval_mode = "prompt"` goes to its own auto reviewer, probe check 12), so these forced cards could not hold there (see [Codex agents](codex.md)). Looking tools follow the mode. The forced card covers the `zumibot_desktop` MCP path only (a non-goal, see the spec): the agent's Bash children inherit `ZUMIBOT_DESKTOP_CAPABILITY`/`_IPC` and, as the same user, can reach the 0600 sockets and the X cookie, so in auto mode a classifier-approved Bash command can drive the desktop, and Bash approval is the boundary there. Cards and tool rows show `desktopActionSummary` ("Click at 412, 300"; agent text shows each Return as ⏎ plus "presses Enter N×", and every control, format, default-ignorable or separator character as `\u{…}` through `shared/src/visibleText.ts`, whose `visibleJson` also gives every tool card's and tool row's Input panel JSON escapes), pointer cards offer **Show on desktop** (opens the view with a marker) and every other pending desktop card **Open Desktop** (watch only), the Jev risk hint gets `desktop_type`'s text replaced by its length, and results are stored as "Desktop command completed./failed." (no screenshot in the chat JSON). Viewers use `/ws/desktop` (`http/desktopSocket.ts`, behind `createGate` and the Origin check, refused or signed-out sockets close 4401): JSON `watch`/`unwatch`/`takeControl`/`releaseControl`/`answer` requests, `status` and `rfb open/closed` messages tagged with the `watchId`, and binary frames relayed to `vnc.sock` through a fresh `RfbClientFilter` per leg (`rfbFilter.ts`: RFB 3.8 with None only, ClientInit forced shared, `-316` stripped from SetEncodings, key, pointer and clipboard input dropped unless this socket holds control, anything malformed closes 1008), with back-pressure pausing at 4 MiB and closing after 10 s. The UI (`net/desktop.ts`, `useAgentDesktop.ts`, `DesktopPanel.tsx`, pure rules in `state/desktopView.ts`) streams only while a panel shows on a visible page, starts with Take control off, sends a `paste` event's plain text (under 256 KiB, TigerVNC's default `MaxCutText`) as the desktop's clipboard only while in control, and loads noVNC (`@novnc/novnc` 1.7.0) as a lazy chunk; the CSP is unchanged. A handoff is a `browser-action` card with `surface: 'desktop'` (`BrowserActionCard.tsx`); I'm done and Cancel go through the socket's `answer` without opening a live view, and a pending one counts as waiting like an approval. `desktops:status` and `desktops:clear` are the RPCs, the `desktop-check` CLI command (`npm run desktop:check`) lists found and missing programs and the cua-driver version, and `sync.mjs` never copies `desktops/`. Limits (`ZUMIBOT_DESKTOP_*`): `MAX` 2, `IDLE_MS` 15 min, `LEASE_IDLE_MS` 2 min, `HANDOFF_IDLE_MS` 10 min, `COMMAND_MS` 30 s, `QUEUE_MS` 2 min, `WIDTH`/`HEIGHT` 1280×800 (max 1920×1080); program overrides `ZUMIBOT_DESKTOP_XVNC`, `ZUMIBOT_DESKTOP_DBUS_DAEMON`, `ZUMIBOT_DESKTOP_SESSION` (split on spaces, absolute first word) and `ZUMIBOT_CUA_DRIVER`. Server setup is the "Server setup (agent desktops)" section at the end of this doc. Design: `docs/superpowers/specs/2026-11-04-computer-use-design.md`; real-stack findings: `docs/superpowers/verification/2026-11-04-computer-use-spike.md`.

## Server setup (agent desktops)

Optional. An agent with computer use gets its own private desktop (Xvnc + a light XFCE session + [cua-driver](https://cua.ai)) that it drives with screenshots, clicks and typing, and that you can watch or take over from the app. Without these programs everything else works; the agent's Desktop view just says what is missing. Nothing below runs by itself: ZumiBot never installs a package and never needs sudo while it runs.

### 1. OS packages (operator, needs sudo)

Install them as an admin user, not as the server user:

```sh
sudo apt-get install -y tigervnc-standalone-server dbus-daemon at-spi2-core fonts-noto-core \
  xfwm4 xfce4-panel xfdesktop4 xfce4-settings
```

What the server looks for (the names `desktop-check` prints):

| Program | Package | Used for |
|---|---|---|
| `Xvnc` | `tigervnc-standalone-server` | the X server and its VNC endpoint |
| `dbus-daemon` | `dbus-daemon` | the desktop's own session bus |
| `xfsettingsd`, `xfwm4`, `xfce4-panel`, `xfdesktop` | `xfce4-settings`, `xfwm4`, `xfce4-panel`, `xfdesktop4` | the session (windows, panel, wallpaper) |
| AT-SPI (`at-spi2-core`) | `at-spi2-core` | the accessibility tree cua-driver reads; started on demand through D-Bus |
| Noto fonts | `fonts-noto-core` | Latin, Arabic and other scripts on screen |

`xfce4-session` is **not** needed and `startxfce4` is not used: it would run the host's autostart entries (updaters, upgrade dialogs, an ssh-agent) inside every desktop. Optional extras for the agent to use: `mousepad`, `xfce4-terminal`.

### 2. Firefox from Mozilla's apt repository (operator, needs sudo)

The steps below and the cua-driver install use `curl` and `gpg`; install them first if they are missing: `sudo apt-get install -y curl gnupg`.

Install Firefox as a **deb from Mozilla**, not the Ubuntu snap: a snap Firefox does not run cleanly under the desktop's private `HOME`, and snap apps are not listed by cua-driver. Read each command before you run it; nothing is piped into `sudo`.

```sh
# 1. Fetch Mozilla's signing key into a temp file and read it. Compare its fingerprint with the one
#    on Mozilla's own install page (https://support.mozilla.org/kb/install-firefox-linux) before trusting it.
k=$(mktemp) && curl -fsSL https://packages.mozilla.org/apt/repo-signing-key.gpg -o "$k"
gpg -n -q --import --import-options import-show "$k"

# 2. Only if the fingerprint matches: install the key and the source.
sudo install -d -m 0755 /etc/apt/keyrings
sudo install -m 0644 "$k" /etc/apt/keyrings/packages.mozilla.org.asc; rm -f "$k"
s=$(mktemp) && printf '%s\n' 'deb [signed-by=/etc/apt/keyrings/packages.mozilla.org.asc] https://packages.mozilla.org/apt mozilla main' > "$s"
sudo install -m 0644 "$s" /etc/apt/sources.list.d/mozilla.list; rm -f "$s"

# 3. Prefer Mozilla's package over Ubuntu's snap stub.
p=$(mktemp) && printf '%s\n' 'Package: *' 'Pin: origin packages.mozilla.org' 'Pin-Priority: 1000' > "$p"
sudo install -m 0644 "$p" /etc/apt/preferences.d/mozilla; rm -f "$p"

# 4. Install and confirm it comes from packages.mozilla.org.
sudo apt-get update && sudo apt-get install -y firefox
apt-cache policy firefox
```

### 3. cua-driver (server user, no sudo)

cua-driver is installed per user into `~/.cua-driver` (with a symlink in `~/.local/bin`). Download the installer, **read it first**, then run it as the server user (the account that ran `install.sh`); `--no-modify-path` keeps it from editing your shell profile:

```sh
f=$(mktemp) && curl -fsSL https://cua.ai/driver/install.sh -o "$f"
less "$f"
/bin/bash "$f" --no-modify-path; rm -f "$f"
```

(The upstream one-liner is `/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"`; the three lines above are the same thing with a reading step in between.) The server finds the binary on `PATH` or at `~/.cua-driver/packages/current/cua-driver`, so no profile change is needed. cua-driver's Linux support is marked pre-release upstream; the build was verified against 0.38.0.

ZumiBot turns cua-driver's telemetry and update check off itself, through environment variables on every cua-driver process it starts (`DO_NOT_TRACK=1`, `CUA_DRIVER_RS_TELEMETRY_ENABLED=0`, `CUA_TELEMETRY_ENABLED=0`, `CUA_DRIVER_RS_UPDATE_CHECK=0`), and it also turns off cua-driver's script runner and unrestricted mode. Nothing is written to the agents' desktop homes.

### 4. Check

As the server user, from the installed app (or `npm run desktop:check` in a checkout):

```sh
~/zumibot/bin/zumibot-server desktop-check
```

It prints one line per program (`found <path>` or `missing <name>`), then `cua-driver <version>`, and exits 1 when anything is missing and 0 when all four are found. It only looks: it installs nothing and needs no sudo. A missing program leaves text chats and browsers unaffected.

### 5. How it runs

- **No port is opened.** Xvnc starts with `-rfbport -1 -nolisten tcp -nolisten local`; its VNC endpoint is a unix socket (mode 0600) in a private runtime directory (`$XDG_RUNTIME_DIR/zumibot-<uid>/…`, else under the system temp directory), and the app reaches it only through the authenticated `/ws/desktop` WebSocket. Nothing about the firewall or the reverse proxy changes.
- **Per-agent state** lives under `<dataDir>/desktops/` (each agent's private home and files, such as Firefox profiles). The sync script never pulls, pushes or backs up this folder; PC and VPS desktops stay separate.
- **Settings** (all optional, integers; a bad value is a start-up error that names the variable): `ZUMIBOT_DESKTOP_MAX` (desktops at once, 1-8, default 2), `ZUMIBOT_DESKTOP_IDLE_MS` (default 900000, a stopped desktop closes its open apps), `ZUMIBOT_DESKTOP_LEASE_IDLE_MS` (120000), `ZUMIBOT_DESKTOP_HANDOFF_IDLE_MS` (600000), `ZUMIBOT_DESKTOP_COMMAND_MS` (30000), `ZUMIBOT_DESKTOP_QUEUE_MS` (120000), `ZUMIBOT_DESKTOP_WIDTH` (640-1920, default 1280) and `ZUMIBOT_DESKTOP_HEIGHT` (480-1080, default 800).
- **Program overrides** (absolute paths; an unusable override counts as missing and does not fall back to `PATH`): `ZUMIBOT_DESKTOP_XVNC`, `ZUMIBOT_DESKTOP_DBUS_DAEMON`, `ZUMIBOT_DESKTOP_SESSION` (a command whose first word is absolute; do not point it at `startxfce4`) and `ZUMIBOT_CUA_DRIVER`. Put them in the service environment (a drop-in, see [Install](install.md), Service environment) and in the shell you run `desktop-check` from.
- Each desktop costs real RAM (Xvnc, the XFCE parts, cua-driver and whatever the agent opens, Firefox especially); watch the process tree before raising `ZUMIBOT_DESKTOP_MAX`.

### Local mode

The desktop app's Local server uses the same programs on your PC: install the same packages, Firefox deb and cua-driver there (with your go-ahead; the app never does it), run `npm run desktop:check` in the checkout, and the Desktop view works the same. Local desktops are separate from the VPS's and are never synced.
