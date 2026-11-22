import { ORIGIN_TEXT, fixedOrigin, jsonInside, jsonStringPlaceholders } from '@zumibot/shared/workflowHttp'
import { fillTemplate, type TemplateCtx } from '@zumibot/shared/workflowTemplate'
import { HTTP_BODY_MAX, type Step } from '@zumibot/shared/workflows'
import type { HttpRequest } from './httpCalls'

type HttpStep = Extract<Step, { kind: 'http' }>
export interface VaultKey {
  name: string
  value: string
}

export const KEY_UNAVAILABLE = 'API key not found or not allowed for workflows'
export const ADDRESS_LEFT_HOST = 'The filled address leaves its host'
export const BODY_NOT_JSON = 'The body is not valid JSON'
export const BODY_TOO_BIG = 'The body is over 1 MiB'
export const DOT_SEGMENT = 'A filled value makes a . or .. path segment'

// The address's path segments, before the query and fragment. A filled value never adds one: it is percent-encoded, so it
// holds no / ? # or \ of its own, and the segments of two fills of one template line up.
const pathSegments = (url: string): string[] =>
  url
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '')
    .split(/[?#]/)[0]
    .split('/')
// What the URL parser takes as . or .. (a %2e counts as a dot).
const isDotSegment = (seg: string): boolean => /^(\.|%2e){1,2}$/i.test(seg)

/** Every form of the key a response or an error could echo, replaced by its tag. */
export function scrubKey(text: string, key: VaultKey | null): string {
  if (!key) return text
  const tag = `[vault: ${key.name}]`
  let out = text
  for (const form of new Set([key.value, encodeURIComponent(key.value), jsonInside(key.value)])) if (form) out = out.split(form).join(tag)
  return out
}

/**
 * The request a step makes in this context. Every template is filled raw (no model reads it): the address's values are
 * percent-encoded, so none can move it to another host or path segment (nor make a . or .. one); a JSON body's values are
 * escaped inside a string and pasted as is outside one.
 */
export function buildHttpRequest(
  step: HttpStep,
  ctx: TemplateCtx,
  key: VaultKey | null
): { req: HttpRequest; missing: string[] } | { error: string; missing: string[] } {
  const vars = key ? { key: key.value } : undefined
  const missing = new Set<string>()
  const fill = (text: string, encode?: (value: string, at: number) => string): string => {
    const f = fillTemplate(text, ctx, 'raw', { ...(encode ? { encode } : {}), ...(vars ? { vars } : {}) })
    for (const m of f.missing) missing.add(m)
    return f.text
  }
  const done = (error: string) => ({ error, missing: [...missing] })
  const template = step.url.trim()
  const origin = fixedOrigin(template)
  if (origin === null) return done(ORIGIN_TEXT)
  const url = fill(template, (v) => encodeURIComponent(v))
  let filled: URL
  try {
    filled = new URL(url)
  } catch {
    return done(ORIGIN_TEXT)
  }
  if (filled.origin !== origin) return done(ADDRESS_LEFT_HOST)
  // encodeURIComponent keeps dots, and the URL parser drops a . segment and climbs on a .. one, so a value of `..` would move
  // the request (with its key) to another path. The same fill with every value as `x` shows which segments the step wrote.
  const shape = fillTemplate(template, ctx, 'raw', { encode: () => 'x', ...(vars ? { vars } : {}) }).text
  const mine = pathSegments(shape)
  if (pathSegments(url).some((seg, i) => isDotSegment(seg) && !isDotSegment(mine[i] ?? ''))) return done(DOT_SEGMENT)

  const headers: [string, string][] = []
  for (const h of step.headers) {
    const name = h.name.trim()
    if (!name) continue
    const value = fill(h.value)
    if (/[\r\n]/.test(value)) return done(`The ${name} header has a line break`)
    headers.push([name, value])
  }
  let body: string | undefined
  if (step.method !== 'GET' && (step.body ?? '') !== '') {
    if (step.bodyType === 'json') {
      const inString = jsonStringPlaceholders(step.body!)
      body = fill(step.body!, (v, at) => (inString.has(at) ? jsonInside(v) : v))
      try {
        JSON.parse(body)
      } catch {
        return done(BODY_NOT_JSON)
      }
    } else {
      body = fill(step.body!)
    }
    if (Buffer.byteLength(body, 'utf8') > HTTP_BODY_MAX) return done(BODY_TOO_BIG)
    if (!headers.some(([n]) => n.toLowerCase() === 'content-type')) {
      headers.push(['Content-Type', step.bodyType === 'json' ? 'application/json' : 'text/plain; charset=utf-8'])
    }
  }
  const req: HttpRequest = {
    method: step.method,
    url: filled.href,
    headers,
    ...(body !== undefined ? { body } : {}),
    ...(step.allowLocalNetwork ? { allowLocal: true } : {})
  }
  return { req, missing: [...missing] }
}
