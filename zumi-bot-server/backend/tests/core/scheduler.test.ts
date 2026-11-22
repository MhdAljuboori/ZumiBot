import { describe, expect, it, vi } from 'vitest'
import type { Routine, Schedule } from '@zumibot/shared/routines'
import { createScheduler, LATE_AFTER_MS, TICK_MAX_MS } from '../../src/core/routines/scheduler'

const T = Date.UTC(2026, 9, 27, 9)
function routine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: 'r1',
    name: 'Daily',
    enabled: true,
    timeZone: 'UTC',
    trigger: { kind: 'schedule', schedule: { freq: 'daily', time: '09:00', days: [0, 1, 2, 3, 4, 5, 6] } },
    target: { kind: 'chat', chatId: 'c1' },
    prompt: 'hello',
    nextRunAt: T,
    createdAt: T,
    updatedAt: T,
    ...overrides
  }
}
function harness(rows: Routine[], at = T) {
  let now = at
  const timers: Array<{ fn: () => void; ms: number; clear(): void; cleared: boolean }> = []
  const calls: string[] = []
  const store = {
    list: vi.fn(async () => rows),
    update: vi.fn(async (id: string, fn: (r: Routine) => Routine | null) => {
      calls.push(`update:${id}`)
      const index = rows.findIndex((x) => x.id === id)
      if (index < 0) return null
      const updated = fn(rows[index]!)
      if (!updated) return null
      rows[index] = updated
      return updated
    })
  }
  const run = vi.fn(async (r: Routine, _via: 'schedule', opts?: { late?: boolean }) => {
    calls.push(`run:${r.id}:${opts?.late}`)
    return {
      id: 'run',
      routineId: r.id,
      via: 'schedule' as const,
      status: 'running' as const,
      late: opts?.late ?? false,
      chatId: null,
      messageId: null,
      startedAt: now
    }
  })
  const d = {
    store,
    runner: { run },
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const timer = {
        fn,
        ms,
        cleared: false,
        clear() {
          this.cleared = true
        }
      }
      timers.push(timer)
      return timer
    },
    onError: vi.fn()
  }
  return {
    d,
    rows,
    timers,
    calls,
    run,
    store,
    setNow: (n: number) => {
      now = n
    }
  }
}

