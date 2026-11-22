import { randomUUID } from 'node:crypto'
import { routineDef, type RoutineDef } from '@zumibot/shared/definitionHistory'
import type { Routine, RoutineInput } from '@zumibot/shared/routines'
import type { CapEngines } from '../caps/capEngines'
import type { HistoryStore } from '../history/historyStore'
import { keepHistory, logHistoryError } from '../history/keepHistory'
import { nextFor } from '../nextFor'
import type { SaveSource } from '../workflows/workflowEditing'
import type { RoutineStore } from './routineStore'

export const NOT_FOUND = 'Routine not found'

export interface RoutineEditingDeps {
  store: RoutineStore
  scheduler: { rearm(): Promise<void> }
  /** Tells every tab the routines changed. */
  changed(): void
  newSecret(): string
  now?: () => number
  /** Every save keeps the definition it saved (absent in tests that do not look at history). */
  history?: HistoryStore<RoutineDef>
  /** Refuses a spend cap that can't hold for the agents the routine runs (absent in tests that do not look at caps). */
  capEngines?: Pick<CapEngines, 'routine'>
}

/** The save and remove behind `routines:save` and `routines:remove`, shared with Zumi Bot's tools. */
export function routineEditing(d: RoutineEditingDeps) {
  const { store } = d
  const clock = d.now ?? Date.now
  return {
    /** webhookWithoutSample: a webhook with no test call yet saves with sample null (the caller's hook waits for one). */
    async save(input: RoutineInput, o: { webhookWithoutSample?: true } & SaveSource = {}): Promise<Routine> {
      // First: a cap that can't hold is refused, never saved and ignored.
      const uncapped = await d.capEngines?.routine(input)
      if (uncapped) throw new Error(uncapped)
      const now = clock()
      let trigger = input.trigger
      if (trigger.kind === 'webhook') {
        const latest = input.id ? (await store.hook(input.id))?.latest : null
        if (!latest && !o.webhookWithoutSample) throw new Error('Webhook needs a test call before saving')
        trigger = { kind: 'webhook', sample: latest ?? null, ...(trigger.condition ? { condition: trigger.condition } : {}) }
      }
      const id = input.id ?? randomUUID()
      const fields = {
        name: input.name,
        enabled: input.enabled,
        timeZone: input.timeZone,
        trigger,
        target: input.target,
        prompt: input.prompt,
        ...(input.command ? { command: input.command } : {}),
        limitPolicy: input.limitPolicy,
        missedPolicy: input.missedPolicy,
        sessionPolicy: input.sessionPolicy,
        ...(input.spendCap !== undefined ? { spendCap: input.spendCap } : {}),
        updatedAt: now
      }
      let saved: Routine | null
      const before = await store.get(id)
      if (before) {
        // Atomic with the scheduler: it may be advancing nextRunAt right now.
        // The old command and cap go: a save without them clears them.
        saved = await store.update(id, ({ command: _dropped, spendCap: _cap, ...old }) => {
          const moved =
            old.enabled !== input.enabled || old.timeZone !== input.timeZone || JSON.stringify(old.trigger) !== JSON.stringify(trigger)
          return { ...old, ...fields, nextRunAt: moved ? nextFor(trigger, input.enabled, input.timeZone, now) : old.nextRunAt }
        })
        if (!saved) throw new Error(NOT_FOUND)
      } else {
        saved = { id, ...fields, nextRunAt: nextFor(trigger, input.enabled, input.timeZone, now), createdAt: now }
        await store.put(saved)
      }
      // After the write: the save has landed, so a history failure is logged and never fails it.
      await keepHistory(d.history, id, before && { def: routineDef(before), at: before.updatedAt }, routineDef(saved), o)
      // Only once the routine exists, so a stale-draft sweep cannot drop the hook in between.
      if (trigger.kind === 'webhook' && o.webhookWithoutSample) await store.ensureHook(id, d.newSecret, now)
      await store.clearDraft(id) // after the routine exists: a stale-draft sweep skips hooks that have an owner
      await d.scheduler.rearm()
      d.changed()
      return saved
    },
    async remove(id: string): Promise<void> {
      await store.remove(id)
      await d.history?.remove(id).catch(logHistoryError)
      await d.scheduler.rearm()
      d.changed()
    }
  }
}

export type RoutineEditing = ReturnType<typeof routineEditing>
