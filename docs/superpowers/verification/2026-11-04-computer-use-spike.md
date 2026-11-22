# Computer use spike: cua-driver on an Xvnc desktop (Task 1)

> **Superseded (controller ruling, Task 6):** ZumiBot never passes `max_image_dimension`; screenshots are always full-size PNG so coordinates, element frames and the desktop size share one pixel space. Ignore the `max_image_dimension:1280` advice in sections 3 and 10.

Date: 2026-11-04/05, on the dev PC (Ubuntu 24.04.5, kernel 7.0). Display `:90` only; the user's own `:1` was never touched.

Stack: TigerVNC `Xvnc` 1.13.1, XFCE 4.18 parts (`xfwm4`, `xfce4-panel`, `xfdesktop`, `xfsettingsd`, `startxfce4`), dbus 1.14.10, at-spi2-core, mousepad, **cua-driver 0.38.0** (`cua-driver --version` → `cua-driver 0.38.0`, sha256 `bf57b2f3…4137934`). Driven over MCP stdio with `@modelcontextprotocol/sdk` 1.32.2 `Client`. Firefox was not installed, so it was not tested.

**Result: everything the gate needs lands.** It needs the input routes below, not cua-driver's defaults. On Xvnc, cua-driver's default `background` delivery has no keyboard or pointer backend, and its AT-SPI typing route cuts off non-ASCII text. Desktop-scope input (XTest) works for every action, including Arabic.

---

## 1. Working commands and env

### Process layout that works (recommended)

Run five things, each in its own process group:

| # | Process | Command | stdio |
|---|---|---|---|
| 1 | X + VNC | `Xvnc :90 -geometry 1280x800 -depth 24 -rfbport -1 -rfbunixpath <run>/vnc.sock -rfbunixmode 0600 -SecurityTypes None -nolisten tcp -nolisten local -auth <run>/Xauthority -AlwaysShared -AcceptSetDesktopSize=0 -desktop ZumiBot` | ignore, log, log |
| 2 | session bus | `dbus-daemon --session --nofork --nopidfile --nosyslog --address=unix:path=<run>/xdg/bus` | ignore, log, log |
| 3 | session | `sh -c 'xfsettingsd & xfwm4 & xfce4-panel & exec xfdesktop'` | ignore, log, log |
| 4 | cua-driver | `<cua> mcp` | **pipe, pipe**, log |
| (5) | apps | whatever `launch_app` starts: a child of cua-driver, in cua-driver's process group | inherited |

