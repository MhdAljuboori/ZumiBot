import {
  GROUPS_MAX,
  GROUP_DESCRIPTION_MAX,
  GROUP_NAME_MAX,
  groupsOf,
  notesOf,
  type CanvasGroup,
  type WorkflowInput
} from '@zumibot/shared/workflows'
import { GROUP_RULE_TEXT, groupRuleBreak, type GroupRuleBreak } from '@zumibot/shared/workflowGroups'
import { GRID, freshId, idsOf, randomId, removeItems, snap, type IdGen } from './workflowCanvas'
import { picked, type Picked, type Selection } from './workflowEditor'
import { setNoteText } from './workflowNotes'
import { COLLAPSED_SIZE, groupBox, type Box, type SizeOf } from './workflowGroupView'

// Pure edits of a workflow's canvas groups, the push an expanding group gives its neighbors, and where the collapse
// state is kept. Like workflowCanvas.ts, each edit returns a new workflow, or the same object back when it refuses or
// nothing changes. The box and the collapsed view live in workflowGroupView.ts (toFlow needs them) and are re-exported.

export {
  COLLAPSED_SIZE,
  GROUP_HEAD,
  GROUP_PAD,
  STEP_SIZE,
  collapsedView,
  groupBox,
  groupOf,
  realConnection,
  stepInto,
  stepOutOf,
  visibleItem,
  visiblePicked
} from './workflowGroupView'
export type { Box, SizeOf } from './workflowGroupView'

/** The space left between an expanding group and what it pushes aside. */
export const PUSH_GAP = 40
export const GROUPS_FULL = `A workflow holds at most ${GROUPS_MAX} groups`

const withGroup = (w: WorkflowInput, id: string, change: (g: CanvasGroup) => CanvasGroup): WorkflowInput => {
  const groups = groupsOf(w)
  const at = groups.find((g) => g.id === id)
  if (!at) return w
  const next = change(at)
  return next === at ? w : { ...w, groups: groups.map((g) => (g === at ? next : g)) }
}

// The picked items as group members: only ids the workflow has (the rules take any id), in workflow order, and the
// members of a picked collapsed group, which are then taken by it.
function members(w: WorkflowInput, p: Picked): { steps: string[]; notes: string[] } {
  const picked = groupsOf(w).filter((g) => p.groups.includes(g.id))
  const steps = new Set([...p.steps, ...picked.flatMap((g) => g.steps)]),
    notes = new Set([...p.notes, ...picked.flatMap((g) => g.notes)])
  return {
    steps: w.steps.filter((s) => steps.has(s.id)).map((s) => s.id),
    notes: notesOf(w)
      .filter((n) => notes.has(n.id))
      .map((n) => n.id)
  }
}

/** Why these picked items cannot become a group, in words, or null when they can. */
export function groupRefusal(w: WorkflowInput, p: Picked): string | null {
  const m = members(w, p)
  const reason = groupRuleBreak(w, m.steps, m.notes)
  return reason ? GROUP_RULE_TEXT[reason] : null
}

/** A new group of the picked items, named "Group N" with the first number no group's name has. */
export function makeGroup(w: WorkflowInput, p: Picked, gen: IdGen = randomId): { w: WorkflowInput; groupId: string } | { error: string } {
  const refused = groupRefusal(w, p)
  if (refused) return { error: refused }
  const groups = groupsOf(w)
  if (groups.length >= GROUPS_MAX) return { error: GROUPS_FULL }
  const names = new Set(groups.map((g) => g.name))
  let n = 1
  while (names.has(`Group ${n}`)) n++
  const groupId = freshId(idsOf(w), gen)
  return { w: { ...w, groups: [...groups, { id: groupId, name: `Group ${n}`, ...members(w, p) }] }, groupId }
}

/** These groups gone, their members left where they are. */
export function ungroup(w: WorkflowInput, ids: string[]): WorkflowInput {
  const groups = groupsOf(w)
  const kept = groups.filter((g) => !ids.includes(g.id))
  return kept.length === groups.length ? w : { ...w, groups: kept }
}

