import {
  GROUPS_MAX,
  NOTES_MAX,
  groupsOf,
  notesOf,
  type CanvasGroup,
  type Edge,
  type Note,
  type Step,
  type StepKind,
  type WorkflowInput
} from '@zumibot/shared/workflows'
import { handleFor } from '@zumibot/shared/workflowGraph'
import { parseEdges, parseGroup, parseNote, parseStep } from '@zumibot/shared/workflowInput'
import { freshId, handlesOf, idsOf, randomId, rewriteHandles, type IdGen } from './workflowCanvas'
import { itemsSelection, picked, type Selection } from './workflowEditor'
import { GROUPS_FULL } from './workflowGroupEdit'
import { NOTES_FULL } from './workflowNotes'

// Copy, cut, paste and duplicate on the canvas as pure rules. The clip travels as JSON text on the system clipboard, so
// a paste works across tabs and workflows; text that is not a clip is never taken for one.

export const CLIP_MARK = 'workflow-clip'
export interface Clip {
  steps: Step[]
  edges: Edge[]
  notes: Note[]
  groups: CanvasGroup[]
}

/** Where a paste with no pointer lands: the copy sits a little off its source so it does not hide it. */
const OFFSET = 40

/**
 * The picked steps (never the trigger), notes, the edges between the steps, and every group all of whose members are
 * copied; null when there is nothing to copy. A picked collapsed group stands for all its members; an expanded one is
 * never picked as a group (its members are), so it adds nothing here.
 */
export function copyClip(w: WorkflowInput, sel: Selection | null, collapsed: Set<string>): Clip | null {
  const p = picked(sel)
  const folded = groupsOf(w).filter((g) => p.groups.includes(g.id) && collapsed.has(g.id))
  const want = new Set([...p.steps, ...folded.flatMap((g) => g.steps)]),
    wantNotes = new Set([...p.notes, ...folded.flatMap((g) => g.notes)])
  const steps = w.steps.filter((s) => want.has(s.id) && s.kind !== 'trigger')
  const notes = notesOf(w).filter((n) => wantNotes.has(n.id))
  if (steps.length === 0 && notes.length === 0) return null
  const ids = new Set(steps.map((s) => s.id)),
    noteIds = new Set(notes.map((n) => n.id))
  const groups = groupsOf(w).filter(
    (g) => g.steps.length + g.notes.length > 0 && g.steps.every((id) => ids.has(id)) && g.notes.every((id) => noteIds.has(id))
  )
  return { steps, edges: w.edges.filter((e) => ids.has(e.from) && ids.has(e.to)), notes, groups }
}

export const clipText = (c: Clip): string => JSON.stringify({ zumibot: CLIP_MARK, v: 1, ...c })

/** A clip from clipboard text, rebuilt through the server's own step and edge rules; null for anything else. */
export function parseClip(text: string): Clip | null {
  try {
    const x: unknown = JSON.parse(text)
    if (!x || typeof x !== 'object' || Array.isArray(x)) return null
    const o = x as Record<string, unknown>
    if (o.zumibot !== CLIP_MARK || o.v !== 1 || !Array.isArray(o.steps)) return null
    const steps = o.steps.map(parseStep)
    const kinds = new Map<string, StepKind>(steps.map((s) => [s.id, s.kind]))
    if (kinds.size !== steps.length || steps.some((s) => s.kind === 'trigger')) return null
    // Old clips have no notes or groups key; a present one must be a list the server's own rule accepts.
    if (o.notes !== undefined && !Array.isArray(o.notes)) return null
    if (o.groups !== undefined && !Array.isArray(o.groups)) return null
    const notes = (o.notes ?? []).map(parseNote)
    const groups = (o.groups ?? []).map(parseGroup)
    if (notes.length > NOTES_MAX || groups.length > GROUPS_MAX) return null
    const all = [...steps, ...notes, ...groups].map((x) => x.id)
    if (new Set(all).size !== all.length) return null
    // A group holds only what the clip holds, each item at most once across groups, as the save checks; one holding
    // nothing would paste as a group nobody can see, still counting toward the cap.
    const noteIds = new Set(notes.map((n) => n.id)),
      taken = new Set<string>()
    for (const g of groups) {
      if (g.steps.length + g.notes.length === 0) return null
      if (g.steps.some((id) => !kinds.has(id)) || g.notes.some((id) => !noteIds.has(id))) return null
      for (const m of [...g.steps, ...g.notes]) {
        if (taken.has(m)) return null
        taken.add(m)
      }
    }
    return { steps, edges: parseEdges(o.edges, new Map(steps.map((s) => [s.id, s]))), notes, groups }
  } catch {
    return null
  }
}

