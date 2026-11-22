import { spendCapBlocker, workflowRefs } from '@zumibot/shared/capAgents'
import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'
import type { Schedule, WebhookCall } from '@zumibot/shared/routines'
import { fieldList } from '@zumibot/shared/routineFields'
import { defaultTrigger, eventCall, EVENT_SAMPLES, isEventKind } from '@zumibot/shared/workflowEvents'
import type { Problem } from '@zumibot/shared/workflowGraph'
import type { AgentSummary, ChatMeta } from '@zumibot/shared/types'
import { WORKFLOW_PROBLEMS_TEXT, groupsOf, notesOf } from '@zumibot/shared/workflows'
import type {
  Port,
  Workflow,
  WorkflowInput,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowRunSummary,
  WorkflowsSnapshot,
  WorkflowTrigger
} from '@zumibot/shared/workflows'
import { ALL_DAYS } from './routineDraft'
import { removalOf } from './workflowCanvas'
import { mergeRuleAdditions } from './workflowRoom'
import { lastRunStatus, triggerSummary } from './workflows'

// The editor's rules that need no DOM: what `{{` offers, which key does what, the notices after a save or a refused
// switch, and where Run step's input comes from. The components only wire these to React.

/** What can be picked on the canvas besides an edge; 'group' is a collapsed group's node. */
export type ItemKind = 'step' | 'note' | 'group'

/** One item (its inspector), one edge, or several items picked together to move, copy or delete them. */
export type Selection =
  { kind: 'step' | 'edge' | 'note' | 'group'; id: string } | { kind: 'items'; steps: string[]; notes: string[]; groups: string[] }

export interface Picked {
  steps: string[]
  notes: string[]
  groups: string[]
}

/** The ids a selection holds, by kind, in the order they were picked; all empty for an edge. */
export function picked(s: Selection | null): Picked {
  if (!s || s.kind === 'edge') return { steps: [], notes: [], groups: [] }
  if (s.kind === 'items') return { steps: s.steps, notes: s.notes, groups: s.groups }
  return { steps: s.kind === 'step' ? [s.id] : [], notes: s.kind === 'note' ? [s.id] : [], groups: s.kind === 'group' ? [s.id] : [] }
}

export const pickedCount = (p: Picked): number => p.steps.length + p.notes.length + p.groups.length

/** These ids as a selection: nothing, one item of its kind, or items; without repeats. */
export function itemsSelection(p: Partial<Picked>): Selection | null {
  const steps = [...new Set(p.steps ?? [])],
    notes = [...new Set(p.notes ?? [])],
    groups = [...new Set(p.groups ?? [])]
  const n = steps.length + notes.length + groups.length
  if (n === 0) return null
  if (n > 1) return { kind: 'items', steps, notes, groups }
  return steps.length ? { kind: 'step', id: steps[0] } : notes.length ? { kind: 'note', id: notes[0] } : { kind: 'group', id: groups[0] }
}

/**
 * React Flow's select changes (a click, Ctrl-click, a box drawn on empty canvas, a drag starting on an unpicked item)
 * applied to the selection. They come against React Flow's own idea of what is picked, which is the canvas's, so they
 * add up. An edge stays selected until an item is picked: a click on an edge sends unselect changes for items too.
 */
export function applySelect(
  s: Selection | null,
  changes: { id: string; selected: boolean }[],
  kindOf: (id: string) => ItemKind | null
): Selection | null {
  const p = picked(s)
  const lists: Record<ItemKind, string[]> = { step: [...p.steps], note: [...p.notes], group: [...p.groups] }
  for (const c of changes) {
    for (const k of ['step', 'note', 'group'] as const) lists[k] = lists[k].filter((id) => id !== c.id)
    const kind = c.selected ? kindOf(c.id) : null
    if (kind) lists[kind].push(c.id)
  }
  const next = itemsSelection({ steps: lists.step, notes: lists.note, groups: lists.group })
  return next === null && s?.kind === 'edge' ? s : next
}

