import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  screen,
  session,
  Tray
} from 'electron'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { cleanAgentList, cleanHotkey, type IslandSettings } from '@zumibot/shared/island'
import { LOCAL_RESTART_EXIT, LOCAL_UPDATES_ENV, UPDATE_LOG_FILE } from '@zumibot/shared/update'
import { resolveDataDir } from '@zumibot/backend/config'
import { isThemePref } from '@zumibot/shared/types'
import { macMenuTemplate } from './appMenu'
import { cleanupAttachmentDirs, openAttachment } from './attachmentsOpen'
import { autostartFile, HIDDEN_FLAG, syncAutostart, wantsHidden } from './autostart'
import { LEGACY_APP_DIR, migrateLegacyShell } from './legacyName'
import { readPortalPrefersDark } from './desktopTheme'
import { createIslandHost, type IslandHost } from './island'
import { agentsFor, loadIslandPrefs, renameAgentIn, saveIslandPrefs, withAgents } from './islandPrefs'
import { createLocalHost, LaunchAborted } from './localHost'
import { portInUse, startLocalServer, type LocalServer } from './localServer'
import { isPermissionAllowed, isSameOrigin } from './navigation'
import { checkDesktopNotification, createClickRelay, createDesktopNotifier } from './notifications'
import { isLoginUrl, QUIET_RETRY_MS, quietStep } from './quietStart'
import { runningMessage, switchMessage } from './quitGuard'
import { raiseWindow, type RaiseMode } from './raiseWindow'
import { forgetBuild, pickServer, pruneBuilds } from './serverPick'
import {
  DEFAULT_LOCAL_PORT,
  loadLastTheme,
  loadServerChoice,
  localRunsInWsl,
  parseServerChoice,
  saveLastTheme,
  saveServerChoice,
  type ServerChoice
} from './servers'
import { createSwitchServer } from './switchServer'
import { wantsSwitchServer } from './switchTrigger'
import { createDesktopSync } from './syncDesktop'
import { wantsSync } from './syncTrigger'
import { trayMenuTemplate } from './tray'
import { createVoiceHotkey, type VoiceHotkey } from './voiceHotkey'
import { askUnsavedChanges, createWindow, showHidden, whenRealScreen, type ShellWindow } from './window'

const SAVE_REPLY_TIMEOUT_MS = 10_000
const BUSY_POLL_MS = 2_000 // the close flow is synchronous, so it reads the last polled running count
const BUSY_REFRESH_MS = 500
const LOCAL_COOKIE = 'cb_local'

let shell: ShellWindow | null = null
let choice: ServerChoice | null = null
let busyCount = 0
let processCount = 0
let busyTimer: ReturnType<typeof setInterval> | null = null
let editorDirty = false
let lastError = ''
let desktopDark: Promise<boolean | null> = Promise.resolve(null)
let changingServer = false
let connecting = 0
let syncDesktop: ReturnType<typeof createDesktopSync> | null = null
let pendingSync = wantsSync(process.argv)
// The app lives in the tray: closing the main window only hides it, and only a quit (tray, logout, app.quit) ends it.
let quitRequested = false
let exiting = false // the app is really quitting (before-quit let it through): the island window may close
let tray: Tray | null = null
let island: IslandHost | null = null // made once the app is ready
let voiceHotkey: VoiceHotkey | null = null // the desk shortcut that starts and stops a voice conversation on the island
// A login start (--hidden) stays out of sight while the server and the network come up.
let quiet = wantsHidden(process.argv)
const quietStartedAt = Date.now()
let quietTimer: ReturnType<typeof setTimeout> | null = null

/** Shows the main window: `go` takes the user to its workspace, `bring` moves it onto theirs (see raiseWindow). */
function showMain(mode: RaiseMode = 'go'): void {
  endQuiet(false) // the user asked for it: no quiet retry or login detection may act after this
  if (!shell || shell.win.isDestroyed()) return
  const w = shell.win
  whenRealScreen(w, () => raiseWindow(w, mode, () => showHidden(w)))
}

function endQuiet(reveal: boolean): void {
  if (!quiet) return
  quiet = false
  if (quietTimer) clearTimeout(quietTimer)
  quietTimer = null
  if (reveal) showMain()
}

