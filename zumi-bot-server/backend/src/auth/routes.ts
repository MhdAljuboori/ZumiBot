import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Config } from '../config'
import { applySecurityHeaders, sendJson } from '../http/headers'
import type { Hub } from '../rpc/hub'
import type { AuthStore } from './authStore'
import { sessionKeyOf } from './authStore'
import type { Guard } from './guard'
import type { Limiter } from './rateLimit'
import { FIELD_MAX, readJsonBody } from './requestBody'

const COOKIE_NAME = 'cb_session'
const MAX_AGE_SEC = 30 * 24 * 60 * 60
const MAX_CHECKS = 2 // scrypt takes 32 MiB each, so only two may run at once
const MAX_WAITING = 16
const GENERIC = 'Wrong password or code.'

// Where login.html/css/js live. The server bundle must ship them next to this folder layout or set loginDir.
const DEFAULT_LOGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'http', 'login')

const PAGES: Record<string, { file: string; type: string }> = {
  '/login': { file: 'login.html', type: 'text/html; charset=utf-8' },
  '/login.css': { file: 'login.css', type: 'text/css; charset=utf-8' },
  '/login.js': { file: 'login.js', type: 'text/javascript; charset=utf-8' },
  // Served before sign-in so the login tab has an icon too; local mode gets the web app's copy instead.
  '/favicon.png': { file: 'favicon.png', type: 'image/png' }
}
const LOCAL_MODE_404 = new Set(['/login', '/login.css', '/login.js', '/api/login', '/api/logout', '/api/logout-all'])

export interface AuthRoutesOptions {
  config: Config
  auth: AuthStore
  limiter: Limiter
  hub: () => Hub
  log(line: string): void
  guard: Guard
  ipOf(req: IncomingMessage): string
  loginDir?: string
}

