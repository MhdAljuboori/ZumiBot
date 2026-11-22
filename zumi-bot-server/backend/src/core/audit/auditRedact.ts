import { AUDIT_ANSWER_MAX, AUDIT_ERROR_MAX, AUDIT_INPUT_MAX } from '@zumibot/shared/audit'
import { FILL_TOOL } from '@zumibot/shared/vault'
import { scrubText, scrubValue } from '../vault/scrub'

// Everything here runs before a record leaves memory: the writer never sees a raw input, answer or error.

export const BROWSER_PREFIX = 'mcp__zumibot_browser__'
export const DESKTOP_PREFIX = 'mcp__zumibot_desktop__'
const DESKTOP_TYPE = `${DESKTOP_PREFIX}desktop_type`

// Secrets that never came from the vault but have a known shape. A net, not a guarantee: the list is fixed and short.
const SECRET_SHAPES: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-ant-[A-Za-z0-9_-]{10,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g
]

export function maskSecretShapes(text: string): string {
  let out = text
  for (const re of SECRET_SHAPES) out = out.replace(re, (m) => (/^(Bearer|Basic)\s/.test(m) ? `${m.split(/\s/)[0]} [secret]` : '[secret]'))
  return out
}

const walkStrings = (v: unknown, fn: (s: string) => string): unknown => {
  if (typeof v === 'string') return fn(v)
  if (Array.isArray(v)) return v.map((x) => walkStrings(x, fn))
  if (v !== null && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walkStrings(x, fn)]))
  }
  return v
}

/** Shortens the longest strings first until the JSON fits, so it stays valid JSON; null when it fits already. */
export function cutJson(v: unknown, max: number): { value: unknown; original: number } | null {
  const original = (JSON.stringify(v ?? null) ?? 'null').length
  if (original <= max) return null
  let value = v
  for (let round = 0; round < 40; round++) {
    const strings: string[] = []
    walkStrings(value, (s) => {
      strings.push(s)
      return s
    })
    const size = (JSON.stringify(value ?? null) ?? 'null').length
    if (size <= max) return { value, original }
    const longest = strings.reduce((a, b) => (b.length > a.length ? b : a), '')
    if (longest.length <= 64) break
    const over = size - max
    const keep = Math.max(32, longest.length - over - 40)
    let done = false
    value = walkStrings(value, (s) => {
      if (done || s !== longest) return s
      done = true
      return `${s.slice(0, keep)}…[cut ${s.length - keep} chars]`
    })
  }
  // Still too big (many small strings, deep arrays): the head of its JSON as one string.
  const json = JSON.stringify(value ?? null) ?? 'null'
  if (json.length <= max) return { value, original }
  // Stored as a string, its quotes are escaped again: shrink until the stored form fits.
  let keep = max - 40
  let head = `${json.slice(0, keep)}…[cut ${json.length - keep} chars]`
  while (keep > 0 && JSON.stringify(head).length > max) {
    keep -= Math.max(16, JSON.stringify(head).length - max)
    head = `${json.slice(0, Math.max(0, keep))}…[cut ${json.length - Math.max(0, keep)} chars]`
  }
  return { value: head, original }
}

const cutText = (t: string, max: number): string => (t.length <= max ? t : `${t.slice(0, max)}…[cut ${t.length - max} chars]`)

export type Scrub = ReadonlyMap<string, string>

/** The input as the audit stores it: vault values tagged, browser input dropped, typed desktop text as its length, then cut. */
export function redactInput(
  tool: string,
  input: unknown,
  scrub: Scrub,
  fillRow?: (input: unknown) => unknown
): { input: unknown; inputCut: number | null } {
  let v: unknown
  if (tool === FILL_TOOL) v = fillRow ? fillRow(input) : {}
  else if (tool.startsWith(BROWSER_PREFIX)) v = {}
  else if (tool === DESKTOP_TYPE && input !== null && typeof input === 'object' && 'text' in input) {
    const { text } = input as { text: unknown }
    v = { ...(input as object), text: typeof text === 'string' ? `<${[...text].length} chars>` : '<text>' }
  } else v = input
  v = walkStrings(scrubValue(v, scrub), maskSecretShapes)
  const cut = cutJson(v, AUDIT_INPUT_MAX)
  return cut ? { input: cut.value, inputCut: cut.original } : { input: v ?? null, inputCut: null }
}

/** A call's error text: browser and desktop as fixed lines (their text is page or screen content), the rest tagged and cut. */
export function redactError(tool: string, text: string, scrub: Scrub): string {
  if (tool.startsWith(BROWSER_PREFIX)) return 'Browser command failed.'
  if (tool.startsWith(DESKTOP_PREFIX)) return 'Desktop command failed.'
  return cutText(maskSecretShapes(scrubText(text, scrub)), AUDIT_ERROR_MAX)
}

/** A question card's answers or a plan's feedback. */
export function redactAnswer(answer: unknown, scrub: Scrub): unknown {
  const v = walkStrings(scrubValue(answer, scrub), maskSecretShapes)
  return cutJson(v, AUDIT_ANSWER_MAX)?.value ?? v
}