/**
 * The clip added to `w` with new ids and handles that clash with nothing there; templates among the pasted steps follow
 * their new handles, and pasted groups hold the pasted members under their new ids. The top-left of the pasted steps
 * lands at `at`, or 40 px down and right of where they were.
 */
export function pasteClip(
  w: WorkflowInput,
  c: Clip,
  at: { x: number; y: number } | null,
  gen: IdGen = randomId
): { w: WorkflowInput; picked: Selection | null } | { error: string } {
  if (c.steps.length === 0 && c.notes.length === 0) return { error: 'Nothing to paste.' }
  if (notesOf(w).length + c.notes.length > NOTES_MAX) return { error: NOTES_FULL }
  if (groupsOf(w).length + c.groups.length > GROUPS_MAX) return { error: GROUPS_FULL }
  try {
    const used = idsOf(w)
    const taken = handlesOf(w)
    // The clip's top-left covers its notes too, so a note keeps its place against the steps.
    const minX = Math.min(...c.steps.map((s) => s.x), ...c.notes.map((n) => n.x)),
      minY = Math.min(...c.steps.map((s) => s.y), ...c.notes.map((n) => n.y))
    const dx = at ? at.x - minX : OFFSET,
      dy = at ? at.y - minY : OFFSET
    // Every pasted step gets its own handle, tracked by its id: steps may share an old handle (Save allows it).
    const ids = new Map<string, string>(),
      own = new Map<string, string>()
    const oldCount = new Map<string, number>()
    for (const s of c.steps) oldCount.set(s.handle, (oldCount.get(s.handle) ?? 0) + 1)
    for (const s of c.steps) {
      const id = freshId(used, gen)
      used.add(id)
      const handle = handleFor(s.handle, taken)
      taken.add(handle)
      ids.set(s.id, id)
      own.set(s.id, handle)
    }
    // Templates follow only an old handle that names one pasted step; a duplicated one stays as written (ambiguous).
    const handles = new Map<string, string>()
    for (const s of c.steps) if (oldCount.get(s.handle) === 1) handles.set(s.handle, own.get(s.id) as string)
    const steps = c.steps.map(
      (s) =>
        ({ ...rewriteHandles(s, handles), id: ids.get(s.id) as string, handle: own.get(s.id) as string, x: s.x + dx, y: s.y + dy }) as Step
    )
    const edges: Edge[] = []
    for (const e of c.edges) {
      const from = ids.get(e.from),
        to = ids.get(e.to)
      if (!from || !to) continue
      const id = freshId(used, gen)
      used.add(id)
      edges.push({ id, from, port: e.port, to })
    }
    const noteIds = new Map<string, string>()
    const notes = c.notes.map((n): Note => {
      const id = freshId(used, gen)
      used.add(id)
      noteIds.set(n.id, id)
      return { ...n, id, x: n.x + dx, y: n.y + dy }
    })
    // copyClip and parseClip both keep every member inside the clip; one that is not would be left out, never kept stale.
    const groups = c.groups.map((g): CanvasGroup => {
      const id = freshId(used, gen)
      used.add(id)
      return {
        id,
        name: g.name,
        ...(g.description !== undefined ? { description: g.description } : {}),
        steps: g.steps.flatMap((m) => ids.get(m) ?? []),
        notes: g.notes.flatMap((m) => noteIds.get(m) ?? [])
      }
    })
    const out: WorkflowInput = { ...w, steps: [...w.steps, ...steps], edges: [...w.edges, ...edges] }
    if (notes.length > 0) out.notes = [...notesOf(w), ...notes]
    if (groups.length > 0) out.groups = [...groupsOf(w), ...groups]
    return { w: out, picked: itemsSelection({ steps: steps.map((s) => s.id), notes: notes.map((n) => n.id) }) }
  } catch {
    return { error: 'Could not paste.' }
  }
}

// The last clip copied here, for a menu's Paste that has no clipboard event to read from.
let last: Clip | null = null
export function setLastClip(c: Clip): void {
  last = c
}
export const lastClip = (): Clip | null => last
