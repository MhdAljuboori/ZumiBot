import { BrowserWindow, dialog, Menu, nativeTheme, screen, shell } from 'electron'
import { join } from 'node:path'
import { createCloseFlow } from './closeFlow'
import { contextMenuTemplate } from './contextMenu'
import { createShowGate } from './desktopTheme'
import { isServerError, isSameOrigin, isWebUrl, redirectAction } from './navigation'
import { runningMessage } from './quitGuard'
import { isSwitchShortcut } from './switchTrigger'
import { createScreenWaits, hasRealScreen } from './screenGuard'
import { createWindowStateTracker, initialBounds, loadWindowState, saveWindowState, showHiddenWindow, showMaximized } from './windowState'
import { loadZoom, saveZoom, zoomStep } from './zoom'

const THEME_WAIT_MS = 2_000 // how long a painted window waits for nativeTheme to catch up with the desktop
const WINDOW_STATE_SAVE_MS = 500 // a move/resize is saved once the window has stayed put this long
const WINDOW_SETTLE_MS = 50 // a window reopening maximized is maximized once the window manager stops moving it this long
const SCREEN_SETTLE_MS = 500 // a screen that came back is trusted this long after: Mutter handles the same RandR change a moment after Electron sees it
const DEFAULT_WINDOW_SIZE = { width: 1200, height: 800 }

// The build icon, copied next to the main bundle (electron.vite.config.ts). Without it a window shows the running exe's
// icon: Electron's own under `npm run dev`, where Windows takes the taskbar and Alt+Tab icon from the window.
export const APP_ICON = join(__dirname, 'tray.png')

export interface WindowOptions {
  /** The connected server's origin; '' for the picker and error pages. The preload exposes the bridge to this origin only. */
  origin: string
  mode: 'local' | 'vps'
  stateFile: string
  /** Where the page zoom (Ctrl+= / Ctrl+- / Ctrl+0) is kept between runs. */
  zoomFile: string
  desktopDark: Promise<boolean | null>
  getState(): { editorDirty: boolean; runningCount: number; processCount?: number }
  saveBeforeClose(w: BrowserWindow): Promise<boolean>
  stopAll(): Promise<void>
  refreshState?(): Promise<void> | undefined
  canClose?(): boolean
  /** Ctrl+Shift+S pressed in this window. */
  onSwitchShortcut(): void
  onFailLoad(w: BrowserWindow, info: { url: string; description: string; code: number }): void
  /** The main frame went to a new document: nothing the old page held (unsaved edits) is still there. */
  onNavigated(w: BrowserWindow, url: string, serverError: boolean): void
  /** A login start: the window is made and loads, but the show gate never shows it. */
  startHidden: boolean
  /** True unless a quit was asked: closing the window then only hides it (the app lives in the tray). */
  shouldHide(): boolean
  /** A quit attempt ended with the window staying open. Must not throw: the close flow calls it unguarded. */
  onQuitCancelled(): void
}

export interface ShellWindow {
  win: BrowserWindow
  origin: string
  /** Closes without the close flow: the window is being replaced, not quit. */
  dispose(): void
}

/** The Save / Discard / Cancel question shared by closing the window and switching server. */
export async function askUnsavedChanges(w: BrowserWindow): Promise<'save' | 'discard' | 'cancel'> {
  const { response } = await dialog.showMessageBox(w, {
    type: 'question',
    message: 'You have unsaved changes to this agent.',
    buttons: ['Save', 'Discard', 'Cancel'],
    defaultId: 0,
    cancelId: 2
  })
  return response === 0 ? 'save' : response === 1 ? 'discard' : 'cancel'
}

// The app's canvas (tokens.css --bg-sidebar, Blue color theme): on a wide window the nav sits on it and the main pane
// floats over it. The window cannot know a picked color theme before the page loads, so it starts in the default's.
export const windowBackground = (): string => (nativeTheme.shouldUseDarkColors ? '#0a0c10' : '#eef1f6')

function workAreas(): Electron.Rectangle[] {
  const primary = screen.getPrimaryDisplay()
  return [primary, ...screen.getAllDisplays().filter((d) => d.id !== primary.id)].map((d) => d.workArea)
}

const screenWaits = createScreenWaits<BrowserWindow>((w) => ({
  usable: () => hasRealScreen(screen.getAllDisplays()),
  onChange: (cb) => {
    screen.on('display-added', cb)
    screen.on('display-removed', cb)
    screen.on('display-metrics-changed', cb)
    return () => {
      screen.off('display-added', cb)
      screen.off('display-removed', cb)
      screen.off('display-metrics-changed', cb)
    }
  },
  isGone: () => w.isDestroyed(),
  settleMs: SCREEN_SETTLE_MS
}))

