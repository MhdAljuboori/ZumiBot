import type { RoutineDef, VersionSummary, WorkflowDef } from '@zumibot/shared/definitionHistory'
import type { ChatMeta } from '@zumibot/shared/types'
import type { Routine, WebhookCall } from '@zumibot/shared/routines'
import type { WorkflowInput } from '@zumibot/shared/workflows'
import { draftFromRoutine, type RoutineDraft } from './routineDraft'

// Pure rules of the History dialog and of a restore in the workflow and routine editors.

const DAY_MS = 86_400_000
const startOfDay = (t: number): number => new Date(t).setHours(0, 0, 0, 0)

/** "Today 14:02", "Yesterday 09:10", "3 Nov, 14:02", or with the year when it is not this one. */
export function versionTimeText(ts: number, now: number): string {
  const d = new Date(ts)
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / DAY_MS)
  if (days === 0) return `Today ${time}`
  if (days === 1) return `Yesterday ${time}`
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  const date = d.toLocaleDateString(
    undefined,
    sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' }
  )
  return `${date}, ${time}`
}

/** Who saved the version. */
export function sourceText(v: Pick<VersionSummary, 'source' | 'restoredFrom'>, now: number): string {
  switch (v.source) {
    case 'editor':
      return 'Saved by you'
    case 'zumi-bot':
      return 'Saved by Zumi Bot'
    case 'restore':
      return v.restoredFrom !== undefined ? `Restored from ${versionTimeText(v.restoredFrom, now)}` : 'Restored'
    case 'earlier':
      return 'Earlier version'
  }
}

/** What the version changed; the oldest kept one has nothing to compare with. */
export const changesText = (v: Pick<VersionSummary, 'changes'>, oldest: boolean): string =>
  v.changes.length > 0 ? v.changes.join(' · ') : oldest ? 'The oldest version kept' : 'Same steps, saved again'

export const restoreNotice = (savedAt: number, now: number): string =>
  `Restored the version from ${versionTimeText(savedAt, now)}. Save to keep it, or Discard changes to go back.`

const policiesOf = (def: WorkflowDef): Pick<WorkflowInput, 'limitPolicy' | 'missedPolicy'> => ({
  ...(def.limitPolicy ? { limitPolicy: def.limitPolicy } : {}),
  ...(def.missedPolicy ? { missedPolicy: def.missedPolicy } : {})
})

/** A workflow version put into the editor: its definition over the draft, keeping the draft's id and on/off. */
export function restoredWorkflow(draft: WorkflowInput, def: WorkflowDef, sample: WebhookCall | null): WorkflowInput {
  // The draft's own policies go first: a version saved without one has none.
  const { limitPolicy: _limit, missedPolicy: _missed, ...kept } = draft
  return {
    ...kept,
    name: def.name,
    timeZone: def.timeZone,
    // A webhook keeps the hook's latest call: the server puts it there on save anyway.
    trigger: def.trigger.kind === 'webhook' ? { ...def.trigger, sample } : def.trigger,
    steps: def.steps,
    edges: def.edges,
    notes: def.notes ?? [],
    groups: def.groups ?? [],
    // The version's cap, or none: a version kept before it was set had none.
    spendCap: def.spendCap,
    // The same for the policies, but as absent keys, so the draft equals a saved workflow without them.
    ...policiesOf(def)
  }
}

/** A routine version put into the editor's form, keeping the draft's id and on/off. */
export function restoredRoutine(draft: RoutineDraft, def: RoutineDef, chats: readonly ChatMeta[]): RoutineDraft {
  const r: Routine = { ...def, id: draft.id ?? '', enabled: draft.enabled, nextRunAt: null, createdAt: 0, updatedAt: 0 }
  return { ...draftFromRoutine(r, chats), id: draft.id, enabled: draft.enabled }
}
