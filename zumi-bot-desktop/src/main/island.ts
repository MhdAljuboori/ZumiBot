import { BrowserWindow, ipcMain, screen } from 'electron'
import { ISLAND_AGENTS_MAX, ISLAND_PATH, parseIslandOpenTarget, type IslandOpenTarget, type IslandRect } from '@zumibot/shared/island'
import { POPUP_WIDTH, islandBounds, type SlidingLayout } from '@zumibot/shared/islandLayout'
import { agentsFor, loadIslandPrefs, saveIslandPrefs } from './islandPrefs'
import { isSameOrigin } from './navigation'
import { lockToOrigin } from './window'

export type IslandState = 'none' | 'hidden' | 'shown'

/**
 * No window without a connected server, or without a picked agent unless a voice conversation runs; hidden until the page
 * is ready and reports an icon, or until the page is ready and a voice conversation runs.
 */
export function islandWanted(s: {
  origin: string | null
  picked: number
  ready: boolean
  icons: number
  voice: boolean
  open: boolean
}): IslandState {
  // `open`: the page's popup is up. With no agent picked that is a voice request's chat; the window lives until it closes.
  if (s.origin === null || (s.picked === 0 && !s.voice && !s.open)) return 'none'
  return s.ready && (s.icons > 0 || s.voice || s.open) ? 'shown' : 'hidden'
}

/** A settled island window that is not on its page (a login redirect, a failed load) is sent back when the main window returns. */
export function needsIslandLoad(s: { hasWindow: boolean; loading: boolean; onIsland: boolean; failed: boolean }): boolean {
  return s.hasWindow && !s.loading && (s.failed || !s.onIsland)
}

/** Alt+F4 or the Overview's close on the island must not remove it for good: only a quit may close it. */
export function preventsIslandClose(s: { current: boolean; quitting: boolean }): boolean {
  return s.current && !s.quitting
}

/**
 * The island's own desktop entry (build/zumibot-island.desktop, hidden). Electron names a window's X11 WM_CLASS after
 * CHROME_DESKTOP, read when the window is made, so the island gets WM_CLASS zumibot-island and GNOME Shell files it
 * under that entry, not ZumiBot's. Filed under ZumiBot, the island was the app's only window once the main window
 * was hidden, and Ubuntu Dock's click activated it (it activates an app's first window, skip-taskbar or not) instead of
 * launching the second instance that shows the main window.
 */
export const ISLAND_DESKTOP_NAME = 'zumibot-island.desktop'

/** Runs `make` with CHROME_DESKTOP set to `name`, then puts the old value back (or none), even when it throws. */
export function withDesktopName<T>(env: NodeJS.ProcessEnv, name: string, make: () => T): T {
  const before = env['CHROME_DESKTOP']
  env['CHROME_DESKTOP'] = name
  try {
    return make()
  } finally {
    if (before === undefined) delete env['CHROME_DESKTOP']
    else env['CHROME_DESKTOP'] = before
  }
}

export interface IslandDrag {
  top: number
  screenY: number
  moved: boolean
}

/**
 * One step of a strip drag, tops on screen: the new drag, where to place the strip, and whether to save. The end places the
 * strip where the page slid it (`endTop`) or, from a page that sent moves, where the pointer took it, and saves only if that
 * is not where it began or a move went somewhere, so a plain click saves nothing.
 */
export function dragStep(
  d: IslandDrag | null,
  phase: 'start' | 'move' | 'end',
  screenY: number,
  top: number | null,
  endTop: number | null = null
): { drag: IslandDrag | null; place: number | null; save: boolean } {
  if (phase === 'start') return { drag: top === null ? null : { top, screenY, moved: false }, place: null, save: false }
  if (!d) return { drag: null, place: null, save: false }
  const at = d.top + (screenY - d.screenY)
  if (phase === 'move') return { drag: { ...d, moved: d.moved || at !== d.top }, place: at, save: false }
  const end = endTop ?? at
  return { drag: null, place: end, save: d.moved || end !== d.top }
}

const sameRect = (a: IslandRect, b: IslandRect): boolean => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

/** What takes the pointer and is drawn (window coordinates): the strip and popup, or while a drag lasts the columns they slide in. A voice-only island has no strip. */
export function islandShape(l: SlidingLayout, dragging: boolean): IslandRect[] {
  if (dragging) return l.popup ? [l.track, { x: 0, y: 0, width: POPUP_WIDTH, height: l.track.height }] : [l.track]
  const strip = l.strip.height > 0 ? [l.strip] : []
  return l.popup ? [...strip, l.popup] : strip
}

