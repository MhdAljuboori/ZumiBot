// Where Zumi Bot's workflow steps go on the canvas. The canvas draws a step 220 by 72 (WorkflowCanvas.tsx NODE_HALF),
// so a column and a row leave a clear gap around each one.
export const COLUMN_WIDTH = 320
export const ROW_HEIGHT = 140

export interface Point {
  x: number
  y: number
}

const key = (from: string, to: string) => `${from}\n${to}`

/**
 * Edges that close a loop (found by a DFS from the trigger: an edge to a step still on the path), and the reachable
 * steps in post-order. Iterative, so a long chain cannot overflow the stack.
 */
function walk(start: string, next: Map<string, string[]>): { back: Set<string>; post: string[] } {
  const onPath = new Set<string>([start]),
    done = new Set<string>()
  const back = new Set<string>(),
    post: string[] = []
  const stack: { id: string; i: number }[] = [{ id: start, i: 0 }]
  while (stack.length) {
    const top = stack[stack.length - 1]!
    const outs = next.get(top.id) ?? []
    if (top.i < outs.length) {
      const to = outs[top.i++]!
      if (onPath.has(to)) back.add(key(top.id, to))
      else if (!done.has(to)) {
        onPath.add(to)
        stack.push({ id: to, i: 0 })
      }
    } else {
      onPath.delete(top.id)
      done.add(top.id)
      post.push(top.id)
      stack.pop()
    }
  }
  return { back, post }
}

/** The order edges reach steps from the trigger, breadth first. */
function reachOrder(start: string, next: Map<string, string[]>): string[] {
  const seen = new Set([start]),
    order = [start]
  for (let i = 0; i < order.length; i++) {
    for (const to of next.get(order[i]!) ?? [])
      if (!seen.has(to)) {
        seen.add(to)
        order.push(to)
      }
  }
  return order
}

/**
 * A position for every step. With nothing placed (a new workflow) each step's column is its longest path from the
 * trigger, ignoring edges that close a loop, and a column stacks in reach order; unreachable steps take a last column.
 * Otherwise (an edit) placed steps stay put and each new one goes a column right of the step feeding it, below
 * anything already in that column, so the user's own arrangement is never moved.
 */
export function layout(
  steps: { id: string }[],
  edges: { from: string; to: string }[],
  triggerId: string,
  placed: Map<string, Point>
): Map<string, Point> {
  const ids = new Set(steps.map((s) => s.id))
  const next = new Map<string, string[]>(),
    prev = new Map<string, string[]>()
  const add = (m: Map<string, string[]>, k: string, v: string) => {
    const l = m.get(k)
    if (l) l.push(v)
    else m.set(k, [v])
  }
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue
    add(next, e.from, e.to)
    add(prev, e.to, e.from)
  }
  const hasTrigger = ids.has(triggerId)
  const { back, post } = hasTrigger ? walk(triggerId, next) : { back: new Set<string>(), post: [] }
  const order = hasTrigger ? reachOrder(triggerId, next) : []
  const out = new Map<string, Point>()

  if (placed.size === 0) {
    // Reverse post-order is a topological order once loop-closing edges are left out.
    const col = new Map<string, number>([[triggerId, 0]])
    for (const id of [...post].reverse()) {
      const c = col.get(id) ?? 0
      for (const to of next.get(id) ?? []) if (!back.has(key(id, to))) col.set(to, Math.max(col.get(to) ?? 0, c + 1))
    }
    const rows = new Map<number, number>()
    const put = (id: string, c: number) => {
      const r = rows.get(c) ?? 0
      rows.set(c, r + 1)
      out.set(id, { x: c * COLUMN_WIDTH, y: r * ROW_HEIGHT })
    }
    for (const id of order) put(id, col.get(id) ?? 0)
    const last = order.length ? order.reduce((m, id) => Math.max(m, col.get(id) ?? 0), 0) + 1 : 0
    for (const s of steps) if (!out.has(s.id)) put(s.id, last)
    return out
  }

  for (const [id, p] of placed) if (ids.has(id)) out.set(id, p)
  // Anything closer than a column's width could overlap a step put at x, so it counts as being in that column.
  const put = (id: string, x: number, level: number) => {
    let lowest: number | null = null
    for (const p of out.values()) if (Math.abs(p.x - x) < COLUMN_WIDTH && (lowest === null || p.y > lowest)) lowest = p.y
    out.set(id, { x, y: lowest === null ? level : lowest + ROW_HEIGHT })
  }
  // Reach order places a step's feeder first; a feeder through a forward edge wins over one closing a loop.
  for (const id of order) {
    if (out.has(id)) continue
    const from = prev.get(id) ?? []
    const src = from.find((s) => out.has(s) && !back.has(key(s, id))) ?? from.find((s) => out.has(s))
    if (src === undefined) continue
    const p = out.get(src)!
    put(id, p.x + COLUMN_WIDTH, p.y)
  }
  const rest = steps.filter((s) => !out.has(s.id))
  if (rest.length) {
    let right = -COLUMN_WIDTH
    for (const p of out.values()) right = Math.max(right, p.x)
    const level = out.get(triggerId)?.y ?? 0
    for (const s of rest) put(s.id, right + COLUMN_WIDTH, level)
  }
  return out
}
