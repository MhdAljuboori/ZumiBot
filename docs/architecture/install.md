# Install

How someone other than the author stands ZumiBot up: a server anyone can run with Docker or one command, a
first-run setup in the browser, and a macOS desktop build. This doc is the plan and the audit behind it; each
phase fills in its own section as it lands.

The original install was manual and single-operator: a 13-step runbook, a system unit and a Caddyfile that both
hardcoded one domain, and an rsync deploy from the author's PC. That is gone: `install.sh` (Phase 3 below) installs a
systemd user unit, a release tag plus the in-app Update ships new versions, and
[`deploy/SETUP-VPS.md`](../../zumi-bot-server/deploy/SETUP-VPS.md) is now a short page for the one step that needs
root, the reverse proxy.

**What never changes.** The server listens on `127.0.0.1` only (`app.ts#startServer`, and the comment there says it
is not configurable): a reverse proxy or the desktop shell is the only way in. No setting loosens that, in any
install path. `ZUMIBOT_ORIGIN` stays required in vps mode, origin checks apply to every write and to the
WebSocket upgrade, and there is no default password, no skip-2FA switch and no setup without the one-time code.

## Phase 0: platform audit

Scope: every platform assumption in `zumi-bot-server/backend/src` and `zumi-bot-desktop/src`. Each row is
**fine** (works on macOS as written), **change** (works on Linux, needs a change for macOS) or **Linux** (Linux-only
by design, already guarded or to be guarded). Windows is covered separately below.

### Backend: fine as written

| Assumption | Where | Why it is fine on macOS |
|---|---|---|
| POSIX file modes `0600`/`0700` on every secret and private folder | `auth/authStore.ts`, `control.ts`, `core/fsutil.ts`, `core/hooks/hookFile.ts`, `core/vault/*`, `core/jev/jevStore.ts`, `core/notify/notifyStore.ts`, `core/store/chatStore.ts`, `core/files/snapshotStore.ts`, `dataDir.ts`, 20 more | APFS and HFS+ enforce mode bits; `chmod`/`mkdir(mode)` behave as on Linux |
| `process.getuid()` for the socket-folder and data-folder owner checks | `dataDir.ts`, `core/{asks,automations,todos,vault,browser,desktop}/*Ipc.ts` | Present on darwin |
| Unix domain sockets for the control channel and the seven IPC bridges | `control.ts` (`<dataDir>/control.sock`), `core/*/\*Ipc.ts` (`mkdtemp('/tmp/cb-?-')` + `/s`) | macOS has `/tmp` (a symlink to `/private/tmp`); every path is far inside the 104-byte `sun_path` limit, and the guards already cap it at 100 bytes |
| `CLAUDE_CODE_TMPDIR` per chat under the data dir, named by a 16-hex hash | `core/chat/chatTmp.ts` | The hash is what keeps CLI sockets under the limit; the macOS limit (104) is the one the comment and [data.md](data.md) already assume |
| Atomic writes by temp file + `rename`, with `EXDEV` fallback | `core/fsutil.ts`, `core/trash.ts` | Same semantics |
| `detached: true` plus `process.kill(-pid, sig)` to end a whole process group | `cli.ts`, `core/extensions/{claudeCli,probe}.ts`, `core/desktop/desktopProcess.ts` | POSIX process groups |
| The SIGTERM-then-SIGKILL ladder and `SIGTERM`/`SIGINT` shutdown | `cli.ts`, `core/chat/claudeRunner.ts`, `core/codex/codexRunner.ts`, every `*Bridge.ts` | Same signals |
| POSIX `sh` one-liners in the CLI's `--settings` hooks | `core/chat/pauseSettings.ts` (`[ -e "$ZUMIBOT_PAUSE_FILE" ] || exit 0; …`), `core/vault/vaultGuard.ts` (`grep -qF …`) | `/bin/sh` is there; the quoting is single-quote POSIX |
| `git` through `execFile` | `core/git/git.ts` | On the PATH on any dev Mac (Xcode CLT) |
| Data dir `$XDG_DATA_HOME/zumibot`, else `~/.local/share/zumibot` | `config.ts#resolveDataDir` | Works. Not the macOS-native `~/Library/Application Support`, deliberately: the same path on both machines is what lets `npm run sync` and the docs stay one set of instructions |
| Vault key `~/.config/zumibot-vault/vault.key`, refused inside the data dir or in a shared folder | `config.ts#resolveVaultKeyFile`, `dedicatedKeyDir` | Works; `tmpdir()` resolves to the per-user `/var/folders/…/T` and is still rejected as shared |
| `migrateFromDesktop` from the Electron userData folder | `migrate.ts` | A no-op on macOS: userData is `~/Library/Application Support/ZumiBot`, which holds only `island.json`, `server.json`, `window-state.json` and `sync.env`, none of them in `ENTRIES` |
| Web push (VAPID), IMAP mail watchers, OpenRouter voice calls, message search, export | `core/notify/`, `core/workflows/mailWatchers.ts`, `core/voice/`, `core/search/`, `core/export/` | Pure Node and TCP |

### Backend: needs a change for macOS

| # | Assumption | Where | What breaks, and the fix |
|---|---|---|---|
| B1 | **Done:** on darwin `processStart` reads `ps -o lstart=` (spaces made `_`). Was: the data lock records a process start time read from `/proc/<pid>/stat` | `lock.ts#processStart` | On darwin it returns `null`, so the lock file holds only a pid. After an unclean exit a **reused** pid reads as live and the next start is refused with "Another ZumiBot server is using …". Fix: on darwin take the start time from `ps -o lstart= -p <pid>` (or `-o lstart=,etime=`) and keep the same two-field file format. The rest of `acquireDataLock` already handles a missing start time, so this is a localised change with a unit test |
| B2 | The agent trash is the freedesktop trash: `~/.local/share/Trash/{files,info}` with a `.trashinfo` file | `core/trash.ts`, used by `AgentStore` and `MemoryStore` | It works, but it writes a stray `~/.local/share/Trash` that Finder never shows, so "the Trash is the undo" (see [agents.md](agents.md)) stops being true for a Mac user. Fix: on darwin move into `~/.Trash` with no info file (Finder's own layout), keeping the same atomic name-claiming loop |
| B3 | **Done for the vault guard** (`grep -qiF` on darwin). Path containment and the vault deny rules compare paths case-sensitively | `core/fsutil.ts#assertInside`, `config.ts#dedicatedKeyDir`, `core/vault/vaultGuard.ts#vaultGuardCommand` | macOS volumes are case-insensitive by default. `assertInside` fails closed (a differently-cased path is rejected), so it is safe. `vaultGuardCommand`'s `grep -qF` on exact spellings fails **open**: `cat ~/.config/Zumibot-vault/vault.key` does not match and is not blocked. The guard is already documented as a speed bump, not a wall ([vault.md](vault.md)), but the Mac case is a step weaker than the Linux one. Fix: `grep -qiF` on darwin, and say so in vault.md. Agent names are the same hazard: `Bob.md` and `bob.md` are one file in `~/.claude/agents` on a Mac |
| B4 | **Done:** `loginShell` (`shellEnv.ts`) is zsh on darwin unless `$SHELL` is bash, used `-ilc` by `resolveRunPath` and `loginShellWhich` (claude, codex); `locateBin` also looks in `/opt/homebrew/bin` and `/usr/local/bin` there. Was: the login-shell PATH and the `claude`/`codex` fallback lookup both run **bash** | `core/chat/shellEnv.ts` (`bash -ilc`), `core/chat/claudeLocator.ts` and `core/codex/codexLocator.ts` (`bash -lc 'command -v claude'`) | `/bin/bash` exists on macOS, so nothing errors, but the default login shell is zsh: a PATH added to `~/.zprofile`/`~/.zshrc` (what every `npm -g` and nvm instruction on a Mac edits) is invisible to `bash -ilc`. The user then has to set the path by hand in Settings. Fix: try `$SHELL -ilc` first and fall back to `bash`, keeping the `__CB__` marker parse and the `/`-prefixed validation as they are |
| B5 | The managed-browser locations list a macOS Chrome path that can never be reached | `core/browser/browserRuntime.ts:45` (`/Applications/Google Chrome.app/…`) vs `browserRuntime.ts:60` and `workerAdapter.ts:28` (`platform !== 'linux'` → null / throw) | Dead code that reads like macOS support. Either drop the macOS entry or keep it and make the refusal a clean "Linux only" message, never a thrown `Error` surfacing as a tool failure. Phase 4's "the UI must say so instead of failing" lands here |
| B6 | The ACP attempt's process-tree walk reads `/proc` | `core/acp/procTree.ts` (`procIo`), used by `acpRunner.ts` and `acpProbe.ts` | Found running the unit suite on a Mac (2026-11-22). Off Linux `list()` is null, so only the group kill runs: a tool shell an ACP agent started in a session of its own (claude-agent-acp's Bash calls `setsid`) outlives the attempt, and the SIGTERM grace never reaches it. Not a one-line port: macOS `ps -o sess=` prints 0, so the crash path's "walk from what is left in its session" has no data there. Fix: a darwin `ProcIo` from `ps -axo pid=,ppid=,pgid=,lstart=` (start time as the identity), with the session fallback left out. The tree tests are gated to Linux until then |
| B7 | The stale IPC sweep tells a live server from a dead one by the connect error | `core/ipc/staleIpcDirs.ts` (only `ECONNREFUSED` means nothing listens) | Found by the suite. On Linux a full backlog is `EAGAIN`; on macOS it is `ECONNREFUSED`, the same as a dead socket. So a server that is frozen (stopped, or hung with a full backlog of 511 connections) when another server starts can have its socket folder swept. Rare enough to leave; its test is skipped on darwin |
| B8 | An oversized upload is answered 413 before its body is read | `http/server.ts` (`/api/attachments/stage`), `chats:send` size checks | Found by the suite. As on Windows, macOS resets the socket when the server answers early, so a client may see a network error instead of the 413 text. `tests/support/chatTooLarge.ts` accepts the reset on darwin as on win32; Linux must still see the 413 |