/** The group and its members, with every edge to or from them, in one edit. */
export function deleteGroup(w: WorkflowInput, id: string): WorkflowInput {
  return removeItems(w, { steps: [], notes: [], groups: [id] })
}

// Kept as typed (a field may be mid-word with a trailing space), capped so the save never refuses it; the save trims.
export function renameGroup(w: WorkflowInput, id: string, name: string): WorkflowInput {
  const v = name.slice(0, GROUP_NAME_MAX)
  if (!v.trim()) return w
  return withGroup(w, id, (g) => (g.name === v ? g : { ...g, name: v }))
}

/** A blank description is none: the key goes, as the save drops a blank one. */
export function setGroupDescription(w: WorkflowInput, id: string, text: string): WorkflowInput {
  const v = text.slice(0, GROUP_DESCRIPTION_MAX)
  return withGroup(w, id, (g) => {
    if (!v.trim()) {
      if (g.description === undefined) return g
      const rest = { ...g }
      delete rest.description
      return rest
    }
    return g.description === v ? g : { ...g, description: v }
  })
}

/** The groups the picked items belong to, and the picked collapsed groups, once each, in workflow order. */
export function groupsOfPicked(w: Pick<WorkflowInput, 'groups'>, p: Picked): string[] {
  const items = new Set([...p.steps, ...p.notes])
  return groupsOf(w)
    .filter((g) => p.groups.includes(g.id) || g.steps.some((id) => items.has(id)) || g.notes.some((id) => items.has(id)))
    .map((g) => g.id)
}

/** The groups Alt+G and Shift+Alt+G act on: those of the picked items (or picked collapsed groups), or every group when nothing is picked. */
export function groupsToToggle(w: Pick<WorkflowInput, 'groups'>, s: Selection | null): string[] {
  return s === null ? groupsOf(w).map((g) => g.id) : groupsOfPicked(w, picked(s))
}

/** The collapse state with these groups collapsed (`on`) or expanded; the same set back when that changes nothing. */
export function withCollapsed(collapsed: Set<string>, ids: string[], on: boolean): Set<string> {
  if (ids.every((id) => collapsed.has(id) === on)) return collapsed
  const next = new Set(collapsed)
  for (const id of ids) {
    if (on) next.add(id)
    else next.delete(id)
  }
  return next
}

/** "2 steps", or "1 step · 1 note" when the group holds notes, for the collapsed node and the group panel. */
export function groupCountText(steps: number, notes: number): string {
  const n = (count: number, one: string): string => `${count} ${one}${count === 1 ? '' : 's'}`
  return notes > 0 ? `${n(steps, 'step')} · ${n(notes, 'note')}` : n(steps, 'step')
}

/**
 * What the save says about the groups it dropped for breaking a rule, or null when it dropped none. A sentence of its
 * own: the save's own notice may follow it.
 */
export function ungroupNotice(dropped: { group: CanvasGroup; reason: GroupRuleBreak }[]): string | null {
  if (dropped.length === 0) return null
  if (dropped.length === 1) return `Ungrouped ${dropped[0].group.name}: ${GROUP_RULE_TEXT[dropped[0].reason]}.`
  return `Ungrouped ${dropped.length} groups: ${dropped.map((d) => `${d.group.name} (${GROUP_RULE_TEXT[d.reason]})`).join(', ')}.`
}

type At = { x: number; y: number }

/**
 * Where a drop lands, from React Flow's last positions and where each collapsed group's node was before the drag. React
 * Flow snaps only the first item of a drag (moving the rest by the same offset), so several items keep their places to
 * each other and a lone one lands on the grid. A collapsed group moves its members by whole grid steps, alone or with
 * others: its node sits off the grid (the box's padding) while they are on it, and when it is the first item (nothing
 * but collapsed groups dragged) React Flow put that node on the grid, not them.
 */
