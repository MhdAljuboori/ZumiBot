import type { CanvasGroup, Edge, Note, Port, Step, StepKind, WorkflowInput } from '@zumibot/shared/workflows'
import { CHAT_NOT_FOUND, FAILING_KINDS, PICK_CHAT, failsBranch, groupsOf, notesOf, portsOf, stepPorts } from '@zumibot/shared/workflows'
import { stepDefaults } from '@zumibot/shared/workflowDefaults'
import { handleFor, type Problem } from '@zumibot/shared/workflowGraph'
import { GROUP_RULE_TEXT, brokenGroups } from '@zumibot/shared/workflowGroups'
import type { Picked } from './workflowEditor'
import { COLLAPSED_SIZE, collapsedView, groupBox, groupLinks, type SizeOf } from './workflowGroupView'

// Pure edit operations on a workflow being drawn, and its mapping to React Flow's node and edge shapes. Nothing here
// imports React Flow, so the editor's rules stay testable without a DOM. Every operation returns a new workflow, and
// the same object back when it refuses, so callers can tell "nothing changed" by identity.

export type IdGen = () => string
export interface StepRunState {
  status: 'idle' | 'running' | 'paused' | 'waiting' | 'done' | 'failed' | 'stopped'
  visits: number
}
export interface FlowNode {
  id: string
  type: 'step'
  position: { x: number; y: number }
  data: { step: Step; summary: string; problems: string[]; state?: StepRunState }
}
export interface NoteFlowNode {
  id: string
  type: 'note'
  position: { x: number; y: number }
  width: number
  height: number
  zIndex: number
  data: { note: Note }
}
/**
 * An expanded group's box: drawn under everything, never picked or dragged itself (its members are). Not React Flow's
 * own 'group' type, whose stylesheet gives that node a padding, border, background and width of its own.
 */
export interface GroupFlowNode {
  id: string
  type: 'groupBox'
  position: { x: number; y: number }
  width: number
  height: number
  zIndex: number
  selectable: false
  draggable: false
  data: { group: CanvasGroup; broken: string | null }
}
/** A collapsed group's one node, at its box's top-left: picked and dragged like a step. `broken` as on the box. */
export interface CollapsedGroupFlowNode {
  id: string
  type: 'groupCollapsed'
  position: { x: number; y: number }
  width: number
  height: number
  selectable: true
  draggable: true
  data: { group: CanvasGroup; ports: Port[]; hasInput: boolean; counts: { steps: number; notes: number }; broken: string | null }
}
export type FlowItem = FlowNode | NoteFlowNode | GroupFlowNode | CollapsedGroupFlowNode
export interface FlowEdge {
  id: string
  source: string
  sourceHandle: Port
  target: string
  label?: 'Yes' | 'No' | 'Approved' | 'Rejected' | 'Failed'
}

export const STEP_LABELS: Record<Exclude<StepKind, 'trigger'>, string> = {
  agent: 'Agent',
  room: 'Room',
  foreach: 'For each',
  llm: 'LLM',
  condition: 'Condition',
  approval: 'Approval',
  wait: 'Wait',
  notify: 'Notify',
  http: 'HTTP request',
  transform: 'Transform',
  workflow: 'Sub-workflow',
  chat: 'Chat'
}
const PORT_LABELS: Partial<Record<Port, FlowEdge['label']>> = {
  yes: 'Yes',
  no: 'No',
  approved: 'Approved',
  rejected: 'Rejected',
  error: 'Failed'
}

// The server's save rule for step and edge ids (validId in workflowInput.ts): an id that names an Object.prototype
// property would break its lookups, so it is never made here either.
const ID_RE = /^[A-Za-z0-9-]{1,64}$/
const idOk = (id: string): boolean => ID_RE.test(id) && !Object.hasOwn(Object.prototype, id)

// The canvas grid: drags snap to it and the background dots sit on it. Existing positions are never moved to it on load.
export const GRID = 20
// n8n allows 0-4; 0.2-2 was too tight for a wide workflow.
export const ZOOM = { min: 0.1, max: 4 }
// `+ 0` keeps a -0 (from a small negative value) out of the saved position.
export const snap = (v: number): number => Math.round(v / GRID) * GRID + 0

