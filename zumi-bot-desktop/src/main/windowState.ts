import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** The window's normal (not maximized) bounds, and whether it was maximized over them. */
export interface WindowState {
  bounds: Rect
  maximized: boolean
}

const MIN_VISIBLE = 100 // px, each way, of a saved window that must still land on a screen to reopen there

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export function parseWindowState(raw: unknown): WindowState | null {
  if (!raw || typeof raw !== 'object') return null
  const { bounds: b, maximized } = raw as { bounds?: Partial<Rect>; maximized?: unknown }
  if (!b || typeof b !== 'object' || ![b.x, b.y, b.width, b.height].every(isNum)) return null
  const bounds = { x: Math.round(b.x!), y: Math.round(b.y!), width: Math.round(b.width!), height: Math.round(b.height!) }
  if (bounds.width <= 0 || bounds.height <= 0) return null
  return { bounds, maximized: maximized === true }
}

// Read and written synchronously: the last save happens on window close, right before the app quits.
export function loadWindowState(file: string): WindowState | null {
  try {
    return parseWindowState(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return null
  }
}

export function saveWindowState(file: string, s: WindowState): void {
  const tmp = join(dirname(file), `.${basename(file)}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

const overlap = (a: Rect, b: Rect): { width: number; height: number } => ({
  width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
  height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
})

/**
 * Where the window opens: the saved size, shrunk to fit and moved fully onto the screen it mostly sits on. With no
 * saved state, or a saved spot no screen shows enough of anymore, x/y are left out so the window opens centered.
 * workAreas: the screens' work areas, primary first.
 */
export function initialBounds(
  saved: WindowState | null,
  workAreas: Rect[],
  fallback: { width: number; height: number }
): { x?: number; y?: number; width: number; height: number } {
  if (!saved) return { ...fallback }
  const b = saved.bounds
  let best: Rect | null = null
  let bestArea = 0
  for (const wa of workAreas) {
    const o = overlap(b, wa)
    if (o.width < Math.min(MIN_VISIBLE, b.width) || o.height < Math.min(MIN_VISIBLE, b.height)) continue
    if (o.width * o.height > bestArea) {
      best = wa
      bestArea = o.width * o.height
    }
  }
  const fit = best ?? workAreas[0]
  const width = fit ? Math.min(b.width, fit.width) : b.width
  const height = fit ? Math.min(b.height, fit.height) : b.height
  if (!best) return { width, height }
  const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(v, hi))
  return {
    x: clamp(b.x, best.x, best.x + best.width - width),
    y: clamp(b.y, best.y, best.y + best.height - height),
    width,
    height
  }
}

/** What the window reports right now. */
export interface WindowSnapshot {
  bounds: Rect
  maximized: boolean
  minimized: boolean
  fullScreen: boolean
}

export interface WindowStateTrackerDeps {
  initial: Rect // the bounds the window opened with: its normal bounds until it is seen at its normal size
  read(): WindowSnapshot | null // null once the window is gone
  save(s: WindowState): void
  delayMs: number
  onError(err: unknown): void
}

/**
 * Saves the window's state delayMs after the last move/resize/maximize, or at once on flush() (window close).
 * The normal bounds are tracked here, not taken from getNormalBounds(), which on Linux reports the maximized bounds;
 * and they are read once events have stopped, since a resize can come in before isMaximized() turns true.
 */
export function createWindowStateTracker(d: WindowStateTrackerDeps): { changed(): void; flush(): void } {
  let normal = d.initial
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    try {
      const s = d.read()
      if (!s) return
      if (!s.maximized && !s.minimized && !s.fullScreen) normal = s.bounds
      d.save({ bounds: normal, maximized: s.maximized })
    } catch (err) {
      d.onError(err)
    }
  }
  return {
    changed() {
      if (timer) clearTimeout(timer)
      timer = setTimeout(flush, d.delayMs)
    },
    flush
  }
}

export interface ShowMaximizedDeps {
  show(): void
  maximize(): void
  onMove(cb: () => void): () => void // subscribes to the window's move events; returns the unsubscribe
  isGone(): boolean
  settleMs: number
}

/**
 * Shows the window, then maximizes it once the window manager has stopped moving it into place. On GNOME/X11 a
 * maximize asked for before that (even before show) is undone ~100ms after the window maps, when its frame arrives.
 */
export function showMaximized(d: ShowMaximizedDeps): void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const settled = (): void => {
    off()
    if (!d.isGone()) d.maximize()
  }
  const moved = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(settled, d.settleMs)
  }
  const off = d.onMove(moved)
  d.show()
  moved()
}

/**
 * Shows a window that was hidden (closed to the tray). One hidden maximized is mapped at its normal size and maximized
 * once placed (`showMaximized`, as on the first show): mapped maximized, Mutter took the maximize and dropped it about
 * 100 ms later, so the window came back at its normal size. While the window is unmapped, unmaximize only changes the
 * state Chromium keeps for the next map; nothing reaches the window manager.
 */
export function showHiddenWindow(w: { isMaximized(): boolean; unmaximize(): void; show(): void }, showMaximized: () => void): void {
  if (!w.isMaximized()) return w.show()
  w.unmaximize()
  showMaximized()
}