export function dropMoves(
  landed: ({ id: string } & At)[],
  foldedAt: Map<string, At>
): { items: ({ id: string } & At)[]; folded: { id: string; dx: number; dy: number }[] } {
  const place = landed.length === 1 ? snap : Math.round
  const items = landed.filter((m) => !foldedAt.has(m.id)).map((m) => ({ id: m.id, x: place(m.x), y: place(m.y) }))
  const folded = landed.flatMap((m) => {
    const at = foldedAt.get(m.id)
    return at ? [{ id: m.id, dx: snap(m.x - at.x), dy: snap(m.y - at.y) }] : []
  })
  return { items, folded }
}

/** A note's text or a group's name or description as typed in its open field, before it lands. */
export type OpenField =
  { kind: 'note'; id: string; text: string } | { kind: 'group'; id: string; field: 'name' | 'description'; text: string }

/** The edit the field makes when it closes; the same workflow back when it would change nothing. */
export function landField(w: WorkflowInput, f: OpenField): WorkflowInput {
  if (f.kind === 'note') return setNoteText(w, f.id, f.text)
  return f.field === 'name' ? renameGroup(w, f.id, f.text) : setGroupDescription(w, f.id, f.text)
}

/** The history key of that edit: typing in one field undoes as one step. */
export const fieldKey = (f: OpenField): string => (f.kind === 'note' ? `note:${f.id}:text` : `group:${f.id}:${f.field}`)

/** A drag of a collapsed group: every member moves by the same amount. */
export function moveGroup(w: WorkflowInput, groupId: string, dx: number, dy: number): WorkflowInput {
  const g = groupsOf(w).find((x) => x.id === groupId)
  if (!g || (dx === 0 && dy === 0)) return w
  const steps = new Set(g.steps),
    notes = new Set(g.notes)
  const by = <T extends { id: string; x: number; y: number }>(v: T): T => ({ ...v, x: v.x + dx, y: v.y + dy })
  const noted = notesOf(w).some((n) => notes.has(n.id))
  return {
    ...w,
    steps: w.steps.map((s) => (steps.has(s.id) ? by(s) : s)),
    ...(noted ? { notes: notesOf(w).map((n) => (notes.has(n.id) ? by(n) : n)) } : {})
  }
}

const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
const holds = (outer: Box, inner: Box): boolean =>
  outer.x <= inner.x &&
  outer.y <= inner.y &&
  outer.x + outer.width >= inner.x + inner.width &&
  outer.y + outer.height >= inner.y + inner.height
// Up to the next grid line, never down: rounding down would leave less than the gap. `+ 0` keeps a -0 (from a small
// negative value) out of the saved position, as snap does.
const upToGrid = (v: number): number => Math.ceil(v / GRID) * GRID + 0

// What the push moves as one: a step or note in no group, or another group whole (its collapsed node, or its box).
interface Unit {
  kind: 'step' | 'note' | 'group'
  id: string
  box: Box
  order: number
}

/**
 * What expanding a group does to its neighbors, as n8n does: anything outside it that its box would cover moves right,
 * just clear of the box plus PUSH_GAP, and so does anything a moved item would then land on. Nothing moves left, so it
 * ends; the passes are capped anyway. The group's own members never move. The same workflow back when nothing moves.
 * A loose note that holds the whole collapsed node (a phase note drawn behind the group) is a backdrop: it never moves
 * and stops nothing, or every expand would throw the user's wrapper note off to the right.
 */