export function randomId(): string {
  const bytes = new Uint8Array(8)
  const c = globalThis.crypto
  if (c?.getRandomValues) c.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

// A bad or taken id from the generator is skipped; a generator stuck on one value is a bug, not a loop to hang in.
export function freshId(used: Set<string>, gen: IdGen): string {
  for (let i = 0; i < 1000; i++) {
    const id = gen()
    if (idOk(id) && !used.has(id)) return id
  }
  throw new Error('No unused id')
}
// One id space for steps, notes, groups and edges: React Flow keys steps, notes and groups together, the save refuses a
// clash among them, and a paste must clash with none.
export const idsOf = (w: WorkflowInput): Set<string> =>
  new Set([...w.steps.map((s) => s.id), ...notesOf(w).map((n) => n.id), ...groupsOf(w).map((g) => g.id), ...w.edges.map((e) => e.id)])
export const handlesOf = (w: WorkflowInput, except?: string): Set<string> =>
  new Set(w.steps.filter((s) => s.id !== except).map((s) => s.handle))

export function newWorkflow(timeZone: string, gen: IdGen = randomId): WorkflowInput {
  const trigger: Step = { id: freshId(new Set(), gen), handle: 'trigger', name: 'Trigger', kind: 'trigger', x: 0, y: 0 }
  return {
    id: null,
    name: 'New workflow',
    enabled: false,
    timeZone,
    trigger: { kind: 'manual' },
    steps: [trigger],
    edges: [],
    notes: [],
    groups: []
  }
}

export function addStep(
  w: WorkflowInput,
  kind: Exclude<StepKind, 'trigger'>,
  at: { x: number; y: number },
  connectFrom?: { stepId: string; port: Port },
  gen: IdGen = randomId
): { w: WorkflowInput; stepId: string } {
  const stepId = freshId(idsOf(w), gen)
  const name = STEP_LABELS[kind]
  const step = { id: stepId, handle: handleFor(name, handlesOf(w)), name, kind, x: at.x, y: at.y, ...stepDefaults(kind) } as Step
  const next = { ...w, steps: [...w.steps, step] }
  return { w: connectFrom ? connect(next, connectFrom, stepId, gen) : next, stepId }
}

/**
 * A new step put into a connection, as n8n's + on an edge does: the edge goes, the source's port connects to the new
 * step and the new step's first port to the old target. An unknown edge leaves the workflow as it is. Put between two
 * members of one group, the step joins that group, so the chain stays whole.
 */
export function insertStep(
  w: WorkflowInput,
  edgeId: string,
  kind: Exclude<StepKind, 'trigger'>,
  at: { x: number; y: number },
  gen: IdGen = randomId
): { w: WorkflowInput; stepId: string | null } {
  const edge = w.edges.find((e) => e.id === edgeId)
  if (!edge) return { w, stepId: null }
  const added = addStep(removeEdge(w, edgeId), kind, at, { stepId: edge.from, port: edge.port }, gen)
  const out = connect(added.w, { stepId: added.stepId, port: portsOf(kind)[0] }, edge.to, gen)
  const home = groupsOf(out).find((g) => g.steps.includes(edge.from) && g.steps.includes(edge.to))
  if (!home) return { w: out, stepId: added.stepId }
  return {
    w: { ...out, groups: groupsOf(out).map((g) => (g === home ? { ...g, steps: [...g.steps, added.stepId] } : g)) },
    stepId: added.stepId
  }
}

export function connect(w: WorkflowInput, from: { stepId: string; port: Port }, to: string, gen: IdGen = randomId): WorkflowInput {
  const source = w.steps.find((s) => s.id === from.stepId)
  const target = w.steps.find((s) => s.id === to)
  if (!source || !target || target.kind === 'trigger' || from.stepId === to) return w
  if (!stepPorts(source).includes(from.port)) return w
  if (w.edges.some((e) => e.from === from.stepId && e.port === from.port && e.to === to)) return w
  const edge: Edge = { id: freshId(idsOf(w), gen), from: from.stepId, port: from.port, to }
  return { ...w, edges: [...w.edges, edge] }
}

/**
 * The On failure setting: on adds the step's error port; off removes it with every connection out of it, since the save
 * refuses an edge from a port the step does not have. A step that can't fail by itself is left as it is.
 */
export function setFailurePath(w: WorkflowInput, id: string, on: boolean): WorkflowInput {
  const s = w.steps.find((x) => x.id === id)
  if (!s || !FAILING_KINDS.includes(s.kind) || failsBranch(s) === on) return w
  const next = updateStep(w, id, { onFailure: on ? 'branch' : undefined })
  return on ? next : { ...next, edges: next.edges.filter((e) => !(e.from === id && e.port === 'error')) }
}

// Through removeItems, so a step deleted from its inspector leaves its group as a Delete on the canvas does.
export const removeStep = (w: WorkflowInput, id: string): WorkflowInput => removeItems(w, { steps: [id], notes: [], groups: [] })

/**
 * What Delete takes for these picked items: the steps (never the trigger) and notes that exist, plus every member of a
 * picked group, which goes with them. removableCount counts the same, so the button's number is what goes.
 */
export function removalOf(
  w: Pick<WorkflowInput, 'steps' | 'notes' | 'groups'>,
  p: Picked
): { steps: Set<string>; notes: Set<string>; groups: Set<string> } {
  const picked = groupsOf(w).filter((g) => p.groups.includes(g.id))
  const steps = new Set([...p.steps, ...picked.flatMap((g) => g.steps)]),
    notes = new Set([...p.notes, ...picked.flatMap((g) => g.notes)])
  return {
    steps: new Set(w.steps.filter((s) => s.kind !== 'trigger' && steps.has(s.id)).map((s) => s.id)),
    notes: new Set(
      notesOf(w)
        .filter((n) => notes.has(n.id))
        .map((n) => n.id)
    ),
    groups: new Set(picked.map((g) => g.id))
  }
}

/**
 * The picked items removed in one edit (Delete, cut): steps with every edge to or from them, notes, and picked groups
 * with their members. The trigger always stays. A member that goes leaves its group, and a group left with fewer than
 * two items or no step goes too, since it could never be one again.
 */
export function removeItems(w: WorkflowInput, p: Picked): WorkflowInput {
  const gone = removalOf(w, p)
  if (gone.steps.size === 0 && gone.notes.size === 0 && gone.groups.size === 0) return w
  let out: WorkflowInput = w
  if (gone.steps.size > 0)
    out = {
      ...out,
      steps: w.steps.filter((s) => !gone.steps.has(s.id)),
      edges: w.edges.filter((e) => !gone.steps.has(e.from) && !gone.steps.has(e.to))
    }
  if (gone.notes.size > 0) out = { ...out, notes: notesOf(w).filter((n) => !gone.notes.has(n.id)) }
  const groups = groupsOf(w)
  if (groups.length === 0) return out
  const kept: CanvasGroup[] = []
  for (const g of groups) {
    if (gone.groups.has(g.id)) continue
    const steps = g.steps.filter((id) => !gone.steps.has(id)),
      notes = g.notes.filter((id) => !gone.notes.has(id))
    if (steps.length === g.steps.length && notes.length === g.notes.length) kept.push(g)
    else if (steps.length >= 1 && steps.length + notes.length >= 2) kept.push({ ...g, steps, notes })
  }
  return kept.length === groups.length && kept.every((g, i) => g === groups[i]) ? out : { ...out, groups: kept }
}

export function removeEdge(w: WorkflowInput, id: string): WorkflowInput {
  return w.edges.some((e) => e.id === id) ? { ...w, edges: w.edges.filter((e) => e.id !== id) } : w
}

export function moveStep(w: WorkflowInput, id: string, x: number, y: number): WorkflowInput {
  const s = w.steps.find((v) => v.id === id)
  if (!s) return w
  if (s.x === x && s.y === y) return w
  return { ...w, steps: w.steps.map((v) => (v.id === id ? { ...v, x, y } : v)) }
}

/** A drop of one or more items (steps and notes): every one it moved lands in one edit, so the draft changes once. */
export function moveItems(w: WorkflowInput, moves: { id: string; x: number; y: number }[]): WorkflowInput {
  const to = new Map(moves.map((m) => [m.id, m]))
  const notes = notesOf(w)
  const moved = (v: { id: string; x: number; y: number }): boolean => {
    const m = to.get(v.id)
    return m !== undefined && (m.x !== v.x || m.y !== v.y)
  }
  const steps = w.steps.some(moved),
    noted = notes.some(moved)
  if (!steps && !noted) return w
  const at = <T extends { id: string; x: number; y: number }>(v: T): T => {
    const m = to.get(v.id)
    return m ? { ...v, x: m.x, y: m.y } : v
  }
  return { ...w, ...(steps ? { steps: w.steps.map(at) } : {}), ...(noted ? { notes: notes.map(at) } : {}) }
}

/**
 * A step with every `{{steps.<old>.output}}` its text fields name moved to the new handle in `map`, whitespace inside
 * the braces kept as the user typed it. One pass, so a swap of two handles never chains.
 */
export function rewriteHandles(step: Step, map: Map<string, string>): Step {
  if (map.size === 0) return step
  // Same shape as the engine's placeholder.
  const re = /\{\{(\s*)steps\.([^.\s}]+)\.output(\s*)\}\}/g
  const rewrite = (text: string): string =>
    text.replace(re, (m, a: string, h: string, b: string) => {
      const to = map.get(h)
      return to === undefined ? m : `{{${a}steps.${to}.output${b}}}`
    })
  // Every text field, so a new template field is covered without a list to keep in step.
  const out: Record<string, unknown> = { ...step }
  for (const [k, val] of Object.entries(out))
    if (typeof val === 'string' && k !== 'id' && k !== 'handle' && k !== 'kind') out[k] = rewrite(val)
  return out as unknown as Step
}

