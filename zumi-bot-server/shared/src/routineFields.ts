import type { WebhookCall } from './routines'

export const FIELDS_MAX = 500
export const FIELD_DEPTH_MAX = 10
export const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g

interface Entry {
  path: string
  text: string
  leaf: boolean
}

function scalar(v: unknown): string {
  if (v === null || v === undefined) return ''
  return typeof v === 'string' ? v : String(v)
}

function isContainer(v: unknown): v is object {
  return typeof v === 'object' && v !== null
}

// Document-order walk. The leaf budget bounds the work for a huge body; containers add at most one entry per leaf below them.
function walk(value: unknown, path: string, depth: number, out: Entry[], budget: { left: number }): void {
  if (budget.left <= 0) return
  const entries = isContainer(value) ? Object.entries(value) : null
  // Containers at the depth limit, and empty ones, count as leaves so their JSON is still reachable.
  if (!entries || !entries.length || depth >= FIELD_DEPTH_MAX) {
    out.push({ path, text: isContainer(value) ? JSON.stringify(value) : scalar(value), leaf: true })
    budget.left--
    return
  }
  const at = out.length
  out.push({ path, text: '', leaf: false })
  for (const [k, v] of entries) {
    if (budget.left <= 0) break
    walk(v, `${path}.${k}`, depth + 1, out, budget)
  }
  out[at].text = JSON.stringify(value)
}

function entries(call: WebhookCall): Entry[] {
  const out: Entry[] = []
  const budget = { left: FIELDS_MAX }
  for (const [k, v] of Object.entries(call.query ?? {})) {
    if (budget.left <= 0) break
    out.push({ path: `query.${k}`, text: scalar(v), leaf: true })
    budget.left--
  }
  if (call.method !== 'GET' && call.body !== null && call.body !== undefined) walk(call.body, 'body', 0, out, budget)
  return out
}

/** Every path → its text. Leaves and containers (containers as compact JSON). */
export function flattenCall(call: WebhookCall): Record<string, string> {
  return Object.fromEntries(entries(call).map((e) => [e.path, e.text]))
}

/** Leaves only, for the Insert list: query first, then body, in document order. */
export function fieldList(call: WebhookCall): { path: string; sample: string }[] {
  return entries(call)
    .filter((e) => e.leaf)
    .map((e) => ({ path: e.path, sample: e.text }))
}

export function renderPrompt(prompt: string, fields: Record<string, string>): { text: string; missing: string[] } {
  const missing: string[] = []
  // Single pass, so substituted text is never expanded again.
  const text = prompt.replace(PLACEHOLDER_RE, (_m, path: string) => {
    if (Object.hasOwn(fields, path)) return fields[path]
    if (!missing.includes(path)) missing.push(path)
    return ''
  })
  return { text, missing }
}