export function sameSelection(a: Selection | null, b: Selection | null): boolean {
  if (a === null || b === null) return a === b
  if (a.kind === 'items' || b.kind === 'items') {
    if (a.kind !== 'items' || b.kind !== 'items') return false
    const same = (x: string[], y: string[]): boolean => x.join('\n') === y.join('\n')
    return same(a.steps, b.steps) && same(a.notes, b.notes) && same(a.groups, b.groups)
  }
  return a.kind === b.kind && a.id === b.id
}

/**
 * The selection with what the workflow no longer has taken out (an item can go while picked), and what a collapsed group
 * hides (it collapsed while its members were picked): a hidden item is never picked. A group stays picked only while it
 * exists and is collapsed: an expanded group is not an item, its members are.
 */
export function pruneSelection(
  s: Selection | null,
  w: Pick<WorkflowInput, 'steps' | 'edges' | 'notes'> & { groups?: { id: string; steps?: string[]; notes?: string[] }[] },
  collapsedGroups: Set<string>
): Selection | null {
  if (!s) return null
  if (s.kind === 'edge') return w.edges.some((e) => e.id === s.id) ? s : null
  const folded = (w.groups ?? []).filter((x) => collapsedGroups.has(x.id))
  const hidden = new Set(folded.flatMap((g) => [...(g.steps ?? []), ...(g.notes ?? [])]))
  const steps = new Set(w.steps.map((x) => x.id).filter((id) => !hidden.has(id))),
    notes = new Set((w.notes ?? []).map((x) => x.id).filter((id) => !hidden.has(id)))
  const groups = new Set(folded.map((x) => x.id))
  const p = picked(s)
  return itemsSelection({
    steps: p.steps.filter((id) => steps.has(id)),
    notes: p.notes.filter((id) => notes.has(id)),
    groups: p.groups.filter((id) => groups.has(id))
  })
}

/**
 * Every item on the canvas, for Ctrl+A and the menu's Select all: each step and note, and with `collapsed` each collapsed
 * group in place of the members it hides (what shows is what gets picked).
 */
export function selectAllItems(w: Pick<WorkflowInput, 'steps' | 'notes' | 'groups'>, collapsed: Set<string> = new Set()): Selection | null {
  const folded = groupsOf(w).filter((g) => collapsed.has(g.id))
  const hidden = new Set(folded.flatMap((g) => [...g.steps, ...g.notes]))
  return itemsSelection({
    steps: w.steps.filter((s) => !hidden.has(s.id)).map((s) => s.id),
    notes: notesOf(w)
      .filter((n) => !hidden.has(n.id))
      .map((n) => n.id),
    groups: folded.map((g) => g.id)
  })
}

/** How many items Delete takes for the picked ones, as removeItems takes them: never the trigger, a group's members with it. */
export const removableCount = (w: Pick<WorkflowInput, 'steps' | 'notes' | 'groups'>, p: Picked): number => {
  const gone = removalOf(w, p)
  return gone.steps.size + gone.notes.size
}

/**
 * The React key of the editor WorkflowsMode shows, or null when it shows none. A new workflow's editor is `new-<n>`,
 * `n` taken from a counter that only grows (so no two New clicks ever share an editor). After its first save that editor
 * is adopted by the saved id and keeps its key, so it is not remounted mid-edit; a saved workflow opened any other way
 * is `wf-<id>`, which can never equal a `new-` key.
 */
export function editorKey(
  route: { workflowId: string | null; fresh?: number },
  adopted: { id: string; key: string } | null
): string | null {
  if (route.workflowId === null) return route.fresh === undefined ? null : `new-${route.fresh}`
  return adopted?.id === route.workflowId ? adopted.key : `wf-${route.workflowId}`
}

/**
 * The workflow at an address: the pushed snapshot's, else a duplicate just made. Its answer opens it, and the push that
 * lists it may come a moment later; without this the editor would read "This workflow was deleted" meanwhile.
 */