// Gives step `id` a new handle and name, rewriting every `{{steps.<old>.output}}` that named the old handle.
function rehandle(w: WorkflowInput, id: string, old: string, handle: string, name: string): WorkflowInput {
  const map = new Map([[old, handle]])
  const steps = w.steps.map((v) => {
    const out = rewriteHandles(v, map)
    return v.id === id ? ({ ...out, name, handle } as Step) : out
  })
  return { ...w, steps }
}

/** A name change. A handle that still matches what its old name would have made follows the new name, and the
 * `{{steps.<old>.output}}` placeholders that name it are rewritten; a handle the user edited stays as it is. */
export function renameStep(w: WorkflowInput, id: string, name: string): WorkflowInput {
  const s = w.steps.find((v) => v.id === id)
  if (!s) return w
  const others = handlesOf(w, id)
  const auto = s.handle === handleFor(s.name, others)
  const handle = auto ? handleFor(name, others) : s.handle
  if (handle === s.handle) return { ...w, steps: w.steps.map((v) => (v.id === id ? { ...v, name } : v)) }
  return rehandle(w, id, s.handle, handle, name)
}

/**
 * A handle typed in the inspector. The server only saves `[a-z0-9-]{1,32}`, so the text goes through handleFor against
 * the other steps' handles: a name with no Latin letters (Arabic, say) still gets `step`, and a clash gets `-2`. The
 * placeholders that named the old handle follow it, as on a rename.
 */
