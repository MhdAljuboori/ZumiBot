import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import {
  createWindowStateTracker,
  initialBounds,
  loadWindowState,
  parseWindowState,
  saveWindowState,
  showHiddenWindow,
  showMaximized,
  type WindowSnapshot,
  type WindowState
} from '../src/main/windowState'

const screenA = { x: 0, y: 0, width: 1920, height: 1050 }
const screenB = { x: 1920, y: 0, width: 1280, height: 1000 }
const fallback = { width: 1200, height: 800 }
const state = (x: number, y: number, width: number, height: number, maximized = false): WindowState => ({
  bounds: { x, y, width, height },
  maximized
})

describe('parseWindowState', () => {
  it('reads bounds and maximized, rounding to whole pixels', () => {
    expect(parseWindowState({ bounds: { x: 10.4, y: -5, width: 900.6, height: 600 }, maximized: true })).toEqual(
      state(10, -5, 901, 600, true)
    )
  })

  it('treats a missing or non-boolean maximized as not maximized', () => {
    expect(parseWindowState({ bounds: { x: 0, y: 0, width: 900, height: 600 } })?.maximized).toBe(false)
    expect(parseWindowState({ bounds: { x: 0, y: 0, width: 900, height: 600 }, maximized: 'yes' })?.maximized).toBe(false)
  })

  it('rejects anything without four finite numbers and a positive size', () => {
    for (const bad of [
      null,
      5,
      {},
      { bounds: null },
      { bounds: { x: 0, y: 0, width: 900 } },
      { bounds: { x: '0', y: 0, width: 900, height: 600 } },
      { bounds: { x: 0, y: 0, width: Infinity, height: 600 } },
      { bounds: { x: 0, y: 0, width: 0, height: 600 } }
    ]) {
      expect(parseWindowState(bad)).toBeNull()
    }
  })
})

describe('loadWindowState / saveWindowState', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-window-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('round-trips and leaves no temp file behind', async () => {
    const file = join(dir, 'window-state.json')
    saveWindowState(file, state(40, 50, 1000, 700, true))
    expect(loadWindowState(file)).toEqual(state(40, 50, 1000, 700, true))
    expect(await fs.readdir(dir)).toEqual(['window-state.json'])
  })

  it('returns null for a missing or corrupt file', async () => {
    const file = join(dir, 'window-state.json')
    expect(loadWindowState(file)).toBeNull()
    await fs.writeFile(file, '{oops')
    expect(loadWindowState(file)).toBeNull()
  })

  it('throws when the folder is gone', () => {
    expect(() => saveWindowState(join(dir, 'missing', 'window-state.json'), state(0, 0, 900, 600))).toThrow()
  })
})

describe('initialBounds', () => {
  it('uses the default size, centered, with nothing saved', () => {
    expect(initialBounds(null, [screenA], fallback)).toEqual(fallback)
  })

  it('reopens at the saved spot and size', () => {
    expect(initialBounds(state(100, 80, 1000, 700), [screenA, screenB], fallback)).toEqual({ x: 100, y: 80, width: 1000, height: 700 })
    expect(initialBounds(state(2000, 50, 900, 600), [screenA, screenB], fallback)).toEqual({ x: 2000, y: 50, width: 900, height: 600 })
  })

  it('moves a window hanging off the edge fully onto its screen', () => {
    expect(initialBounds(state(1500, -40, 1000, 700), [screenA], fallback)).toEqual({ x: 920, y: 0, width: 1000, height: 700 })
  })

  it('picks the screen the window mostly sits on', () => {
    expect(initialBounds(state(1700, 100, 1000, 700), [screenA, screenB], fallback)).toEqual({ x: 1920, y: 100, width: 1000, height: 700 })
  })

  it('shrinks a window bigger than its screen', () => {
    expect(initialBounds(state(1920, 0, 1600, 1200), [screenA, screenB], fallback)).toEqual({ x: 1920, y: 0, width: 1280, height: 1000 })
  })

  it('centers a window whose screen is gone, fitted to the primary screen', () => {
    expect(initialBounds(state(2000, 50, 900, 600), [screenA], fallback)).toEqual({ width: 900, height: 600 })
    expect(initialBounds(state(2000, 50, 2400, 1400), [screenA], fallback)).toEqual({ width: 1920, height: 1050 })
  })

  it('centers a window only a sliver of which is still on screen', () => {
    expect(initialBounds(state(1850, 100, 1000, 700), [screenA], fallback)).toEqual({ width: 1000, height: 700 })
  })
})

