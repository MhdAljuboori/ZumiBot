/**
 * Mutter 46 (Ubuntu 24.04, X11) aborts the whole desktop (libmutter assertion `logical_monitor`, in meta_window_unmaximize)
 * when a window that is flagged maximized gets a "remove maximized" message while Mutter has no monitor at all. Chromium
 * sends that message after a show, and a window reopened maximized is flagged within ms of it. X reports a 32x32 stand-in
 * display (its minimum screen) while the window manager has no monitor, e.g. one asleep or being re-detected, so the main
 * window is neither shown nor maximized until a real screen is back.
 */
export const MIN_SCREEN = 64 // px: X's own minimum screen is 32x32, and no real monitor is near this small

export function hasRealScreen(displays: { bounds: { width: number; height: number } }[]): boolean {
  return displays.some((d) => d.bounds.width > MIN_SCREEN && d.bounds.height > MIN_SCREEN)
}

export interface WhenScreenDeps {
  usable(): boolean
  /** Subscribes to display changes; returns the unsubscribe. */
  onChange(cb: () => void): () => void
  run(): void
  isGone(): boolean
  /** After a wait, how long the screen must have stayed real before `run`: Mutter handles the same RandR change a moment after Electron sees it. */
  settleMs: number
}

/**
 * Runs `run` now when a real screen is there; else once one has appeared and stayed for `settleMs` (a screen that
 * vanishes again in that time starts the wait over; a window that is gone by then never runs). Returns the cancel,
 * which drops the listeners and the timer.
 */
export function whenScreen(d: WhenScreenDeps): () => void {
  if (d.usable()) {
    d.run()
    return () => {}
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  let ended = false
  let unsubscribe = () => {} // assigned below: a callback fired inside onChange must not hit it before it exists
  const off = (): void => {
    ended = true
    if (timer) clearTimeout(timer)
    timer = null
    unsubscribe()
  }
  const finish = (): void => {
    timer = null
    if (d.isGone()) return off()
    if (!d.usable()) return // the screen went away during the settle: keep waiting
    off()
    d.run()
  }
  const changed = (): void => {
    if (ended) return
    if (timer) clearTimeout(timer)
    timer = null
    if (d.isGone()) return off()
    if (d.usable()) timer = setTimeout(finish, d.settleMs)
  }
  unsubscribe = d.onChange(changed)
  if (ended) unsubscribe()
  return off
}

/**
 * At most one pending wait per key (a window): a later call only replaces what runs, so N presses of tray Open run one
 * show, not N, and `screen` never collects N listeners. `cancel(key)` (the window closed) drops the wait.
 */
export function createScreenWaits<K extends object>(
  mk: (key: K) => Omit<WhenScreenDeps, 'run'>
): {
  when(key: K, run: () => void): void
  cancel(key: K): void
} {
  const pending = new WeakMap<K, { run: () => void; cancel: () => void }>()
  return {
    when(key, run) {
      const p = pending.get(key)
      if (p) {
        p.run = run // latest wins
        return
      }
      const entry = { run, cancel: () => {} }
      pending.set(key, entry)
      entry.cancel = whenScreen({
        ...mk(key),
        run: () => {
          pending.delete(key)
          entry.run()
        }
      })
    },
    cancel(key) {
      const p = pending.get(key)
      if (!p) return
      pending.delete(key)
      p.cancel()
    }
  }
}