export function setHandle(w: WorkflowInput, id: string, typed: string): WorkflowInput {
  const s = w.steps.find((v) => v.id === id)
  if (!s) return w
  const handle = handleFor(typed, handlesOf(w, id))
  return handle === s.handle ? w : rehandle(w, id, s.handle, handle, s.name)
}

/** Settings of one step changed from the inspector. A key set to undefined is dropped (an optional setting cleared);
 * id, kind and handle never change here (setHandle owns the handle, renameStep the name's effect on it). */
export function updateStep(w: WorkflowInput, id: string, patch: Record<string, unknown>): WorkflowInput {
  if (!w.steps.some((v) => v.id === id)) return w
  const steps = w.steps.map((v) => {
    if (v.id !== id) return v
    const out: Record<string, unknown> = { ...v }
    for (const [k, val] of Object.entries(patch)) {
      if (k === 'id' || k === 'kind' || k === 'handle') continue
      if (val === undefined) delete out[k]
      else out[k] = val
    }
    return out as unknown as Step
  })
  return { ...w, steps }
}

/** `roomTitle` names a Room step's template room (null = gone or not a room) and `chatTitle` a Chat step's chat (null = gone); without them (a view that has no chats) the node reads just Room or Chat. */
export function stepSummary(s: Step, roomTitle?: (id: string) => string | null, chatTitle?: (id: string) => string | null): string {
  switch (s.kind) {
    case 'agent':
      return `${s.agent || 'No agent'} · ${s.model ?? "agent's model"}`
    case 'chat':
      return !s.chat ? PICK_CHAT : chatTitle ? (chatTitle(s.chat) ?? CHAT_NOT_FOUND) : 'Chat'
    case 'room':
      return !s.room ? 'Pick a room' : roomTitle ? (roomTitle(s.room) ?? 'Room not found') : 'Room'
    case 'foreach':
      return `${s.agent || 'No agent'} · for each line`
    case 'llm':
      return s.effort ? `${s.model} · ${s.effort}` : s.model
    case 'condition':
      return s.question.slice(0, 60)
    case 'approval':
      return s.question
    case 'wait':
      return `Wait ${s.minutes} min`
    case 'notify':
      return s.title
    case 'http':
      return s.url ? `${s.method} ${s.url}`.slice(0, 80) : s.method
    case 'transform':
      return s.fields.length
        ? s.fields
            .map((f) => f.path || '(all)')
            .join(', ')
            .slice(0, 60)
        : 'No fields'
    case 'workflow':
      return s.workflow ? '' : 'No workflow'
    case 'trigger':
      return 'Trigger'
  }
}