/** True when a screen point falls in one of the rects, given in the coordinates of a window at `at`. */
export function inShape(p: { x: number; y: number }, at: { x: number; y: number }, rects: readonly IslandRect[]): boolean {
  return rects.some((r) => p.x >= at.x + r.x && p.x < at.x + r.x + r.width && p.y >= at.y + r.y && p.y < at.y + r.y + r.height)
}

const HOVER_POLL_MS = 50 // how often a Mac island checks whether the pointer is over the strip or popup

export interface IslandDeps {
  /**
   * How the transparent rest of the window lets clicks through. 'shape' (default): `setShape`, which only Windows and
   * Linux have. 'cursor' (macOS): the window ignores the mouse, forwarding moves to the page, except while the pointer is
   * over the shape; without it the island's full-height column took every click on the right of the screen.
   */
  hitTest?: 'shape' | 'cursor'
  /** The pointer in screen coordinates; only 'cursor' asks. */
  cursor?(): { x: number; y: number }
  prefsFile: string
  preload: string
  /** The primary display's work area. */
  area(): IslandRect
  openMain(t: IslandOpenTarget): void
  openAttachment(url: string, name: string, origin: string): Promise<boolean>
  /** True once the app is really quitting: the island window may then close. */
  quitting(): boolean
}

export interface IslandHost {
  /** The desk shortcut: starts a voice conversation on the island, or asks the one that runs to stop. */
  voicePress(): void
  setOrigin(origin: string | null): void
  agentsChanged(): void
  dispose(): void
}

const URL_MAX = 4096
const NAME_MAX = 1000
const TOP_MAX = 1_000_000 // far past any screen; islandBounds clamps the rest