export function expandPush(w: WorkflowInput, groupId: string, sizeOf: SizeOf, collapsed: Set<string>): WorkflowInput {
  const groups = groupsOf(w)
  const self = groups.find((g) => g.id === groupId)
  if (!self) return w
  const area = groupBox(w, self, sizeOf)
  // What the user saw before expanding: the collapsed node at the box's top-left.
  const node: Box = { x: area.x, y: area.y, ...COLLAPSED_SIZE }
  const inGroup = new Set(groups.flatMap((g) => [...g.steps, ...g.notes]))
  const units: Unit[] = []
  for (const s of w.steps)
    if (!inGroup.has(s.id)) units.push({ kind: 'step', id: s.id, box: { x: s.x, y: s.y, ...sizeOf(s.id) }, order: units.length })
  for (const n of notesOf(w)) {
    const box = { x: n.x, y: n.y, width: n.width, height: n.height }
    if (!inGroup.has(n.id) && !holds(box, node)) units.push({ kind: 'note', id: n.id, box, order: units.length })
  }
  for (const g of groups) {
    if (g === self) continue
    const box = groupBox(w, g, sizeOf)
    if (box.width === 0) continue // no member left to move
    units.push({ kind: 'group', id: g.id, box: collapsed.has(g.id) ? { x: box.x, y: box.y, ...COLLAPSED_SIZE } : box, order: units.length })
  }
  const start = new Map(units.map((u) => [u, u.box.x]))
  const from = (u: Unit): number => start.get(u) as number
  const pushed = new Set<Unit>()
  // Left to right, two at one x by where they started, then by list order: so between two moved items the one that
  // started further left stays, and a push never swaps their order.
  const first = (a: Unit, b: Unit): number => a.box.x - b.box.x || from(a) - from(b) || a.order - b.order
  const before = (a: Unit, b: Unit): boolean => first(a, b) < 0
  const clear = (u: Unit, right: number): void => {
    // A group moves by whole grid steps so its members stay on the grid; a loose item lands on a grid line.
    u.box = { ...u.box, x: u.kind === 'group' ? u.box.x + upToGrid(right + PUSH_GAP - u.box.x) : upToGrid(right + PUSH_GAP) }
    pushed.add(u)
  }
  const limit = w.steps.length + notesOf(w).length
  let moved = true
  for (let pass = 0; moved && pass < limit; pass++) {
    moved = false
    for (const u of [...units].sort(first)) {
      if (overlaps(u.box, area)) {
        clear(u, area.x + area.width)
        moved = true
      }
      for (const o of [...pushed]) {
        if (o === u || !overlaps(u.box, o.box) || (pushed.has(u) && !before(o, u))) continue
        clear(u, o.box.x + o.box.width)
        moved = true
      }
    }
  }
  const dx = new Map<string, number>()
  for (const u of units) if (u.box.x !== from(u)) dx.set(u.id, u.box.x - from(u))
  if (dx.size === 0) return w
  // One id space, so a loose item's id never names a group's member; groups move through moveGroup.
  const shift = <T extends { id: string; x: number }>(v: T): T => {
    const d = dx.get(v.id)
    return d === undefined ? v : { ...v, x: v.x + d }
  }
  let out: WorkflowInput = w
  if (w.steps.some((s) => dx.has(s.id))) out = { ...out, steps: out.steps.map(shift) }
  if (notesOf(w).some((n) => dx.has(n.id))) out = { ...out, notes: notesOf(out).map(shift) }
  for (const u of units) if (u.kind === 'group' && dx.has(u.id)) out = moveGroup(out, u.id, dx.get(u.id) as number, 0)
  return out
}

const COLLAPSED_KEY = 'cb.wf.collapsed.'

/**
 * Which groups this device keeps collapsed in a workflow. It is a view preference, so it lives in localStorage, never
 * in the workflow; storage can throw (a private window, blocked site data), so any failure reads as none collapsed.
 */
export function loadCollapsed(workflowId: string | null, storage?: Storage): Set<string> {
  if (workflowId === null) return new Set()
  try {
    const raw = (storage ?? globalThis.localStorage).getItem(COLLAPSED_KEY + workflowId)
    const v: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

/** A workflow never saved has no id to keep it under, so the editor holds its state in memory instead. */
export function saveCollapsed(workflowId: string | null, ids: Set<string>, storage?: Storage): void {
  if (workflowId === null) return
  try {
    const s = storage ?? globalThis.localStorage
    if (ids.size === 0) s.removeItem(COLLAPSED_KEY + workflowId)
    else s.setItem(COLLAPSED_KEY + workflowId, JSON.stringify([...ids]))
  } catch {
    /* nothing to remember it in */
  }
}
