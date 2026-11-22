import { randomUUID } from 'node:crypto'
import { workflowDef, type VersionSource, type WorkflowDef } from '@zumibot/shared/definitionHistory'
import type { Workflow, WorkflowInput } from '@zumibot/shared/workflows'
import type { Problem } from '@zumibot/shared/workflowGraph'
import { dropBrokenGroups } from '@zumibot/shared/workflowGroups'
import type { CapEngines } from '../caps/capEngines'
import type { HistoryStore } from '../history/historyStore'
import { keepHistory, logHistoryError } from '../history/keepHistory'
import { nextFor } from '../nextFor'
import type { WorkflowRunner } from './workflowRunner'
import type { WorkflowStore } from './workflowStore'

export const WORKFLOW_NOT_FOUND = 'Workflow not found'

export interface WorkflowEditingDeps {
  store: WorkflowStore
  runner: Pick<WorkflowRunner, 'problems' | 'stopAllOf'>
  scheduler: { rearm(): Promise<void> }
  /** Tells every tab the workflows changed. */
  changed(): void
  newSecret(): string
  now?: () => number
  /** Every save keeps the definition it saved (absent in tests that do not look at history). */
  history?: HistoryStore<WorkflowDef>
  /** Refuses a spend cap that can't hold for the agents the workflow's steps run (absent in tests that do not look at caps). */
  capEngines?: Pick<CapEngines, 'workflow'>
}

/** Who saved, for the history: the editor unless said otherwise; restoredFrom marks a save of a restored version. */
export interface SaveSource {
  source?: Exclude<VersionSource, 'earlier' | 'restore'>
  restoredFrom?: number
}

// A webhook workflow's sample is the hook's latest real call, as for routines; the client's copy is never trusted.
export async function withSample(store: WorkflowStore, input: WorkflowInput): Promise<WorkflowInput> {
  if (input.trigger.kind !== 'webhook') return input
  const latest = input.id ? ((await store.hooks.hook(input.id))?.latest ?? null) : null
  return { ...input, trigger: { ...input.trigger, sample: latest } }
}

/** The save and remove behind `workflows:save` and `workflows:remove`, shared with Zumi Bot's tools. */
export function workflowEditing(d: WorkflowEditingDeps) {
  const { store, runner } = d
  const clock = d.now ?? Date.now
  return {
    /** ensureHook: a webhook workflow gets its hook now, not at its first Run step or Webhook panel visit. */
    async save(raw: WorkflowInput, o: { ensureHook?: true } & SaveSource = {}): Promise<{ workflow: Workflow; problems: Problem[] }> {
      // First: a cap that can't hold is refused, never saved and ignored.
      const uncapped = await d.capEngines?.workflow(raw)
      if (uncapped) throw new Error(uncapped)
      const input = await withSample(store, raw)
      const now = clock()
      const id = input.id ?? randomUUID()
      const before = await store.get(id)
      // Only a reserved webhook draft can supply a new id. Deleted workflows must never be brought back.
      if (input.id !== null && !before) {
        const hook = await store.hooks.hook(id)
        if (!hook?.reserved || hook.draftAt === null) throw new Error(WORKFLOW_NOT_FOUND)
      }
      // Save always works, but never turns on what setEnabled would refuse. Asked only when it would turn it on.
      const allowed = input.enabled && !before?.enabled ? (await runner.problems(input)).length === 0 : false
      // A group that breaks a chain rule is dropped here, not refused: the editor shows the rules, and a stale tab must still save.
      const kept = dropBrokenGroups(input)
      const fields = {
        name: input.name,
        timeZone: input.timeZone,
        trigger: input.trigger,
        steps: input.steps,
        edges: input.edges,
        notes: input.notes ?? [],
        groups: kept.groups ?? [],
        ...(input.spendCap !== undefined ? { spendCap: input.spendCap } : {}),
        ...(input.limitPolicy ? { limitPolicy: input.limitPolicy } : {}),
        ...(input.missedPolicy ? { missedPolicy: input.missedPolicy } : {}),
        updatedAt: now
      }
      let saved: Workflow | null
      if (before) {
        // Atomic with the scheduler: it may be advancing nextRunAt (or switching a spent "once" off) right now.
        // A save without a cap or a run setting clears the old one.
        saved = await store.update(id, ({ spendCap: _cap, limitPolicy: _limit, missedPolicy: _missed, ...old }) => {
          const enabled = input.enabled && (old.enabled || allowed)
          const moved =
            old.enabled !== enabled || old.timeZone !== input.timeZone || JSON.stringify(old.trigger) !== JSON.stringify(input.trigger)
          return { ...old, ...fields, enabled, nextRunAt: moved ? nextFor(input.trigger, enabled, input.timeZone, now) : old.nextRunAt }
        })
        if (!saved) throw new Error(WORKFLOW_NOT_FOUND)
      } else {
        const enabled = input.enabled && allowed
        saved = { id, ...fields, enabled, nextRunAt: nextFor(input.trigger, enabled, input.timeZone, now), createdAt: now }
        await store.put(saved)
      }
      // After the write: the save has landed, so a history failure is logged and never fails it.
      await keepHistory(d.history, id, before && { def: workflowDef(before), at: before.updatedAt }, workflowDef(saved), o)
      if (input.trigger.kind === 'webhook' && o.ensureHook) await store.hooks.ensureHook(id, d.newSecret, now)
      await store.hooks.clearDraft(id) // after the workflow exists: a stale-draft sweep skips hooks that have an owner
      await d.scheduler.rearm()
      d.changed()
      return { workflow: saved, problems: await runner.problems(saved) }
    },
    async remove(id: string): Promise<void> {
      // First: a run left waiting on an approval would keep its notification for a workflow that is gone.
      await runner.stopAllOf(id)
      await store.remove(id)
      await d.history?.remove(id).catch(logHistoryError)
      await d.scheduler.rearm()
      d.changed()
    }
  }
}

export type WorkflowEditing = ReturnType<typeof workflowEditing>
