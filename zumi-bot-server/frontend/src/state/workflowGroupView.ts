import { groupsOf, notesOf, type CanvasGroup, type Port, type WorkflowInput } from '@zumibot/shared/workflows'
import { groupEnds } from '@zumibot/shared/workflowGroups'

// Where a group shows on the canvas: its box, derived from its members (never stored), and what a collapsed group hides
// and reroutes. Kept apart from the group edits because toFlow needs it, and the edits need workflowCanvas: one module
// for both would import itself in a circle. workflowGroupEdit.ts re-exports all of it.

export type Box = { x: number; y: number; width: number; height: number }
export type SizeOf = (id: string) => { width: number; height: number }

export const GROUP_PAD = 24
// Room above the members for the name and the description under it.
export const GROUP_HEAD = 36
// About a step's size, so a collapsed group sits in the flow like one.
export const COLLAPSED_SIZE = { width: 220, height: 64 }
// A step's size before the canvas has measured it (a member of a group that was collapsed when the workflow opened).
export const STEP_SIZE = { width: 220, height: 80 }

// Every port in one order that agrees with each kind's own (portsOf), so a collapsed group lists them as its exit does.
const PORT_ORDER: Port[] = ['out', 'yes', 'no', 'approved', 'rejected', 'error']

/** The group a step or note belongs to, or null. */
export function groupOf(w: Pick<WorkflowInput, 'groups'>, itemId: string): CanvasGroup | null {
  return groupsOf(w).find((g) => g.steps.includes(itemId) || g.notes.includes(itemId)) ?? null
}

/** The members' bounding box (steps measured by `sizeOf`, notes by their own size), padded, with room for the header. */
export function groupBox(w: Pick<WorkflowInput, 'steps' | 'notes'>, g: CanvasGroup, sizeOf: SizeOf): Box {
  const steps = new Set(g.steps),
    notes = new Set(g.notes)
  const boxes: Box[] = [
    ...w.steps.filter((s) => steps.has(s.id)).map((s) => ({ x: s.x, y: s.y, ...sizeOf(s.id) })),
    ...notesOf(w)
      .filter((n) => notes.has(n.id))
      .map((n) => ({ x: n.x, y: n.y, width: n.width, height: n.height }))
  ]
  if (boxes.length === 0) return { x: 0, y: 0, width: 0, height: 0 }
  const left = Math.min(...boxes.map((b) => b.x)),
    top = Math.min(...boxes.map((b) => b.y))
  const right = Math.max(...boxes.map((b) => b.x + b.width)),
    bottom = Math.max(...boxes.map((b) => b.y + b.height))
  return {
    x: left - GROUP_PAD,
    y: top - GROUP_PAD - GROUP_HEAD,
    width: right - left + 2 * GROUP_PAD,
    height: bottom - top + 2 * GROUP_PAD + GROUP_HEAD
  }
}

/**
 * What the collapsed groups hide (their members and the edges among them) and where each edge that crosses one is
 * drawn instead: into the group's input, or out of the group's handle for the port it leaves by.
 */
export function collapsedView(
  w: Pick<WorkflowInput, 'edges' | 'groups'>,
  collapsed: Set<string>
): { hidden: Set<string>; edgeEnds: Map<string, { source?: string; target?: string; sourceHandle?: string }> } {
  const hidden = new Set<string>()
  const owner = new Map<string, string>()
  for (const g of groupsOf(w)) {
    if (!collapsed.has(g.id)) continue
    for (const id of g.steps) {
      hidden.add(id)
      owner.set(id, g.id)
    }
    for (const id of g.notes) hidden.add(id)
  }
  const edgeEnds = new Map<string, { source?: string; target?: string; sourceHandle?: string }>()
  for (const e of w.edges) {
    const from = owner.get(e.from),
      to = owner.get(e.to)
    if (from === undefined && to === undefined) continue
    if (from === to) {
      hidden.add(e.id)
      continue
    }
    edgeEnds.set(e.id, {
      ...(from !== undefined ? { source: from, sourceHandle: e.port } : {}),
      ...(to !== undefined ? { target: to } : {})
    })
  }
  return { hidden, edgeEnds }
}