// Lax, not Strict: Chrome on Android launches an installed app from the home screen as a cross-site navigation and
// holds Strict cookies back, so the PWA was signed out on every launch. Lax adds only cross-site top-level GETs, which
// change nothing: every other method and the WebSocket upgrade still need our own Origin (originOk).
function cookie(value: string, maxAge: number, secure: boolean): string {
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Max-Age=${maxAge}`
}

function parseCredentials(body: string | null): { password: string; code: string } | null {
  if (body === null) return null
  try {
    const v = JSON.parse(body) as unknown
    if (!v || typeof v !== 'object') return null
    const { password, code } = v as Record<string, unknown>
    if (typeof password !== 'string' || typeof code !== 'string') return null
    if (!password || password.length > FIELD_MAX || code.length > FIELD_MAX) return null
    return { password, code }
  } catch {
    return null
  }
}

function createSemaphore(max: number) {
  let active = 0
  const waiting: (() => void)[] = []
  return {
    waiting: () => waiting.length,
    async acquire(): Promise<() => void> {
      if (active >= max) await new Promise<void>((r) => waiting.push(r))
      else active++
      // A released slot is handed straight to the next waiter, so `active` stays accurate.
      return () => {
        const next = waiting.shift()
        if (next) next()
        else active--
      }
    }
  }
}

export function createAuthRoutes(o: AuthRoutesOptions) {
  const { config, auth, limiter, guard } = o
  const loginDir = o.loginDir ?? DEFAULT_LOGIN_DIR
  const secure = config.origin.startsWith('https:') // http only exists under NODE_ENV=test
  const inflight = new Set<string>()
  const checks = createSemaphore(MAX_CHECKS)
  // Read now, so a bundle that lacks the login files fails at boot instead of at the first sign-in.
  const assets = new Map<string, Buffer>()
  if (config.mode === 'vps') for (const { file } of Object.values(PAGES)) assets.set(file, readFileSync(join(loginDir, file)))

  function tooMany(res: ServerResponse, retryAfterMs: number): void {
    const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000))
    sendJson(
      res,
      429,
      { error: `Too many tries. Try again in ${retryAfterSec} seconds.`, retryAfterSec },
      { 'Retry-After': String(retryAfterSec) }
    )
  }

  const denied = (res: ServerResponse): void => sendJson(res, 401, { error: GENERIC })

  async function servePage(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (path === '/login' && (await guard.authorize(req))) {
      res.writeHead(302, { Location: '/', 'Content-Length': 0 })
      res.end()
      return
    }
    const page = PAGES[path]!
    const body = assets.get(page.file)!
    applySecurityHeaders(res)
    res.writeHead(200, { 'Content-Type': page.type, 'Content-Length': body.length, 'Cache-Control': 'no-cache' })
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  // Decides the outcome only; the caller releases the per-IP slot before anything is sent.
  async function attempt(req: IncomingMessage, ip: string): Promise<{ cookie?: string; tooMany?: number }> {
    // The body is read first (bounded in size and time). The failure is booked before any password check starts,
    // so parallel guesses cannot all see an empty record.
    const creds = parseCredentials(await readJsonBody(req))
    if (checks.waiting() >= MAX_WAITING) return { tooMany: 1000 }
    limiter.fail(ip)
    if (!creds) return {}
    const release = await checks.acquire()
    let ok: boolean
    try {
      ok = await auth.checkLogin(creds.password, creds.code)
    } finally {
      release()
    }
    if (!ok) return {}
    limiter.succeed(ip)
    return { cookie: cookie(await auth.createSession(), MAX_AGE_SEC, secure) }
  }

  async function login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!(await guard.originOk(req))) return sendJson(res, 403, { error: 'Bad origin' })
    const ip = o.ipOf(req)
    const gate = limiter.check(ip)
    if (!gate.allowed) return tooMany(res, gate.retryAfterMs)
    // One attempt per IP at a time: otherwise a burst of parallel guesses all pass check() before any failure is recorded.
    if (inflight.has(ip)) return tooMany(res, 1000)
    inflight.add(ip)
    let outcome: { cookie?: string; tooMany?: number; errored?: boolean }
    try {
      outcome = await attempt(req, ip)
    } catch {
      // Whatever broke (corrupt auth.json, unconfigured...), the caller learns nothing beyond a failed login.
      o.log('login error')
      outcome = { errored: true }
    } finally {
      inflight.delete(ip)
    }
    if (outcome.tooMany) return tooMany(res, outcome.tooMany)
    if (outcome.cookie) {
      res.writeHead(204, { 'Set-Cookie': outcome.cookie })
      res.end()
      return
    }
    if (!outcome.errored) o.log(`login failed from ${ip}`)
    denied(res)
  }

  async function logout(req: IncomingMessage, res: ServerResponse, all: boolean): Promise<void> {
    if (!(await guard.authorize(req))) return sendJson(res, 401, { error: 'Unauthorized' })
    if (!(await guard.originOk(req))) return sendJson(res, 403, { error: 'Bad origin' })
    const token = guard.token(req)!
    if (all) {
      await auth.revokeAll()
      o.hub().closeSession('all')
    } else {
      await auth.revokeSession(token)
      o.hub().closeSession(sessionKeyOf(token))
    }
    res.writeHead(204, { 'Set-Cookie': cookie('', 0, secure) })
    res.end()
  }

  return {
    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
      const path = (req.url ?? '/').split(/[?#]/)[0]!
      const method = req.method ?? 'GET'
      if (config.mode === 'local') {
        // Local mode has no sign-in at all; answer 404 instead of redirecting the unauthenticated to a page that does not exist.
        if (!LOCAL_MODE_404.has(path)) return false
        res.writeHead(404, { 'Content-Length': 0 })
        res.end()
        return true
      }
      if (Object.hasOwn(PAGES, path) && (method === 'GET' || method === 'HEAD')) {
        await servePage(req, res, path)
        return true
      }
      if (method !== 'POST') return false
      if (path === '/api/login') await login(req, res)
      else if (path === '/api/logout') await logout(req, res, false)
      else if (path === '/api/logout-all') await logout(req, res, true)
      else return false
      return true
    }
  }
}
