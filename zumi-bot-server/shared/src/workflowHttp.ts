import { PLACEHOLDER_RE } from './routineFields'
import type { HttpHeader, Step } from './workflows'

// Pure rules of the HTTP request step, shared by the editor's problems and the server's request.

type HttpStep = Extract<Step, { kind: 'http' }>

export const URL_MAX = 8_000
export const HEADER_NAME_MAX = 100
export const HEADER_VALUE_MAX = 8_000
// Set by the request itself, or a way to smuggle a second one.
const FORBIDDEN_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'cookie',
  'keep-alive',
  'upgrade',
  'te',
  'trailer'
])
const TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const KEY_RE = /\{\{\s*key\s*\}\}/

export const ORIGIN_TEXT = 'Start the address with http:// or https:// and a host, with no {{…}} before the path'
export const KEY_UNUSED_TEXT = 'Use {{key}} where the API key goes'
export const KEY_MISSING_TEXT = 'Pick an API key for {{key}}'
export const GET_BODY_TEXT = 'A GET request has no body'

/**
 * The address's fixed origin, or null when the template could put a {{…}} in its scheme, host or port: every
 * placeholder must come after the first / ? or # past the host, so no value (a webhook's, a model's) picks the host.
 */
export function fixedOrigin(url: string): string | null {
  const at = url.indexOf('{{')
  const literal = at < 0 ? url : url.slice(0, at)
  const m = /^(https?:\/\/[^/?#\s]+)([/?#]|$)/i.exec(literal)
  if (!m || (at >= 0 && m[2] === '')) return null
  try {
    const u = new URL(m[1])
    if (u.username || u.password) return null // no credentials in the address: they'd be stored in plain text
    return u.origin
  } catch {
    return null
  }
}

export function headerProblem(h: HttpHeader): string | null {
  const name = h.name.trim()
  if (!name) return 'A header needs a name'
  if (name.length > HEADER_NAME_MAX || !TOKEN_RE.test(name)) return `"${name.slice(0, 40)}" is not a header name`
  if (FORBIDDEN_HEADERS.has(name.toLowerCase())) return `The ${name} header is set by the request itself`
  if (/[\r\n]/.test(h.value)) return `The ${name} header has a line break`
  if (h.value.length > HEADER_VALUE_MAX) return `The ${name} header is too long`
  return null
}

const usesKey = (s: HttpStep): boolean => [s.url, s.body ?? '', ...s.headers.map((h) => h.value)].some((t) => KEY_RE.test(t))

/** The step's own problems; template lengths and unknown handles are problemsOf's, as for every step. */
export function httpProblems(s: HttpStep): string[] {
  const out: string[] = []
  if (!s.url.trim()) out.push('Write the address')
  else if (fixedOrigin(s.url.trim()) === null) out.push(ORIGIN_TEXT)
  if (s.url.length > URL_MAX) out.push('The address is too long')
  if (s.method === 'GET' && (s.body ?? '') !== '') out.push(GET_BODY_TEXT)
  const bad = s.headers.map(headerProblem).find((p) => p !== null)
  if (bad) out.push(bad)
  const lower = s.headers.map((h) => h.name.trim().toLowerCase())
  if (new Set(lower).size !== lower.length) out.push('Two headers have the same name')
  if (usesKey(s) && !s.key) out.push(KEY_MISSING_TEXT)
  if (s.key && !usesKey(s)) out.push(KEY_UNUSED_TEXT)
  return out
}

/**
 * The offsets of the placeholders that sit inside a JSON string literal of a body template, so their values can be
 * escaped there and pasted as JSON outside one. A placeholder never changes whether the text around it is in a string.
 */
export function jsonStringPlaceholders(template: string): Set<number> {
  const inside = new Set<number>()
  let inString = false,
    escaped = false,
    i = 0
  for (const m of template.matchAll(PLACEHOLDER_RE)) {
    const at = m.index
    for (; i < at; i++) walk(template[i]!)
    if (inString) inside.add(at)
    i = at + m[0].length
  }
  return inside
  function walk(c: string): void {
    if (!inString) {
      if (c === '"') inString = true
      return
    }
    if (escaped) escaped = false
    else if (c === '\\') escaped = true
    else if (c === '"') inString = false
  }
}

/** A value's text as it goes inside a JSON string: escaped, without the quotes round it. */
export const jsonInside = (value: string): string => JSON.stringify(value).slice(1, -1)

/** "HTTP 404": the status alone, since an HTTP/2 answer carries no reason text. */
export const httpStatusText = (status: number): string => `HTTP ${status}`
