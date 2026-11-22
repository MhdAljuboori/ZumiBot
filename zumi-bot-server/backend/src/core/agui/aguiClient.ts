import http, { type ClientRequest, type IncomingMessage } from 'node:http'
import https from 'node:https'
import { isIP, type Socket } from 'node:net'
import { AGUI_TEXT } from '@zumibot/shared/agui'
import { checkUrl, pinnedLookup, redirectTarget, resolveTarget, type AguiLookup } from './aguiEndpoint'
import { SseReader, SseTooBig } from './aguiSse'

// One AG-UI run is one pinned POST whose answer is an event stream. This file owns the transport: the endpoint checks, the
// pinned connect, redirects, every timeout and size cap, and the SSE framing. What the events mean is the runner's.
// See docs/architecture/protocol-engines.md (Endpoint checks and transport limits).

export interface AguiLimits {
  /** To the TCP connection (with TLS, its handshake). */
  connectMs: number
  /** From the connection to the response headers. */
  headersMs: number
  /** No bytes at all for this long ends the run; keep-alive comments count. */
  idleMs: number
  /** One whole request, its name lookup and redirects included. */
  runMs: number
  bodyBytes: number
  eventBytes: number
  /** An error response's body is read to this and never kept. */
  errorBodyBytes: number
  /** The runner's: past this the kept state is dropped. */
  stateBytes: number
  redirects: number
  /** The runner's: how long the body gets to end after our terminal event (Rulings 2). */
  finishGraceMs: number
  /** The runner's: interrupt rounds in one turn (Rulings 4). */
  rounds: number
}

export const AGUI_LIMITS: Readonly<AguiLimits> = {
  connectMs: 10_000,
  headersMs: 30_000,
  idleMs: 120_000,
  runMs: 1_800_000,
  bodyBytes: 16 * 1024 * 1024,
  eventBytes: 1024 * 1024,
  errorBodyBytes: 4096,
  stateBytes: 256 * 1024,
  redirects: 2,
  finishGraceMs: 5_000,
  rounds: 10
}

export interface PostRunOptions {
  url: string
  /** The RunAgentInput as JSON, sent again as it is on a 307 or 308. */
  body: string
  /** The auth header. Its value is never logged or put in an error. */
  headers: Readonly<Record<string, string>>
  /** The env name of the key the header carries (never its value): a 401 or 403 names it. */
  authKey: string | null
  allowLocal: boolean
  lookup?: AguiLookup
  limits: AguiLimits
  /** Ends the request at once; it then resolves `ended` (the caller knows why it aborted). */
  signal: AbortSignal
}

/**
 * `unsent`: nothing left this machine (refused by the checks, or never connected), so the run never started. `status`: the
 * server answered with this error status, so it took the request and refused it.
 */
export type PostRunResult = { kind: 'ended' } | { kind: 'error'; text: string; unsent?: true; status?: number }

const ENDED: PostRunResult = { kind: 'ended' }

