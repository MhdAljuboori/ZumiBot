import type { WorkflowInput } from '@zumibot/shared/workflows'

export type NavDir = 'next' | 'prev' | 'up' | 'down'
type Graph = Pick<WorkflowInput, 'steps' | 'edges'>

/** Which step an arrow key moves to: along the edges (right, left) or among the steps that share a parent (up, down). */
export function navTarget(w: Graph, from: string | null, dir: NavDir): string | null {
  if (from === null) return w.steps.find((s) => s.kind === 'trigger')?.id ?? null
  if (!w.steps.some((s) => s.id === from)) return null
  const ordered = (ids: Iterable<string>): string[] => {
    const at = new Map(w.steps.map((s) => [s.id, s]))
    // y, then x, then id: the same answer however the steps are listed.
    return [...new Set(ids)]
      .filter((id) => at.has(id))
      .sort((a, b) => at.get(a)!.y - at.get(b)!.y || at.get(a)!.x - at.get(b)!.x || (a < b ? -1 : a > b ? 1 : 0))
  }
  if (dir === 'next') return ordered(w.edges.filter((e) => e.from === from).map((e) => e.to))[0] ?? null
  if (dir === 'prev') return ordered(w.edges.filter((e) => e.to === from).map((e) => e.from))[0] ?? null
  const parents = new Set(w.edges.filter((e) => e.to === from).map((e) => e.from))
  const row = ordered([from, ...w.edges.filter((e) => parents.has(e.from)).map((e) => e.to)])
  const i = row.indexOf(from)
  return (dir === 'up' ? row[i - 1] : row[i + 1]) ?? null
}

/** Every step downstream (or upstream) of `from`, loops included once, `from` itself left out. */
export function reachAll(w: Graph, from: string, dir: 'next' | 'prev'): string[] {
  const seen = new Set<string>([from])
  const out: string[] = []
  const queue = [from]
  while (queue.length) {
    const id = queue.shift()!
    for (const e of w.edges) {
      const [a, b] = dir === 'next' ? [e.from, e.to] : [e.to, e.from]
      if (a !== id || seen.has(b)) continue
      seen.add(b)
      out.push(b)
      queue.push(b)
    }
  }
  return out
}
