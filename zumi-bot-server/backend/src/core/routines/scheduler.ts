import { nextRun } from '@zumibot/shared/schedule'
import type { Schedule } from '@zumibot/shared/routines'

export const LATE_AFTER_MS = 120_000
export const TICK_MAX_MS = 60_000

/** What the scheduler needs of a routine or a workflow: both keep their schedule in `trigger`. */
export interface Scheduled {
  id: string
  enabled: boolean
  timeZone: string
  trigger: { kind: string; schedule?: Schedule }
  nextRunAt: number | null
}

export interface SchedulerDeps<T extends Scheduled> {
  store: { list(): Promise<T[]>; update(id: string, fn: (t: T) => T | null): Promise<T | null> }
  runner: { run(t: T, via: 'schedule', o: { late: boolean }): Promise<unknown> }
  now(): number
  setTimer(fn: () => void, ms: number): { clear(): void }
  onError(err: unknown): void
}

export function createScheduler<T extends Scheduled>(
  d: SchedulerDeps<T>
): { start(): Promise<void>; rearm(): Promise<void>; stop(): void } {
  let timer: { clear(): void } | null = null
  let stopped = false
  let inFlight: Promise<void> | null = null

  function clearTimer(): void {
    timer?.clear()
    timer = null
  }

  function arm(routines: T[], failed = false): void {
    if (stopped) return
    clearTimer()
    const now = d.now()
    const candidates = routines.filter((r) => r.enabled && r.trigger.kind === 'schedule' && r.nextRunAt !== null)
    let delay = TICK_MAX_MS
    if (failed) {
      delay = TICK_MAX_MS
    } else if (candidates.length > 0) {
      const earliest = Math.min(...candidates.map((r) => r.nextRunAt as number))
      delay = Math.min(TICK_MAX_MS, Math.max(0, earliest - now))
    }
    timer = d.setTimer(() => {
      void rearm()
    }, delay)
  }

  async function tick(): Promise<void> {
    if (stopped) return
    let routines: T[] = []
    let failed = false
    try {
      routines = await d.store.list()
      const now = d.now()
      for (const routine of routines) {
        if (stopped) return
        if (!routine.enabled || routine.trigger.kind !== 'schedule') continue
        if (!routine.trigger.schedule) continue
        if (routine.nextRunAt === null) {
          try {
            const updated = await d.store.update(routine.id, (current) => {
              const schedule = current.trigger.schedule
              if (!current.enabled || current.trigger.kind !== 'schedule' || !schedule || current.nextRunAt !== null) return null
              const next = nextRun(schedule, current.timeZone, now)
              return {
                ...current,
                nextRunAt: next,
                ...(next === null && schedule.freq === 'once' ? { enabled: false } : {})
              }
            })
            if (updated) routines = replaceRoutine(routines, updated)
          } catch (error) {
            failed = true
            d.onError(error)
          }
          continue
        }
        if (routine.nextRunAt > now) continue

        const due = routine.nextRunAt
        let updated: T | null
        try {
          updated = await d.store.update(routine.id, (current) => {
            const schedule = current.trigger.schedule
            if (!current.enabled || current.trigger.kind !== 'schedule' || !schedule || current.nextRunAt !== due) return null
            const next = nextRun(schedule, current.timeZone, now)
            return {
              ...current,
              nextRunAt: schedule.freq === 'once' ? null : next,
              ...(schedule.freq === 'once' ? { enabled: false } : {})
            }
          })
        } catch (error) {
          failed = true
          d.onError(error)
          continue
        }
        if (!updated) continue
        routines = replaceRoutine(routines, updated)
        try {
          await d.runner.run(updated, 'schedule', { late: now - due > LATE_AFTER_MS })
        } catch (error) {
          failed = true
          d.onError(error)
        }
      }
    } catch (error) {
      failed = true
      d.onError(error)
    } finally {
      if (!stopped) arm(routines, failed)
    }
  }

  function rearm(): Promise<void> {
    if (stopped) return Promise.resolve()
    if (inFlight) return inFlight
    clearTimer()
    inFlight = tick().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  return {
    start: () => rearm(),
    rearm,
    stop: () => {
      stopped = true
      clearTimer()
    }
  }
}

function replaceRoutine<T extends Scheduled>(routines: T[], updated: T): T[] {
  return routines.map((routine) => (routine.id === updated.id ? updated : routine))
}
