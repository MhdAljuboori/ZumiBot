import { limitPolicyOf, missedPolicyOf, sessionPolicyOf, type Routine, type RoutineTrigger } from './routines'
import type { Step, Workflow, WorkflowTrigger } from './workflows'

// Saved history of workflows and routines: every save keeps the definition it saved, so an earlier one can be put back.

/** editor: saved in the editor. zumi-bot: by Zumi Bot's tools. restore: a save of a restored version. earlier: what was
 * there before history was kept, or anything written around a save (a copy Duplicate made, say). */
export type VersionSource = 'editor' | 'zumi-bot' | 'restore' | 'earlier'

/** A workflow's definition: what a save changes, without on/off, times or a webhook's sample (a real caller's body). */
export type WorkflowDef = Pick<
  Workflow,
  'name' | 'timeZone' | 'trigger' | 'steps' | 'edges' | 'notes' | 'groups' | 'spendCap' | 'limitPolicy' | 'missedPolicy'
>
export type RoutineDef = Pick<
  Routine,
  'name' | 'timeZone' | 'trigger' | 'target' | 'prompt' | 'command' | 'limitPolicy' | 'missedPolicy' | 'sessionPolicy' | 'spendCap'
>

/** restoredFrom: the restored version's savedAt, for a save of a restored version. */
export interface DefinitionVersion<D> {
  id: string
  savedAt: number
  source: VersionSource
  restoredFrom?: number
  def: D
}
export interface HistoryFile<D> {
  v: 1
  versions: DefinitionVersion<D>[]
} // newest first

/** One row of the History dialog. current: it equals the saved definition. changes: what it changed against the one before. */
export interface VersionSummary {
  id: string
  savedAt: number
  source: VersionSource
  restoredFrom?: number
  current: boolean
  changes: string[]
}

/** What a save can say about where it came from. */
export interface SaveMeta {
  restoredFrom?: number
}

export const HISTORY_KEPT = 50
export const HISTORY_CHARS_MAX = 2_000_000 // of one item's file; the newest version always stays
// The pattern a workflow or routine id must pass before it names a history file.
export const HISTORY_ID_RE = /^[A-Za-z0-9-]{1,100}$/

const workflowTrigger = (t: WorkflowTrigger): WorkflowTrigger =>
  t.kind === 'webhook' ? { kind: 'webhook', sample: null, filters: t.filters, ...(t.condition ? { condition: t.condition } : {}) } : t
const routineTrigger = (t: RoutineTrigger): RoutineTrigger =>
  t.kind === 'webhook' ? { kind: 'webhook', sample: null, ...(t.condition ? { condition: t.condition } : {}) } : t

/** Built key by key in a fixed order, so two definitions compare by their JSON. */
export function workflowDef(w: Pick<Workflow, keyof WorkflowDef>): WorkflowDef {
  return {
    name: w.name,
    timeZone: w.timeZone,
    trigger: workflowTrigger(w.trigger),
    steps: w.steps,
    edges: w.edges,
    notes: w.notes ?? [],
    groups: w.groups ?? [],
    // Last and only when set, so a definition kept before spend caps still equals its next save without one.
    ...(w.spendCap !== undefined ? { spendCap: w.spendCap } : {}),
    ...(w.limitPolicy ? { limitPolicy: w.limitPolicy } : {}),
    ...(w.missedPolicy ? { missedPolicy: w.missedPolicy } : {})
  }
}

export function routineDef(r: Pick<Routine, keyof RoutineDef>): RoutineDef {
  return {
    name: r.name,
    timeZone: r.timeZone,
    trigger: routineTrigger(r.trigger),
    target: r.target,
    prompt: r.prompt,
    ...(r.command ? { command: r.command } : {}),
    // Read with their defaults, so a routine saved before the policies existed equals its first save with them.
    limitPolicy: limitPolicyOf(r),
    missedPolicy: missedPolicyOf(r),
    sessionPolicy: sessionPolicyOf(r),
    ...(r.spendCap !== undefined ? { spendCap: r.spendCap } : {})
  }
}