### Backend: Linux-only by design

| Assumption | Where | Guarded? |
|---|---|---|
| `/proc/<pid>/{stat,environ,cmdline}` for process ownership and desktop recovery | `core/browser/browserProcess.ts`, `core/desktop/desktopProcess.ts` | Yes: `platform !== 'linux'` throws in `browserProcess.ts:13,106` and `workerAdapter.ts:28`, and returns early in `desktopProcess.ts:235` |
| Xvnc, `dbus-daemon`, the XFCE parts, cua-driver, `/tmp/.X11-unix`, X lock files, `XDG_RUNTIME_DIR` sockets, the AT-SPI bus | `core/desktop/` | Yes: `desktopApplication.ts:33` reports `['Linux']` as the missing program on any other platform, and `desktopProcess.ts:249` throws `DesktopUnavailableError(['Linux'])`. See [computer-use.md](computer-use.md) |
| The pinned managed Chromium download (`browser-install`), linux x64/arm64 only | `core/browser/browserRuntime.ts:60` | Yes (returns `null`) |
| `bin/zumibot-server` is a `/bin/sh` launcher; the unit is systemd | `deploy/` | By design. macOS runs the server from the desktop shell, not from a unit |

Both Linux-only areas already say so in their own docs, and the two server-side entry points (`desktop-check`,
`browser-check`) exit non-zero with a named missing program rather than crashing.

### Desktop shell: fine as written

| Assumption | Where | Why it is fine on macOS |
|---|---|---|
| The local server is `process.execPath` with `ELECTRON_RUN_AS_NODE=1` and the secret passed through env only | `main/localServer.ts`, `main/index.ts#launchLocal` | Supported on macOS as long as the `runAsNode` fuse stays enabled; this build sets no fuses. Signing caveat in D11 |
| `app.requestSingleInstanceLock()` and the `second-instance` handler | `main/index.ts:551` | Works on macOS |
| `window-all-closed` keeps the app alive (tray only; a requested quit ends it) | `main/index.ts` | This is the macOS convention already — but see D7 |
| `zumibot://` protocol registration for the Sync link | `electron-builder.yml#protocols` | Becomes `CFBundleURLTypes` in the bundle |
| The portal dark-mode probe is already platform-gated | `main/index.ts:502` (`platform === 'linux' ? readPortalPrefersDark() : Promise.resolve(null)`), `main/desktopTheme.ts`, `main/window.ts:172` (`boolean \| null \| undefined`) | On macOS the promise resolves `null` and `nativeTheme` covers it. The one `process.platform` check in the whole shell |
| The Mutter screen guard | `main/screenGuard.ts` | Pure display-bounds logic; on macOS `hasRealScreen` is simply always true |
| `shell.openPath` / `showItemInFolder` for attachments | `main/attachmentsOpen.ts` | Cross-platform Electron |
| Window state, navigation lock, close flow, quit guard, sync windows | `main/{windowState,navigation,closeFlow,quitGuard,sync*}.ts` | No platform API |

### Desktop shell: needs a change for macOS

| # | Assumption | Where | What breaks, and the fix |
|---|---|---|---|
| D1 | **Done:** `hitTest: 'cursor'` on darwin: the window ignores the mouse (`forward: true`) and a 50 ms poll of the pointer takes it back over `islandShape`'s rects or during a drag. Was: the island calls `win.setShape(rects)` on every placement | `main/island.ts:141` | **Hard break.** Electron documents `setShape` as *Windows, Linux, Experimental* — there is no macOS implementation, so the first `place()` throws `win.setShape is not a function` and the island never appears. Fix: guard the call and on darwin give the window the strip/popup bounds themselves, plus `setIgnoreMouseEvents(true, { forward: true })` with the interactive rect re-enabled, so the transparent remainder stays click-through. `islandShape()` stays the single source of the rects |
| D2 | **Done:** no type on darwin (`panel` logged "NSWindow does not support nonactivating panel styleMask"; a frameless window is in neither the Dock nor Cmd+Tab). Was: the island window is `type: 'toolbar'` | `main/island.ts:171` | Not a macOS value (macOS takes `desktop`, `textured`, `panel`). It is ignored rather than fatal, so the island would show in Mission Control and the app switcher. Fix: `type: 'panel'` on darwin. `skipTaskbar` is supported on macOS, and `setAlwaysOnTop(true, 'floating')` and `setVisibleOnAllWorkspaces(…, { visibleOnFullScreen: true })` both are too |
| D3 | `CHROME_DESKTOP` is swapped so the island gets its own X11 `WM_CLASS`, backed by a `.desktop` file installed through `deb.fpm` | `main/island.ts#withDesktopName`, `ISLAND_DESKTOP_NAME`, `build/zumibot-island.desktop`, `electron-builder.yml` | X11 only. A harmless no-op on macOS (the `fpm` extra is already scoped to the `deb` target, so it cannot leak into a mac build); the comments should say so, and the island's dock/Mission Control behaviour on macOS comes from D2 and D7 instead |
| D4 | **Done:** `setLoginItemSettings` off Linux; macOS 13+ passes no args, so a packaged start with `wasOpenedAtLogin` is quiet too. Not yet tried at a real login. Was: start at login writes `~/.config/autostart/zumibot.desktop` | `main/autostart.ts`, called from `main/index.ts#applyAutostart` with `exec: process.env.APPIMAGE ?? process.execPath` | Writes a file nothing on macOS reads, so the setting silently does nothing. Fix: on darwin use `app.setLoginItemSettings({ openAtLogin, args: [HIDDEN_FLAG] })`; keep `syncAutostart` as the pure Linux writer and pick between them in `applyAutostart`. `wantsHidden(argv)` already works either way |
| D5 | **Partly:** 18 px on darwin; still the colour icon, not a template image. Was: the tray image is the app icon resized to 24×24 | `main/index.ts#createTray`, `electron.vite.config.ts` (`build/icon.png` → `out/main/tray.png`) | A 24 px colour bitmap in the macOS menu bar renders oversized and ignores the menu-bar appearance. Fix: ship a monochrome template image (16 pt, with an @2x), `nativeImage.setTemplateImage(true)` on darwin, and keep the colour icon for Linux |
| D6 | `build/` holds only `icon.png` | `zumi-bot-desktop/build/` | No `.icns`. electron-builder can derive one from a ≥512 px png, but the dmg/zip targets should ship an explicit `build/icon.icns` so the Dock and dmg background are not a guess |
| D7 | **Done:** `activate` shows the main window; the Dock icon stays (no `app.dock.hide()`). Was: no `activate` handler and no Dock handling | `main/index.ts` | With the window closed the app lives on in the tray (right for macOS), but clicking the Dock icon reopens nothing. Fix: `app.on('activate', () => showMain())`, and decide whether the Dock icon is hidden while only the island is up (`app.dock.hide()`), which also keeps the island off the Dock without D3's WM_CLASS trick |
| D8 | **Done:** `mac` (dmg, arm64 and x64), `hardenedRuntime`, `build/entitlements.mac.plist`, `NSMicrophoneUsageDescription`; CI signs ad-hoc (`-c.mac.identity=-`). Notarization still waits on an Apple account. Was: `electron-builder.yml` has a `linux` block only | `zumi-bot-desktop/electron-builder.yml` | No mac targets. Phase 4 adds `mac` (dmg + zip, `arm64` and `x64`), `build/entitlements.mac.plist`, `hardenedRuntime`, notarization wired to env vars, and a `build:mac` script |
| D9 | `extraResources` copies the whole backend `dist` plus `playwright-core` | `electron-builder.yml` | `playwright-core` only serves the Linux-only browser tools. Checked: the package holds no Mach-O binaries (JS, one `.wasm`, and shell scripts including a Linux `lib/xdg-open`), so it is 14 MB of dead weight on macOS rather than a notarization risk. Fix: leave it out of the mac targets |
| D10 | `npm run e2e -w zumibot` builds with `electron-builder --linux --dir` | `zumi-bot-desktop/package.json` | The desktop e2e cannot run on macOS as written; Phase 4 needs a `--mac --dir` variant, and it has to be run on a Mac |
| D11 | **Checked on an Intel Mac (macOS 15, Electron 45):** the ad-hoc signed, hardened-runtime bundle verifies (`codesign --verify --deep --strict`), and `ELECTRON_RUN_AS_NODE` starts the Local server and spawns `claude` from it. Notarization not tried. Was: nothing says how the app is signed | — | Two things to verify on real hardware: that `ELECTRON_RUN_AS_NODE` still works from a signed, hardened-runtime bundle (the child inherits the app's entitlements, and Electron needs `com.apple.security.cs.allow-jit`), and that notarization passes with the whole `extraResources` tree signed. Credentials come from env vars only, never committed or logged, and an unsigned build must still run for local testing |
| D12 | `Menu.setApplicationMenu(null)` | `main/index.ts#start` | **Done.** Not in the first audit: on a Mac the Edit roles live in the app menu, so with none Cmd+C/V/X/A/Z did nothing in any text field, nor Cmd+Q/H. darwin gets `macMenuTemplate` (`appMenu.ts`): About/Hide/Quit (Quit runs `requestQuit`, the close checks), the Edit roles and Window, still no Reload or DevTools |
| D13 | The switch shortcut is Ctrl+Shift+S | `main/switchTrigger.ts`, the picker and error pages | **Done.** Cmd+Shift+S on darwin (`isSwitchShortcut(input, mac)`), and the pages say so (`.switch-key`) |

### Windows: native

The server runs natively on Windows (the desktop's Local mode starts it there, see [Desktop shell](desktop-shell.md)).
Tested on Windows 11 with Node 26 and Claude Code 2.1.329 installed through npm: a chat, a Bash call, an approval card,
`busy`, and stopping and killing the shell. What differs from Linux, and where:

- **IPC.** Windows has no socket files. The seven MCP bridges get their address from `ipcEndpoint` (`core/ipc/ipcEndpoint.ts`):
  a fresh `\\.\pipe\zumibot-<letter>-<24 hex>` on Windows, the private `/tmp/cb-<letter>-XXXXXX/s` (0700 folder, 0600
  socket, uid check) elsewhere. A pipe has no mode bits, so its unguessable name and the token handshake every bridge
  already does are what guard it. The control channel is `controlPath(dataDir)` (`control.ts`): `control.sock` in the
  data dir, or a pipe named from a hash of the lowercased data dir, so the desktop, `busy` and a second server all find
  the same one. `staleIpcDirs` has nothing to sweep there (pipes end with their server).
- **Finding claude** (`claudeLocator.ts`). PATH splits on `;` (`pathOf` reads it whatever the key's case: a copy of the
  Windows env keeps `Path`). In each folder `claude.exe` (the native installer, also `~\.local\bin`) or an npm
  `claude.cmd` shim, resolved to the exe it runs (`shimTarget`): Node cannot spawn a `.cmd` without a shell, and a shell
  would mangle a turn's JSON arguments. No login-shell fallback: a `bash` there is WSL's or Git Bash's. Codex and ACP
  agents use the same rules; a shim that runs a script through node has no exe and is not found.
- **PATH for runs** (`shellEnv.ts`). Never asked of bash on Windows: it would hand back Linux or `/c/` paths. The run env
  folds every spelling of `Path` into one `PATH`.
- **Console windows.** `hideChildWindows` (`windowsHide.ts`, called first in `main.ts`) sets `windowsHide` in
  `ChildProcess.prototype.spawn`, which spawn, exec, execFile and fork all end in: the server runs under Electron's GUI
  exe, so every console child would otherwise open a window.
- **Ending processes** (`core/procKill.ts`). No signals or groups: `signalGroup` is `taskkill /T /F` on the leader's
  tree there (signal 0 asks the leader), and a stopped claude or codex turn ends its tree the same way at once, instead
  of a SIGINT that would be TerminateProcess on claude alone. A child of the server is killed through `signalChildGroup`
  (the ACP runner and probe, the extensions probe, `claudeCli`, `cli.ts`), which on Windows kills nothing once node saw
  the child exit (signal 0 then answers ESRCH): node closes the child's handle at the exit, which frees its pid, and
  Windows gives a freed pid to the next process at once, so a `taskkill /T` by it ended a stranger's tree (a test's fake
  CLI on the other worker, in CI) and could not reach the dead child's orphans anyway. Background processes run in Git Bash (`defaultBash`:
  `CLAUDE_CODE_GIT_BASH_PATH`, else next to `git.exe`), the shell Claude Code's own Bash tool uses there. A command's
  own background jobs (`sleep 300 &`) escape `taskkill /T`: Git Bash starts each from a forked bash that has already
  exited, so no Windows parent link leads to them. So each background process gets its id in `ZUMIBOT_PROCESS`, which
  every descendant inherits, and `endTree` also kills (Git Bash `kill`, then `taskkill /T` for native children) every
  Git Bash process whose `/proc/<pid>/environ` carries it (`processTree.ts`). The same tag ends a crashed server's
  leftovers at the next start, which Linux does through `/proc` identity.
