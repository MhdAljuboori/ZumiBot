import http, { type IncomingMessage } from 'node:http'
import https from 'node:https'
import { httpStatusText } from '@zumibot/shared/workflowHttp'
import { HTTP_READ_MAX, HTTP_REDIRECTS_MAX, HTTP_TIMEOUT_MS, OUTPUT_MAX, spaced, type HttpMethod } from '@zumibot/shared/workflows'
import { checkedAddresses, pinnedLookup, publicOrLocal, type AddressLookup } from '../addressGuard'

// A workflow HTTP request step's one request. Its errors are fixed sentences (an error code at most): a network error's
// message could hold the address, and with it a vault key.

// allowLocal: the step's "Allow local network"; without it only public addresses are reached (core/addressGuard.ts).
export interface HttpRequest {
  method: HttpMethod
  url: string
  headers: [string, string][]
  body?: string
  allowLocal?: true
}
export type HttpResult = { ok: true; status: number; body: string } | { ok: false; error: string; status?: number; body?: string }

export const HTTP_STOPPED = 'Stopped'
export const httpTimedOut = (): string => `The request timed out after ${HTTP_TIMEOUT_MS / 1000} s`
export const HTTP_TOO_BIG = `The response is over ${spaced(OUTPUT_MAX)} characters`
export const HTTP_NOT_TEXT = 'The response is not text'
export const HTTP_NOT_PUBLIC =
  'The address is on this machine, the local network or a reserved range; "Allow local network" lets the step reach this machine and the LAN'
export const HTTP_NOT_RESOLVED = 'The host name did not resolve'

// A redirect that changes a POST into a GET drops the body, as browsers do; 307 and 308 keep both.
const asGet = (status: number, method: HttpMethod): boolean => status === 303 || ((status === 301 || status === 302) && method === 'POST')

/** The body, at most HTTP_READ_MAX bytes read; null once past it (the rest is dropped, never buffered). */
async function readCapped(res: IncomingMessage): Promise<Uint8Array | null> {
  const parts: Buffer[] = []
  let size = 0
  for await (const chunk of res as AsyncIterable<Buffer>) {
    size += chunk.byteLength
    if (size > HTTP_READ_MAX) {
      res.destroy()
      return null
    }
    parts.push(chunk)
  }
  return Buffer.concat(parts, size)
}

// Waits for `p` unless the signal fires first: a resolver that hangs ends as the timeout or Stop says.
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const off = () => reject(signal.reason)
    signal.addEventListener('abort', off, { once: true })
    p.then(
      (v) => {
        signal.removeEventListener('abort', off)
        resolve(v)
      },
      (e) => {
        signal.removeEventListener('abort', off)
        reject(e)
      }
    )
  })
}

// One request to an address already checked. No pooled agent: a kept-alive socket would skip the next hop's check.
function send(
  url: URL,
  method: HttpMethod,
  headers: [string, string][],
  body: string | undefined,
  addresses: string[],
  signal: AbortSignal
): Promise<IncomingMessage> {
  const out: Record<string, string> = {}
  for (const [n, v] of headers) {
    const k = n.toLowerCase()
    out[k] = k in out ? `${out[k]}, ${v}` : v
  }
  // What fetch sent before, so an API that wants a user agent still answers.
  out['accept'] ??= '*/*'
  out['user-agent'] ??= 'ZumiBot'
  if (body !== undefined) out['content-length'] = String(Buffer.byteLength(body, 'utf8'))
  return new Promise((resolve, reject) => {
    const r = (url.protocol === 'https:' ? https : http).request(
      url,
      { method, headers: out, lookup: pinnedLookup(addresses), agent: false, signal },
      resolve
    )
    r.on('error', reject)
    r.end(body)
  })
}

function connectError(error: unknown): string {
  const e = error as { code?: unknown; cause?: { code?: unknown } } | null
  const raw = e?.code ?? e?.cause?.code
  const code = typeof raw === 'string' && /^[A-Z_]{2,40}$/.test(raw) ? raw : null
  return code ? `The request failed (${code})` : 'The request failed'
}

/**
 * Sends the request. Every hop resolves its host once, refuses it unless every address passes (public only, unless the step
 * allows the local network) and connects to that checked address, so DNS cannot answer differently in between. Redirects are
 * followed only within the origin (at most 5): one to another host is the answer itself, so a header (a vault key) never
 * travels to a host the step does not name.
 */
export async function httpCall(
  req: HttpRequest,
  signal: AbortSignal,
  o: { timeoutMs?: number; lookup?: AddressLookup } = {}
): Promise<HttpResult> {
  const timeout = AbortSignal.timeout(o.timeoutMs ?? HTTP_TIMEOUT_MS)
  const both = AbortSignal.any([signal, timeout])
  const ok = publicOrLocal(req.allowLocal === true)
  let { method, body } = req
  let url = new URL(req.url)
  const origin = url.origin
  try {
    let res: IncomingMessage
    for (let hops = 0; ; hops++) {
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, error: 'The request failed' }
      const checked = await abortable(checkedAddresses(url.hostname, ok, o.lookup), both)
      if ('error' in checked) return { ok: false, error: checked.error === 'resolve' ? HTTP_NOT_RESOLVED : HTTP_NOT_PUBLIC }
      res = await send(url, method, req.headers, body, checked.addresses, both)
      const status = res.statusCode ?? 0
      const location = status >= 300 && status < 400 ? (res.headers.location ?? null) : null
      if (location === null || hops >= HTTP_REDIRECTS_MAX) break
      let next: URL
      try {
        next = new URL(location, url)
      } catch {
        break
      }
      if (next.origin !== origin) break
      res.destroy()
      if (asGet(status, method)) {
        method = 'GET'
        body = undefined
      }
      url = next
    }
    const status = res.statusCode ?? 0
    const bytes = await readCapped(res)
    if (bytes === null) return { ok: false, error: HTTP_TOO_BIG, status }
    const text = new TextDecoder('utf-8').decode(bytes)
    if (text.includes('\u0000')) return { ok: false, error: HTTP_NOT_TEXT, status }
    if (text.length > OUTPUT_MAX) return { ok: false, error: HTTP_TOO_BIG, status, body: text.slice(0, OUTPUT_MAX) }
    const type = res.headers['content-type']
    const shown = prettyJson(text, typeof type === 'string' ? type : null)
    if (status >= 200 && status < 400) return { ok: true, status, body: shown }
    return { ok: false, error: httpStatusText(status), status, body: shown }
  } catch (error) {
    if (signal.aborted) return { ok: false, error: HTTP_STOPPED }
    if (timeout.aborted) return { ok: false, error: httpTimedOut() }
    return { ok: false, error: connectError(error) }
  }
}

// A JSON answer as the trigger's body is shown: two-space indents. Anything that does not parse stays as it came.
function prettyJson(text: string, type: string | null): string {
  if (!type || !/[/+]json\b/i.test(type)) return text
  try {
    const out = JSON.stringify(JSON.parse(text), null, 2)
    return out.length <= OUTPUT_MAX ? out : text
  } catch {
    return text
  }
}