/** Asks to quit: the main window's close flow runs as today (unsaved edits, running replies). */
function requestQuit(): void {
  quitRequested = true
  if (shell && !shell.win.isDestroyed()) shell.win.close()
  else app.quit()
}

function showPendingSync(): void {
  if (!pendingSync || !shell || !syncDesktop || connecting > 0 || changingServer) return
  pendingSync = false
  syncDesktop.open(true)
}

// A click restores the window, then tells the page; the page may not have subscribed yet, so the relay holds it.
const clickRelay = createClickRelay((target) => {
  if (shell && !shell.win.isDestroyed()) shell.win.webContents.send('desktop:notificationClick', target)
})
// Electron's Notification (not the HTML5 one, whose permission stays refused for the remote page).
let notifier: ReturnType<typeof createDesktopNotifier> | null = null // made once the app is ready
function createNotifier(): void {
  if (!Notification.isSupported()) return
  notifier = createDesktopNotifier({
    create: (o) => new Notification({ title: o.title, body: o.body, silent: o.silent }),
    onClick: (chatId, open) => {
      showMain()
      clickRelay.click(chatId, open)
    }
  })
}

function createTray(): void {
  try {
    // 24 px: the panel scales it down, and the build icon is much larger. The macOS menu bar is 22 pt tall and draws
    // an image at its own size, so there it is 18.
    const size = process.platform === 'darwin' ? 18 : 24
    const image = nativeImage.createFromPath(join(__dirname, 'tray.png')).resize({ width: size, height: size })
    tray = new Tray(image)
    tray.setToolTip('ZumiBot')
    tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate({ open: () => showMain(), quit: requestQuit })))
  } catch (err) {
    console.error('creating the tray failed:', err)
  }
}

const islandFile = (): string => join(app.getPath('userData'), 'island.json')

function applyAutostart(on: boolean): void {
  try {
    // Windows and macOS keep login items themselves; the XDG autostart file is Linux's.
    if (process.platform !== 'linux') {
      if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: on, args: [HIDDEN_FLAG] })
      return
    }
    syncAutostart({
      on,
      packaged: app.isPackaged,
      file: autostartFile(process.env, app.getPath('home')),
      exec: process.env.APPIMAGE ?? process.execPath
    })
  } catch (err) {
    console.error('start at login entry failed:', err) // never fatal: the app works without it
  }
}

const allowLoopbackHttp = (): boolean => !app.isPackaged
const inWsl = localRunsInWsl()
const serverFile = (): string => join(app.getPath('userData'), 'server.json')
const serverEntry = (): string =>
  app.isPackaged
    ? join(process.resourcesPath, 'server', 'server.mjs')
    : join(app.getAppPath(), '..', 'zumi-bot-server', 'backend', 'dist', 'server.mjs')
// Server builds Local mode's update downloads (serverPick.ts). Packaged only: a dev run always serves the fresh local build.
// A WSL server writes them here too, through the /mnt path wslLaunch translates.
const updatesDir = (): string | null => (app.isPackaged ? join(app.getPath('userData'), 'server-updates') : null)

// Always the static files built next to this bundle: the same under `dev`, `build` and a packaged app.
const pageFile = (name: 'picker' | 'error'): string => join(__dirname, 'pages', `${name}.html`)
const showing = (name: 'picker' | 'error'): boolean =>
  !!shell && !shell.win.isDestroyed() && shell.win.webContents.getURL() === pathToFileURL(pageFile(name)).href

// --- IPC trust: a channel answers only the frame it was exposed to -----------------------------------------------

const fromPage = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean =>
  !!shell && e.sender === shell.win.webContents && !!e.senderFrame && e.senderFrame.url.startsWith('file:')
const fromApp = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean =>
  !!shell && shell.origin !== '' && e.sender === shell.win.webContents && !!e.senderFrame && isSameOrigin(e.senderFrame.url, shell.origin)
// The island channels also refuse a subframe of the app page: they change what the shell does outside the window.
const fromAppMain = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean => fromApp(e) && e.senderFrame === e.sender.mainFrame

