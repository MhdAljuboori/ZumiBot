import { notesOf, type CanvasGroup, type Note, type WorkflowInput } from './workflows'

// The rules for a group of steps and notes, shared by the editor (what it offers and says) and the save (what it keeps).
// A group is only a box for people; these rules keep it one clean stretch of the flow, so it can fold into one node.

export type GroupRuleBreak = 'too-few' | 'trigger' | 'taken' | 'not-connected' | 'many-entries' | 'many-exits'

export const GROUP_RULE_TEXT: Record<GroupRuleBreak, string> = {
  'too-few': 'A group needs at least two items, one of them a step',
  trigger: 'The trigger cannot be in a group',
  taken: 'A step or note is already in another group',
  'not-connected': 'The steps must form one connected chain',
  'many-entries': 'Steps outside can only connect into the first step of the group',
  'many-exits': 'Steps outside can only connect from the last step of the group'
}

type G = Pick<WorkflowInput, 'steps' | 'edges' | 'groups'>

/** The step edges enter the group at, and the one they leave from; several of either break the group. */
function ends(w: Pick<WorkflowInput, 'edges'>, steps: string[]): { entries: string[]; exits: string[] } {
  const inside = new Set(steps)
  const entries = new Set<string>(),
    exits = new Set<string>()
  for (const e of w.edges) {
    if (inside.has(e.to) && !inside.has(e.from)) entries.add(e.to)
    if (inside.has(e.from) && !inside.has(e.to)) exits.add(e.from)
  }
  return { entries: [...entries], exits: [...exits] }
}

/** The group's first step (where outside edges come in) and last (where they leave); null where there are none. */
export function groupEnds(w: Pick<WorkflowInput, 'edges'>, steps: string[]): { entry: string | null; exit: string | null } {
  const { entries, exits } = ends(w, steps)
  return { entry: entries[0] ?? null, exit: exits[0] ?? null }
}

// Direction is ignored: a step reached by any edge between members belongs to the chain.
function connected(w: Pick<WorkflowInput, 'edges'>, steps: string[]): boolean {
  const inside = new Set(steps)
  const seen = new Set<string>([steps[0]!])
  const todo = [steps[0]!]
  while (todo.length) {
    const at = todo.pop()!
    for (const e of w.edges) {
      if (!inside.has(e.from) || !inside.has(e.to)) continue
      const next = e.from === at ? e.to : e.to === at ? e.from : null
      if (next !== null && !seen.has(next)) {
        seen.add(next)
        todo.push(next)
      }
    }
  }
  return seen.size === inside.size
}

/**
 * Why these steps and notes cannot be one group, or null. `self` is the group being checked (or changed), whose own
 * members never count as taken.
 */
export function groupRuleBreak(w: G, steps: string[], notes: string[], self?: string): GroupRuleBreak | null {
  if (steps.length < 1 || steps.length + notes.length < 2) return 'too-few'
  const kinds = new Map(w.steps.map((s) => [s.id, s.kind]))
  if (steps.some((id) => kinds.get(id) === 'trigger')) return 'trigger'
  const mine = new Set([...steps, ...notes])
  if ((w.groups ?? []).some((g) => g.id !== self && [...g.steps, ...g.notes].some((id) => mine.has(id)))) return 'taken'
  if (!connected(w, steps)) return 'not-connected'
  const { entries, exits } = ends(w, steps)
  if (entries.length > 1) return 'many-entries'
  if (exits.length > 1) return 'many-exits'
  return null
}

/** The groups that break a rule now, with the first one each breaks; each is checked as itself, so none is `taken` by its own members. */
export function brokenGroups(w: G): { group: CanvasGroup; reason: GroupRuleBreak }[] {
  const out: { group: CanvasGroup; reason: GroupRuleBreak }[] = []
  for (const group of w.groups ?? []) {
    const reason = groupRuleBreak(w, group.steps, group.notes, group.id)
    if (reason) out.push({ group, reason })
  }
  return out
}

/**
 * The workflow as the save keeps it: members that no longer exist are taken out of each group, then a group that breaks
 * a rule is dropped, as n8n ungroups on save. The groups are checked in order, so an earlier one keeps a contested item.
 */
export function dropBrokenGroups<T extends G>(w: T): T {
  const steps = new Set(w.steps.filter((s) => s.kind !== 'trigger').map((s) => s.id))
  const notes = new Set(notesOf(w as T & { notes?: Note[] }).map((n) => n.id))
  const kept: CanvasGroup[] = []
  for (const g of w.groups ?? []) {
    const own = { ...g, steps: g.steps.filter((id) => steps.has(id)), notes: g.notes.filter((id) => notes.has(id)) }
    if (!groupRuleBreak({ ...w, groups: kept }, own.steps, own.notes, own.id)) kept.push(own)
  }
  return { ...w, groups: kept }
}