export function shownWorkflow(listed: Workflow[], id: string, arriving: Workflow | null): Workflow | null {
  return listed.find((w) => w.id === id) ?? (arriving?.id === id ? arriving : null)
}

/** A copy is made of the saved workflow or routine, so unsaved edits (or one never saved) are saved first, and the item says so. */
export const duplicateLabel = (dirty: boolean, saved: boolean): string => (dirty || !saved ? 'Save and duplicate' : 'Duplicate')

export const toInput = (w: Workflow): WorkflowInput => ({
  id: w.id,
  name: w.name,
  enabled: w.enabled,
  timeZone: w.timeZone,
  trigger: w.trigger,
  steps: w.steps,
  edges: w.edges,
  notes: notesOf(w),
  groups: groupsOf(w),
  ...(w.spendCap !== undefined ? { spendCap: w.spendCap } : {}),
  // The server clears a policy a save leaves out, so the draft must carry what is saved or an editor save wipes it.
  ...(w.limitPolicy ? { limitPolicy: w.limitPolicy } : {}),
  ...(w.missedPolicy ? { missedPolicy: w.missedPolicy } : {})
})

/** The workflow with this run cap, or none (the key gone, so a draft without a cap equals one saved without). */
export const withSpendCap = (w: WorkflowInput, cap: number | null): WorkflowInput => {
  const { spendCap: _old, ...rest } = w
  return cap === null ? rest : { ...rest, spendCap: cap }
}

/**
 * Why the run cap can't be set: an agent one of the steps runs is on an engine without `cost` (the fixed sentence naming it),
 * else null. The inspector shows this in the cap's place; the server refuses such a cap at save and again where a run starts.
 */
export const workflowCapBlocker = (
  w: Pick<WorkflowInput, 'steps'>,
  agents: readonly AgentSummary[],
  chats: readonly ChatMeta[]
): string | null => spendCapBlocker(workflowRefs(w.steps), agents, (id) => chats.find((c) => c.id === id))

/** The workflow's usage-limit policy: only 'skip' is stored, so a draft choosing the default equals one saved without. */
export const withLimitPolicy = (w: WorkflowInput, p: 'wait' | 'skip'): WorkflowInput => {
  const { limitPolicy: _old, ...rest } = w
  return p === 'skip' ? { ...rest, limitPolicy: 'skip' } : rest
}

/** The same for a schedule run missed while the server was off ('run-once' is the default). */
export const withMissedPolicy = (w: WorkflowInput, p: 'run-once' | 'skip'): WorkflowInput => {
  const { missedPolicy: _old, ...rest } = w
  return p === 'skip' ? { ...rest, missedPolicy: 'skip' } : rest
}

/** A webhook's Jev condition as typed; blank drops the key (the server trims and stores none for blank, too). */
export const withConditionText = (w: WorkflowInput, text: string): WorkflowInput => {
  if (w.trigger.kind !== 'webhook') return w
  const { condition: _old, ...rest } = w.trigger
  return { ...w, trigger: text.trim() === '' ? rest : { ...rest, condition: text } }
}

/** The condition field shows while Jev checks calls, or a saved one needs saying it is ignored (as the routine's does). */
export const conditionShown = (t: WorkflowTrigger, jevOn: boolean): boolean =>
  t.kind === 'webhook' && (jevOn || (t.condition ?? '').trim() !== '')

/**
 * The saved workflow changed elsewhere (a rule saved from a card) while the editor holds unsaved edits: it becomes the
 * base, and the draft keeps every edit of its own and gains the rules the saved one added to its room steps. The on/off
 * switch follows the saved one unless the draft flipped it, as an `enabled` push does.
 */
export function adoptSaved(draft: WorkflowInput, base: WorkflowInput, live: Workflow): { baseline: WorkflowInput; draft: WorkflowInput } {
  return {
    baseline: toInput(live),
    draft: {
      ...draft,
      steps: mergeRuleAdditions(draft.steps, base.steps, live.steps),
      enabled: draft.enabled === base.enabled ? live.enabled : draft.enabled
    }
  }
}