const islandSettings = (origin: string): IslandSettings => {
  const p = loadIslandPrefs(islandFile())
  return { agents: agentsFor(p, origin), startAtLogin: p.startAtLogin, voiceHotkey: p.voiceHotkey }
}

// --- local server -------------------------------------------------------------------------------------------------

const host = createLocalHost(launchLocal)
const localServer = (): LocalServer | null => host.current()

function stopPolling(): void {
  if (busyTimer) clearInterval(busyTimer)
  busyTimer = null
  busyCount = 0
  processCount = 0
}

// A fresh count for the close flow (short timeout; on no answer the cached count stands).
function refreshBusy(): Promise<void> | undefined {
  const s = localServer()
  if (!s) return undefined
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('busy timeout')), BUSY_REFRESH_MS).unref())
  const procs = Promise.race([s.processes(), timeout]).then(
    (n) => void (processCount = n),
    () => {}
  )
  return Promise.race([s.busy(), timeout])
    .then((n) => void (busyCount = n))
    .finally(() => procs)
}

function dropCookie(origin: string): void {
  void session.defaultSession.cookies.remove(origin, LOCAL_COOKIE).catch(() => {})
}

async function stopLocal(): Promise<void> {
  island?.setOrigin(null)
  const s = localServer()
  stopPolling()
  await host.stop()
  if (s) dropCookie(s.origin)
}

function launchPort(): number {
  return choice?.kind === 'local' ? choice.port : DEFAULT_LOCAL_PORT
}