export const sameDef = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** The newest HISTORY_KEPT versions that fit HISTORY_CHARS_MAX together; the newest always stays. */
export function pruneVersions<D>(versions: DefinitionVersion<D>[]): DefinitionVersion<D>[] {
  const out: DefinitionVersion<D>[] = []
  let chars = 0
  for (const v of versions.slice(0, HISTORY_KEPT)) {
    chars += JSON.stringify(v).length
    if (out.length > 0 && chars > HISTORY_CHARS_MAX) break
    out.push(v)
  }
  return out
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`
const named = (s: Pick<Step, 'name' | 'handle'>): string => `“${s.name.trim() || s.handle}”`
// A step's content without its place on the canvas.
const content = (s: Step): string => {
  const { x: _x, y: _y, ...rest } = s
  return JSON.stringify(rest)
}

/** What `next` changed against `prev`, in a few words each; `prev` null is the first version kept. */
export function workflowChanges(prev: WorkflowDef | null, next: WorkflowDef): string[] {
  if (!prev) return []
  const out: string[] = []
  if (prev.name !== next.name) out.push('Renamed')
  if (!sameDef(prev.trigger, next.trigger)) out.push('Trigger changed')
  if (prev.timeZone !== next.timeZone) out.push('Time zone changed')
  const before = new Map(prev.steps.map((s) => [s.id, s]))
  const after = new Map(next.steps.map((s) => [s.id, s]))
  const added = next.steps.filter((s) => !before.has(s.id))
  const removed = prev.steps.filter((s) => !after.has(s.id))
  const changed = next.steps.filter((s) => before.has(s.id) && content(before.get(s.id)!) !== content(s))
  if (added.length) out.push(added.length === 1 ? `Step ${named(added[0]!)} added` : `${plural(added.length, 'step')} added`)
  if (removed.length) out.push(removed.length === 1 ? `Step ${named(removed[0]!)} removed` : `${plural(removed.length, 'step')} removed`)
  if (changed.length) out.push(changed.length === 1 ? `Step ${named(changed[0]!)} changed` : `${plural(changed.length, 'step')} changed`)
  const edges = (d: WorkflowDef) => JSON.stringify(d.edges.map((e) => [e.from, e.port, e.to]).sort())
  if (edges(prev) !== edges(next)) out.push('Connections changed')
  if (!sameDef(prev.notes, next.notes)) out.push('Notes changed')
  if (!sameDef(prev.groups, next.groups)) out.push('Groups changed')
  if (prev.spendCap !== next.spendCap) out.push('Spend cap changed')
  if (prev.limitPolicy !== next.limitPolicy || prev.missedPolicy !== next.missedPolicy) out.push('Run settings changed')
  const moved = next.steps.some((s) => {
    const b = before.get(s.id)
    return !!b && (b.x !== s.x || b.y !== s.y)
  })
  if (out.length === 0 && moved) out.push('Layout changed')
  return out
}

export function routineChanges(prev: RoutineDef | null, next: RoutineDef): string[] {
  if (!prev) return []
  const out: string[] = []
  if (prev.name !== next.name) out.push('Renamed')
  if (!sameDef(prev.trigger, next.trigger)) out.push('Trigger changed')
  if (prev.timeZone !== next.timeZone) out.push('Time zone changed')
  if (!sameDef(prev.target, next.target)) out.push('Target changed')
  if (prev.prompt !== next.prompt || !sameDef(prev.command, next.command)) out.push('Prompt changed')
  if (
    prev.limitPolicy !== next.limitPolicy ||
    prev.missedPolicy !== next.missedPolicy ||
    prev.sessionPolicy !== next.sessionPolicy ||
    prev.spendCap !== next.spendCap
  )
    out.push('Settings changed')
  return out
}

/** The History dialog's rows: each version's changes against the next older one, and which equals the saved definition. */
export function summarizeVersions<D>(
  versions: DefinitionVersion<D>[],
  current: D | null,
  changes: (prev: D | null, next: D) => string[]
): VersionSummary[] {
  return versions.map((v, i) => ({
    id: v.id,
    savedAt: v.savedAt,
    source: v.source,
    ...(v.restoredFrom !== undefined ? { restoredFrom: v.restoredFrom } : {}),
    current: current !== null && sameDef(v.def, current),
    changes: changes(versions[i + 1]?.def ?? null, v.def)
  }))
}