/** Runs `run` for a window now if a real screen is there, else once one is back (see screenGuard: Mutter dies on a maximized window without a monitor). One wait per window; a later call replaces what runs. */
export function whenRealScreen(w: BrowserWindow, run: () => void): void {
  screenWaits.when(w, run)
}

/** Shows the window at its current (normal) size, then maximizes it once the window manager has placed it. */
function showThenMaximize(w: BrowserWindow): void {
  showMaximized({
    show: () => w.show(),
    // A monitor that went away in these ms is no place to flag it. Electron's maximize shows a hidden window, so one
    // hidden again meanwhile (a quit dialog's Cancel) stays hidden.
    maximize: () =>
      whenRealScreen(w, () => {
        if (w.isVisible()) w.maximize()
      }),
    onMove: (cb) => {
      w.on('move', cb)
      return () => w.off('move', cb)
    },
    isGone: () => w.isDestroyed(),
    settleMs: WINDOW_SETTLE_MS
  })
}

/** Shows a window hidden to the tray, a maximized one maximized (see showHiddenWindow). Call it with a real screen. */
export function showHidden(w: BrowserWindow): void {
  showHiddenWindow(w, () => showThenMaximize(w))
}

/**
 * Ctrl+= / Ctrl+- / Ctrl+0 (Cmd on a Mac) in a window of the server's pages, before the page sees them: true when the
 * press was one and was handled. The factor is read from the page, since Chromium shares it per origin between the
 * main window and the popouts, and saved for the next run.
 */
export function zoomOnKey(w: BrowserWindow, zoomFile: string, e: Electron.Event, input: Electron.Input): boolean {
  const next = zoomStep(input, process.platform === 'darwin', w.webContents.getZoomFactor())
  if (next === null) return false
  e.preventDefault()
  w.webContents.setZoomFactor(next)
  try {
    saveZoom(zoomFile, next)
  } catch (err) {
    console.error('saving the zoom failed:', err)
  }
  return true
}

/**
 * What every window that shows the connected server's pages gets: it stays on its own origin, links go to the browser,
 * nothing else opens, a webview never attaches and right-click gives the spelling menu. `onMainRedirectAway` is called
 * when a main-frame redirect to another site was stopped (the main window shows its error page; the island ignores it).
 */
export function lockToOrigin(w: BrowserWindow, origin: string, onMainRedirectAway?: (url: string) => void): void {
  const openIfWeb = (url: string): void => {
    if (isWebUrl(url)) void shell.openExternal(url)
  }
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (!isSameOrigin(url, origin)) openIfWeb(url)
    return { action: 'deny' }
  })
  const lock = (e: Electron.Event & { url: string }): void => {
    if (isSameOrigin(e.url, origin)) return
    e.preventDefault()
    openIfWeb(e.url)
  }
  w.webContents.on('will-navigate', lock)
  // A redirect away is no link click: a subframe one is dropped, a main-frame one (a hidden window would otherwise
  // stay blank) is reported.
  w.webContents.on('will-redirect', (e) => {
    const action = redirectAction({ isMainFrame: e.isMainFrame, url: e.url }, origin)
    if (action === 'allow') return
    e.preventDefault()
    if (action === 'error') onMainRedirectAway?.(e.url)
  })
  w.webContents.on('context-menu', (_e, params) => {
    const items = contextMenuTemplate(params, {
      replace: (word) => w.webContents.replaceMisspelling(word),
      learn: (word) => w.webContents.session.addWordToSpellCheckerDictionary(word)
    })
    if (items.length) Menu.buildFromTemplate(items).popup({ window: w })
  })
  w.webContents.on('will-attach-webview', (e) => e.preventDefault())
}