/** A draft with no edits follows the saved workflow wholesale, so a later edit and Save never sends stale steps. */
export const adoptClean = (live: Workflow): { baseline: WorkflowInput; draft: WorkflowInput } => ({
  baseline: toInput(live),
  draft: toInput(live)
})

/**
 * What the editor does when the saved workflow's push arrives. `wait`: its own save is in flight, and the server pushes
 * before the save's answer, so the push may be that save (the answer sets what was seen). `seen`: nothing newer than
 * the editor has. Otherwise the saved workflow changed elsewhere: a clean draft is replaced, a dirty one is merged.
 */
export function savedChange(o: {
  saving: boolean
  seenAt: number
  liveUpdatedAt: number
  dirty: boolean
}): 'wait' | 'seen' | 'replace' | 'merge' {
  if (o.saving) return 'wait'
  if (o.liveUpdatedAt <= o.seenAt) return 'seen'
  return o.dirty ? 'merge' : 'replace'
}

/**
 * What `{{` lists in one step's template field: its own input, every other step's output by handle, and the trigger's
 * fields. A schedule hands on no text, so `trigger.text` would only ever be filled with nothing there; the webhook's
 * body and query fields come from its latest test call.
 */
export function templateFields(w: Pick<WorkflowInput, 'steps' | 'trigger'>, stepId: string, sample: WebhookCall | null): string[] {
  const out = ['input']
  // The item exists only in a For each prompt, where the engine fills it per line.
  const own = w.steps.find((s) => s.id === stepId)
  if (own?.kind === 'foreach') out.push('item', 'item.number', 'item.total')
  // The vault key, only where the engine fills it: an HTTP step that picked one.
  if (own?.kind === 'http' && own.key) out.push('key')
  for (const s of w.steps) if (s.id !== stepId && s.kind !== 'trigger') out.push(`steps.${s.handle}.output`)
  if (w.trigger.kind !== 'schedule') out.push('trigger.text')
  if (w.trigger.kind === 'webhook' && sample) for (const f of fieldList(sample)) out.push(`trigger.${f.path}`)
  // An event's fields are known up front: the sample call stands in for the test call a webhook has.
  if (isEventKind(w.trigger.kind)) for (const f of fieldList(eventCall(EVENT_SAMPLES[w.trigger.kind], 0))) out.push(`trigger.${f.path}`)
  return [...new Set(out)]
}

/** The agents an Agent step can use: loadable ones, never Zumi Bot (problemsOf refuses it as a step). */
export const stepAgents = (agents: AgentSummary[]): AgentSummary[] => agents.filter((a) => a.error === null && a.name !== ZUMI_BOT_NAME)

/** Problems that belong to no step (no trigger, two triggers): shown in the banner, since no node can carry them. */
export const generalProblems = (problems: Problem[]): Problem[] => problems.filter((p) => p.stepId === null)

export const DEFAULT_SCHEDULE: Schedule = { freq: 'daily', time: '09:00', days: [...ALL_DAYS] }

/** The trigger after a kind change, reusing what that kind had earlier in this editor so a switch back loses nothing. */
export function switchTrigger(
  kind: WorkflowTrigger['kind'],
  earlier: Partial<Record<WorkflowTrigger['kind'], WorkflowTrigger>>
): WorkflowTrigger {
  const kept = earlier[kind]
  if (kept && kept.kind === kind) return kept
  if (kind === 'manual') return { kind: 'manual' }
  if (kind === 'schedule') return { kind: 'schedule', schedule: DEFAULT_SCHEDULE }
  if (isEventKind(kind)) return defaultTrigger(kind)
  return { kind: 'webhook', sample: null, filters: [] }
}

