import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createScreenWaits, hasRealScreen, whenScreen } from '../src/main/screenGuard'

const display = (width: number, height: number): { bounds: { width: number; height: number } } => ({ bounds: { width, height } })

describe('hasRealScreen', () => {
  it('is true for an ordinary monitor, alone or among others', () => {
    expect(hasRealScreen([display(1920, 1080)])).toBe(true)
    expect(hasRealScreen([display(1366, 768), display(2560, 1440)])).toBe(true)
  })

  it('is false for no display at all', () => {
    expect(hasRealScreen([])).toBe(false)
  })

  it('is false for the 32x32 stand-in X reports while the window manager has no monitor', () => {
    expect(hasRealScreen([display(32, 32)])).toBe(false)
  })

  it('is true as soon as any one display is real', () => {
    expect(hasRealScreen([display(32, 32), display(1920, 1080)])).toBe(true)
  })
})

describe('whenScreen', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function setup(usable: boolean) {
    const s = { usable, ran: 0, gone: false, listeners: new Set<() => void>() }
    const cancel = whenScreen({
      usable: () => s.usable,
      onChange: (cb) => {
        s.listeners.add(cb)
        return () => s.listeners.delete(cb)
      },
      run: () => {
        s.ran++
      },
      isGone: () => s.gone,
      settleMs: 500
    })
    const change = (): void => [...s.listeners].forEach((cb) => cb())
    return { s, change, cancel }
  }

  it('runs at once when a screen is there, and subscribes to nothing', () => {
    const { s } = setup(true)
    expect(s.ran).toBe(1)
    expect(s.listeners.size).toBe(0)
  })

  it('waits while there is no screen, then runs once the screen has stayed for settleMs', () => {
    const { s, change } = setup(false)
    change()
    vi.advanceTimersByTime(1000)
    expect(s.ran).toBe(0)
    s.usable = true
    change()
    vi.advanceTimersByTime(499)
    expect(s.ran).toBe(0)
    vi.advanceTimersByTime(1)
    expect(s.ran).toBe(1)
    expect(s.listeners.size).toBe(0)
    change()
    vi.advanceTimersByTime(1000)
    expect(s.ran).toBe(1)
  })

  it('starts the wait over when the screen goes away again', () => {
    const { s, change } = setup(false)
    s.usable = true
    change()
    vi.advanceTimersByTime(400)
    s.usable = false
    change()
    vi.advanceTimersByTime(1000)
    expect(s.ran).toBe(0)
    s.usable = true
    change()
    vi.advanceTimersByTime(500)
    expect(s.ran).toBe(1)
  })

  it('never runs for a window that is gone, and lets go of the listener', () => {
    const { s, change } = setup(false)
    s.usable = true
    change()
    s.gone = true
    vi.advanceTimersByTime(500)
    expect(s.ran).toBe(0)
    expect(s.listeners.size).toBe(0)
  })

  it('keeps waiting when the screen is gone again by the end of the settle', () => {
    const { s, change } = setup(false)
    s.usable = true
    change()
    s.usable = false // lost before the timer fires, and no display event told the wait
    vi.advanceTimersByTime(500)
    expect(s.ran).toBe(0)
    expect(s.listeners.size).toBe(1)
    s.usable = true
    change()
    vi.advanceTimersByTime(500)
    expect(s.ran).toBe(1)
  })

  it('a cancel drops the listeners and the timer, and nothing runs after it', () => {
    const { s, change, cancel } = setup(false)
    s.usable = true
    change()
    cancel()
    expect(s.listeners.size).toBe(0)
    vi.advanceTimersByTime(1000)
    expect(s.ran).toBe(0)
  })

  it('survives an onChange that fires its callback before it returns', () => {
    let ran = 0
    let usable = false
    let unsubscribed = 0
    whenScreen({
      usable: () => usable,
      onChange: (cb) => {
        usable = true
        cb()
        return () => void unsubscribed++
      },
      run: () => void ran++,
      isGone: () => false,
      settleMs: 10
    })
    vi.advanceTimersByTime(10)
    expect(ran).toBe(1)
    expect(unsubscribed).toBe(1)
  })
})

describe('createScreenWaits', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function setup(usable = false) {
    const s = { usable, subscribed: 0, listeners: new Set<() => void>() }
    const waits = createScreenWaits<object>(() => ({
      usable: () => s.usable,
      onChange: (cb) => {
        s.subscribed++
        s.listeners.add(cb)
        return () => s.listeners.delete(cb)
      },
      isGone: () => false,
      settleMs: 500
    }))
    const change = (): void => [...s.listeners].forEach((cb) => cb())
    return { s, waits, change }
  }

  it('runs at once with a screen there', () => {
    const { s, waits } = setup(true)
    const run = vi.fn()
    waits.when({}, run)
    expect(run).toHaveBeenCalledOnce()
    expect(s.subscribed).toBe(0)
  })

  it('repeated calls for one window share one wait and run only the latest, once', () => {
    const { s, waits, change } = setup()
    const w = {}
    const runs = [vi.fn(), vi.fn(), vi.fn()]
    for (const r of runs) waits.when(w, r)
    expect(s.subscribed).toBe(1)
    expect(s.listeners.size).toBe(1)
    s.usable = true
    change()
    vi.advanceTimersByTime(500)
    expect(runs[0]).not.toHaveBeenCalled()
    expect(runs[1]).not.toHaveBeenCalled()
    expect(runs[2]).toHaveBeenCalledOnce()
    expect(s.listeners.size).toBe(0)
  })

  it('another window waits on its own', () => {
    const { s, waits } = setup()
    waits.when({}, () => {})
    waits.when({}, () => {})
    expect(s.listeners.size).toBe(2)
  })

  it('a call made from inside run starts a fresh wait', () => {
    const { s, waits, change } = setup()
    const w = {}
    const second = vi.fn()
    waits.when(w, () => {
      s.usable = false
      waits.when(w, second)
    })
    s.usable = true
    change()
    vi.advanceTimersByTime(500)
    expect(second).not.toHaveBeenCalled()
    expect(s.listeners.size).toBe(1)
    s.usable = true
    change()
    vi.advanceTimersByTime(500)
    expect(second).toHaveBeenCalledOnce()
  })

  it('cancel (the window closed) removes the listeners with no display event, and a new call waits afresh', () => {
    const { s, waits } = setup()
    const w = {}
    const run = vi.fn()
    waits.when(w, run)
    waits.cancel(w)
    expect(s.listeners.size).toBe(0)
    waits.cancel(w) // harmless twice
    waits.when(w, run)
    expect(s.listeners.size).toBe(1)
  })
})