- **Paths.** `isInside` (`fsutil.ts`) checks containment through `path.relative`, which ignores case on Windows as NTFS
  does; the channels' file guard uses it. `chatFiles.ts` (shared, so string-only) takes drive paths with either slash and
  compares them without case, so the Files panel and Restore work. Scratch folders keep the home's separator
  (`scratchChild`). A worktree's `node_modules` link is a junction: a symlink needs admin rights or Developer Mode. Git
  reads a junction as a folder, so a `node_modules/` pattern ignores it and the top one is linked too. Git prints its
  top folder as `C:/x`: `topOf` (worktrees and the Changes panel) resolves it to `C:\x`, so a worktree's stored paths and
  the chat's cwd share one form. An ACP command found on PATH must be an `.exe` (or a `.cmd` shim's): npm puts a bare
  `<name>` sh script beside its shim, which Node cannot spawn.
- **Files.** `writeFileAtomic` retries a rename that a reader (indexer, antivirus) blocks with EPERM/EBUSY/EACCES.
  Uploaded names lose what NTFS cannot hold (`storableName`: `< > : " | ? *`, trailing dots, CON/NUL...). Mode bits and
  `chmod` are no-ops; the profile's ACL is what keeps other accounts out. A Local update unpacks with paths relative to
  the builds folder: Git for Windows' GNU tar, first on PATH under Git Bash, takes `C:\...` for a remote host.
- **CLI hooks** run in Git Bash, so they stay `sh`. The vault guard adds the Windows spellings of its paths (JSON's
  doubled backslashes, forward slashes, `/c/...`). Its deny rules, the connectors guard's (`connectorsGuard.ts`) and Zumi
  Bot's own file rule (`zumiBotDenyRules`) use the `//c/...` form Claude Code matches Windows paths in; a `/C:\...` rule
  never matches. Git for Windows ships grep 3.0, which aborts on `-iF` and mismatches `-F` patterns holding a backslash,
  so on Windows `tr` lowercases the call and turns `\` into `/` and the patterns match that. That backslash is written as
  octal `\134`: a doubled one reaches Git Bash halved through a Windows command line, and tr's warning would join the
  block text. `windowsPort.test.ts` runs the real hook in Git Bash. The pause hook was not exercised on Windows.

Still Linux-only on Windows, as on macOS: computer use, the agent browser, the sandbox and container isolation, the
freedesktop trash (`trash.ts`), rsync Sync and the systemd installer. The data folder keeps its XDG default
(`~\.local\share\zumibot`). A dropped connection on an oversized upload reads as a network error rather than 413
(Windows resets the socket when the server answers before reading the body).

**Tests on Windows.** `npm test` runs there too (`.github/workflows/test.yml` runs it on Linux, Windows and macOS); run
it from Git Bash, since the hook tests need its `sh`, `tr` and `sleep`. Tests of the Windows behaviour above take the
platform as an argument, so they run everywhere. What keeps the rest platform-neutral:

- Fake CLIs come from `tests/support/fakeBin.ts`: a `#!/bin/sh` wrapper on POSIX, and on Windows a copy of a tiny
  launcher exe (`fakeBinLauncher.cs`, built once per machine with the `csc.exe` of .NET Framework, which every Windows
  has) beside a `.launch` file naming the command. Fakes with logic of their own are small node scripts, not `sh`.
- Mode-bit assertions are guarded (`process.platform !== 'win32'`). File symlinks skip without the privilege
  (`symlinksWork` in `tests/support/platform.ts`); folder links are junctions there. Signals, `/proc`, process groups
  and socket files skip on win32 with a one-line reason.
- Whole files of a Linux-only feature (above) are excluded off Linux in `backend/vitest.config.ts` (`LINUX_ONLY`);
  files that only touch one gate single tests with `skipIf(process.platform !== 'linux')`.