/** A focused element the user types into. Plain fields, so the rule is testable without a DOM. */
export function isTypingTarget(t: { tagName?: string; isContentEditable?: boolean; type?: string } | null): boolean {
  if (!t) return false
  if (t.isContentEditable) return true
  const tag = (t.tagName ?? '').toUpperCase()
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag !== 'INPUT') return false
  // A checkbox or button input takes no text, so the keys still reach the canvas.
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes((t.type ?? 'text').toLowerCase())
}

/**
 * Which of the controls after a step's name Enter or a double-click focuses (-1: none): the first text field, else the
 * first other control. A select waits its turn, since a focused one takes the next typed letter as a pick (an LLM step's
 * model would change); a disabled or read-only control is never picked.
 */
export function firstFieldIndex(
  els: { tagName?: string; isContentEditable?: boolean; type?: string; disabled?: boolean; readOnly?: boolean }[]
): number {
  const usable = (e: (typeof els)[number]): boolean => !e.disabled && !e.readOnly
  const text = els.findIndex((e) => usable(e) && (e.tagName ?? '').toUpperCase() !== 'SELECT' && isTypingTarget(e))
  return text >= 0 ? text : els.findIndex(usable)
}

// A step's footprint on the canvas with some air around it (nodes are 220 to 240 wide and about 80 tall).
const SLOT = { w: 260, h: 110 }
const SLOT_DX = [0, 280, 560, -280]
const SLOT_DY = [0, 120, -120, 240, -240, 360]

/**
 * Where a new step lands: the point asked for, or the nearest slot that no step covers, so a new step never hides one
 * already there (the view's centre is often right on the trigger). The flow reads left to right, so a slot to the right
 * comes before one below.
 */
export function freeSpot(w: Pick<WorkflowInput, 'steps'>, at: { x: number; y: number }): { x: number; y: number } {
  const base = { x: Math.round(at.x), y: Math.round(at.y) }
  const free = (p: { x: number; y: number }): boolean => !w.steps.some((s) => Math.abs(s.x - p.x) < SLOT.w && Math.abs(s.y - p.y) < SLOT.h)
  for (const dy of SLOT_DY) {
    for (const dx of SLOT_DX) {
      const p = { x: base.x + dx, y: base.y + dy }
      if (free(p)) return p
    }
  }
  return base // a crowded spot: the user moves it
}

interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

/** How far to pan (screen px) so a box shows inside the view with a margin; 0, 0 when it already does. */
export function panInto(box: Box, view: Box, margin: number): { dx: number; dy: number } {
  const into = (lo: number, hi: number, min: number, max: number): number =>
    hi > max - margin ? hi - (max - margin) : lo < min + margin ? lo - (min + margin) : 0
  return { dx: into(box.left, box.right, view.left, view.right), dy: into(box.top, box.bottom, view.top, view.bottom) }
}

/** A step's top-left moved just enough that a step of `size` fits inside `view` (both in canvas units). */
export function fitInView(at: { x: number; y: number }, view: Box, size: { w: number; h: number }): { x: number; y: number } {
  const fit = (v: number, min: number, max: number): number => Math.max(min, Math.min(v, max))
  return { x: fit(at.x, view.left, view.right - size.w), y: fit(at.y, view.top, view.bottom - size.h) }
}

const SAVED_OFF = 'Saved, but the workflow stays off: it has problems. Fix them, then turn it on.'
const SAVED_ON_WITH_PROBLEMS = 'Saved. The workflow is on, but its runs fail until its problems are fixed.'
// The one problem the editor cannot see: the server checks each Agent step's folder.
const FOLDER_HINT = "Check that each Agent step's folder exists."

/**
 * What to tell the user after a save. The server never turns a workflow on while it has problems (it saves it off
 * instead), and keeps one that was already on, on: both are said, never left silent.
 */
export function saveNotice(askedOn: boolean, saved: Pick<Workflow, 'enabled'>, problems: Problem[]): string | null {
  if (askedOn && !saved.enabled) return problems.length > 0 ? SAVED_OFF : `${SAVED_OFF} ${FOLDER_HINT}`
  if (saved.enabled && problems.length > 0) return SAVED_ON_WITH_PROBLEMS
  return null
}