// Notes sit below every step (zIndex 0) and edge: the biggest lowest, so a small note on a big one stays pickable. An
// expanded group's box sits over the loose notes (a phase note behind it stays a backdrop) and under its own notes,
// which would vanish under its fill otherwise; at most NOTES_MAX notes, so each band has room for every rank.
const NOTE_Z = -1000
const GROUP_Z = -500
const MEMBER_NOTE_Z = -400

/**
 * The workflow as React Flow nodes and edges. With `opts` (the collapsed groups and how big each step is drawn) the
 * groups show too: an expanded one as a box under its members, a collapsed one as one node that hides them, the edges
 * that cross it drawn to and from it. Without `opts` there are no group nodes, as before groups.
 */
export function toFlow(
  w: WorkflowInput,
  problems: Problem[],
  states?: Record<string, StepRunState>,
  opts?: { collapsed: Set<string>; sizeOf: SizeOf },
  roomTitle?: (id: string) => string | null,
  chatTitle?: (id: string) => string | null
): { nodes: FlowItem[]; edges: FlowEdge[] } {
  const view = opts ? collapsedView(w, opts.collapsed) : null
  const shown = (id: string): boolean => !view?.hidden.has(id)
  const steps = w.steps
    .filter((s) => shown(s.id))
    .map((step): FlowNode => {
      const data: FlowNode['data'] = {
        step,
        summary: stepSummary(step, roomTitle, chatTitle),
        problems: problems.filter((p) => p.stepId === step.id).map((p) => p.text)
      }
      if (states && Object.hasOwn(states, step.id)) data.state = states[step.id]
      return { id: step.id, type: 'step', position: { x: step.x, y: step.y }, data }
    })
  const notes = notesOf(w)
  // Area, biggest first; on a tie the earlier note is lower, so the later one lands on top.
  const order = notes.map((_, i) => i).sort((i, j) => notes[j].width * notes[j].height - notes[i].width * notes[i].height || i - j)
  // Only with opts are there boxes to lift notes over (a collapsed group's notes are not drawn at all).
  const members = new Set(opts ? groupsOf(w).flatMap((g) => g.notes) : [])
  const noteNodes = notes.flatMap((note, i): NoteFlowNode[] =>
    shown(note.id)
      ? [
          {
            id: note.id,
            type: 'note',
            position: { x: note.x, y: note.y },
            width: note.width,
            height: note.height,
            zIndex: (members.has(note.id) ? MEMBER_NOTE_Z : NOTE_Z) + order.indexOf(i),
            data: { note }
          }
        ]
      : []
  )
  const boxes: GroupFlowNode[] = [],
    folded: CollapsedGroupFlowNode[] = []
  if (opts) {
    const broken = new Map(brokenGroups(w).map((b) => [b.group.id, GROUP_RULE_TEXT[b.reason]]))
    const existing = new Set([...w.steps.map((s) => s.id), ...notes.map((n) => n.id)])
    for (const group of groupsOf(w)) {
      // A group whose members are all gone has no place to draw; the save drops it.
      if (![...group.steps, ...group.notes].some((id) => existing.has(id))) continue
      const box = groupBox(w, group, opts.sizeOf)
      const position = { x: box.x, y: box.y }
      if (opts.collapsed.has(group.id)) {
        folded.push({
          id: group.id,
          type: 'groupCollapsed',
          position,
          ...COLLAPSED_SIZE,
          selectable: true,
          draggable: true,
          data: {
            group,
            ...groupLinks(w, group),
            counts: { steps: group.steps.length, notes: group.notes.length },
            broken: broken.get(group.id) ?? null
          }
        })
      } else {
        boxes.push({
          id: group.id,
          type: 'groupBox',
          position,
          width: box.width,
          height: box.height,
          zIndex: GROUP_Z,
          selectable: false,
          draggable: false,
          data: { group, broken: broken.get(group.id) ?? null }
        })
      }
    }
  }
  const nodes: FlowItem[] = [...boxes, ...noteNodes, ...steps, ...folded]
  const edges = w.edges
    .filter((e) => shown(e.id))
    .map((e): FlowEdge => {
      const end = view?.edgeEnds.get(e.id)
      const edge: FlowEdge = { id: e.id, source: end?.source ?? e.from, sourceHandle: e.port, target: end?.target ?? e.to }
      const label = PORT_LABELS[e.port]
      if (label) edge.label = label
      return edge
    })
  return { nodes, edges }
}

// JSON with object keys sorted: two workflows are the same when they differ only in key order.
export const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, val: unknown) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : val
  )

export const dirty = (a: WorkflowInput, b: WorkflowInput): boolean => canon(a) !== canon(b)