- Starting a process costs far more on Windows, and many tests run fake-CLI turns against wall-clock deadlines. So
  there vitest uses half the cores, and the deadline-heavy files (`WINDOWS_SERIAL` in `backend/vitest.config.ts`: the
  `*Probe` files and the extensions probe) run after the rest, one at a time, as the `backend-serial` project. That
  project runs on every platform with the files that start a real Chrome (`REAL_BROWSER`): beside a full parallel run
  their commands missed a deadline on Linux too (WSL with 10 workers, a 2-core CI runner), never when run alone. On a
  machine busy with other work some of them still miss a deadline; each passes when run alone. Defender's real-time
  scanning of the temp folder (on by default on a PC, off on the GitHub runner) makes a full local run on Windows flaky
  in a different place each time (`EBUSY`, `EPERM` spawning, timeouts); an exclusion for the repo and `%TEMP%` (an
  administrator's choice) or the CI run is the reliable read.
- `.gitattributes` pins LF, since `core.autocrlf` (on by default there) breaks byte-exact tests and the shell scripts.

**Tests on macOS.** `npm test` passes on a Mac after `npm run build:server`, as in CI (`macos-15`, Apple silicon; also
checked on an Intel Mac, macOS 15, Node 22; the two start-time lock tests need B1). What differs from Linux:

- No `/proc`: tests that read it (`procTree`, open-file counts in `http/streams`, the ACP tree tests, the desktop ask probe's
  leftover check) skip off Linux, the same gate as Windows but `!== 'linux'`. A child's pgid comes from `ps -o pgid=`.
- No `setsid` command: a fake that needs a grandchild in a session of its own spawns it from node with `detached: true`.
- `tmpdir()` is `/var/folders/…`, a link to `/private/var/…`, and a child's `process.cwd()` reports the latter: realpath a
  temp root a test compares with a child's cwd.
- Only `127.0.0.1` is on the loopback interface (a connect to `127.0.0.2` hangs), so "an address nothing listens on" is
  `::1` there. The Unix socket buffer is small, so a server that cuts a long line mid-write gives the writer `EPIPE`.
- Timing: like Windows, vitest uses half the cores and a 30 s cap per test on darwin (`DARWIN_TIMEOUTS` in
  `backend/vitest.config.ts`, the shared and desktop configs). Deadlines meant to fall after a fake's start are longer on
  darwin where a file already widens them for Windows (`START_MS`), and a wait on a watched folder is longer (file events
  arrive later than inotify's). Linux assertions and deadlines are unchanged.

## The claude CLI in a container

The server shells out to the `claude` CLI per turn and needs it **installed and signed in on the same machine, as
the same user the server runs as** (`core/chat/claudeLocator.ts`, `core/chat/shellEnv.ts`). In a container that
means signing in inside the container; the host's login does not travel.

**Where the CLI's state lives (Claude Code docs, checked 2026-11-16).**

- On Linux, the login is `~/.claude/.credentials.json`, file mode `0600`.
- On macOS it is the **encrypted Keychain** instead, with `~/.claude/.credentials.json` only as a fallback when the
  Keychain rejects the write. So bind-mounting a Mac host's `~/.claude` into a container carries no login.
- On Windows it is `%USERPROFILE%\.claude\.credentials.json`, protected by the profile's ACL.
- Account details, personal MCP servers and per-project trust are in **`~/.claude.json`**, which sits *outside*
  `~/.claude`. Mounting a volume at `~/.claude` alone is not enough: the file is discarded with the container's home
  and the CLI repeats first-launch setup.
- `CLAUDE_CONFIG_DIR` moves both the directory's contents and `.claude.json` under one path, and keys the macOS
  Keychain entry to it.

**What ZumiBot requires of that path.** ZumiBot honours `CLAUDE_CONFIG_DIR` for the user `settings.json`,
skills, `.claude.json`, `agent-memory/` and the auto-memory switch (`core/extensions/extensionsService.ts:165`,
`core/extensions/settingsFile.ts:200`, `core/memory/memoryStore.ts#memoryRoot`, `app.ts:433`), but it joins two
paths from `HOME` regardless: the agents folder (`config.ts` → `$HOME/.claude/agents`, overridable with
`ZUMIBOT_AGENTS_DIR`) and the CLI's session logs it reads for the cost baseline (`app.ts:193` →
`$HOME/.claude/projects`). So the container must set

```
CLAUDE_CONFIG_DIR=$HOME/.claude
```

— exactly the home `.claude`, not somewhere else. That value is a no-op for every path ZumiBot joins from `HOME`
and still pulls `.claude.json` inside the mounted volume, so one volume at `$HOME/.claude` holds the login, the
settings, the agents, the memories and the session logs. Any other value splits ZumiBot's view from the CLI's.

**Signing in, with no browser in the container.** Run the CLI interactively as the server user and use the printed
login URL on any device, then paste the code back:

```sh
docker compose exec -u zumibot zumibot claude   # sign in, then exit
```

The docs note that in a container the browser may not open, or may sign in and then show a `localhost` error; the
URL printed above the paste prompt is the one to use. This is the same shape as the Codex device-code step already
in the old VPS runbook.

**Unattended alternatives**, for a host with no interactive step:

- `claude setup-token` on a machine that *has* a browser prints a one-year OAuth token; pass it as
  `CLAUDE_CODE_OAUTH_TOKEN` at run time (an env file or `-e`), **never** `ENV` in the Dockerfile, where it would be
  baked into an image layer. It needs a Pro, Max, Ultra, Team or Enterprise plan, and it can only make model
  requests — no claude.ai connectors, no Remote Control.
- `ANTHROPIC_API_KEY` for Console/API billing, same handling.

Either way the secret never reaches a log, a URL, an error message or an image layer, which is the repo's standing
rule.

**Two container gotchas to carry into Phase 2.** A named volume mounted at a path the image never created is owned
by `root`, so the non-root user cannot write it: create `$HOME/.claude` with the right owner in the Dockerfile
before the volume is declared. And the Dev Container feature always installs the newest CLI, which is wrong here:
ZumiBot relies on hidden CLI flags (`--resume-session-at`, `--fork-session`) that `npm run e2e` checks, so the
image pins `npm i -g @anthropic-ai/claude-code@X.Y.Z` and sets `DISABLE_AUTOUPDATER=1`, and a version bump is a
deliberate change followed by `npm run e2e` (see [e2e.md](e2e.md)).

## Phase 1: first-run setup in the browser

A vps server with no password or TOTP serves a setup wizard instead of exiting, so a new operator never has to run a
CLI command on the box. Nothing in the sign-in path changed: the wizard stores exactly what `set-password` and
`setup-2fa` store, through the same two functions.

### The setup server

`backend/src/setupServer.ts#startSetupServer` resolves `null` when `setupNeeded()` is false, so the caller can always
just ask. Otherwise it takes the data lock, generates the one-time code, and listens on `127.0.0.1` at the same
`ZUMIBOT_PORT` the app will use. **It builds nothing else** — no hub, no agent store, no chats, no schedulers, no
static app — which is what makes "answers nothing except the setup page and its calls" true by construction rather
than by a list of guards:

| Request | Answer |
|---|---|
| `GET /setup`, `/setup.js`, `/setup.css`, `/login.css`, `/favicon.png` | the wizard |
| `GET /api/setup/state` | `{step}` — no secret in it, so no code needed; it only tells a reloaded page where to resume |
| `POST /api/setup/{password,totp/start,totp/confirm,check,finish}` | the wizard's calls, each needing the one-time code |
| any other `GET`/`HEAD` | `302` to `/setup` |
| any other method | `404` |
| a WebSocket upgrade | the socket is destroyed; there is no hub to attach it to |
| anything, after `finish` | `503` with `Retry-After: 1` |

`cli.ts#serve` drives the handover: `startSetupServer`, then `waitForSetup` (which races the wizard against
SIGTERM/SIGINT so a server nobody finishes setting up still stops cleanly), then `startServer` on the freed port.
The data lock and the port move across in that gap, and the wizard's last screen polls `/login` until the app
answers before it sends the browser there, so the operator sees one page turn into the sign-in page. `startServer`
keeps its own `NEEDS_AUTH` throw as a backstop for a caller that skipped this.

### The one-time code

80 bits as 16 base32 characters in groups of four (`auth/setupCode.ts`), printed to the server's **own stdout** at
start, beside the URL to open:

```
LISTENING 4317
ZumiBot is not set up yet. Open https://zumibot.example.com/setup
Setup code: K4TQ-7ZJM-2WXE-5RBD
The code is only in this server's memory: it is gone once setup finishes, or if the server restarts.
```

Only its sha256 is kept, in a closure, so it is in no file, no journal entry of its own beyond that one line, and no
error message; a restart prints a new one and the old one stops working. This is the one place a secret is written to
stdout on purpose: it is the only channel a fresh server shares with its operator, and everything else about it is
scoped to make that safe. On systemd it lands in `journalctl -u zumibot`; under Docker in
`docker compose logs zumibot`. The wizard names both.

Every setting call checks, in this order: our own `Origin` (`ZUMIBOT_ORIGIN` is still required, and still the only
accepted origin), the per-IP rate limit, the code, then the step. The limiter is the same `createLimiter` sign-in
uses — free for two failures, then 1s, 2s, 4s… to 60s, locked 15 minutes at the tenth — on its own instance, so
fumbling the code cannot lock the operator out of the sign-in they are about to do. A failure is booked *before* the
compare, so a burst of parallel guesses cannot all pass the check before one is recorded.

### The steps

`auth/setupState.ts` is a pure table of what the current step allows, and it carries the security properties:

- **A stored password is never replaced here.** If the operator already ran `set-password`, the wizard resumes at the
  authenticator step and `POST /api/setup/password` answers `409`. A leaked code cannot take the account over.
- **A stored TOTP secret is never re-enrolled.** Once confirmed, `totp/start` and `totp/confirm` answer `409` too.
- **`finish` needs both**, so the code can never drop the setup routes on a server that still has no way in.
- **`check` is allowed at every step**, because it only reads.

What the operator sees: the setup code and a password (16+ characters, the same `passwordProblem` rule the CLI
applies); then a QR code and the secret behind it, confirmed with one 6-digit code whose step is stored as `lastStep`
so it cannot be replayed to sign in; then ten recovery codes, shown once, behind an "I have saved these codes"
checkbox; then the `claude` CLI check; then Finish.

Mistyping the password is the one thing the wizard cannot undo — the step is done once it is stored. Fix it with
`zumibot-server set-password`. Reloading mid-wizard asks for the code again (it is only in a page variable) and
resumes at the first unfinished step; reloading after the authenticator step means the recovery codes are gone, and
the page says to run `zumibot-server setup-2fa` for a new set.

### The claude CLI check

`core/claudeStatus.ts` splits looking from deciding: `probeClaude` reads the disk, `describeClaude` is pure. It
reports found/not-found from `locateClaude` (honouring the `claudePath` in `settings.json`), and ready/not-ready from
the `oauthAccount` in `~/.claude.json` (`parseProfile`, the same thing the rail's Usage popover reads — no token, no
CLI run, no model call), else a credential variable in the server's own environment, named and never valued. A
not-ready answer carries the commands to run and the user to run them as; "Check again" re-reads. It never blocks
Finish, and it never claims more than it checked: the wording says outright that a key or the macOS Keychain is
invisible to it and replies will still work.

### Tests

- Pure, in `backend/tests/auth/`: `setupCode.test.ts` (shape, uniqueness, hash-only, every spelling of the code,
  every malformed guess), `setupState.test.ts` (the step mapping and the whole allow table, each security property
  named), `setupSteps.test.ts` (the two shared saves: the NFKC rule, a usable sign-in, sessions revoked, ten
  single-use recovery codes, the burned confirmation code), and `tests/core/claudeStatus.test.ts`.
- HTTP, through `tests/http/helpers.ts#startSetupRig`, which starts the **real** setup server on a temp data folder
  and exposes the printed code: `tests/http/setupRoutes.test.ts` covers what it prints, that the code reaches no
  file, the 302/404/503/405 answers, the refused WebSocket, origin checks, the rate limit, every step guard, and that
  the sign-in it leaves behind works. `tests/http/setupPage.test.ts` keeps the page CSP-clean and free of storage.
- End to end: `npm run e2e:setup` (`e2e/setup.e2e.mjs`) walks the wizard in Chrome on a fresh data dir — wrong code,
  short password, mistyped repeat, wrong 6-digit code, the QR and secret, ten recovery codes, the CLI check going
  from "sign in" to "signed in as", Finish, the handover, and a real sign-in with what the wizard set. The harness
  takes `setup: false` for this and exposes `setupCode` and `waitForOutput`.

### What it does not change

The server still binds `127.0.0.1` only. `ZUMIBOT_ORIGIN` is still required in vps mode and still the only accepted
origin, including for the setup calls. There is no default password, no way to skip 2FA, and no setup without the
one-time code. The setup calls are plain HTTP routes like `/api/login`, not WebSocket RPC, so `ZumiBotApi`,
`rpc/handlers.ts` and `net/api.ts` are untouched. For an existing install nothing changes: a server that already has
a password and TOTP never starts a setup server, and the two CLI steps (`set-password`, `setup-2fa`) still work exactly as before —
they are now optional, not required.

## Phase 2: Docker

**Preview:** the Docker install is labelled a preview because it has not been proven on many real hosts yet. The
label is only that: the installer, the image and the checks below are what ship.

On a host with Docker and `curl`, the installer is the whole install:

```sh
curl -fsSL https://zumibot.run/releases/latest/docker/install.sh -o install.sh
less install.sh
sh install.sh                      # or: --domain zumibot.example.com, or --origin https://<this-machine>.<tailnet>.ts.net:8443
```

It pulls a ready-made image, so nothing is built on the host. It prints the `/setup` address and where the one-time
code is; see "The one-line installer" below. With `--domain`, an `A` (and `AAAA`) record must already point at the
host, ports 80 and 443 must be free and reachable, and the host clock must be synced: the container shares it, and
TOTP needs it.

**From a source checkout**, to build the image from the code you have (no release needed):

```sh
cp .env.example .env     # set ZUMIBOT_DOMAIN
docker compose up -d --build
docker compose logs zumibot     # the one-time setup code
```

then open `https://<your domain>/setup`. The two paths share the compose file's shape, the two profiles and the
volumes below; they differ only in where the image comes from.

### The topology

Caddy runs **in the server's own network namespace** (`network_mode: "service:zumibot"`), so it reaches the server
at `127.0.0.1:4317` while the server still binds nothing but loopback. Caddy is the only listener, exactly as on the
VPS. Docker will not let a container that joins another's namespace publish ports, so the namespace owner — the
`zumibot` service — is where `ports:` lives, and Caddy listens on them from inside.

Inside that shared namespace, the two Caddyfiles turn off things that would otherwise be reachable from the server's
own container, where agents run arbitrary `Bash`:

- **`admin off`**, or Caddy's admin API would answer on `127.0.0.1:2019` and an agent could rewrite the only
  listener. Configuration comes from the mounted Caddyfile plus `docker compose restart caddy`.
- **`auto_https disable_redirects`** in the local profile, so Caddy opens no `:80` at all. In the domain profile `:80`
  stays: it answers the certificate challenge and redirects to https.

A check inside the running container, with the local profile up, shows exactly two listeners —
`0.0.0.0:8443` (Caddy, published to `127.0.0.1` on the host only) and `127.0.0.1:4317` (the server).

### The image

`Dockerfile`, three stages, all on `node:22-bookworm-slim` **pinned by digest** (`scratch` for the middle one).
`build` copies the manifests, runs `npm ci --ignore-scripts` (nothing here needs an install script, and it keeps
Electron's postinstall from fetching a ~100 MB binary this image never runs) and then `npm run build:server`.
`dist` is `FROM scratch` and holds only `backend/dist`, as a stage of its own so a release can swap it (below). The
runtime stage installs `git` (the git chip and worktrees), `tzdata` (routines and workflows schedule in the user's
zone) and `ca-certificates`, then the `claude` CLI **pinned** to `CLAUDE_CODE_VERSION` (2.1.325; a source build can
override it with `ZUMIBOT_CLAUDE_VERSION` in `.env` — namespaced so a stray `CLAUDE_CODE_VERSION` in the host's shell
cannot change the pin), with `DISABLE_AUTOUPDATER=1`. It copies `dist` to `/app`, adds a
`/usr/local/bin/zumibot-server` wrapper so documented CLI steps read the same as on a VPS, and runs as
**uid 10001 `zumibot`**. About 620 MB, most of it the base image and the CLI.

**Where the image comes from.** A source checkout builds it from the Dockerfile as it stands. A release does not
build the server a second time: the `image` job unpacks the signed tarball and builds with
`--build-context dist=<tarball>/zumibot-server/app`, which replaces the `dist` stage, so BuildKit never runs `build`
and the image holds exactly the bytes that were signed. It is `docker.io/mhdaljuboori/zumibot` on Docker Hub, for
`linux/amd64` and `linux/arm64`, pushed by digest with no tag first. The version tag and `latest` are added only after
the bundle that names that digest is signed, so a tag never points at an image no signed bundle names. The installer
never uses a tag: the bundle's `docker-compose.yml` has the source `build:` block replaced by
`image: docker.io/mhdaljuboori/zumibot:<x.y.z>@sha256:<digest>` (`bundleCompose` in `shared/src/dockerBundle.ts`, which
throws on any compose shape it does not know rather than ship a wrong file), because a tag can move and a digest
cannot. The release's CLI is the Dockerfile's pin: the release build passes no `--build-arg`.

Two details that matter:

- `CLAUDE_CONFIG_DIR=/home/zumibot/.claude`, **exactly** the home's `.claude`. ZumiBot joins the agents folder
  and the CLI's session logs from `HOME` whatever that variable says, so any other value would split its view from
  the CLI's; this value is a no-op for those paths and still pulls `~/.claude.json` inside the mounted volume. One
  volume then holds the login, the settings, the agents and the memories.
- `/data`, `/vault` and `/home/zumibot/.claude` are created **in the image, owned by 10001**. A named volume
  mounted over a path the image never created comes out owned by root, and nothing would be writable.

`init: true` gives the container a real init: the server spawns the CLI per turn, and an orphaned grandchild would
stay a zombie under node as pid 1. `stop_grace_period: 30s` is longer than the server's own 10-second shutdown, so
every reply is stopped and the data lock released before the kill. The `HEALTHCHECK` is `zumibot-server busy`,
which answers in the setup state too, so a container that is up but not yet set up still reads as healthy.

### The two profiles

One `.env` picks one, and `docker compose up -d` is the whole command either way (`COMPOSE_PROFILES` is read from
`.env`). Compose interpolates the whole file before it filters by profile, so a required-variable marker on the
domain would also fire for a local user; the domain therefore falls back to the reserved `zumibot.invalid`, which
fails obviously instead of ordering a certificate for a real host.

| | `COMPOSE_PROFILES=domain` | `COMPOSE_PROFILES=local` |
|---|---|---|
| Services | `zumibot`, `caddy` | `zumibot-local`, `caddy-local` |
| Published | `80:80`, `443:443` | `${ZUMIBOT_LOCAL_PUBLISH:-127.0.0.1:8443}:8443` |
| Certificate | Let's Encrypt, HTTP-01 on port 80 | Caddy's own CA (`tls internal`) |
| Origin | `https://${ZUMIBOT_DOMAIN}` | `${ZUMIBOT_LOCAL_ORIGIN:-https://localhost:8443}` |

There is **no plain-HTTP mode**, public or otherwise: the session cookie is `Secure` and the origin check needs an
https origin. For the local profile that means Caddy's local CA, so a browser warns until its root is trusted:

```sh
docker compose cp caddy-local:/data/caddy/pki/authorities/local/root.crt ./zumibot-local-ca.crt
```

Reach it through an SSH tunnel (`ssh -L 8443:127.0.0.1:8443 you@host`, then `https://localhost:8443`) or over
Tailscale. For Tailscale the publish stays `127.0.0.1:8443` and `tailscale serve` on the host forwards the tailnet's
port to it:

```sh
sh install.sh --origin https://<this-machine>.<tailnet>.ts.net:8443     # first install; or set it in .env
tailscale serve --bg --tcp=8443 tcp://127.0.0.1:8443
```

then open `<origin>/setup` from any device on the tailnet. The origin is `ZUMIBOT_LOCAL_ORIGIN` in `.env`; to change
it later, edit `.env` and run `docker compose up -d` in that folder. Publishing on the tailnet IP instead
(the `100.x.y.z` address, in `ZUMIBOT_LOCAL_PUBLISH`) is not supported: on Colima that IP is on the Mac, not in the VM, so Docker
cannot bind it, and on Linux the bind fails at boot when `tailscaled` starts after Docker. `tailscale serve` is a TCP
forward, so Caddy still ends the TLS.

**The port is fixed at 8443**: compose publishes `${ZUMIBOT_LOCAL_PUBLISH}:8443` and `Caddyfile.local` listens on the
origin's own port, so any other port breaks. **The origin must be exactly what the browser types, port included**:
every write and the WebSocket upgrade are checked against it. Caddy's `tls internal` certificate follows the origin's
host, so the browser warns the same way as for `localhost`. `docker compose down -v` deletes `caddy-data`, which is
Caddy's local CA, so the root has to be trusted again after that.

### Volumes, and what to back up

| Volume | Holds | Back up |
|---|---|---|
| `data` → `/data` | chats, settings, attachments, `auth.json` | yes |
| `claude` → `/home/zumibot/.claude` | the CLI's login and session logs, the agent files, memories | yes |
| `vault` → `/vault` | `vault.key` alone | **yes, separately** |
| `caddy-data`, `caddy-config` | certificates and Caddy's state | no |

The vault key is in its own volume for the same reason it sits outside the data dir on a VPS: no copy or backup of
`data` ever carries it ([vault.md](vault.md)). Losing it means the vault can only be started empty. **`docker compose
down -v` deletes every volume, the key included.**

### Signing the claude CLI in

The server runs the CLI for every reply, as its own user, so the login has to be made **inside the container** —
a host login does not travel, and on a Mac host it is in the Keychain and cannot travel at all. The wizard's last
step says so, and reports what it found:

```sh
docker compose exec zumibot claude     # sign in with the printed URL, then exit
```

The container has no browser, so use the login URL shown above the paste prompt and paste the code back. It lands in
the `claude` volume and survives restarts and rebuilds. For an unattended host, `claude setup-token` on a machine
that has a browser gives a one-year token to pass as `CLAUDE_CODE_OAUTH_TOKEN` at run time — never `ENV` in the
Dockerfile, where it would be baked into a layer. The claude CLI section above has the details.

The same wrapper runs the other CLI commands:
`docker compose exec zumibot zumibot-server set-password | setup-2fa | busy | browser-check | desktop-check`.

### What is deliberately not in the image

Both are Linux-only features that need packages a server image should not carry, and both already say what is
missing rather than failing:

- **Computer use** (agent desktops) needs Xvnc, a light XFCE session, D-Bus, AT-SPI, fonts, a Firefox deb and
  cua-driver — see [computer-use.md](computer-use.md), whose list applies to a derived image.
  `zumibot-server desktop-check` prints what is found; without them the agent's Desktop view says so.
- **Agent browsers** need Chromium's OS libraries and a sandbox, plus a few hundred MB of browser downloaded by
  `zumibot-server browser-install` into the data dir — see [browser.md](browser.md). `browser-check` reports what
  is missing; text chats are unaffected. `playwright-core` itself does ship in the image (it is part of the bundle),
  so the feature is present but unprovisioned.

To add either, build a derived image `FROM docker.io/mhdaljuboori/zumibot:<x.y.z>` with those packages (a source build:
`FROM zumibot:local`); nothing in ZumiBot installs a package or needs sudo while it runs. Keep that Dockerfile in a
folder of your own and rebuild it for each release: the installer's folder is replaced on every update, so anything
kept inside it is lost, and the bundle's compose file names the stock image.

### Updating

Run the installer again (`sh install.sh`, or `sh ~/zumibot-docker/docker/install.sh`). It is the same command as the
first install, and it refuses while a reply is running. A source checkout keeps its own way:

```sh
git pull && docker compose up -d --build
```

Recreating the container sends the server SIGTERM, which stops every reply and releases the data lock inside the
30-second grace period. A source checkout has no "refuse while a reply is running" guard; the installer does (below).
`docker compose exec zumibot zumibot-server busy` says how many are running before you start.

A container install does not use `npm run sync`: it is for a VPS reached over ssh
([deploy-and-sync.md](deploy-and-sync.md)).

### The one-line installer

```sh
curl -fsSL https://zumibot.run/releases/latest/docker/install.sh -o install.sh
less install.sh
sh install.sh      # or: --domain zumibot.example.com, or --origin https://<this-machine>.<tailnet>.ts.net:8443
```

Download, read, run, the same shape as Phase 3 and for the same reason. The URL is the showcase site's copy of the
installer taken out of the latest release's Docker bundle (see [Updates](updates.md)), so it is the one that release
shipped, and nothing about it reads the repository.

`docker/install.sh` is for someone who has Docker and nothing else, and never reads a compose file, so every default
is the safe one. Its steps, in order:

1. **Checks the host.** `tar`, `mktemp`, `docker`, the compose plugin at 2.17 or newer, and a reachable daemon; for a
   download also `curl` and `sha256sum` or `shasum` (a Mac has the second). An older compose ignores
   `depends_on: restart: true`, which would strand Caddy in a dead namespace after a server restart. On a Mac
   (`uname -s` says `Darwin`) a missing `docker` or an unreachable daemon names Docker Desktop, OrbStack or Colima
   instead of Docker Engine and the `usermod -aG docker` line, and the script uses no GNU-only flags (see "Mac
   hosts" below).
2. **Picks the profile.** `local` unless `--domain`. `--domain` takes a bare host name (no scheme, port or path, no
   IP) and turns on the `domain` profile, which opens 80 and 443. An unresolvable name is a warning, not a failure,
   because DNS may still be propagating. `--origin https://HOST:8443` is the loopback profile's other form, for
   Tailscale: https only, the port exactly 8443, no path, a host of letters (lowercased first, so uppercase is
   accepted), digits, dots and dashes, with no leading, trailing or doubled dots; it is written as `ZUMIBOT_LOCAL_ORIGIN` while the publish stays `127.0.0.1:8443`, and `--domain` together with it is
   refused. An existing `.env` decides the profile instead, and `--domain` or `--origin` over one that says something
   else is refused rather than silently rewriting it.
3. **Downloads the bundle.** The version comes first (`--version`, else `<site>/releases/latest.json`), since the
   signature binds it; `zumibot-docker.tar.gz` and its `.sig` then both come from `<site>/releases/<x.y.z>/`, so a
   site deploy in between cannot mix two releases. The site is `$ZUMIBOT_UPDATE_URL` (default `https://zumibot.run`,
   https only). A release with no bundle (every one from before this install existed) gets a plain message saying so,
   not a bare curl error. `curl --proto '=https' --tlsv1.2`, so a redirect cannot drop to http. **No downgrades:**
   before downloading anything, a release older than `<dir>/VERSION` (when that is a plain `x.y.z`) is refused with
   "which is older than the … already in `<dir>`". `latest.json` is not signed, so a tampered site could otherwise name
   an older signed release and roll a server back to it. The same version is a repair and passes. Going back on
   purpose is the `.prev` rollback below, or `--bundle` with a file you trust. A source-built install has no
   `VERSION`, so its first update is not checked.
4. **Checks the signature**, in a container, so the check needs nothing on the host but `docker` (a Mac has an old
   LibreSSL and no `node`; only the sha256 is taken on the host, with `sha256sum` or `shasum`). The container is the Dockerfile's own pinned base,
   `node:22-bookworm-slim@sha256:e9f5…21ee`, run with `--network none --read-only --user 65534:65534`; the public key
   (`RELEASE_PUBLIC_KEY`, the same string as in `shared/src/update.ts`), the version, the sha256 and the signature go in
   by env, never into the script text. The signed text is `zumibot-docker\n<version>\n<sha256>\n`. Anything short of a
   good signature refuses, and nothing is installed.
5. **Unpacks it** and checks the six files are there and that the `VERSION` inside is the signed one, so an older
   signed bundle cannot be served under a newer name.
6. **Hands over** to the bundle's own copy of `docker/install.sh`, with `--bundle`: the downloaded script only
   fetched and checked, so a fix to the install steps ships with the release it belongs to. A `--bundle` you bring
   yourself is used as it is, unchecked: you vouch for it.
7. **Writes `<dir>.next`** (default `<dir>` is `~/zumibot-docker`; a leftover `.next` from an interrupted run is
   removed first). A first run writes `.env` with `umask 077`; an update copies the existing one in untouched.
8. **Pulls the images first**, from `.next`, by digest. A slow or failed pull never leaves the server down: it removes
   `.next` and changes nothing.
9. **Refuses while a reply is running, then swaps and starts.** On an update of a running install (the profile's
   service container is up) it asks `zumibot-server busy` of that service
   (`zumibot` or `zumibot-local`) and refuses on a count above zero, or on a count it cannot read, unless `--force`.
   Then `<dir>` becomes `<dir>.prev` and `.next` becomes `<dir>`, and `docker compose up -d --remove-orphans` runs;
   it waits up to 60 seconds for the server and warns, with the log command, if it does not answer. A failed second
   move puts the old folder back.

Options: `--domain HOST`, `--origin URL`, `--dir PATH` (or `ZUMIBOT_DOCKER_DIR`), `--version X.Y.Z` (the site keeps only the latest
release, so an older one may have no bundle), `--bundle PATH`, `--force`, `--help`. `--version` and `--bundle` do
not go together: a bundle is already one release.

**The hand-off.** It ends by printing where to open `/setup` (the https address for a domain; for loopback with the
default origin, the SSH tunnel line, a note that Caddy's own CA makes the browser warn, and how to use Tailscale
instead: `--origin https://<this-machine>.<tailnet>.ts.net:8443` on install, or set `ZUMIBOT_LOCAL_ORIGIN` in
`<dir>/.env` and run `docker compose up -d` there; with a tailnet origin, the `tailscale serve --bg --tcp=8443
tcp://127.0.0.1:8443` line to run on the host), where the one-time code is
(`docker compose logs <service>`, never the code itself, as `install.sh` prints the journal command), the one-time
`docker compose exec <service> claude` sign-in, and how to update. It says plainly that the install is a preview.

**Rollback.** An update leaves the old project in `<dir>.prev`, and the installer prints the way back as one line:
`mv <dir> <dir>.failed && mv <dir>.prev <dir> && cd <dir> && docker compose up -d`. The old compose file names the old
digest, so this starts the old image. That line appears only when a `.prev` exists: a first install has none, and
prints a note that each update will keep one. The same line is in the message when `up -d` itself fails. Volumes are
named by the compose project (`name: zumibot`), not the folder, so neither the swap nor a rollback touches any chat.

**Mac hosts.** A spare Mac can be the server: Docker Desktop, OrbStack or Colima, reached over Tailscale. The
installer has what it needs there: hashing falls back to `shasum -a 256`, `getent` is optional, and the signature
check runs in a container. The image is multi-arch, so Apple silicon pulls arm64 and an Intel Mac amd64. A Mac is also
a good first real end-to-end check: pull, the wizard, the `claude` sign-in, a reply, then an update.

**Running it again** on the version already installed is a repair: `.env` is kept and a `.prev` is left. **Moving a
source install**: pointing the installer at a folder that holds a source-built install (full tree, `.env` with
`COMPOSE_PROFILES`, no `VERSION`) works as an update. `.env` is kept byte for byte, the busy check uses the service
that profile names, and the source tree goes to `<dir>.prev`. The image built on the host (`zumibot:local`) stays on
disk until you remove it; the volumes, and so every chat, carry over.

- **No sudo.** If the user can't reach the Docker daemon, it prints the `usermod -aG docker` line (on a Mac, which
  of Docker Desktop, OrbStack or Colima to start) and stops.
- **stdin is the script** under `curl | sh`, so every docker call gets `</dev/null`. Otherwise a command that reads
  stdin would eat the rest of the script. Nothing is ever piped into a shell.

`shared/tests/dockerSetup.test.ts` pins these promises as text, `dockerInstall.test.ts` runs the real script against
a fake `docker` and `curl` (`tests/fixtures/fake-docker.mjs`) and a bundle signed by a test key (a first install, an
update, a busy refusal, a bad signature, a release with no bundle, a repair, a source install, a leftover `.next`, a
failed pull, a failed move, `--domain` over a differing install; `--origin` on a first install, its bad values (another
port, http, no port, a path, a bad host, with `--domain`) and over an existing install; a download or `--version` older
than the installed release refused before anything is fetched, versions compared per number, and a `--bundle` going
back installing; the Mac daemon message), and `dockerBundle.test.ts` pins the bundle.

## Phase 3: installer for a host without Docker

```sh
curl -fsSL https://zumibot.run/releases/latest/install.sh -o install.sh
less install.sh
sh install.sh --origin https://zumibot.example.com
```

Download, read, run — the shape the NodeSource steps use, and for the same reason. The showcase site's server
scene shows these steps (`zumi-bot-site/src/serverInstall.ts`); change both together. The script does
work as `curl … | sh` for anyone who wants that, which is why it reads its one question from `/dev/tty` rather than
stdin, but the documented form is the one above.

### What it does, and refuses to do

`zumi-bot-server/deploy/install.sh`, POSIX `sh`, `set -eu`:

- **Refuses to run as root.** Agents run as the server's own user, the same rule the image follows.
- **Checks the host.** Node 22+ is a hard requirement (it prints the NodeSource steps, download-read-run, and
  stops). A missing `claude` CLI is a warning, not a failure: the server starts, and the wizard's last step says how
  to fix it.
- **Takes an https origin only**, with no path, query or credentials. `http://` is refused with the reason: the
  session cookie is `Secure` and every write is checked against this origin, so there is no plain-HTTP mode.
- **Takes only plain `--dir` and `--origin` values.** `--dir` must be absolute and use only `A-Za-z0-9._/:-`, and the
  origin's host only `A-Za-z0-9.:-`, checked before anything is written: both are written into
  `bin/zumibot-update` inside single quotes and into the unit and proxy configs through `sed`, which would read any
  other character as syntax.
- **Downloads the release and checks it** against `SHA256SUMS` and then the publisher's ed25519 signature before
  unpacking (see [Updates](updates.md), Release signing). The version comes first (`--version`, else
  `<site>/releases/latest.json`), since the signature binds it; the tarball, `SHA256SUMS` and
  `zumibot-server.tar.gz.sig` then all come from `<site>/releases/<x.y.z>/`. `RELEASE_PUBLIC_KEY` is pinned in the
  script (the same string as in `shared/src/update.ts`) and the check runs in `node` (already required), with every
  value passed by env. A missing `.sig`, a bad one, or a `VERSION` inside that is not the signed one stops the install
  before anything is written. A `--tarball` you bring yourself is not checked (the server's own update verifies the
  download before it hands it over). `curl --proto '=https'` (or `wget --https-only`) so a redirect cannot drop to http.
- **Installs nothing with sudo without asking.** The only privileged command is `loginctl enable-linger`, without
  which a user service stops at logout. It tries the unprivileged form first (polkit usually allows it for your own
  account from an active session), and only if that fails does it print the exact command and ask. Answer no and
  everything else still works. It installs no packages and never touches `/etc`.
- **Installs a systemd user service**, `~/.config/systemd/user/zumibot.service`, from
  `zumibot-user.service` in the verified tarball. Where there is no user instance of systemd it says so and
  prints how to run the server by hand instead, rather than reaching for the system manager.
- **Prints what is left**: the proxy step, the `/setup` URL, and `journalctl --user -u zumibot -n 20` for the
  one-time code. It never reads the code out of the journal itself — that would copy a secret into a second log.

The reverse proxy stays the operator's job, because installing one needs root. The script writes
`<dir>/proxy/Caddyfile` and `<dir>/proxy/nginx-zumibot.conf` with the host already substituted and points at
SETUP-VPS.md for the commands.

### Updating

Running it again is the update, and `<dir>/bin/zumibot-update` is the same thing with no arguments (it execs the
copy of the installer saved in `<dir>`). It swaps the build in place:

- The origin is read back from the installed unit, so an update needs no flags.
- It asks `<dir>/bin/zumibot-server busy` — the control socket — and **refuses while a reply is running**, with
  `--force` to interrupt. A call that fails means no server, which counts as idle; a call that succeeds but prints
  something that is not a number is `unknown` and also refuses, because a noisy shell must not read as idle. That
  distinction was learned the hard way.
- The live app is replaced whole and the old one kept: `app.next` is staged, then `rm -rf app.prev`,
  `mv app app.prev`, `mv app.next app`. A rollback is `mv app.prev app` and a restart, or `bin/zumibot-rollback`
  below, which also puts the data back.
- **`--snapshot-data`** keeps a copy of the data folder (`${ZUMIBOT_DATA_DIR:-~/.local/share/zumibot}`) in
  `<dir>/data.prev` after the new app is fully staged (`app.next`, `bin/` copied) and before the live app moves, so a new version that migrates the data can be undone.
  It is built in `data.prev.new` and renamed, so a half copy is never `data.prev`; if the copy fails (a second copy
  needs the room) the update stops with the running app untouched, and a new `data.prev` is never left beside an old
  `app.prev`. It leaves out `browsers`, `browser-runtime`,
  `claude-tmp`, `control.sock` and `server.lock`, and writes the version being replaced (from `<dir>/VERSION`, else
  `unknown`) to `data.prev/.zumibot-from`. No data folder yet (a first install) skips it, and drops an older
  `data.prev`. An update **without** the flag removes any older `data.prev` too, since it would pair with the new `app.prev` and put newer code on older data.
  The server stays up during the copy (it is idle, but a file can change under `tar`, which then fails the update; run
  it again).
- **Where it downloads from.** The showcase site, `$ZUMIBOT_UPDATE_URL` (default
  `https://zumibot.run`, https only): `<site>/releases/<x.y.z>/{zumibot-server.tar.gz,SHA256SUMS,zumibot-server.tar.gz.sig}`,
  the version taken from `--version` or `<site>/releases/latest.json`. The site's build re-publishes the latest GitHub release there
  (see [Updates](updates.md)), so no token is needed anywhere; the site keeps only the latest release, so an older one
  needs `--tarball`. The checksum and signature checks are the same as above. The self-copy fallback (no `install.sh` in the
  package) fetches `<site>/releases/latest/install.sh`.
- **It ships itself.** The release holds `install.sh` and `bin/zumibot-rollback`; the installer keeps the release's
  copy as `<dir>/install.sh` (so `zumibot-update` runs the matching installer) and the server can run the one it
  extracts, with `--dir <dir> --tarball <file> --snapshot-data [--force]`. The unit carries
  `ZUMIBOT_INSTALL_DIR=<dir>`, which is how the server knows it was installed this way.

### Service environment (drop-ins)

The unit file is rewritten whenever an update changes it, so a setting put in it can be lost. Put your own environment variables in a systemd drop-in instead: `systemctl --user edit zumibot` creates `~/.config/systemd/user/zumibot.service.d/override.conf`, where `[Service]` and `Environment=NAME=value` lines go, then `systemctl --user restart zumibot`. `install.sh` only rewrites the unit file, so the drop-in survives updates, and the in-app Update leaves it alone too. This is where `ZUMIBOT_CODEX_BIN`, `ZUMIBOT_BROWSER_EXECUTABLE_PATH`, the desktop program overrides and `ZUMIBOT_VAULT_KEY_FILE` go. The updater's own unit (`zumibot-updater-<stamp>`, see [Updates](updates.md)) does not read a drop-in; it is passed `ZUMIBOT_DATA_DIR` only.

### Rolling back

`<dir>/bin/zumibot-rollback` (no arguments; it finds `<dir>` from its own place and the data folder like the
launcher) undoes the last update. It refuses as root, and refuses, changing nothing, unless `app.prev` and `data.prev`
both exist (data without code, or code without data, would mix versions). Then: `systemctl --user stop zumibot`;
`data.prev` to `<data>.restoring` (a copy that dies half way, if `data.prev` is on another filesystem, leaves only a
stray `.restoring`), `app` to `app.failed`, `app.prev` to `app`, the data folder to `<data>.failed`, and last
`<data>.restoring` renamed to the data folder (one parent, so atomic);
`browsers/` and `browser-runtime/` moved back from `<data>.failed`; `.zumibot-from` removed and `<dir>/VERSION` set to
it; `<data>/update-rolled-back` written as `{"from":"<failed version>","to":"<restored version>"}` (the server shows
"rolled back" when it finds it at boot); `systemctl --user start zumibot`. The failed build and its data are kept
aside, never deleted (an earlier `.failed` pair is replaced). The user unit is left as the update wrote it. If a `mv`
fails the server stays stopped and the script prints the commands still to run, from the failed one on.
- A changed unit is rewritten, an unchanged one is left alone, so running it twice is quiet.

### The release artifacts

`zumi-bot-server/deploy/package.sh` (also `npm run package`) packs what the installer consumes, from an
already-built `backend/dist`:

```
zumibot-server.tar.gz
  zumibot-server/app/        the whole dist: server.mjs, login/ (with the wizard), web/
  zumibot-server/bin/        zumibot-server, the launcher that pins ZUMIBOT_DATA_DIR, and zumibot-rollback
  zumibot-server/install.sh  the installer itself, so the server can update itself from the release
  zumibot-server/systemd/    zumibot-user.service, with the two placeholders (origin, dir; the dir also as ZUMIBOT_INSTALL_DIR)
  zumibot-server/proxy/      Caddyfile and nginx-zumibot.conf templates
  zumibot-server/VERSION
SHA256SUMS
zumibot-server.tar.gz.sig   added by the release job's publish step, not by package.sh
```

It refuses to pack a build that is not whole, including the check the deploy added after an interrupted build once
served a blank page: every asset `web/index.html` names must exist. With GNU tar it packs reproducibly (sorted
names, fixed mtime, no owner), so the same build gives the same checksum.

The Docker bundle is packed by `deploy/docker-bundle.mjs` in the release's `publish` job, after `package.sh`:

```
zumibot-docker.tar.gz
  zumibot-docker/docker-compose.yml     the repo's, with the image named by digest instead of built
  zumibot-docker/docker/Caddyfile       and Caddyfile.local, the two proxy configs the compose file mounts
  zumibot-docker/docker/install.sh      the installer itself, which the downloaded copy hands over to
  zumibot-docker/.env.example
  zumibot-docker/VERSION
zumibot-docker.tar.gz.sig               added by release-sign.mjs
```

The list is `DOCKER_BUNDLE_FILES` in `shared/src/dockerBundle.ts`. Like `package.sh` it packs reproducibly with GNU tar.

`.github/workflows/release.yml` runs on a `v*` tag and nothing else, with no default permissions and three jobs.
- `build` (`contents: read`) checks out with `persist-credentials: false` (actions pinned by commit SHA, like every
  dependency here), installs with `--ignore-scripts`, **stops if the tag and the version in the workspaces disagree**,
  runs `npm run typecheck`, builds, runs `package.sh`, writes the notes (the tag's `CHANGELOG.md` section,
  `deploy/changelog.mjs notes`; a tag with no notes fails the job, never `--generate-notes`) and uploads the tarball,
  `SHA256SUMS` and the notes as an artifact.
- `image` (`contents: read`) downloads that artifact, unpacks the tarball, builds the multi-arch image from it
  (`--build-context dist=…`, see "The image") and pushes it **by digest, with no tag**, with the Docker Hub token. It
  passes the digest on as an output. No npm runs on its runner.
- `publish` (`contents: write`) installs nothing and runs no npm code. In order: it packs the Docker bundle
  (`deploy/docker-bundle.mjs`, which writes the image's digest into the bundle's compose file and adds the bundle's line
  to `SHA256SUMS`), signs **both** tarballs (`deploy/release-sign.mjs`, with the `RELEASE_SIGNING_KEY` secret; it
  checks both against `SHA256SUMS` before signing either, and fails when the secret is missing or is not the pinned
  key's pair), only then tags the pushed digest `<x.y.z>` and `latest` (`docker buildx imagetools create`, with the
  Docker Hub secrets), and creates the release with `zumibot-server.tar.gz(.sig)`, `zumibot-docker.tar.gz(.sig)` and
  `SHA256SUMS`. A last step posts to the `VERCEL_DEPLOY_HOOK` secret, which only that step's env carries, to
  rebuild the showcase site, skipped when the secret is unset.

The docker.io repository is the owner's to make, once: the account and the public repository `mhdaljuboori/zumibot`, an
access token that can push to it, and the two repository secrets `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`. Each step
that needs them has them in its own `env` only, and the token goes in through stdin, never on a command line. A
release without either fails at the `image` job's "Sign in to Docker Hub" step, naming both secrets, before anything
is published (the `publish` job's tagging step checks the same).

**Secrets and npm.** No runner of a job that holds a Docker Hub secret runs npm: `build`, the only job that does,
holds none, and `image` and `publish` only run docker and node scripts with no installs. The image build itself runs
`npm i -g` for the claude CLI, inside the build container and not on the runner.

**The check run.** `.github/workflows/docker-image-check.yml` is manual (`workflow_dispatch`) and holds no secret.
It builds the server tarball as the release does, builds the image for both platforms, starts the amd64 image and
waits for the server and `claude --version`, proves the image's `/app/server.mjs` has the hash of the tarball's (so
a build context BuildKit ignored cannot pass), packs the bundle with a dummy digest and has compose read the result
under both profiles, and runs `sh -n docker/install.sh`. It pushes and signs nothing. Run it once before the first tag,
and after any change to the Dockerfile, `docker-compose.yml`, `docker/` or a workflow; only a real tag proves the
release itself. The unit suite is not a gate in either workflow: parts of it need
`rsync`, `ssh` and a non-root user, so it stays a developer-machine check. The workflow never creates a tag.

Releasing is: `npm run bump:patch` (`deploy/bump.mjs`: `npm version` in every workspace, the lockfile, and an empty `## v<version> — <date>` section added to `CHANGELOG.md`; `npm run bump:set -- 0.1.0` sets an exact version), write the notes under that heading, commit, `git tag v10.2.5 && git push origin v10.2.5`.

### Tests

`shared/tests/installScripts.test.ts` pins what cannot drift unseen, since no unit test runs these scripts:
the root refusal, the https-only origin, that the **only** sudo command is the linger one and that it sits inside
the question, that nothing is ever piped into a shell, that the checksum and the signature (with the pinned key
matching `shared/src/update.ts`) are verified before the unpack, the `--dir`/`--origin` charset checks, the busy
refusal and its `unknown` case, the whole-app swap, that the token is only in the stdin header and never an argument,
the snapshot's excludes and order, that `zumibot-rollback` refuses root and checks both snapshots before it stops or
moves anything (and runs of it in a scratch dir with a fake `systemctl`, one with a failing `mv`, and a real run of
`install.sh --snapshot-data` over a minimal fake release), that the code is never echoed, the unit's shape and its
placeholders, and the workflow's trigger, per-job permissions, `persist-credentials: false`, pinning, tag check, that
npm stays out of the signing job, and that the signing secret is required. One check is a cross-file one: every
path `install.sh` requires in the tarball must be something `package.sh` stages.

## Phase 4

Not built yet:
- **macOS desktop build.** The changes in the tables above, dmg and zip for `arm64` and `x64`, signing and
  notarization wired to env vars, and Local mode working end to end.