Env for 2–4 (built from scratch, never the server's env):

```
PATH=/usr/bin:/bin   LANG=en_US.UTF-8   DISPLAY=:90   XAUTHORITY=<run>/Xauthority
HOME=<home>   XDG_CONFIG_HOME=<home>/.config   XDG_DATA_HOME=<home>/.local/share   XDG_CACHE_HOME=<home>/.cache
XDG_RUNTIME_DIR=<run>/xdg (0700)   DBUS_SESSION_BUS_ADDRESS=unix:path=<run>/xdg/bus   (for 3 and 4)
GIO_USE_VFS=local   GIO_USE_VOLUME_MONITOR=unix   GVFS_DISABLE_FUSE=1      (optional, see 6)
```

cua-driver only, on top of that:

```
DO_NOT_TRACK=1 CUA_DRIVER_RS_TELEMETRY_ENABLED=0 CUA_TELEMETRY_ENABLED=0 CUA_DRIVER_RS_UPDATE_CHECK=0
CUA_DRIVER_PERMISSION_MODE=standard CUA_DRIVER_DISABLE_RUN_SCRIPT=1 CUA_DRIVER_DISABLE_UNRESTRICTED=1
```

AT-SPI needed **no extra env**:

- GTK3 loads its atk-bridge by default. `NO_AT_BRIDGE` must stay unset (or not `1`).
- `GTK_MODULES` is not needed.
- `at-spi-bus-launcher` does not need starting: the first `org.a11y.Bus` call (by cua-driver) activates it through D-Bus, along with `at-spi2-registryd` and `dconf-service`.
- cua-driver's own checks (`check_permissions`, `health_report`, `doctor`) ask for exactly X11 `DISPLAY` plus `org.a11y.Bus` reachable on `DBUS_SESSION_BUS_ADDRESS`, and no `WAYLAND_DISPLAY`.
- Qt (`QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1`) and Firefox (`GNOME_ACCESSIBILITY=1`) are **untested**: no such app was installed.

### Telemetry (exact output)

With the scratch HOME plus the env above, `cua-driver telemetry status` prints:

```
Telemetry: disabled (source: do_not_track)
Installation ID: not created
Registration recorded: false
Current release recorded: false
```

- With only `CUA_DRIVER_RS_TELEMETRY_ENABLED=0`, it prints `disabled (source: environment)`.
- With a fresh HOME and no env, it prints `enabled (source: default)`.
- cua-driver wrote nothing into the desktop HOME (no `~/.cua-driver`).
- `tools/list` returns 65 tools, and `run_script` is absent.

### Xauthority

The Node writer works:

- One FamilyWild entry: `ffff`, empty address, display `"90"`, `MIT-MAGIC-COOKIE-1`, 16-byte cookie, each field u16 BE length-prefixed. That is 46 bytes, mode 0600.
- `xauth -f F list` shows it as `#ffff##:90  MIT-MAGIC-COOKIE-1  <cookie>`.
- `xauth add :90 …` writes a FamilyLocal + hostname entry instead, so use the Node writer.
- A client without the cookie gets `Authorization required`.

### Xvnc

- All of the plan's flags are accepted by 1.13.1, including `-AcceptSetDesktopSize=0`.
- `-rfbunixmode 0600` is parsed as octal: the log says `(mode 0600)` and the socket is `srw-------`.
- Extra flags I recommend:
  - `-desktop ZumiBot`: the default name `user@host` is sent to every viewer in ServerInit.
  - `-nolisten local`: drops the abstract `@/tmp/.X11-unix/X90` socket. The file socket `/tmp/.X11-unix/X90` stays (0777, cookie-protected). The desktop still works with it.
- `ss -ltnup` shows no TCP or UDP listener for Xvnc or anything in the desktop's groups. The only unix listeners are `vnc.sock` and `/tmp/.X11-unix/X90`.
- RFB check, with a tiny Node client on `vnc.sock`:
  - `"RFB 003.008\n"`, security types `[1]` (None), SecurityResult 0.
  - ServerInit `{w:1280, h:800, bpp:32, depth:24, name:'ZumiBot'}` within 2–4 ms.
- A second client (ClientInit shared=0) connected while the first (shared=1) was open. Both stayed open, so `AlwaysShared` works.
- Modes during the run: run dir `drwx------`, `vnc.sock` `srw-------`, `Xauthority` `-rw-------`, `xdg/` `drwx------`.

### What did NOT work

1. **Long socket paths.** `sun_path` is 108 bytes. With the scratchpad path (166 bytes) Xvnc died: `vncExtInit: socket path is too long: File name too long (36)`. The spike used a short symlink `/tmp/claude-1000/cb90 → <scratch>/run`. With the real default data dir, `<data>/desktops/<uuid>/run/vnc.sock` is **100 bytes** for this user, and `run/xdg/bus` is 99, which is too close to the limit (see 8).
2. **The plan's one-liner** `dbus-run-session -- sh -c '"$0" & exec "$@"' startxfce4 cua-driver mcp`:
   - dbus-run-session's `dbus-daemon` inherits its stdout, which is the MCP pipe. So does every D-Bus-activated service. `at-spi2-registryd` wrote `SpiRegistry daemon is running with well-known name - org.a11y.atspi.Registry` **into the MCP stream**: the SDK `ReadBuffer` threw on a non-JSON line. A foreign line without a newline would corrupt the next JSON-RPC message.
   - Redirecting only the session (`"$0" </dev/null >&2 &`) does not help, because the bus is started before `sh`.
   - The backgrounded session also inherited the MCP stdin. Hence the split layout above.
3. **`startxfce4` (`xfce4-session`) under a fresh HOME** runs all of `/etc/xdg/autostart`. That gave 43 processes, among them:
   - an `update-notifier` / `check-new-release-gtk` window **"Ubuntu 26.04.1 LTS Upgrade Available" with a "Yes, Upgrade Now" button**, and `update-manager` (175 MB);
   - `evolution-*`, `tracker-miner-fs-3`, `nm-applet`, `goa-daemon`, the printer applet, the geoclue agent and `xdg-desktop-portal*`.

   xfce4-session also:
   - starts `ssh-agent -s`, which calls setsid, **escapes the process group and outlived the desktop** (I killed it by hand);
   - launches gpg-agent, which **socket-activated the user's own systemd `gpg-agent.service`** through `/run/user/1000/gnupg`. I stopped it again afterwards; its sockets stay active as before.

   Its xinitrc also runs `systemctl --user list-jobs`. That failed harmlessly against the private bus because `XDG_RUNTIME_DIR` was private.
4. **Starting any program with `DISPLAY` set but no `DBUS_SESSION_BUS_ADDRESS`** triggers libdbus X11 autolaunch. `cua-driver doctor` spawned `dbus-launch --autolaunch`, `dbus-daemon` and `at-spi-bus-launcher`. They were reparented to `systemd --user`, outside any group we own, and I killed them by hand. Never let that happen. For CLI calls outside a desktop (`desktop-check`), set `DBUS_SESSION_BUS_ADDRESS=disabled:` and leave `DISPLAY` unset.

---

## 2. Tools: exact arguments that landed

Notation: **desktop scope** means `{"scope":"desktop", …}` or, equivalently, `{"target":{"kind":"desktop","display_id":"primary"}, …}`. Coordinates are in the latest `get_desktop_state` image's pixels. The result says `route:"global_input"`, `delivery.mode:"not_applicable"`, and the input is XTest.

| Want | Exact args that landed | Route / ms | Notes |
|---|---|---|---|
| screenshot | `get_desktop_state {}` | 38–55 | PNG, full 1280×800 (see 3) |
| screen size | `get_screen_size {}` | 7 | `{width:1280,height:800,scale_factor:1}` |
| windows | `list_windows {}` (also `{app}`, `{pid}`, `{on_screen_only}`) | 7 | see 4 |
| apps | `list_apps {}` | 42 | **all host processes**, filter it (see 7) |
| launch | `launch_app {"name":"mousepad"}` | 234 | the app becomes a child of cua-driver |
| window tree | `get_window_state {"pid":P,"window_id":W}` (+`"tree_format":"elements"`, `"query"`, `"include_screenshot":false`, `"include_accessibility_tree":false`) | 40–50 (mousepad, 20 elements); 160–180 (file chooser, 98) | see 5 |
| click (pixels) | `click {"scope":"desktop","x":114,"y":70}` | global_input, 530–660 | Opened mousepad's Search menu |
| double click | `click {"scope":"desktop","x":465,"y":104,"count":2}` | global_input | Selected the word |
| triple click | `click {…desktop…, "count":3}` | global_input | Selected the whole entry |
| right click | `click {"scope":"desktop","x":300,"y":300,"button":"right"}` | global_input | Context menu opened |
| modifier click | `click {"scope":"desktop","x":120,"y":104,"modifier":["shift"]}` | global_input | Extended the selection. The field is **`modifier`** (singular) here and in drag |
| click (element) | `click {"element_token":"s0000000b:2"}` | accessibility, ~300 | Works when the element has an AT-SPI action. Opened a menu; then `s0000000c:3` (menu item "Find") opened the find bar; then "Ask Me Later" in another app (python GTK) closed that dialog |
| click (element, no action) | `click {"element_token":"s0000001c:19","delivery_mode":"foreground"}` | global_input | With background → `background_unavailable`. Foreground does a real pointer click at the element centre and reports `appeared: popup window …` |
| drag | `drag {"scope":"desktop","from_x":600,"from_y":104,"to_x":420,"to_y":104}` | global_input, 530 | Selected text. Optional `button`, `modifier`, `duration_ms` (default 500), `steps` (20) |
| scroll | `scroll {"scope":"desktop","x":300,"y":300,"direction":"up","amount":5}` | global_input, 570 | The scrollbar value went from 621.85 to 349.75. `amount` 1..50, `by`: `line`/`page` |
| move (hover) | `move_cursor {"scope":"desktop","x":900,"y":600}` | global_input, 7 | `get_cursor_position` → `(900, 600)`. **Without scope it moves only cua's overlay cursor, not the real pointer** |
| type | `type_text {"scope":"desktop","text":"…"}` | global_input, about 9 ms/char + 100 ms | Types into whatever has X keyboard focus. Exact for Arabic, CJK, emoji, accents and every ASCII symbol (see 8) |
| key | `press_key {"scope":"desktop","key":"escape"}`, `press_key {"scope":"desktop","key":"a","modifiers":["ctrl"]}` | global_input, ~20 | The field is **`modifiers`** (plural) here |
| combo | `hotkey {"scope":"desktop","keys":["ctrl","s"]}` | global_input | The "Save As" dialog appeared. `keys` needs at least 2 items. `["alt","tab"]` was accepted in desktop scope |
| focus | `bring_to_front {"pid":P,"window_id":W}` | 5 | `{platform:"linux", prior_active, window_id}`. Needs `pid` |
| zoom | `get_window_state {"pid":P,"window_id":W,"include_accessibility_tree":false}` then `zoom {"pid":P,"window_id":W,"x1":0,"y1":430,"x2":640,"y2":480}` | 12 | JPEG, at most 500 px wide. **Window-scoped only** (see 6) |

Key names (`press_key.key`): `enter`/`return`, `tab`, `escape`, `space`, `backspace`, `delete`, `insert`, `home`, `end`, `pageup`, `pagedown`, `up`, `down`, `left`, `right`, `f1`–`f12`, or one ASCII character. Modifiers: `ctrl`, `shift`, `alt`, `super`.

Window-targeted forms also landed, but only in `foreground`. Each one first activates the target window (`_NET_ACTIVE_WINDOW`) and is slower:

- `type_text {pid, window_id, text, delivery_mode:"foreground"}`: Arabic exact, ~1 s.
- `hotkey {pid, window_id, keys, delivery_mode:"foreground"}`: 200–860 ms.
- `double_click`, `right_click` and `scroll` with `{pid, window_id, x, y, coordinate_frame:"desktop", delivery_mode:"foreground"}`: ~1–1.2 s.

`double_click` and `right_click` reject desktop targeting (`"double_click does not accept a per-call target"`, code `invalid_action_target`), so use `click` with `count` or `button`.

Background clicks with pixel coordinates work only when an accessible control is under the point. One example landed: `click {pid, window_id, x:268, y:514, coordinate_frame:"desktop"}` hit a check box through AT-SPI and checked it. On anything else, cua refuses: *"No accessible control covers this point and the toolkit drops synthetic pointer events"*.

Window-local pixels (`{pid, window_id, x, y}` without a frame) need a prior `get_window_state` screenshot of that window. Without one the code is `screenshot_context_missing`.

Two more checks:

- **capture_id binding**: `click {scope:"desktop", x, y, capture_id}` with the latest capture id landed. With an older one it was refused (`capture_not_found`, "capture id is unknown").
- **Focus after launch**: in the light session a freshly launched mousepad was mapped but did not get keyboard focus. A desktop-scope `type_text` right after `launch_app` went nowhere. After one click into the window, typing landed. The agent (or the bridge) must click the target before typing.

### Background vs foreground on Xvnc

`background` is the default `delivery_mode`, and it does not work for real input on Xvnc. **Keyboard** (`press_key`, `hotkey`), **pointer** (`double_click`, `right_click`, `drag`, `scroll`, pixel clicks on non-accessible spots) all return:

```
isError: true, structuredContent.code: "background_unavailable",
hint: "Background keyboard delivery on X11 needs a virtual master keyboard fed by a uinput device … Xvfb/Xtigervnc cannot hot-add input devices, so the route is unavailable there."
```

The only background routes that work are AT-SPI ones:

- element clicks on elements that have an action;
- pixel clicks that hit an accessible control;
- `type_text` with `pid` or `element_token`, which uses AT-SPI EditableText. **That route breaks non-ASCII** (see 8).

So no app was given ignored XSendEvent input; cua-driver refuses up front instead. `foreground` (XTest after activating the window) fixes all of these. Desktop scope (XTest to whatever is focused) needs no activation and is the fastest.

---

## 3. Images

### `get_desktop_state` returns PNG only

There is no JPEG option. The content order is `[image, text]`:

```jsonc
content: [
  { type: "image", mimeType: "image/png", data: "<base64>" },     // 1280x800, 420–610 KB raw (560–810 KB base64) with the stock XFCE wallpaper
  { type: "text", text: "✅ Desktop screenshot 1280x800 (screen 1280x800)\nVisible windows (…):\n- pid=… window_id=… \"Desktop\" 1280x800 at (0,0) app=Xfdesktop\n…" }
]
structuredContent: { capture_id: "capture_<32hex>_<16hex>", display: "primary", frame_scale: 1, platform: "linux", scale_factor: 1,
  screen_width: 1280, screen_height: 800, screenshot_width: 1280, screenshot_height: 800, screenshot_mime_type: "image/png",
  windows: [<window record>…], agent_overlay_capture: { method: "x11_unshaped_overlay_under_compositor", status: "excluded" } }
```

- If `max_image_dimension` is omitted or 0, the image is full size. The config's `max_image_dimension: 1568` applies only to `get_window_state`.
- `max_image_dimension: 640` returned 640×400 with `frame_scale: 2` and `screenshot_original_width/height: 1280/800`.
- **The scale is sticky.** After that call, desktop-scope coordinates are multiplied by `frame_scale` automatically: `move_cursor {scope:"desktop", x:100, y:100}` ended at (200, 200). This holds until the next `get_desktop_state`; a full-size call reset it to (100, 100).
- `screenshot_out_file` exists (it writes the PNG to a path instead of base64) but was not needed.
- The full-screen PNG is well under `INLINE_IMAGE_MAX_BYTES` (3.75 MiB).
- cua's agent-cursor overlay is drawn on the X screen (so VNC viewers see it) but left out of screenshots.

### `get_window_state` image

A PNG of the window's client area only (no WM frame). The content order is `[text tree, ("Invalidated snapshots …" text), image]`. It is window-local. A capture of the full-screen `Xfdesktop` window showed only the desktop's own pixels, not the mousepad window above it, so captures are per window.

### `zoom`

```jsonc
content: [ { type: "image", mimeType: "image/jpeg", data }, { type: "text", text: "Zoom (0,430)–(640,480) → 500×47 px JPEG." } ]
structuredContent: { format: "jpeg", mime_type: "image/jpeg", width: 500, height: 47 }
```

---

## 4. Window record

The same record appears in `list_windows.structuredContent.windows[]`, `get_desktop_state.structuredContent.windows[]` and `launch_app.structuredContent.windows[]`:

```json
{"app_name":"Mousepad","bounds":{"height":480,"width":640,"x":5,"y":56},"height":480,"is_on_screen":true,"pid":1766881,
 "title":"Untitled 1 - Mousepad","width":640,"window_id":37748739,"x":5,"y":56,"z_index":3}
```

- `window_id` is an integer XID.
- Bounds are the client area in screen pixels.
- Popups (override-redirect menus) are not listed.
- xfce4-panel has a 3×3 window at (−9999, −9999) with `is_on_screen:true`, so filter windows by visible bounds.
- `list_windows` text form: `Found N windows:\n  window_id=… pid=… "title" WxH+X+Y app=App`.
- `launch_app` → text `✅ Launched mousepad (pid 1766881) in background.` and structured `{active:false, bundle_id:null, launcher_pid, name:"mousepad", pid, running:true, windows:[…]}`.

## 5. Element tokens and the tree

- `get_window_state` header: `window_id=… pid=… elements=20 walk_ms=26 snapshot_id=s00000001` plus `element_token for row [N] = s00000001:N`.
- The default `tree_format` is `"markdown"`. Rows look like `- [2] menu "Search" (description "Search menu") [actions=[click]] (closed menu, 9 items; click it to open)`; rows without `[N]` cannot be acted on.
- Token regex: `^s[0-9a-f]{8}:[0-9]+$`. Every new read of the same window invalidates the older snapshot. The result then includes a text block `Invalidated snapshots s00000001: their element_tokens are stale.` and `invalidated_snapshot_ids`.
- A `query` read keeps the original row numbers.

`tree_format:"elements"` → `structuredContent.elements[]`:

```json
{"actions":["click"],"depth":4,"description":"File menu; closed menu with 19 items; not expanded: click it to open","element_index":0,
 "element_token":"s00000002:0","enabled":true,"frame":{"h":27,"w":39,"x":5,"y":56},"label":"File","role":"menu",
 "screenshot_frame":{"h":27,"w":39,"x":0,"y":0}}
{"depth":5,"description":"unlabelled text; 1st of 1 text in this window","element_index":17,"element_token":"s00000002:17","enabled":true,
 "frame":{"h":447,"w":638,"x":6,"y":86},"parent_index":16,"role":"text","screenshot_frame":{"h":447,"w":638,"x":1,"y":30},"unlabelled":true}
```

- `frame` is in screen pixels and `screenshot_frame` is window-local.
- A text element's `value` holds its text, which is how typing was read back.
- Other structured fields: `app_name, bounds_complete, capture_id, coordinate_frame:"window", element_count, elements_complete, pid, returned_element_count, screenshot_frame_valid, screenshot_width/height, screenshot_mime_type, snapshot_id, timeout_ms, total_element_count, tree_format, tree_markdown|elements, truncated, window_bounds, window_id, window_title`.
- Default `max_elements` is 250, and the first read of a window gets a 2000 ms timeout.
- When a popup of the pid is open, `get_window_state {pid}` without `window_id` walks it (the menu items got rows `[3]…[9]`).

## 6. Action and error result shapes

```jsonc
// success (every action tool)
content: [ { type:"text", text:"✅ Sent screen-absolute click at (114,70) (desktop scope)." }, (optional 2nd text, e.g. "A popup menu is open …") ]
structuredContent: { delivery:{ mode:"not_applicable"|"background"|"foreground" }, effect:"unverifiable", hint:"…", route:"global_input"|"accessibility",
                     summary:"…", next_call?: { tool:"get_window_state", arguments:{ pid, window_id, since:"latest" } } }
// failure
isError: true
structuredContent: { code, detail?, hint?, escalation?: { recommended:"foreground", reason }, suggestion?, next_call?, reason? }
```

Codes seen: `background_unavailable`, `screenshot_context_missing`, `invalid_action_target`, `capture_not_found`. Hints talk about `run_steps`, `foreground` and `verify_state`, so the bridge should map codes to its own text and not forward cua's hints to the agent.

`get_screen_size` → `{width, height, scale_factor}`. Every tool also declares an `outputSchema` and annotations (`click`: `{readOnlyHint:false, destructiveHint:true, idempotentHint:false, openWorldHint:true}`).

### `zoom` is window-scoped

`zoom` crops that window's own capture, so occluding windows do not appear in it. It needs a fresh `get_window_state` of the window, and its coordinates are window-local (`window_id` and `x1..y2` are required). Capturing the full-screen Xfdesktop window and zooming on it shows the wallpaper under the other windows, not the screen. cua's guide says *"Never crop a desktop image and label it an attested window capture"*; cropping it and calling it a screen region is fine.

### `list_apps` dumps the host

`list_apps` returned 795 entries: 736 running processes from `/proc`, including kernel threads and the user's real apps with their pids, plus 59 installed. The text is 19 KB and the JSON 165 KB.

- `structuredContent: { apps:[{active, bundle_id, kind, last_used, launch_path, name, pid, running, windows}], processes:[{name,pid}] }`.
- Only `kind:"desktop"` entries are apps (78 here), e.g. `{"bundle_id":"org.xfce.mousepad","kind":"desktop","launch_path":"mousepad","name":"Mousepad","pid":0,"running":false,"windows":[]}`.
- Snap apps are not listed (`/var/lib/snapd/desktop` is not in the default `XDG_DATA_DIRS`).

### `launch_app` resolution

`launch_app.name` is "tried as a direct command first". `launch_path` is "spawned directly via the system shell".

### The desktop shows the host

With the light session and no GIO env, xfdesktop showed the host's volumes ("499 GB Volume", "Games"), "File System" and Trash. `GIO_USE_VOLUME_MONITOR=unix GIO_USE_VFS=local GVFS_DISABLE_FUSE=1` removed the volumes and Trash; "File System" stays. The desktop is not a sandbox: apps run as the server user, and xfce4-terminal is installed and in the panel.

---

## 7. Measurements

**Time from Xvnc spawn to cua-driver ready**, light session, split layout. Ready means `tools/list` answered.

| | ms |
|---|---|
| `vnc.sock` accepting | 55–61 |
| session bus up | ~210 (includes about 150 ms of Node start for the spike driver) |
| cua-driver `tools/list` | 610–690 (5 runs) |
| xfdesktop and xfce4-panel windows listed | ~815 |

### Memory

`ps -o rss` summed over the process groups plus Xvnc. PSS from `smaps_rollup` is the truer per-desktop cost, because libraries are shared.

| Session | State | Processes | RSS sum | PSS sum | Xvnc RSS | cua RSS |
|---|---|---|---|---|---|---|
| `startxfce4` (full) | idle | 43 | 1172 MiB | 515 MiB | 87 MiB | 55 MiB |
| `startxfce4` | mousepad + work | 44 | 1210 MiB | 552 MiB | 107 MiB | 90 MiB |
| light (recommended) | idle | 25 | 690 MiB | 245 MiB | 87 MiB | 35 MiB |
| light | mousepad | 29 | 799 MiB | 292 MiB | 87 MiB | 56 MiB |
| light + GIO env | idle | 21–22 | 651–711 MiB | 232–290 MiB | 83–93 MiB | 34–64 MiB |
| light + GIO env | mousepad, 30 lines typed | 26 | 823 MiB | 335 MiB | 97 MiB | 78 MiB |

**Plan on roughly 250–350 MiB (PSS) per running desktop.**

### Stop and crash behaviour

- **SIGTERM to each group** (bus, session, cua) and Xvnc: everything exited within the 3 s grace. Xvnc removed `vnc.sock`, `/tmp/.X90-lock` and `/tmp/.X11-unix/X90` itself. D-Bus-activated services are reparented to `systemd --user` (a subreaper) but keep the bus's pgid, so the group kill reaches them. In the split layout no process escaped; I scanned every own process for `DISPLAY=:90` or the desktop HOME.
- **SIGKILL to Xvnc** (crash): the session exited (X connection broken). **cua-driver and the bus group kept running.** `vnc.sock`, `/tmp/.X90-lock` (content = the dead Xvnc pid) and `/tmp/.X11-unix/X90` were left behind.
- **cua-driver exits on stdin EOF**, in about 270 ms with exit 0.

---

## 8. Arabic

| Route | Args | Result |
|---|---|---|
| AT-SPI (default background) | `type_text {pid, window_id, text:" مرحبا بالعالم"}` | Reported "Typed 14 character(s) (via AT-SPI)" and `isError:false`, but **only `" مرحبا ب"` landed**: 14 *bytes*. cua passes the character count where GTK's insert expects bytes, so multibyte text is cut. ASCII is fine |
| AT-SPI via element token | `type_text {element_token, text:"spike-ملف.txt"}` (also with `delivery_mode:"foreground"`, which is ignored for tokens) | Field read back `spike-ملف.` (13 of 16 bytes). cua's own readback adds a text block: "The element reads back 'spike-ملف.', which does not contain the typed text", and it is still `isError:false` |
| foreground window | `type_text {pid, window_id, text:"مرحبا بالعالم", delivery_mode:"foreground"}` | **Exact** (byte-compared readback); real key events, ~1 s |
| desktop scope | `type_text {scope:"desktop", text}` | **Exact**: `مرحبا بالعالم hello world`, and `Hello WORLD 123 !@#$%^&*()_+-={}[]\|\:;"<>,.?/~\` é ü ñ 你好 😀 شكراً` compared byte for byte. `\n` gives Return |

- No Arabic keysyms were left in the keymap afterwards (`xmodmap -pke`).
- Mousepad rendered the text right to left with Noto.
- A file was saved as `~/spike-ملف.txt` with Arabic contents, using desktop typing in the GTK Save dialog.
- **Arabic works only through XTest (desktop scope or window-foreground). Never use `type_text` with `element_token`, or with `pid` and no foreground.**
- The user's own Arabic typing through noVNC under Take control was not tested here; there was no viewer. That is Task 15.

Misc: in the GTK file chooser's name entry, `ctrl+a` (desktop or foreground) did not select the text, though it did in mousepad. A triple click (`count:3`) did. That is app behaviour, not cua.

---

## 9. Problems and workarounds (summary)

| Problem | Workaround |
|---|---|
| Background keyboard and pointer unavailable on Xvnc (no uinput hot-add) | Use desktop scope for every coordinate, key and type action. Use the AT-SPI token click first for elements, and retry with `delivery_mode:"foreground"` on `background_unavailable` |
| AT-SPI typing cuts non-ASCII | `type_text` only with `scope:"desktop"` (or `pid`+`window_id`+`foreground`). For "type into element", click the element first |
| Newly launched window has no keyboard focus | Click it, or the field, before typing (prompt text, or the bridge does it for `desktop_type {element}`) |
| `dbus-run-session` puts bus and service output into the MCP pipe | Split layout: own `dbus-daemon` with a fixed address, and cua-driver with clean pipes |
| `startxfce4` autostart (upgrade dialog, updaters, trackers), `ssh-agent` escapes, user's gpg-agent triggered | Session `sh -c 'xfsettingsd & xfwm4 & xfce4-panel & exec xfdesktop'` without xfce4-session |
| `sun_path` 108-byte limit | Short runtime dir and a length check |
| Xvnc crash leaves the lock and socket, and cua-driver runs on | The adapter treats Xvnc exit as fatal, stops the other groups and unlinks the lock and socket when the lock pid is ours and dead |
| `list_apps` exposes every host process | Filter to `kind:"desktop"` plus windows on this display |
| `max_image_dimension` scale is sticky | Default 1280×800 → never pass it (scale 1). Bigger desktops → pass `max_image_dimension:1280` and do **not** pre-scale the coordinates |
| D-Bus autolaunch on stray CLI calls | Always set `DBUS_SESSION_BUS_ADDRESS` (`disabled:` outside a desktop) |

---

## 10. Things Tasks 5/6 must change vs the plan

### Task 5 (process adapter)

1. **The cua-driver fallback path** is `~/.cua-driver/packages/current/cua-driver`, not `…/current/bin/cua-driver`. `~/.local/bin/cua-driver` is a symlink to it.
2. **Replace the one-liner** `dbus-run-session -- sh -c '"$0" & exec "$@"' <session> <cua> mcp` with the split layout in section 1:
   - Xvnc, `dbus-daemon --session --nofork --nopidfile --nosyslog --address=unix:path=<run>/xdg/bus`, the session and `cua-driver mcp`, each `detached` (own pgid), with pid files.
   - Only cua-driver gets piped stdio.
   - Wait for `<run>/xdg/bus` to exist before starting the session and cua-driver.
   - `runtime.dbusRun` becomes `dbus-daemon` (the human name `'D-Bus (dbus-daemon)'`).
   - The fake becomes a fake bus that creates the socket file, or keep the `dbusRun` override pointing at a fake that does.
3. **Spawn cua-driver yourself.** The SDK `StdioClientTransport` cannot spawn `detached`, and it merges `HOME, LOGNAME, PATH, SHELL, TERM, USER` from the server env. Write a small `Transport` over the self-spawned child, using `ReadBuffer`/`serializeMessage` from `@modelcontextprotocol/sdk/shared/stdio.js` (exported through `./*`). The spike did exactly this. Skip, and log, a line that fails to parse.
4. **Default session command**: `sh -c 'xfsettingsd & xfwm4 & xfce4-panel & exec xfdesktop'`. Not `startxfce4`. `missing` should name `'desktop session (xfwm4)'`. If someone sets `ZUMIBOT_DESKTOP_SESSION=startxfce4`, the adapter should warn that autostart applies.
5. **Env**, exactly as in section 1:
   - `DBUS_SESSION_BUS_ADDRESS` for the session and cua-driver.
   - The GIO trio (`GIO_USE_VFS=local`, `GIO_USE_VOLUME_MONITOR=unix`, `GVFS_DISABLE_FUSE=1`) to hide host volumes.
   - No `GTK_MODULES`/`NO_AT_BRIDGE` needed. `QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1` is harmless to add but untested.
   - The cua-only vars go to cua-driver only.
6. **Xvnc args**: the plan's list plus `-desktop ZumiBot` and `-nolisten local`. Readiness = `vnc.sock` accepting (about 60 ms).
7. **Runtime dir length.** Use a short runtime dir that keeps `vnc.sock` and `xdg/bus` well under 108 bytes, e.g. `${XDG_RUNTIME_DIR||os.tmpdir()}/zumibot-<uid>/<8-char id>` at 0700. Fail clearly if a path is longer than about 100 bytes. `recoverDesktops` must scan that root. The default data-dir path is 100 bytes for this user, so `<data>/desktops/<uuid>/run` is not safe.
8. **Crash handling**: Xvnc exit alone must close the desktop; cua-driver does not exit when X dies. On Xvnc exit, and in `recoverDesktops`, unlink `/tmp/.X<N>-lock` and `/tmp/.X11-unix/X<N>` when the lock's pid is our dead Xvnc. Otherwise "skips taken display numbers" leaks numbers after every crash. `close()`: closing stdin stops cua-driver in about 270 ms; then SIGTERM every group, and SIGKILL after 3 s, as planned.
9. **Fake cua shapes** must follow sections 3–6:
   - `get_desktop_state` → `[image/png, text]` plus structured `{screenshot_width, screenshot_height, screen_width, screen_height, frame_scale, capture_id, windows[]}`. Not a JPEG plus a JSON text.
   - `list_windows` → `structuredContent.windows[]` with integer `window_id`, `app_name` (not `app`), `bounds{x,y,width,height}` and `z_index`.
   - Element tokens look like `s00000001:3`, not `t1`.
   - `list_apps` → `structuredContent.apps[]` with `kind:"desktop"`, `launch_path` and `name`.
   - Action errors → `isError:true` plus `structuredContent.code`.
10. Health check: `tools/list` is fine (65 tools). Optionally call `check_permissions`, whose text includes `org.a11y.Bus reachable` when AT-SPI works.

### Task 6 (`cuaRequest` mapping)

| ZumiBot command | cua call |
|---|---|
| screenshot | `get_desktop_state {}` (scale 1 at 1280×800). If width > 1280: `{max_image_dimension:1280}`, and pass the agent's coordinates **unscaled**, because cua maps them back itself. **Drop the "multiply by `scale`" rule**, or keep `scale` at 1 always; pre-scaling would double-scale |
| click x,y | `click {scope:"desktop", x, y, button?, count? (2 double, 3 triple), modifier?: string[]}` |
| click element | `click {element_token}`; on code `background_unavailable`, retry once with `delivery_mode:"foreground"` (same token) |
| drag | `drag {scope:"desktop", from_x, from_y, to_x, to_y, button?, modifier?}` |
| scroll | `scroll {scope:"desktop", x, y, direction, amount (1..50)}`. For an element, use the centre of its `frame` |
| move | `move_cursor {scope:"desktop", x, y}`. Without `scope` only the overlay cursor moves |
| type | `type_text {scope:"desktop", text}` (UTF-8 passed through untouched). With an element: the element click above, then this. **Never `type_text {element_token}`** |
| key | one key: `press_key {scope:"desktop", key, modifiers?}`; a combination: `hotkey {scope:"desktop", keys:[…mods, key]}` (≥2) |
| launch | accept only a name that exactly matches a filtered `list_apps` entry with `kind:"desktop"`, then call `launch_app {name: entry.name}` or `{launch_path: entry.launch_path}`. Never pass free text: `name` is tried as a command, and `launch_path` runs through a shell |
| focus | `bring_to_front {pid, window_id}`. The pid comes from `list_windows` |
| window_state | `get_window_state {pid, window_id, tree_format:"elements"}` (pid from `list_windows`). The image is a window-client PNG; map elements and their `frame` (screen px) |
| zoom | `zoom` is window-only. Either make `desktop_zoom` take a `windowId` (bridge: `get_window_state {pid, window_id, include_accessibility_tree:false}` then `zoom {pid, window_id, x1,y1,x2,y2}` in window-local px = screen px − `bounds.x/y`), or crop the desktop PNG in-process. Output is JPEG ≤500 px wide |
| apps | filter: `kind === "desktop"` → `{name, running}`, plus running entries that have windows. Never forward `processes[]`; the raw output is 165 KB of host processes |
| windows | `list_windows {}` → drop off-screen and tiny windows (the panel's 3×3 at −9999) |

The `double_click` and `right_click` tools are not needed. Optional: pass `capture_id` from the agent's latest screenshot on coordinate actions, so cua also refuses stale coordinates (`capture_not_found`).

### Spec/plan wording to update

- The screenshot is PNG, not JPEG; it fits the image limit.
- The session is "XFCE components without xfce4-session".
- cua-driver's `move_cursor` needs desktop scope to move the real pointer.
- The prompt should tell the agent to click into a field before typing.

GATE: PASS
