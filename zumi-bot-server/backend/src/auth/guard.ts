import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { isIP } from 'node:net'
import type { Config } from '../config'
import type { Hub } from '../rpc/hub'
import type { BrowserHub } from '../http/browserSocket'
import type { DesktopHub } from '../http/desktopSocket'
import type { Gate } from '../http/server'
import type { AuthStore } from './authStore'
import { sessionKeyOf } from './authStore'
import type { Limiter } from './rateLimit'
import { createAuthRoutes } from './routes'

export const SESSION_COOKIE = 'cb_session'
export const LOCAL_COOKIE = 'cb_local'

/** First occurrence wins, so a duplicate cookie cannot override the one the browser sent first. */
export function parseCookies(header: string | string[] | undefined): Map<string, string> {
  const out = new Map<string, string>()
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i < 1) continue
    const name = part.slice(0, i).trim()
    if (!out.has(name)) out.set(name, part.slice(i + 1).trim())
  }
  return out
}

const isLoopbackPeer = (addr: string | undefined): boolean => addr === '127.0.0.1' || addr === '::ffff:127.0.0.1'

/**
 * The forwarded address counts only from the local proxy, and only as a plain IP (it ends up in logs and the limiter).
 * Of a list, the rightmost is the one the proxy appended; everything left of it is client-supplied.
 */
export function clientIp(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress ?? 'unknown'
  if (isLoopbackPeer(peer)) {
    const xff = req.headers['x-forwarded-for']
    const last = typeof xff === 'string' ? xff.split(',').pop()!.trim() : ''
    if (isIP(last)) return keyOf(last)
  }
  return keyOf(peer)
}

// A single IPv6 subscriber holds a whole /64, so keying by full address would give an attacker endless fresh buckets.
function keyOf(ip: string): string {
  if (isIP(ip) !== 6) return ip
  const [head = '', tail = ''] = ip.split('%')[0]!.split('::')
  const parts = (s: string): string[] =>
    s === ''
      ? []
      : s.split(':').flatMap((g) => {
          if (!g.includes('.')) return [g]
          const [a, b, c, d] = g.split('.').map(Number) as [number, number, number, number]
          return [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)]
        })
  const h = parts(head)
  const t = parts(tail)
  const groups = ip.includes('::') ? [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h
  const n = groups.map((x) => parseInt(x, 16))
  if (n.length === 8 && n.slice(0, 5).every((x) => x === 0) && n[5] === 0xffff) {
    return `${n[6]! >> 8}.${n[6]! & 255}.${n[7]! >> 8}.${n[7]! & 255}`
  }
  return `${n
    .slice(0, 4)
    .map((x) => x.toString(16))
    .join(':')}::/64`
}

// Hashing first makes the comparison constant-time even when the lengths differ.
function secretEquals(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())
}

export interface Guard {
  authorize(req: IncomingMessage): Promise<boolean>
  originOk(req: IncomingMessage, opts?: { upgrade?: boolean }): Promise<boolean>
  /** The raw session cookie value, or null. */
  token(req: IncomingMessage): string | null
  sessionKey(req: IncomingMessage): string
}

export function createGuard(o: { config: Config; auth: AuthStore }): Guard {
  const { config, auth } = o
  const token = (req: IncomingMessage): string | null => {
    const v = parseCookies(req.headers.cookie).get(config.mode === 'local' ? LOCAL_COOKIE : SESSION_COOKIE)
    return v ? v : null
  }
  return {
    token,
    sessionKey: (req) => {
      const t = token(req)
      return t ? sessionKeyOf(t) : ''
    },
    async authorize(req) {
      try {
        const t = token(req)
        if (!t) return false
        if (config.mode === 'local') return !!config.localSecret && secretEquals(t, config.localSecret)
        return await auth.checkSession(t)
      } catch {
        return false // a broken auth file must lock people out, not let them in
      }
    },
    async originOk(req, opts) {
      const method = req.method ?? 'GET'
      // Plain reads are not state-changing. The caller says when it is an upgrade (a GET that carries the session),
      // rather than us guessing from a header the client controls.
      if ((method === 'GET' || method === 'HEAD') && !opts?.upgrade) return true
      const origin = req.headers.origin
      return !!config.origin && typeof origin === 'string' && origin === config.origin
    }
  }
}

export function createGate(o: {
  config: Config
  auth: AuthStore
  limiter: Limiter
  hub: () => Hub
  browserHub?: () => BrowserHub | undefined
  desktopHub?: () => DesktopHub | undefined
  log(line: string): void
  loginDir?: string
  // After a sign-out closed its sockets: a session key, or 'all'. Lets push devices follow the session.
  sessionEnded?(key: string | 'all'): void
}): Gate & { sessionKey(req: IncomingMessage): string } {
  const guard = createGuard(o)
  const routes = createAuthRoutes({
    ...o,
    guard,
    ipOf: clientIp,
    hub: () => ({
      ...o.hub(),
      closeSession(key) {
        o.hub().closeSession(key)
        o.browserHub?.()?.closeSession(key)
        o.desktopHub?.()?.closeSession(key)
        try {
          o.sessionEnded?.(key)
        } catch {
          /* the sign-out already happened */
        }
      }
    })
  })
  return {
    authorize: guard.authorize,
    originOk: guard.originOk,
    handle: routes.handle,
    sessionKey: guard.sessionKey
  }
}