// desktopDark: the desktop's own dark preference (null = unknown), which nativeTheme may not report yet (see desktopTheme).
// stateFile: where the window's size, position and maximized state are kept between runs.
export function createWindow(o: WindowOptions): ShellWindow {
  const saved = loadWindowState(o.stateFile)
  const w = new BrowserWindow({
    ...initialBounds(saved, workAreas(), DEFAULT_WINDOW_SIZE),
    minWidth: 800,
    minHeight: 500,
    title: 'ZumiBot',
    icon: APP_ICON,
    show: false, // the gate below shows it once painted in the desktop's theme
    backgroundColor: windowBackground(),
    darkTheme: nativeTheme.shouldUseDarkColors,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      preload: join(__dirname, '../preload/index.js'),
      additionalArguments: [`--zumibot-origin=${o.origin}`, `--zumibot-mode=${o.mode}`]
    }
  })

  let desktop: boolean | null | undefined // undefined until the portal answers
  const gate = createShowGate({
    themeSettled: () =>
      nativeTheme.themeSource !== 'system' || desktop === null || (desktop !== undefined && nativeTheme.shouldUseDarkColors === desktop),
    show: () => {
      if (o.startHidden) return // shown later by the shell, if at all
      // Maximized over the saved normal bounds, which unmaximize returns to.
      whenRealScreen(w, () => (saved?.maximized ? showThenMaximize(w) : w.show()))
    }
  })
  void o.desktopDark.then((d) => {
    desktop = d
    if (!w.isDestroyed()) gate.themeUpdated()
  })
  const onThemeUpdated = (): void => {
    w.setBackgroundColor(windowBackground())
    gate.themeUpdated()
  }
  nativeTheme.on('updated', onThemeUpdated)
  w.on('closed', () => {
    nativeTheme.off('updated', onThemeUpdated)
    screenWaits.cancel(w) // a window destroyed while waiting must not keep its listeners
  })
  w.once('ready-to-show', () => {
    gate.painted()
    setTimeout(() => {
      if (!w.isDestroyed()) gate.giveUp()
    }, THEME_WAIT_MS)
  })

  lockToOrigin(w, o.origin, (url) =>
    o.onFailLoad(w, { url, description: `The server redirected to another site (${new URL(url).origin}), which is blocked.`, code: -1 })
  )
  // Handled before the page sees it, so a non-ZumiBot site cannot swallow the way back to the picker.
  w.webContents.on('before-input-event', (e, input) => {
    if (zoomOnKey(w, o.zoomFile, e, input)) return
    if (!isSwitchShortcut(input, process.platform === 'darwin')) return
    e.preventDefault()
    o.onSwitchShortcut()
  })
  // Chromium keeps zoom per origin, so each new document (the picker, then the server) gets the saved factor again.
  w.webContents.on('did-finish-load', () => w.webContents.setZoomFactor(loadZoom(o.zoomFile)))
  w.webContents.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    if (isMainFrame && code !== -3) o.onFailLoad(w, { url, description, code }) // -3: aborted by a newer navigation
  })
  // did-navigate is main frame only.
  w.webContents.on('did-navigate', (_e, url, httpResponseCode) => {
    const serverError = isServerError(httpResponseCode, o.mode) && isSameOrigin(url, o.origin)
    o.onNavigated(w, url, serverError)
    if (serverError) {
      o.onFailLoad(w, { url, description: `The server answered HTTP ${httpResponseCode}.`, code: httpResponseCode })
    }
  })

  const windowState = createWindowStateTracker({
    initial: w.getBounds(),
    read: () =>
      w.isDestroyed()
        ? null
        : { bounds: w.getBounds(), maximized: w.isMaximized(), minimized: w.isMinimized(), fullScreen: w.isFullScreen() },
    save: (s) => saveWindowState(o.stateFile, s),
    delayMs: WINDOW_STATE_SAVE_MS,
    onError: (err) => console.error('saving the window state failed:', err)
  })
  w.on('resize', windowState.changed)
  w.on('move', windowState.changed)
  w.on('maximize', windowState.changed)
  w.on('unmaximize', windowState.changed)

  let raisedFromHidden = false
  const flow = createCloseFlow({
    getState: o.getState,
    askUnsaved: () => askUnsavedChanges(w),
    saveBeforeClose: () => o.saveBeforeClose(w),
    askRunning: async (n, processes) => {
      const { response } = await dialog.showMessageBox(w, {
        type: 'warning',
        message: runningMessage(n, processes),
        buttons: ['Cancel', n > 0 ? 'Stop & Quit' : 'Quit'],
        defaultId: 0,
        cancelId: 0
      })
      return response === 1
    },
    stopAll: o.stopAll,
    refreshState: o.refreshState,
    onAsk: () => {
      // A dialog over a hidden window would be invisible, but with no real screen showing a maximized-flagged window
      // is the Mutter crash: then the window stays hidden and the dialog is only parented to it.
      if (w.isDestroyed() || !hasRealScreen(screen.getAllDisplays())) return
      if (!w.isVisible()) {
        raisedFromHidden = true
        showHidden(w) // one closed maximized comes back maximized, as from the tray
      }
      w.focus()
    },
    onStay: () => {
      // Cancel leaves the window as the tray had it: one the dialog raised from hidden goes back to hidden.
      if (raisedFromHidden && !w.isDestroyed()) w.hide()
      raisedFromHidden = false
      o.onQuitCancelled()
    },
    closeWindow: () => w.close(),
    isGone: () => w.isDestroyed(),
    onError: (err) => console.error('close flow failed:', err)
  })
  let disposed = false
  w.on('close', (e) => {
    if (disposed) return
    if (o.canClose && !o.canClose()) {
      e.preventDefault()
      o.onQuitCancelled()
      return
    }
    if (o.shouldHide()) {
      e.preventDefault()
      windowState.flush()
      w.hide()
      return
    }
    if (!flow.onClose()) e.preventDefault()
    else windowState.flush()
  })

  return {
    win: w,
    origin: o.origin,
    dispose() {
      disposed = true
      windowState.flush()
      w.destroy()
    }
  }
}