describe('createWindowStateTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const rest = (x: number, y: number, width: number, height: number): WindowSnapshot => ({
    bounds: { x, y, width, height },
    maximized: false,
    minimized: false,
    fullScreen: false
  })
  const maxed: WindowSnapshot = { bounds: { x: 0, y: 0, width: 1920, height: 1050 }, maximized: true, minimized: false, fullScreen: false }

  function setup(initial = { x: 0, y: 0, width: 900, height: 600 }) {
    const s = { current: rest(0, 0, 900, 600) as WindowSnapshot | null, saved: [] as WindowState[] }
    const tracker = createWindowStateTracker({
      initial,
      read: () => s.current,
      save: (v) => s.saved.push(v),
      delayMs: 500,
      onError: (err) => {
        throw err
      }
    })
    return { s, tracker }
  }

  it('saves once, after the window has stayed put', () => {
    const { s, tracker } = setup()
    tracker.changed()
    vi.advanceTimersByTime(400)
    s.current = rest(5, 5, 950, 650)
    tracker.changed()
    vi.advanceTimersByTime(400)
    expect(s.saved).toEqual([])
    vi.advanceTimersByTime(100)
    expect(s.saved).toEqual([state(5, 5, 950, 650)])
  })

  it('flush saves at once and cancels the pending save', () => {
    const { s, tracker } = setup()
    tracker.changed()
    tracker.flush()
    expect(s.saved).toEqual([state(0, 0, 900, 600)])
    vi.advanceTimersByTime(1000)
    expect(s.saved).toHaveLength(1)
  })

  it('keeps the last normal bounds while maximized, minimized or full screen', () => {
    const { s, tracker } = setup()
    s.current = rest(30, 40, 1000, 700)
    tracker.flush()
    s.current = maxed
    tracker.flush()
    s.current = { ...maxed, minimized: true }
    tracker.flush()
    s.current = { ...rest(0, 0, 1920, 1080), fullScreen: true }
    tracker.flush()
    expect(s.saved).toEqual([
      state(30, 40, 1000, 700),
      state(30, 40, 1000, 700, true),
      state(30, 40, 1000, 700, true),
      state(30, 40, 1000, 700)
    ])
  })

  it('keeps the bounds it opened with for a window that opened maximized', () => {
    const { s, tracker } = setup({ x: 100, y: 80, width: 1000, height: 650 })
    s.current = maxed
    tracker.flush()
    expect(s.saved).toEqual([state(100, 80, 1000, 650, true)])
  })

  it('skips the save once the window is gone', () => {
    const { s, tracker } = setup()
    tracker.changed()
    s.current = null
    vi.advanceTimersByTime(500)
    tracker.flush()
    expect(s.saved).toEqual([])
  })

  it('reports a failed save instead of throwing', () => {
    const errors: unknown[] = []
    const tracker = createWindowStateTracker({
      initial: { x: 0, y: 0, width: 900, height: 600 },
      read: () => rest(0, 0, 900, 600),
      save: () => {
        throw new Error('disk full')
      },
      delayMs: 500,
      onError: (err) => errors.push(err)
    })
    expect(() => tracker.flush()).not.toThrow()
    expect(errors).toHaveLength(1)
  })
})

describe('showMaximized', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function setup() {
    const s = { calls: [] as string[], listeners: new Set<() => void>(), gone: false }
    const move = (): void => s.listeners.forEach((cb) => cb())
    showMaximized({
      show: () => s.calls.push('show'),
      maximize: () => s.calls.push('maximize'),
      onMove: (cb) => {
        s.listeners.add(cb)
        return () => s.listeners.delete(cb)
      },
      isGone: () => s.gone,
      settleMs: 50
    })
    return { s, move }
  }

  it('shows at once and maximizes once the window has stopped moving', () => {
    const { s, move } = setup()
    expect(s.calls).toEqual(['show'])
    vi.advanceTimersByTime(40)
    move()
    vi.advanceTimersByTime(40)
    move()
    vi.advanceTimersByTime(40)
    expect(s.calls).toEqual(['show'])
    vi.advanceTimersByTime(10)
    expect(s.calls).toEqual(['show', 'maximize'])
    expect(s.listeners.size).toBe(0)
  })

  it('maximizes after settleMs when the window never moves', () => {
    const { s } = setup()
    vi.advanceTimersByTime(50)
    expect(s.calls).toEqual(['show', 'maximize'])
  })

  it('does nothing once the window is gone', () => {
    const { s } = setup()
    s.gone = true
    vi.advanceTimersByTime(50)
    expect(s.calls).toEqual(['show'])
    expect(s.listeners.size).toBe(0)
  })
})

describe('showHiddenWindow', () => {
  const run = (maximized: boolean): string[] => {
    const calls: string[] = []
    let max = maximized
    showHiddenWindow(
      {
        isMaximized: () => max,
        unmaximize: () => {
          calls.push('unmaximize')
          max = false
        },
        show: () => calls.push('show')
      },
      () => calls.push('showMaximized')
    )
    return calls
  }

  it('shows a window hidden at its normal size as it is', () => {
    expect(run(false)).toEqual(['show'])
  })

  it('maps a window hidden maximized at its normal size and maximizes it once placed, as the first show does', () => {
    // Mapped maximized, Mutter dropped the maximize ~100 ms later and the window came back at its normal size.
    expect(run(true)).toEqual(['unmaximize', 'showMaximized'])
  })
})
