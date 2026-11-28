import { BrowserWindow, nativeTheme, screen, type WebContents } from 'electron'
import { popoutPath } from '@zumibot/shared/popout'
import { loadPopoutSize, popoutBounds, savePopoutSize, type Rect } from './popoutLayout'
import { APP_ICON, lockToOrigin, whenRealScreen, windowBackground, zoomOnKey } from './window'
import { loadZoom } from './zoom'

// The page draws its header in this band (its min-height, popout.css); the shell draws the window buttons over its
// right end (left on a Mac), so the two must match.
const TITLE_BAR_HEIGHT = 48

export interface PopoutWindow {
  win: BrowserWindow
  origin: string
  chatId: string
}

export interface PopoutHost {
  /** Brings the chat's popout forward, or opens one: one window per chat. */
  open(origin: string, chatId: string): void
  /** The popout whose page sent an IPC message, if it is one. */
  find(sender: WebContents): PopoutWindow | null
  /** Closes every popout without asking: their server is being left, or the app quits. */
  closeAll(): void
}

export interface PopoutHostOptions {
  preload: string
  /** popout-state.json: the last popout's size, so the next opens the same. */
  stateFile: string
  /** zoom.json, the main window's: the zoom keys work in a popout too, and the factor is one per origin anyway. */
  zoomFile: string
  /** The main window's bounds when shown, which new popouts cascade from. */
  anchor(): Rect | null
}

const symbolColor = (): string => (nativeTheme.shouldUseDarkColors ? '#e6e8eb' : '#1f2328')

export function createPopoutHost(o: PopoutHostOptions): PopoutHost {
  const open = new Map<string, PopoutWindow>()

  const focus = (w: BrowserWindow): void => {
    if (w.isMinimized()) w.restore()
    whenRealScreen(w, () => {
      w.show()
      w.focus()
    })
  }

  return {
    open(origin, chatId) {
      const had = open.get(chatId)
      if (had && !had.win.isDestroyed() && had.origin === origin) return focus(had.win)
      const anchor = o.anchor()
      const area = (anchor ? screen.getDisplayMatching(anchor) : screen.getPrimaryDisplay()).workArea
      const w = new BrowserWindow({
        ...popoutBounds(loadPopoutSize(o.stateFile), anchor, open.size, area),
        minWidth: 480,
        minHeight: 360,
        title: 'ZumiBot',
        icon: APP_ICON,
        show: false,
        backgroundColor: windowBackground(),
        darkTheme: nativeTheme.shouldUseDarkColors,
        autoHideMenuBar: true,
        // The page's own header is the title bar; the window manager still moves and resizes the window. A Mac keeps its
        // traffic lights, elsewhere Chromium draws the buttons (Window Controls Overlay), recoloured by the page.
        titleBarStyle: 'hidden',
        ...(process.platform === 'darwin'
          ? { trafficLightPosition: { x: 14, y: 13 } }
          : { titleBarOverlay: { color: windowBackground(), symbolColor: symbolColor(), height: TITLE_BAR_HEIGHT } }),
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webviewTag: false,
          preload: o.preload,
          additionalArguments: [`--zumibot-origin=${origin}`, '--zumibot-popout=1']
        }
      })
      const entry: PopoutWindow = { win: w, origin, chatId }
      open.set(chatId, entry)
      lockToOrigin(w, origin)
      w.webContents.on('before-input-event', (e, input) => void zoomOnKey(w, o.zoomFile, e, input))
      w.webContents.on('did-finish-load', () => w.webContents.setZoomFactor(loadZoom(o.zoomFile)))
      w.once('ready-to-show', () => focus(w))
      w.on('close', () => {
        try {
          savePopoutSize(o.stateFile, w.getNormalBounds())
        } catch (err) {
          console.error('saving the popout size failed:', err)
        }
      })
      w.on('closed', () => {
        if (open.get(chatId) === entry) open.delete(chatId)
      })
      void w.loadURL(new URL(popoutPath(chatId), origin).href).catch(() => {})
    },
    find(sender) {
      for (const p of open.values()) if (!p.win.isDestroyed() && p.win.webContents === sender) return p
      return null
    },
    closeAll() {
      for (const p of [...open.values()]) if (!p.win.isDestroyed()) p.win.destroy()
      open.clear()
    }
  }
}

/** Recolours the window buttons to the page's header; a Mac draws its own traffic lights. */
export function setPopoutTitleBar(w: BrowserWindow, color: string, symbols: string): void {
  if (process.platform === 'darwin' || w.isDestroyed()) return
  w.setTitleBarOverlay({ color, symbolColor: symbols, height: TITLE_BAR_HEIGHT })
}
