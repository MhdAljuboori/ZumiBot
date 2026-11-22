// A hand-written RFC 6902 applier for STATE_DELTA, with RFC 6901 pointers. It patches a deep copy and gives the result, or
// fails whole: the caller then drops the state. The state comes from a remote server, so every key is only a key: values are
// set with defineProperty (never `o[k] = v`), and only own properties are ever read. A copy can double the document per op,
// so what a patch writes is measured against a byte budget before it is made, and its ops are capped.

export type PatchResult = { ok: true; doc: unknown } | { ok: false }

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)

function setKey(o: Obj, k: string, v: unknown): void {
  Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true })
}

function clone(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(clone)
  if (!isObj(v)) return v
  const o: Obj = {}
  for (const k of Object.keys(v)) setKey(o, k, clone(v[k]))
  return o
}

function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]))
  if (isObj(a)) {
    if (!isObj(b)) return false
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && same(a[k], b[k]))
  }
  return a === b
}

function pointer(p: unknown): string[] | null {
  if (typeof p !== 'string') return null
  if (p === '') return []
  if (!p.startsWith('/')) return null
  const tokens: string[] = []
  for (const t of p.slice(1).split('/')) {
    if (/~(?![01])/.test(t)) return null
    tokens.push(t.replace(/~1/g, '/').replace(/~0/g, '~'))
  }
  return tokens
}

const INDEX = /^(0|[1-9][0-9]*)$/

class Doc {
  constructor(public root: unknown) {}

  // The container a path's last token is read in, or null when any step on the way is missing.
  private parent(path: string[]): unknown {
    let cur = this.root
    for (const t of path.slice(0, -1)) {
      const next = this.child(cur, t)
      if (!next.found) return null
      cur = next.value
    }
    return cur
  }

  private child(cur: unknown, t: string): { found: true; value: unknown } | { found: false } {
    if (Array.isArray(cur)) return INDEX.test(t) && Number(t) < cur.length ? { found: true, value: cur[Number(t)] } : { found: false }
    if (isObj(cur) && Object.hasOwn(cur, t)) return { found: true, value: cur[t] }
    return { found: false }
  }

  get(path: string[]): { found: true; value: unknown } | { found: false } {
    if (path.length === 0) return { found: true, value: this.root }
    return this.child(this.parent(path), path[path.length - 1])
  }

  add(path: string[], value: unknown): boolean {
    if (path.length === 0) {
      this.root = value
      return true
    }
    const p = this.parent(path)
    const k = path[path.length - 1]
    if (Array.isArray(p)) {
      if (k === '-') {
        p.push(value)
        return true
      }
      if (!INDEX.test(k) || Number(k) > p.length) return false
      p.splice(Number(k), 0, value)
      return true
    }
    if (!isObj(p)) return false
    setKey(p, k, value)
    return true
  }

  remove(path: string[]): boolean {
    if (path.length === 0 || !this.get(path).found) return false
    const p = this.parent(path)
    const k = path[path.length - 1]
    if (Array.isArray(p)) p.splice(Number(k), 1)
    else delete (p as Obj)[k]
    return true
  }

  replace(path: string[], value: unknown): boolean {
    if (path.length === 0) {
      this.root = value
      return true
    }
    if (!this.get(path).found) return false
    const p = this.parent(path)
    const k = path[path.length - 1]
    if (Array.isArray(p)) p[Number(k)] = value
    else setKey(p as Obj, k, value)
    return true
  }
}

const isPrefix = (a: string[], b: string[]): boolean => a.length < b.length && a.every((t, i) => b[i] === t)

/** The most ops one patch may hold: each may walk the document. */
export const PATCH_OPS_MAX = 1000

/**
 * About how many bytes `v` takes as JSON (a string by its length), counted only until the total passes `max`: the walk stops
 * there, so measuring a value built to be huge costs no more than the budget. Iterative, so depth is no limit.
 */
function sizeUpTo(v: unknown, max: number): number {
  let n = 0
  const stack: unknown[] = [v]
  while (stack.length > 0 && n <= max) {
    const x = stack.pop()
    if (typeof x === 'string') n += x.length + 2
    else if (typeof x === 'number') n += String(x).length
    else if (typeof x === 'boolean') n += 5
    else if (Array.isArray(x)) {
      n += 2 + x.length
      if (n <= max) for (const y of x) stack.push(y)
    } else if (isObj(x)) {
      const keys = Object.keys(x)
      n += 2 + keys.length
      for (const k of keys) {
        n += k.length + 3
        if (n > max) break
        stack.push(x[k])
      }
    } else n += 4 // null, and anything JSON would not hold
  }
  return n
}

/** The bytes a patch may still write. */
interface Budget {
  left: number
}

/** A deep copy of `v` to write, or `undefined` once it would pass the budget (measured before anything is copied). */
function spend(budget: Budget, v: unknown): { value: unknown } | undefined {
  const size = sizeUpTo(v, budget.left)
  if (size > budget.left) return undefined
  budget.left -= size
  return { value: clone(v) }
}

function step(doc: Doc, op: unknown, budget: Budget): boolean {
  if (!isObj(op)) return false
  const path = pointer(op.path)
  if (path === null) return false
  const hasValue = Object.hasOwn(op, 'value')
  switch (op.op) {
    case 'add': {
      const w = hasValue ? spend(budget, op.value) : undefined
      return w !== undefined && doc.add(path, w.value)
    }
    case 'remove':
      return doc.remove(path)
    case 'replace': {
      const w = hasValue ? spend(budget, op.value) : undefined
      return w !== undefined && doc.replace(path, w.value)
    }
    case 'test': {
      const got = doc.get(path)
      return hasValue && got.found && same(got.value, op.value)
    }
    case 'move':
    case 'copy': {
      const from = pointer(op.from)
      if (from === null) return false
      const got = doc.get(from)
      if (!got.found) return false
      if (op.op === 'copy') {
        const w = spend(budget, got.value)
        return w !== undefined && doc.add(path, w.value)
      }
      // A value cannot move into its own child; moving onto itself changes nothing.
      if (isPrefix(from, path)) return false
      if (from.length === path.length && from.every((t, i) => path[i] === t)) return true
      return doc.remove(from) && doc.add(path, got.value)
    }
    default:
      return false
  }
}

/**
 * The patched deep copy of `doc`, or `ok: false` when any op is bad or fails (the input is never changed), when there are more
 * than PATCH_OPS_MAX ops, or once what the add, replace and copy ops write would pass `maxBytes`. The kept document is not
 * counted, so the result is at most it plus `maxBytes`: the caller still checks the result against its cap.
 */
export function applyPatch(doc: unknown, ops: unknown, maxBytes: number): PatchResult {
  if (!Array.isArray(ops) || ops.length > PATCH_OPS_MAX) return { ok: false }
  const budget: Budget = { left: maxBytes }
  try {
    const d = new Doc(clone(doc))
    for (const op of ops) if (!step(d, op, budget)) return { ok: false }
    return { ok: true, doc: d.root }
  } catch {
    return { ok: false } // a document nested past the stack
  }
}