/**
 * A refused Run or turn-on, as the user reads it. The server's problems text is fixed; when the editor shows no problem
 * of its own the cause is a missing folder, and unsaved edits are not what the server checked. Other errors (too many
 * runs, offline) are shown as they are.
 */
export function refusalText(message: string, problems: Problem[], dirty: boolean): string {
  if (message !== WORKFLOW_PROBLEMS_TEXT) return message
  const parts = [message]
  if (problems.length === 0) parts.push(FOLDER_HINT)
  if (dirty) parts.push('Save your changes first: the saved workflow is what runs.')
  return parts.join(' ')
}

/** The input of a step's latest visit in one run, or null when that run never reached the step. */
export function latestVisitInput(run: Pick<WorkflowRun, 'visits'>, stepId: string): string | null {
  for (let i = run.visits.length - 1; i >= 0; i--) if (run.visits[i].stepId === stepId) return run.visits[i].input
  return null
}

/**
 * Run step's starting input: the step's latest visit in the newest run that reached it. Looks at a few runs only (each
 * is a fetch); a skipped webhook call made no visits.
 */
export async function newestStepInput(
  runs: WorkflowRunSummary[],
  stepId: string,
  getRun: (runId: string) => Promise<Pick<WorkflowRun, 'visits'> | null>,
  max = 5
): Promise<string | null> {
  const newest = runs
    .filter((r) => r.status !== 'skipped')
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, max)
  for (const r of newest) {
    const run = await getRun(r.id).catch(() => null)
    const input = run ? latestVisitInput(run, stepId) : null
    if (input !== null) return input
  }
  return null
}

const STATUS_LABELS: Record<WorkflowRunStatus, string> = {
  running: 'Running',
  waiting: 'Waiting on you',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
  skipped: 'Skipped'
}
/** The run status in words, for the dot's label and the runs list. Every status has one ('running' included). */
export const runStatusLabel = (s: WorkflowRunStatus): string => STATUS_LABELS[s]
/** A step's or visit's state in words: a run status, or paused (an Agent step whose turn the user paused). */
export const stateLabel = (s: WorkflowRunStatus | 'paused'): string => (s === 'paused' ? 'Paused' : runStatusLabel(s))

export interface WorkflowRow {
  id: string
  name: string
  enabled: boolean
  trigger: WorkflowTrigger['kind']
  summary: string
  dot: WorkflowRunStatus | null
}

/** The sidebar's rows, by name. The dot is the newest real run's status, any of the six. */
export function workflowRows(s: WorkflowsSnapshot): WorkflowRow[] {
  return s.workflows
    .map((w) => ({
      id: w.id,
      name: w.name,
      enabled: w.enabled,
      trigger: w.trigger.kind,
      summary: triggerSummary(w.trigger, w.timeZone),
      dot: lastRunStatus(s, w.id)
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id))
}

/** One workflow's runs, newest first, for the list under its sidebar row. */
export const recentRuns = (s: WorkflowsSnapshot, id: string, limit = 10): WorkflowRunSummary[] =>
  [...(s.runs[id] ?? [])].sort((a, b) => b.startedAt - a.startedAt).slice(0, limit)

const PORT_WORDS: Partial<Record<Port, string>> = { yes: 'Yes', no: 'No', approved: 'Approved', rejected: 'Rejected', error: 'On failure' }

/** An edge in words, for the inspector: `Check → Notify (Yes)`. */
export function edgeLabel(w: Pick<WorkflowInput, 'steps' | 'edges'>, edgeId: string): string | null {
  const e = w.edges.find((x) => x.id === edgeId)
  if (!e) return null
  const name = (id: string): string => w.steps.find((s) => s.id === id)?.name || 'Step'
  const port = PORT_WORDS[e.port]
  return `${name(e.from)} → ${name(e.to)}${port ? ` (${port})` : ''}`
}