describe('routine scheduler', () => {
  it('fires a due daily routine once, saves its next time before running, and marks it not late', async () => {
    const h = harness([routine()], T + 10_000)
    const scheduler = createScheduler(h.d)
    await scheduler.start()
    expect(h.run).toHaveBeenCalledTimes(1)
    expect(h.run.mock.calls[0]?.[2]).toEqual({ late: false })
    expect(h.rows[0]?.nextRunAt).toBe(T + 24 * 60 * 60_000)
    expect(h.calls).toEqual(['update:r1', 'run:r1:false'])
  })

  it('collapses a week of missed runs into one late run', async () => {
    const h = harness([routine()], T + 7 * 24 * 60 * 60_000)
    await createScheduler(h.d).start()
    expect(h.run).toHaveBeenCalledTimes(1)
    expect(h.run.mock.calls[0]?.[2]).toEqual({ late: true })
  })

  it('turns a once routine off before firing it', async () => {
    const once = routine({ trigger: { kind: 'schedule', schedule: { freq: 'once', date: '2026-10-27', time: '09:00' } } })
    const h = harness([once], T + 1)
    await createScheduler(h.d).start()
    expect(h.rows[0]).toMatchObject({ enabled: false, nextRunAt: null })
    expect(h.calls).toEqual(['update:r1', 'run:r1:false'])
  })

  it('does not fire disabled routines', async () => {
    const h = harness([routine({ enabled: false })], T + 1)
    await createScheduler(h.d).start()
    expect(h.run).not.toHaveBeenCalled()
  })

  it('saves a missing next time and disables a once schedule that cannot fire', async () => {
    const once = routine({
      enabled: true,
      nextRunAt: null,
      timeZone: 'Invalid/Zone',
      trigger: { kind: 'schedule', schedule: { freq: 'once', date: '2026-10-27', time: '09:00' } }
    })
    const h = harness([once], T - 1)
    await createScheduler(h.d).start()
    expect(h.rows[0]).toMatchObject({ enabled: false, nextRunAt: null })
    expect(h.run).not.toHaveBeenCalled()
  })

  it('serializes rearm requests made during a run', async () => {
    const h = harness([routine()], T + 1)
    let release!: () => void
    h.run.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              id: 'run',
              routineId: 'r1',
              via: 'schedule',
              status: 'running',
              late: false,
              chatId: null,
              messageId: null,
              startedAt: T
            })
        })
    )
    const scheduler = createScheduler(h.d)
    const started = scheduler.start()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    const rearm = [scheduler.rearm(), scheduler.rearm(), scheduler.rearm()]
    expect(h.run).toHaveBeenCalledTimes(1)
    release()
    await Promise.all([started, ...rearm])
    expect(h.run).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent rearm calls into one tick', async () => {
    const h = harness([routine()], T + 1)
    const scheduler = createScheduler(h.d)
    await Promise.all([scheduler.rearm(), scheduler.rearm()])
    expect(h.run).toHaveBeenCalledTimes(1)
  })

  it('caps the timer delay and continues to arm after a runner rejection', async () => {
    const h = harness([routine()], T + 1)
    h.run.mockRejectedValueOnce(new Error('run failed'))
    const scheduler = createScheduler({ ...h.d, onError: h.d.onError })
    await scheduler.start()
    expect(h.timers.at(-1)?.ms).toBe(TICK_MAX_MS)
    expect(h.d.onError).toHaveBeenCalled()
    expect(LATE_AFTER_MS).toBe(120_000)
  })

  it('uses a fallback timer when list rejects, then succeeds on the next tick', async () => {
    const h = harness([routine()], T + 1)
    h.store.list.mockRejectedValueOnce(new Error('temporary list failure'))
    const scheduler = createScheduler(h.d)
    await scheduler.start()
    expect(h.timers.at(-1)?.ms).toBe(TICK_MAX_MS)
    await scheduler.rearm()
    expect(h.run).toHaveBeenCalledTimes(1)
  })

  it('backs off after a routine update failure', async () => {
    const h = harness([routine()], T + 1)
    h.store.update.mockRejectedValueOnce(new Error('temporary write failure'))
    await createScheduler(h.d).start()
    expect(h.timers.at(-1)?.ms).toBe(TICK_MAX_MS)
    expect(h.d.onError).toHaveBeenCalled()
  })

  it('honors a disable saved while an earlier routine is running', async () => {
    const first = routine({ id: 'first' })
    const second = routine({ id: 'second' })
    const h = harness([first, second], T + 1)
    let unblock!: () => void
    h.run.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        unblock = resolve
      })
      await h.d.store.update('second', (r) => ({ ...r, enabled: false, prompt: 'edited' }))
      return {
        id: 'first-run',
        routineId: 'first',
        via: 'schedule',
        status: 'running',
        late: false,
        chatId: null,
        messageId: null,
        startedAt: T
      }
    })
    const scheduler = createScheduler(h.d)
    const tick = scheduler.start()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    unblock()
    await tick
    expect(h.rows.find((r) => r.id === 'second')).toMatchObject({ enabled: false, prompt: 'edited', nextRunAt: T })
    expect(h.run).toHaveBeenCalledTimes(1)
  })

  it('does not resurrect a routine deleted during an earlier run', async () => {
    const first = routine({ id: 'first' })
    const second = routine({ id: 'second' })
    const h = harness([first, second], T + 1)
    h.run.mockImplementationOnce(async () => {
      h.rows.splice(
        h.rows.findIndex((r) => r.id === 'second'),
        1
      )
      return {
        id: 'first-run',
        routineId: 'first',
        via: 'schedule',
        status: 'running',
        late: false,
        chatId: null,
        messageId: null,
        startedAt: T
      }
    })
    await createScheduler(h.d).start()
    expect(h.rows.map((r) => r.id)).toEqual(['first'])
    expect(h.run).toHaveBeenCalledTimes(1)
  })

  it('schedules a workflow-shaped item', async () => {
    interface Item {
      id: string
      enabled: boolean
      timeZone: string
      trigger: { kind: 'schedule'; schedule: Schedule }
      nextRunAt: number | null
    }
    const rows: Item[] = [
      {
        id: 'w1',
        enabled: true,
        timeZone: 'UTC',
        nextRunAt: T,
        trigger: { kind: 'schedule', schedule: { freq: 'daily', time: '09:00', days: [0, 1, 2, 3, 4, 5, 6] } }
      }
    ]
    const run = vi.fn(async (_t: Item, _via: 'schedule', _o: { late: boolean }) => ({}))
    const scheduler = createScheduler<Item>({
      store: {
        list: async () => rows,
        update: async (id, fn) => {
          const index = rows.findIndex((x) => x.id === id)
          const updated = index < 0 ? null : fn(rows[index]!)
          if (updated) rows[index] = updated
          return updated
        }
      },
      runner: { run },
      now: () => T + 10_000,
      setTimer: () => ({ clear() {} }),
      onError: vi.fn()
    })
    await scheduler.start()
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]?.[0].id).toBe('w1')
    expect(run.mock.calls[0]?.[2]).toEqual({ late: false })
    expect(rows[0]?.nextRunAt).toBe(T + 24 * 60 * 60_000)
  })
})