/** What stands for an item on the canvas: the collapsed group a member hides in, else the item itself. */
export function visibleItem(w: Pick<WorkflowInput, 'groups'>, collapsed: Set<string>, id: string): string {
  const g = groupOf(w, id)
  return g && collapsed.has(g.id) ? g.id : id
}

/**
 * A collapsed group's handles: an input when an edge comes in from outside, and the ports edges leave by. Every edge
 * that crosses counts, not just the entry's and exit's, so a group that breaks a rule still draws each of its edges.
 */
export function groupLinks(w: Pick<WorkflowInput, 'edges'>, g: CanvasGroup): { ports: Port[]; hasInput: boolean } {
  const inside = new Set(g.steps)
  const out = new Set<Port>()
  let hasInput = false
  for (const e of w.edges) {
    if (inside.has(e.from) && !inside.has(e.to)) out.add(e.port)
    if (inside.has(e.to) && !inside.has(e.from)) hasInput = true
  }
  return { ports: PORT_ORDER.filter((p) => out.has(p)), hasInput }
}

/**
 * The steps these picked steps show as: each one a collapsed group hides is that group instead, once, in the order they
 * come, so a selection never holds a step nobody can see (Shift+Arrow walking into a collapsed group).
 */
export function visiblePicked(
  w: Pick<WorkflowInput, 'groups'>,
  collapsed: Set<string>,
  steps: string[]
): { steps: string[]; groups: string[] } {
  const out = { steps: [] as string[], groups: [] as string[] }
  for (const id of steps) {
    const shown = visibleItem(w, collapsed, id)
    const list = shown === id ? out.steps : out.groups
    if (!list.includes(shown)) list.push(shown)
  }
  return out
}

type Linked = Pick<WorkflowInput, 'steps' | 'edges' | 'groups'>
const collapsedGroup = (w: Linked, collapsed: Set<string>, id: string): CanvasGroup | null =>
  collapsed.has(id) ? (groupsOf(w).find((g) => g.id === id) ?? null) : null

/**
 * The step a connection drawn out of this node's port starts at. A collapsed group stands for the member that leaves it
 * by that port (its exit), or for its exit step when none does yet; null when it has none. Any other id is itself.
 */
export function stepOutOf(w: Linked, collapsed: Set<string>, nodeId: string, port: string): string | null {
  const g = collapsedGroup(w, collapsed, nodeId)
  if (!g) return nodeId
  const inside = new Set(g.steps)
  return w.edges.find((e) => e.port === port && inside.has(e.from) && !inside.has(e.to))?.from ?? groupEnds(w, g.steps).exit
}

/**
 * The step a connection dropped on this node ends at. A collapsed group stands for its entry step; one with none yet
 * for the member nothing inside leads into (top-left first), and for nothing when every member has one (a loop). Any
 * other id is itself.
 */
export function stepInto(w: Linked, collapsed: Set<string>, nodeId: string): string | null {
  const g = collapsedGroup(w, collapsed, nodeId)
  if (!g) return nodeId
  const entry = groupEnds(w, g.steps).entry
  if (entry !== null) return entry
  const inside = new Set(g.steps)
  const fed = new Set(w.edges.filter((e) => inside.has(e.from) && inside.has(e.to)).map((e) => e.to))
  const heads = w.steps.filter((s) => inside.has(s.id) && !fed.has(s.id)).sort((a, b) => a.y - b.y || a.x - b.x)
  return heads[0]?.id ?? null
}

/**
 * A connection as React Flow reports it (node ids and a source handle) as the steps it joins, through stepOutOf and
 * stepInto; null when it joins none or would join a step to itself. Whether the steps can be joined is connect's call.
 */
export function realConnection(
  w: Linked,
  collapsed: Set<string>,
  c: { source: string; sourceHandle?: string | null; target: string }
): { from: { stepId: string; port: Port }; to: string } | null {
  // From a collapsed group back into itself would be an edge among its own members, which it hides.
  if (!c.sourceHandle || c.source === c.target) return null
  const from = stepOutOf(w, collapsed, c.source, c.sourceHandle)
  const to = stepInto(w, collapsed, c.target)
  if (from === null || to === null || from === to) return null
  return { from: { stepId: from, port: c.sourceHandle as Port }, to }
}