// Only a plain code reaches a sentence: an error's message may hold the address or more.
const codeOf = (e: unknown): string => {
  const code = (e as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'error'
}

const isSse = (type: string | undefined): boolean => (type ?? '').split(';')[0].trim().toLowerCase() === 'text/event-stream'

/**
 * POSTs one run and hands over each SSE data payload as it completes. Resolves `ended` when the body ends (whatever it held:
 * the caller judges the events) or the signal aborts it; anything else is a fixed sentence naming the host at most.
 */
export function postRun(o: PostRunOptions, onData: (data: string) => void): Promise<PostRunResult> {
  return new Promise<PostRunResult>((resolve) => {
    if (o.signal.aborted) return resolve(ENDED)
    const checked = checkUrl(o.url, o.allowLocal)
    if ('error' in checked) return resolve({ kind: 'error', text: checked.error, unsent: true })

    let settled = false
    let req: ClientRequest | null = null
    let res: IncomingMessage | null = null
    let stage: NodeJS.Timeout | null = null
    const runTimer = setTimeout(() => settle({ kind: 'error', text: AGUI_TEXT.runTimeout }), o.limits.runMs)
    const arm = (ms: number, text: string, unsent = false) => {
      if (stage) clearTimeout(stage)
      stage = setTimeout(() => settle({ kind: 'error', text, ...(unsent ? { unsent: true as const } : {}) }), ms)
    }
    const onAbort = () => settle(ENDED)
    const settle = (r: PostRunResult) => {
      if (settled) return
      settled = true
      clearTimeout(runTimer)
      if (stage) clearTimeout(stage)
      o.signal.removeEventListener('abort', onAbort)
      res?.destroy()
      req?.destroy()
      resolve(r)
    }
    o.signal.addEventListener('abort', onAbort, { once: true })

    const hop = async (url: URL, n: number): Promise<void> => {
      // The name lookup is part of connecting: a resolver that hangs ends as a connect that does.
      arm(o.limits.connectMs, AGUI_TEXT.connectTimeout(url.host), n === 0)
      const target = await resolveTarget(url, o.allowLocal, o.lookup)
      if (settled) return
      if ('error' in target) return settle({ kind: 'error', text: target.error, ...(n === 0 ? { unsent: true as const } : {}) })
      const tls = url.protocol === 'https:'
      const r = (tls ? https : http).request({
        method: 'POST',
        protocol: url.protocol,
        hostname: target.host,
        port: target.port,
        path: url.pathname + url.search,
        // Ours last, so the auth header can never set them (Agent Studio refuses those names too).
        headers: {
          ...o.headers,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'Content-Length': String(Buffer.byteLength(o.body))
        },
        // The connection goes to the checked addresses only, while SNI and Host keep the name.
        lookup: pinnedLookup(target.addresses),
        agent: false,
        // Asked for, not left to the default: NODE_TLS_REJECT_UNAUTHORIZED=0 in the env would turn the default off.
        ...(tls ? { rejectUnauthorized: true } : {}),
        ...(tls && isIP(target.host) === 0 ? { servername: target.host } : {})
      })
      req = r
      // A request a redirect left behind says nothing more: the next hop has its own.
      const live = () => req === r && !settled
      let connected = false
      r.on('socket', (s: Socket) => {
        const up = () => {
          if (!live()) return
          connected = true
          arm(o.limits.headersMs, AGUI_TEXT.headersTimeout)
        }
        if (!s.connecting) up()
        else s.once(tls ? 'secureConnect' : 'connect', up)
      })
      r.on('error', (e) => {
        if (live())
          settle({
            kind: 'error',
            text: AGUI_TEXT.network(url.host, codeOf(e)),
            ...(n === 0 && !connected ? { unsent: true as const } : {})
          })
      })
      r.on('response', (m) => {
        if (!live()) return void m.destroy()
        res = m
        // Each branch says what a dropped connection means for it; this one only keeps an error from going unheard.
        m.on('error', () => {})
        const status = m.statusCode ?? 0
        if (status >= 300 && status < 400) return redirect(url, n, status, m)
        if (status !== 200) return refused(status, m)
        if (!isSse(m.headers['content-type'])) return settle({ kind: 'error', text: AGUI_TEXT.notSse })
        read(m)
      })
      r.end(o.body)
    }

    // Only a same-origin 307 or 308, each target checked again, up to the cap; anything else ends the run.
    const redirect = (url: URL, n: number, status: number, m: IncomingMessage) => {
      const to = redirectTarget(url, status, m.headers.location)
      if (!(to instanceof URL)) return settle({ kind: 'error', text: to.error })
      if (n >= o.limits.redirects) return settle({ kind: 'error', text: AGUI_TEXT.redirected })
      m.destroy()
      req?.destroy()
      res = null
      req = null
      if (stage) clearTimeout(stage)
      hop(to, n + 1).catch((e) => settle({ kind: 'error', text: AGUI_TEXT.network(to.host, codeOf(e)) }))
    }

    // The body may echo the request (the key too), so it is read to its cap and dropped: the sentence names the status only.
    // A server still sending past the cap is cut off there.
    const refused = (status: number, m: IncomingMessage) => {
      const text = status === 401 || status === 403 ? AGUI_TEXT.unauthorized(status, o.authKey) : AGUI_TEXT.status(status)
      const done = () => settle({ kind: 'error', text, status })
      let bytes = 0
      arm(o.limits.idleMs, AGUI_TEXT.idleTimeout)
      m.on('data', (c: Buffer) => {
        bytes += c.length
        if (bytes >= o.limits.errorBodyBytes) return done()
        arm(o.limits.idleMs, AGUI_TEXT.idleTimeout)
      })
      m.on('end', done)
      m.on('error', done)
      m.on('close', done)
    }

    const read = (m: IncomingMessage) => {
      const sse = new SseReader(o.limits.eventBytes)
      let bytes = 0
      arm(o.limits.idleMs, AGUI_TEXT.idleTimeout)
      m.on('data', (c: Buffer) => {
        if (settled) return
        arm(o.limits.idleMs, AGUI_TEXT.idleTimeout)
        bytes += c.length
        if (bytes > o.limits.bodyBytes) return settle({ kind: 'error', text: AGUI_TEXT.bodyTooBig })
        let payloads: string[]
        let fail: PostRunResult | null = null
        try {
          payloads = sse.push(c)
        } catch (e) {
          // Events the chunk completed before the oversize one still count, as they would have in a chunk of their own.
          payloads = e instanceof SseTooBig ? e.before : []
          fail = { kind: 'error', text: e instanceof SseTooBig ? AGUI_TEXT.eventTooBig : AGUI_TEXT.unreadable }
        }
        for (const p of payloads) {
          // The caller may end the request from inside: nothing after that is handed over.
          if (settled) return
          try {
            onData(p)
          } catch {
            return settle({ kind: 'error', text: AGUI_TEXT.unreadable })
          }
        }
        if (fail) settle(fail)
      })
      m.on('end', () => {
        // An event the body ended in the middle of is dropped (the SSE rules), so it reads as no event at all.
        sse.end()
        settle(ENDED)
      })
      // Closed without its end: the connection dropped in the middle of the body.
      const cut = () => settle({ kind: 'error', text: AGUI_TEXT.cut })
      m.on('error', cut)
      m.on('close', cut)
    }

    // A throw here comes before any connection (a header Node refuses), so nothing was sent.
    hop(checked.url, 0).catch((e) => settle({ kind: 'error', text: AGUI_TEXT.network(checked.url.host, codeOf(e)), unsent: true }))
  })
}