async function launchLocal(): Promise<LocalServer> {
  // A WSL server gets only what wslLaunch forwards; the ClaudeBot data it would migrate is a Linux-only folder.
  const env: NodeJS.ProcessEnv = inWsl ? { ...process.env } : { ...process.env, ZUMIBOT_MIGRATE_FROM: join(app.getPath('appData'), LEGACY_APP_DIR) }
  if (app.isPackaged) env['NODE_ENV'] = 'production'
  // Never a random port: webhook URLs must stay the same between launches.
  env['ZUMIBOT_PORT'] = String(launchPort())
  const dir = updatesDir()
  // Tells the server it may update itself, and where builds go; without it the server says updates are unavailable.
  if (dir) env[LOCAL_UPDATES_ENV] = dir
  const bundled = serverEntry()
  const pick = pickServer({ bundledEntry: bundled, bundledVersion: app.getVersion(), dir })
  if (dir) pruneBuilds(dir, pick.downloaded ? pick.version : null)
  let s: LocalServer | null = null
  const start = (entry: string): Promise<LocalServer> =>
    startLocalServer({
      node: process.execPath,
      entry,
      env,
      wsl: inWsl,
      onStderr: (line) => console.error(`[server] ${line}`), // already redacted
      onExit: (code, signal) => {
        if (!s || localServer() !== s) return
        const gone = s
        host.forget(gone)
        stopPolling()
        if (code === LOCAL_RESTART_EXIT) {
          // An update put a new build in place and asked for this: start again on it. The window stays on the same origin
          // (the port is fixed), and its updating overlay reloads once the new version answers.
          void host.ensure().catch((err) => {
            if (err instanceof LaunchAborted) return
            dropCookie(gone.origin)
            showError(err instanceof Error ? err.message : String(err))
          })
          return
        }
        dropCookie(gone.origin)
        showError(`The local server stopped unexpectedly (${signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`}).`)
      }
    })
  try {
    s = await start(pick.entry)
  } catch (err) {
    if (!pick.downloaded || !dir || err instanceof LaunchAborted) throw err
    // The downloaded build would not start: forget it and run the one this app came with. That server's boot settle
    // reads the pending update as failed, with this log as the reason.
    // A WSL server's data folder is inside WSL, out of reach: there the failure is only in the error the shell shows.
    const log = inWsl ? null : join(resolveDataDir(env), UPDATE_LOG_FILE)
    forgetBuild(dir, pick.version, log, err instanceof Error ? err.message : String(err))
    s = await start(bundled)
  }
  const started = s
  // The local origin only, so no other server ever sees the secret.
  await session.defaultSession.cookies.set({ url: started.origin, name: LOCAL_COOKIE, value: started.secret, httpOnly: true, sameSite: 'strict' })
  busyTimer = setInterval(() => {
    void started.busy().then(
      (n) => (busyCount = n),
      () => (busyCount = 0)
    )
    void started.processes().then(
      (n) => (processCount = n),
      () => (processCount = 0)
    )
  }, BUSY_POLL_MS)
  busyTimer.unref()
  return started
}

// --- windows and pages --------------------------------------------------------------------------------------------

function newWindow(origin: string, mode: 'local' | 'vps'): ShellWindow {
  const next = createWindow({
    origin,
    mode,
    stateFile: join(app.getPath('userData'), 'window-state.json'),
    zoomFile: join(app.getPath('userData'), 'zoom.json'),
    desktopDark,
    getState: () => ({ editorDirty, runningCount: localServer() ? busyCount : 0, processCount: localServer() ? processCount : 0 }),
    saveBeforeClose: askSaveBeforeClose,
    stopAll: stopLocal,
    refreshState: refreshBusy,
    canClose: () => {
      if (!syncDesktop?.isOpen()) return true
      syncDesktop.focus()
      return false
    },
    onSwitchShortcut: () => void switchServer(), // same guards as the menu entry: unsaved edits, running replies
    onFailLoad: (w, info) => {
      if (shell?.win !== w || info.url.startsWith('file:')) return
      showError(`Could not reach ${origin || info.url}.\n${info.description}`)
    },
    startHidden: quiet,
    shouldHide: () => !quitRequested,
    onQuitCancelled: () => {
      quitRequested = false
      exiting = false // a cancelled window close cancels the quit with it
    },
    onNavigated: (w, url, serverError) => {
      if (shell?.win !== w) return
      // A proxy's 502/503 while the backend comes up is no success: showError must still find the quiet start on and retry.
      if (quiet && origin !== '' && !serverError) {
        // The sign-in page needs the user; any other page of the server means the start worked, so stay in the tray.
        if (isLoginUrl(url, origin)) endQuiet(true)
        else if (isSameOrigin(url, origin)) endQuiet(false)
      }
      // The strip follows the app page only: not a login page (the island would redirect there too) or a server error.
      if (origin !== '' && !serverError && isSameOrigin(url, origin) && !isLoginUrl(url, origin)) island?.setOrigin(origin)
      editorDirty = false
      clickRelay.reset() // the new document subscribes again and signals ready
    }
  })
  next.win.on('closed', () => {
    if (quitRequested && shell?.win === next.win) app.quit() // a replaced window (dispose) is not the main one
  })
  const old = shell
  shell = next
  editorDirty = false
  try {
    notifier?.closeAll() // they belong to the server just left
  } catch {
    // never block a server switch
  }
  clickRelay.reset()
  if (old) island?.setOrigin(null) // the replaced window's server is left
  old?.dispose() // after the new one exists, so the app never has zero windows
  return next
}

// The window's preload bridge is fixed at creation, so a window serves one origin; a different one gets a new window.
function windowFor(origin: string, mode: 'local' | 'vps'): ShellWindow {
  return shell && !shell.win.isDestroyed() && shell.origin === origin ? shell : newWindow(origin, mode)
}

// The shell's own pages (file:) work in any window: the picker and error pages never get zumibotDesktop.
function showPage(name: 'picker' | 'error', leaveQuiet = name === 'picker'): void {
  island?.setOrigin(null) // no server behind the window: the strip has nothing to show
  const had = !!shell && !shell.win.isDestroyed()
  const wasQuiet = quiet && leaveQuiet
  if (wasQuiet) endQuiet(false) // before newWindow, so a new window shows itself
  const w = shell && !shell.win.isDestroyed() ? shell : newWindow('', 'vps')
  editorDirty = false
  void w.win.loadFile(pageFile(name)).catch(() => {})
  if (wasQuiet && had) showMain() // a window made hidden for the quiet start
}

function showError(message: string): void {
  lastError = message
  const keepQuiet = quiet && quietStep(Date.now(), quietStartedAt) === 'retry'
  showPage('error', !keepQuiet)
  if (keepQuiet) {
    // The network or the server may still be coming up after login: stay hidden and try again.
    if (quietTimer) clearTimeout(quietTimer)
    quietTimer = setTimeout(() => {
      quietTimer = null
      if (quiet && choice) void connect(choice)
    }, QUIET_RETRY_MS)
  }
}

async function connect(c: ServerChoice, reportFailure = false): Promise<void> {
  connecting++
  choice = c
  try {
    if (c.kind === 'local') {
      // No busy guard: the picker only shows at startup or after switchServer stopped Local (or the user confirmed Stop & Switch).
      // ensure() would reuse a server that listens on the old port.
      const running = localServer()
      if (running && new URL(running.origin).port !== String(c.port)) await stopLocal()
      const s = await host.ensure()
      const load = windowFor(s.origin, 'local').win.loadURL(s.origin)
      if (reportFailure) await load
      else void load.catch(() => {})
    } else {
      await stopLocal()
      const load = windowFor(c.url, 'vps').win.loadURL(c.url)
      if (reportFailure) await load
      else void load.catch(() => {})
    }
  } catch (err) {
    if (err instanceof LaunchAborted) return // the user moved on while it was starting
    const msg = err instanceof Error ? err.message : String(err)
    showError(c.kind === 'local' && portInUse(msg) ? `Port ${c.port} is already in use. Choose another port for Local mode.` : msg)
    if (reportFailure) throw err
  } finally {
    connecting--
    showPendingSync()
  }
}

function askSaveBeforeClose(w: BrowserWindow): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (ok: boolean): void => {
      clearTimeout(timer)
      ipcMain.removeListener('desktop:saveBeforeCloseResult', onResult)
      resolve(ok)
    }
    const onResult = (e: Electron.IpcMainEvent, ok: unknown): void => {
      if (e.sender === w.webContents && fromApp(e)) finish(ok === true)
    }
    const timer = setTimeout(() => finish(false), SAVE_REPLY_TIMEOUT_MS)
    ipcMain.on('desktop:saveBeforeCloseResult', onResult)
    w.webContents.send('desktop:saveBeforeClose')
  })
}

const performSwitch = createSwitchServer({
  isDirty: () => editorDirty,
  askUnsaved: () => (shell ? askUnsavedChanges(shell.win) : Promise.resolve('cancel')),
  saveBeforeClose: () => (shell ? askSaveBeforeClose(shell.win) : Promise.resolve(false)),
  isLocal: () => localServer() !== null,
  busy: () => (localServer() ? localServer()!.busy() : Promise.resolve(0)),
  processes: () => (localServer() ? localServer()!.processes() : Promise.resolve(0)),
  askRunning: async (n, processes) => {
    const opts = {
      type: 'warning' as const,
      message: switchMessage(n, processes),
      buttons: ['Cancel', n > 0 ? 'Stop & Switch' : 'Switch'],
      defaultId: 0,
      cancelId: 0
    }
    const { response } = shell ? await dialog.showMessageBox(shell.win, opts) : await dialog.showMessageBox(opts)
    return response === 1
  },
  stopLocal,
  showPicker: () => showPage('picker'),
  onError: (err) => showError(err instanceof Error ? err.message : String(err))
})

async function switchServer(): Promise<void> {
  if (syncDesktop?.isOpen()) {
    syncDesktop.focus()
    return
  }
  if (changingServer) return // not while connecting: switching is how the user leaves a slow local start
  changingServer = true
  try {
    await performSwitch()
  } finally {
    changingServer = false
    showPendingSync()
  }
}

function registerIpc(): void {
  ipcMain.handle('pages:pick', async (e, raw: unknown) => {
    if (!fromPage(e)) return { ok: false, error: 'Not allowed.' }
    if (syncDesktop?.isOpen() || changingServer) return { ok: false, error: 'Wait for the current operation to finish.' }
    const c = parseServerChoice(raw, { allowLoopbackHttp: allowLoopbackHttp() })
    if (!c) {
      const local = (raw as { kind?: unknown } | null)?.kind === 'local'
      return { ok: false, error: local ? 'Enter a port from 1024 to 65535.' : 'Enter the server address as https://host, with no path.' }
    }
    saveServerChoice(serverFile(), c)
    void connect(c)
    return { ok: true }
  })
  ipcMain.handle('pages:currentChoice', (e) => (fromPage(e) ? choice : null))
  ipcMain.handle('pages:localKind', (e) => (fromPage(e) ? (inWsl ? 'wsl' : 'native') : null))
  ipcMain.handle('pages:getError', (e) => (fromPage(e) ? lastError : ''))
  ipcMain.on('pages:retry', (e) => {
    if (!fromPage(e) || !choice || syncDesktop?.isOpen() || changingServer) return
    void connect(choice) // reuses a live local server: restarting it would stop replies in flight
  })
  ipcMain.on('pages:switch', (e) => {
    if (fromPage(e)) void switchServer()
  })

  ipcMain.on('desktop:switchServer', (e) => {
    if (fromApp(e)) void switchServer()
  })
  ipcMain.on('desktop:sync', (e) => {
    if (fromApp(e) && e.senderFrame === e.sender.mainFrame) syncDesktop?.open()
  })
  ipcMain.on('desktop:setEditorDirty', (e, dirty: unknown) => {
    if (fromApp(e)) editorDirty = dirty === true
  })
  ipcMain.on('desktop:setTheme', (e, theme: unknown) => {
    if (!fromApp(e) || !isThemePref(theme)) return
    nativeTheme.themeSource = theme // the window's 'updated' listener follows with the background
    try {
      saveLastTheme(serverFile(), theme) // the next start paints in it before the server has answered
    } catch (err) {
      console.error('saving the theme failed:', err)
    }
  })
  ipcMain.on('desktop:notify', (e, raw: unknown) => {
    if (!fromApp(e) || !notifier) return
    const n = checkDesktopNotification(raw)
    if (n) notifier.show(n)
  })
  ipcMain.on('desktop:closeNotifications', (e, chatId: unknown, waitingOnly: unknown) => {
    if (!fromApp(e) || !notifier || typeof chatId !== 'string' || chatId.length > 200 || typeof waitingOnly !== 'boolean') return
    notifier.close(chatId, waitingOnly)
  })
  ipcMain.on('desktop:closeNotificationTag', (e, tag: unknown) => {
    if (!fromApp(e) || !notifier || typeof tag !== 'string' || tag === '' || tag.length > 200) return
    notifier.closeTag(tag)
  })
  ipcMain.on('desktop:notificationClickReady', (e) => {
    if (fromApp(e) && e.senderFrame === e.sender.mainFrame) clickRelay.ready()
  })
  ipcMain.handle('desktop:openAttachment', (e, url: unknown, name: unknown) =>
    fromApp(e) && shell && typeof url === 'string' && typeof name === 'string' ? openAttachment(url, name, shell.origin) : false
  )

  // The island's Settings controls: the strip's agents per server and the login entry.
  ipcMain.handle('desktop:islandGet', (e): IslandSettings => {
    if (!fromAppMain(e) || !shell) throw new Error('Not allowed.')
    return islandSettings(shell.origin)
  })
  ipcMain.handle('desktop:islandSet', (e, patch: unknown): IslandSettings => {
    if (!fromAppMain(e) || !shell) throw new Error('Not allowed.')
    const origin = shell.origin
    const p = typeof patch === 'object' && patch !== null && !Array.isArray(patch) ? (patch as Record<string, unknown>) : null
    if (!p) throw new Error('Invalid settings.')
    const agents = p['agents'] === undefined ? undefined : cleanAgentList(p['agents'])
    if (agents === null) throw new Error('Invalid agents.')
    if (p['startAtLogin'] !== undefined && typeof p['startAtLogin'] !== 'boolean') throw new Error('Invalid start at login.')
    const startAtLogin = p['startAtLogin'] as boolean | undefined
    // null turns the shortcut off; a string must be a valid accelerator, whatever the page says.
    const hotkey = p['voiceHotkey'] === undefined ? undefined : p['voiceHotkey'] === null ? null : cleanHotkey(p['voiceHotkey'])
    if (hotkey === null && p['voiceHotkey'] !== null) throw new Error('Invalid shortcut.')
    const before = loadIslandPrefs(islandFile())
    let next = agents ? withAgents(before, origin, agents) : before
    if (startAtLogin !== undefined) next = { ...next, startAtLogin }
    // A shortcut another app holds is not saved: the old one comes back and the result says so.
    if (hotkey !== undefined && hotkey !== before.voiceHotkey) {
      if (!voiceHotkey?.set(hotkey).ok) {
        voiceHotkey?.set(before.voiceHotkey)
        return { ...islandSettings(origin), ok: false }
      }
      next = { ...next, voiceHotkey: hotkey }
    }
    try {
      saveIslandPrefs(islandFile(), next)
    } catch (err) {
      console.error('saving the island settings failed:', err)
      voiceHotkey?.set(before.voiceHotkey)
      throw new Error('Could not save the island settings.')
    }
    if (next.startAtLogin !== before.startAtLogin) applyAutostart(next.startAtLogin)
    island?.agentsChanged()
    return islandSettings(origin)
  })
  ipcMain.on('desktop:islandRename', (e, from: unknown, to: unknown) => {
    if (!fromAppMain(e) || !shell) return
    const names = cleanAgentList([from, to])
    if (!names || names.length !== 2) return // not two different, valid names
    const before = loadIslandPrefs(islandFile())
    const next = renameAgentIn(before, shell.origin, names[0]!, names[1]!)
    if (next === before) return
    try {
      saveIslandPrefs(islandFile(), next)
    } catch (err) {
      console.error('saving the island settings failed:', err)
      return
    }
    island?.agentsChanged()
  })
}

async function start(): Promise<void> {
  // macOS 13+ login items take no arguments, so --hidden never arrives there; the system says it started us instead.
  if (process.platform === 'darwin' && app.isPackaged && app.getLoginItemSettings().wasOpenedAtLogin) quiet = true
  // No default menu: Ctrl+R / Force Reload would drop unsaved editor edits and DevTools would be reachable. A Mac needs
  // one for its Edit shortcuts and Cmd+Q, so it gets a minimal one (appMenu.ts).
  Menu.setApplicationMenu(
    process.platform === 'darwin' ? Menu.buildFromTemplate(macMenuTemplate({ appName: app.name, quit: requestQuit })) : null
  )
  // A remote page runs in this app: it gets the clipboard and, for dictation, the microphone, nothing else.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb, details) =>
    cb(
      !!shell &&
        isPermissionAllowed(permission, details.requestingUrl, shell.origin, {
          mediaTypes: 'mediaTypes' in details ? details.mediaTypes : undefined
        })
    )
  )
  session.defaultSession.setPermissionCheckHandler(
    (_wc, permission, requestingOrigin, details) =>
      !!shell && isPermissionAllowed(permission, requestingOrigin, shell.origin, { mediaType: details.mediaType })
  )
  desktopDark = process.platform === 'linux' ? readPortalPrefersDark() : Promise.resolve(null)
  nativeTheme.themeSource = loadLastTheme(serverFile()) ?? 'system'
  syncDesktop = createDesktopSync({
    parent: () => shell?.win ?? null,
    available: () => !changingServer && connecting === 0,
    settingsFile: join(app.getPath('userData'), 'sync.env'),
    developmentConfig: app.isPackaged ? undefined : join(app.getAppPath(), '../zumi-bot-server/deploy/deploy.env'),
    isDirty: () => editorDirty,
    askUnsaved: askUnsavedChanges,
    save: () => (shell ? askSaveBeforeClose(shell.win) : Promise.resolve(false)),
    busy: () => localServer()?.busy() ?? Promise.resolve(0),
    pause: stopLocal,
    // On the picker the user had already left that server, so it stays left.
    restore: async () => {
      if (choice && !showing('picker')) await connect(choice, true)
    }
  })
  createNotifier()
  registerIpc()
  island = createIslandHost({
    hitTest: process.platform === 'darwin' ? 'cursor' : 'shape',
    prefsFile: islandFile(),
    preload: join(__dirname, '../preload/index.js'),
    area: () => screen.getPrimaryDisplay().workArea,
    openMain: (t) => {
      showMain('bring') // the island is how the user stays where they work
      // Only the app page listens; a picker or error page in the window has no one to tell.
      if (
        t.chatId &&
        shell &&
        !shell.win.isDestroyed() &&
        shell.origin !== '' &&
        isSameOrigin(shell.win.webContents.getURL(), shell.origin)
      ) {
        shell.win.webContents.send('desktop:islandOpen', t)
      }
    },
    openAttachment,
    quitting: () => exiting
  })
  // Register-time failures (another app holds it, no X11 grab) only lose the shortcut; Settings shows it again on a change.
  voiceHotkey = createVoiceHotkey({
    register: (acc, cb) => globalShortcut.register(acc, cb),
    unregister: (acc) => globalShortcut.unregister(acc),
    onPress: () => island?.voicePress()
  })
  const prefs = loadIslandPrefs(islandFile())
  if (!voiceHotkey.set(prefs.voiceHotkey).ok) console.error('the voice shortcut could not be registered; another app may hold it')
  applyAutostart(prefs.startAtLogin)
  createTray()
  const saved = loadServerChoice(serverFile(), { allowLoopbackHttp: allowLoopbackHttp() })
  // `--switch-server` opens the picker instead of reconnecting (nothing is running yet, so nothing to guard).
  if (saved && !wantsSwitchServer(process.argv)) await connect(saved)
  else showPage('picker')
  showPendingSync()
}

// Before anything reads userData: settings saved while the shell was still called ClaudeBot.
try {
  const copied = migrateLegacyShell({
    appData: app.getPath('appData'),
    userData: app.getPath('userData'),
    autostartDir: dirname(autostartFile(process.env, app.getPath('home')))
  })
  if (copied.length) console.log(`Copied ${copied.join(', ')} from ${LEGACY_APP_DIR} (ClaudeBot is now ZumiBot).`)
} catch (err) {
  console.error('Could not copy the ClaudeBot settings:', err instanceof Error ? err.message : String(err))
}

// Taken before anything starts: a second instance would otherwise start a second local server on the same data.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // Windows shows toasts only for an app with an AppUserModelID; the installer's shortcut carries this same one.
  if (process.platform === 'win32') app.setAppUserModelId('com.mhdaljuboori.zumibot')
  // macOS: a click on the Dock icon of a running app is this, not a second launch; the window may be hidden to the tray.
  app.on('activate', () => {
    if (shell && !shell.win.isDestroyed()) showMain()
  })
  app.on('second-instance', (_e, argv) => {
    if (wantsSync(argv)) pendingSync = true
    if (!shell || shell.win.isDestroyed()) return
    if (!wantsHidden(argv)) showMain() // a login entry started twice must not pop the window up
    if (wantsSync(argv)) showPendingSync()
    else if (wantsSwitchServer(argv)) void switchServer()
  })
  app
    .whenReady()
    .then(start)
    .catch((err: unknown) => {
      dialog.showErrorBox('ZumiBot failed to start', err instanceof Error ? err.message : String(err))
      app.quit()
    })
}

// The tray keeps the app alive with no window; only a requested quit ends it.
app.on('window-all-closed', () => {
  if (quitRequested) app.quit()
})

app.on('before-quit', (e) => {
  if (syncDesktop?.active()) {
    e.preventDefault()
    syncDesktop.focus()
    return
  }
  if (quitRequested) {
    exiting = true
    return
  }
  // A quit from anywhere (logout, app.quit()) still goes through the main window's close checks.
  quitRequested = true
  if (shell && !shell.win.isDestroyed()) {
    e.preventDefault()
    shell.win.close()
    return
  }
  exiting = true
})

// Whatever way the app ends, the local server it started (or is still starting) goes with it.
let quitting = false
app.on('will-quit', (e) => {
  exiting = true
  voiceHotkey?.dispose()
  voiceHotkey = null
  island?.dispose()
  island = null
  tray?.destroy()
  tray = null
  try {
    notifier?.closeAll()
  } catch {
    // never block quit
  }
  cleanupAttachmentDirs()
  if (quitting) return
  quitting = true
  e.preventDefault()
  // A macrotask: with no server to stop this settles while Electron still handles will-quit, and a quit then is ignored.
  void stopLocal().finally(() => setImmediate(() => app.quit()))
})