export function createIslandHost(d: IslandDeps): IslandHost {
  let origin: string | null = null
  let win: BrowserWindow | null = null
  let ready = false
  let failed = false // the last main-frame load failed: its URL says nothing about whether the page is there
  let icons = 0
  let open = false
  let voice = false // a voice conversation was asked for and its page has not said it is over
  let top: number | null = null // the strip's top as last placed (clamped), for a drag to start from
  let drag: IslandDrag | null = null
  let bounds: IslandRect | null = null // as last set: the window moves only with the work area
  let shape: IslandRect[] = [] // 'cursor' hit test: what takes the pointer, window coordinates
  let ignoring: boolean | null = null // 'cursor': the mouse state last set on the window
  let hoverTimer: ReturnType<typeof setInterval> | null = null

  function setHitArea(w: BrowserWindow, rects: IslandRect[]): void {
    if (d.hitTest !== 'cursor') {
      w.setShape(rects)
      return
    }
    shape = rects
    hover()
  }

  function hover(): void {
    if (!win || win.isDestroyed() || !bounds) return
    const over = drag !== null || inShape((d.cursor ?? (() => screen.getCursorScreenPoint()))(), bounds, shape)
    if (ignoring === !over) return
    ignoring = !over
    win.setIgnoreMouseEvents(!over, { forward: true })
  }

  const prefs = (): ReturnType<typeof loadIslandPrefs> => loadIslandPrefs(d.prefsFile)
  const agents = (): string[] => (origin === null ? [] : agentsFor(prefs(), origin))

  // The sender is the island's own top frame on the connected origin: the login page or a subframe never passes.
  const isSender = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean =>
    !!win &&
    !win.isDestroyed() &&
    origin !== null &&
    e.sender === win.webContents &&
    !!e.senderFrame &&
    e.senderFrame === e.sender.mainFrame &&
    isSameOrigin(e.senderFrame.url, origin)

  // Only the document the island page runs in counts as ready: a login redirect lands on another path.
  const onIslandPage = (): boolean => {
    if (!win || win.isDestroyed() || origin === null) return false
    try {
      const u = new URL(win.webContents.getURL())
      return u.origin === new URL(origin).origin && u.pathname === ISLAND_PATH
    } catch {
      return false
    }
  }

  function place(at?: number): void {
    if (!win || win.isDestroyed() || (icons < 1 && !voice)) return
    const p = islandBounds({ area: d.area(), top: at ?? prefs().top, icons, open })
    top = p.top
    // The window is the work area's column and moves only with it: under Mutter on some setups each move of it reached the
    // screen up to a second late, so a drag slides the strip inside it instead.
    if (!bounds || !sameRect(bounds, p.window)) {
      win.setBounds(p.window)
      bounds = p.window
    }
    // Window coordinates: the transparent rest is click-through on X11 and not drawn.
    setHitArea(win, islandShape(p.layout, drag !== null))
    win.webContents.send('island:layout', p.layout)
  }

  function destroyWindow(): void {
    const w = win
    win = null
    ready = false
    open = false
    voice = false // the page that ran it is gone
    drag = null
    bounds = null
    shape = []
    ignoring = null
    if (hoverTimer) clearInterval(hoverTimer)
    hoverTimer = null
    if (w && !w.isDestroyed()) w.destroy()
  }

  function createWindow(o: string): void {
    // Its own WM_CLASS (see ISLAND_DESKTOP_NAME): synchronous, so nothing else in this process sees the swapped name.
    const w = withDesktopName(
      process.env,
      ISLAND_DESKTOP_NAME,
      () =>
        new BrowserWindow({
          frame: false,
          transparent: true,
          backgroundColor: '#00000000',
          resizable: false,
          movable: false,
          minimizable: false,
          maximizable: false,
          fullscreenable: false,
          // skipTaskbar does nothing on Linux X11; the toolbar type is what makes the window manager skip the taskbar and
          // pager, which keeps the island out of the Super overview and Alt+Tab (GNOME Shell drops every skip-taskbar
          // window from both) and out of the dock's window count. It does not keep the dock from activating it: only its
          // own WM_CLASS does that.
          // Linux only: macOS has no such type (a frameless window is never in its Dock or Cmd+Tab list anyway).
          ...(d.hitTest === 'cursor' ? {} : { type: 'toolbar' }),
          skipTaskbar: true,
          alwaysOnTop: true,
          hasShadow: false,
          show: false,
          title: 'ZumiBot',
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webviewTag: false,
            preload: d.preload,
            additionalArguments: [`--zumibot-origin=${o}`, '--zumibot-island=1']
          }
        })
    )
    win = w
    failed = false
    bounds = null
    w.setAlwaysOnTop(true, 'floating')
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    lockToOrigin(w, o)
    if (d.hitTest === 'cursor') {
      w.setIgnoreMouseEvents(true, { forward: true })
      ignoring = true
      hoverTimer = setInterval(hover, HOVER_POLL_MS)
    }
    // A new document (reload, login redirect) has not said ready yet, and its popup is gone.
    w.webContents.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument || win !== w) return
      if (ready) voice = false // a reload or redirect of a page that was up ends its conversation; the first load keeps the request
      ready = false
      failed = false
      open = false
      drag = null
      apply()
    })
    w.webContents.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
      if (isMainFrame && code !== -3 && win === w) {
        ready = false
        failed = true
        apply()
      }
    })
    w.webContents.on('render-process-gone', () => {
      console.error('the island page crashed')
      if (win === w) destroyWindow() // comes back with the next origin or agent change
    })
    // Destroyed windows skip this (destroyWindow), so only a user's close lands here; a quit closes every window too.
    w.on('close', (e) => {
      if (preventsIslandClose({ current: win === w, quitting: d.quitting() })) e.preventDefault()
    })
    w.on('closed', () => {
      if (win === w) {
        if (hoverTimer) clearInterval(hoverTimer)
        hoverTimer = null
        win = null
        ready = false
      }
    })
    void w.loadURL(`${o}${ISLAND_PATH}`).catch(() => {})
  }

  function apply(): void {
    const state = islandWanted({ origin, picked: agents().length, ready, icons, voice, open })
    if (state === 'none') {
      destroyWindow()
      icons = 0
      return
    }
    if (!win || win.isDestroyed()) createWindow(origin!)
    if (!win) return
    place()
    if (state === 'shown') {
      if (!win.isVisible()) {
        win.showInactive() // never steals focus
        // X11: the sticky and every-workspace state is a message to the window manager, which takes it only once the
        // window is mapped (before the first show Mutter kept the window on workspace 1).
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
        bounds = null // the bounds and shape set on a window not yet mapped may not have reached X: apply them again now
        place()
      }
    } else win.hide()
  }

  const onReady = (e: Electron.IpcMainEvent): void => {
    if (!isSender(e) || !onIslandPage()) return
    ready = true
    apply()
    // A conversation asked for before the page was up: it listens from mount, so it hears this.
    if (voice && win && !win.isDestroyed()) win.webContents.send('island:voice', true)
  }
  const onVoiceEnded = (e: Electron.IpcMainEvent): void => {
    if (!isSender(e) || !voice) return
    voice = false
    apply()
  }
  const onShape = (e: Electron.IpcMainEvent, n: unknown, o: unknown): void => {
    if (!isSender(e) || typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > ISLAND_AGENTS_MAX || typeof o !== 'boolean') return
    icons = n
    open = o
    apply()
  }
  // The page's screenY is not used: X11 Chromium works it out from the window origin it asked for at setBounds, before the
  // window manager has moved the window, so it could run a move's delta past the pointer. The X pointer itself is the truth.
  // (Older shells read screenY, so the page still sends it.) A page that slides the strip itself sends no moves and gives its
  // final top, in window coordinates; an older page sends moves, and the strip then follows the pointer in the layout.
  const onDrag = (e: Electron.IpcMainEvent, phase: unknown, _screenY: unknown, slid: unknown): void => {
    if (!isSender(e)) return
    if (phase !== 'start' && phase !== 'move' && phase !== 'end') return
    const endTop =
      phase === 'end' && typeof slid === 'number' && Number.isFinite(slid) && Math.abs(slid) <= TOP_MAX
        ? Math.round(d.area().y) + slid
        : null
    const step = dragStep(drag, phase, screen.getCursorScreenPoint().y, top, endTop)
    drag = step.drag
    if (phase === 'start' && drag)
      place(drag.top) // the shape becomes the columns the page slides the strip and popup in
    else if (step.place !== null) place(step.place)
    if (step.save) {
      try {
        saveIslandPrefs(d.prefsFile, { ...prefs(), top })
      } catch (err) {
        console.error('saving the island position failed:', err)
      }
    }
  }
  const onOpenMain = (e: Electron.IpcMainEvent, raw: unknown): void => {
    if (!isSender(e)) return
    const t = parseIslandOpenTarget(raw)
    if (t) d.openMain(t)
  }
  const onAgents = (e: Electron.IpcMainInvokeEvent): string[] => (isSender(e) ? agents() : [])
  const onOpenAttachment = (e: Electron.IpcMainInvokeEvent, url: unknown, name: unknown): Promise<boolean> | boolean =>
    isSender(e) &&
    origin !== null &&
    typeof url === 'string' &&
    url.length <= URL_MAX &&
    typeof name === 'string' &&
    name.length <= NAME_MAX
      ? d.openAttachment(url, name, origin)
      : false

  ipcMain.on('island:ready', onReady)
  ipcMain.on('island:voiceEnded', onVoiceEnded)
  ipcMain.on('island:shape', onShape)
  ipcMain.on('island:drag', onDrag)
  ipcMain.on('island:openMain', onOpenMain)
  ipcMain.handle('island:agents', onAgents)
  ipcMain.handle('island:openAttachment', onOpenAttachment)

  const displayChanged = (): void => place()
  screen.on('display-metrics-changed', displayChanged)
  screen.on('display-added', displayChanged)
  screen.on('display-removed', displayChanged)

  return {
    voicePress() {
      if (origin === null) return
      if (!voice) {
        voice = true
        apply() // makes the window if no agent is picked; the page hears it once ready
        if (ready && win && !win.isDestroyed()) win.webContents.send('island:voice', true)
      } else if (ready && win && !win.isDestroyed()) {
        win.webContents.send('island:voice', false) // the page stops the talk and answers with voiceEnded
      } else {
        voice = false // no page to answer: do not leave a hidden window waiting
        apply()
      }
    },
    setOrigin(next) {
      if (next === origin) {
        // The main window is back on the app: bring a stranded island window (login page, failed load) back to its page.
        if (!win || win.isDestroyed()) apply()
        else if (
          origin !== null &&
          needsIslandLoad({ hasWindow: true, loading: win.webContents.isLoading(), onIsland: onIslandPage(), failed })
        ) {
          void win.loadURL(`${origin}${ISLAND_PATH}`).catch(() => {})
        }
        return
      }
      origin = next
      destroyWindow() // the preload's origin is fixed at creation, so another server gets a new window
      icons = 0
      apply()
    },
    agentsChanged() {
      apply()
      if (win && !win.isDestroyed()) win.webContents.send('island:agents', agents())
    },
    dispose() {
      ipcMain.removeListener('island:ready', onReady)
      ipcMain.removeListener('island:voiceEnded', onVoiceEnded)
      ipcMain.removeListener('island:shape', onShape)
      ipcMain.removeListener('island:drag', onDrag)
      ipcMain.removeListener('island:openMain', onOpenMain)
      ipcMain.removeHandler('island:agents')
      ipcMain.removeHandler('island:openAttachment')
      screen.removeListener('display-metrics-changed', displayChanged)
      screen.removeListener('display-added', displayChanged)
      screen.removeListener('display-removed', displayChanged)
      origin = null
      destroyWindow()
    }
  }
}
