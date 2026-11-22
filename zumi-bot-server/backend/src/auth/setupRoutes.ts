import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import qrcode from 'qrcode'
import type { ClaudeStatus } from '../core/claudeStatus'
import { applySecurityHeaders, sendJson } from '../http/headers'
import type { AuthStore } from './authStore'
import type { Guard } from './guard'
import type { Limiter } from './rateLimit'
import { field, readJsonBody, readJsonObject } from './requestBody'
import { setupCodeMatches } from './setupCode'
import { allowsSetupCall, setupStep, type SetupCall, type SetupStep } from './setupState'
import { savePassword, saveTotp } from './setupSteps'
import { newTotpSecret, otpauthUri } from './totp'

// The wizard's files ship beside the login page's, and it reuses login.css for the shared tokens.
const DEFAULT_LOGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'http', 'login')

const PAGES: Record<string, { file: string; type: string }> = {
  '/setup': { file: 'setup.html', type: 'text/html; charset=utf-8' },
  '/setup.css': { file: 'setup.css', type: 'text/css; charset=utf-8' },
  '/setup.js': { file: 'setup.js', type: 'text/javascript; charset=utf-8' },
  '/login.css': { file: 'login.css', type: 'text/css; charset=utf-8' },
  '/favicon.png': { file: 'favicon.png', type: 'image/png' }
}

const CALLS: Record<string, SetupCall> = {
  '/api/setup/password': 'password',
  '/api/setup/totp/start': 'totp-start',
  '/api/setup/totp/confirm': 'totp-confirm',
  '/api/setup/check': 'check',
  '/api/setup/finish': 'finish'
}

const BAD_CODE = 'That setup code is not right.'
const WRONG_STEP = 'That step is already done. Reload the page.'

export interface SetupRoutesOptions {
  auth: AuthStore
  limiter: Limiter
  /** Only originOk is used: there is no session to authorize yet. */
  guard: Pick<Guard, 'originOk'>
  /** sha256 of the normalised one-time code. The code itself is printed once and never stored. */
  codeHash: string
  ipOf(req: IncomingMessage): string
  now(): number
  log(line: string): void
  claudeStatus(): Promise<ClaudeStatus>
  /** The wizard finished: the caller drops these routes for good and serves the app instead. */
  onFinish(): void
  loginDir?: string
}

export function createSetupRoutes(o: SetupRoutesOptions) {
  const { auth, limiter, guard } = o
  const loginDir = o.loginDir ?? DEFAULT_LOGIN_DIR
  // Read at boot, so a bundle missing the wizard fails to start instead of at the first visit.
  const assets = new Map<string, Buffer>()
  for (const { file } of Object.values(PAGES)) assets.set(file, readFileSync(join(loginDir, file)))
  // Only in memory, and only until it is confirmed: nothing is stored before the code is typed back.
  let pendingSecret: string | null = null

  const step = async (): Promise<SetupStep> => setupStep(await auth.configured())

  function servePage(req: IncomingMessage, res: ServerResponse, path: string): void {
    const page = PAGES[path]!
    const body = assets.get(page.file)!
    applySecurityHeaders(res)
    res.writeHead(200, { 'Content-Type': page.type, 'Content-Length': body.length, 'Cache-Control': 'no-cache' })
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  function tooMany(res: ServerResponse, retryAfterMs: number): void {
    const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000))
    sendJson(
      res,
      429,
      { error: `Too many tries. Try again in ${retryAfterSec} seconds.`, retryAfterSec },
      { 'Retry-After': String(retryAfterSec) }
    )
  }

  /** Origin, rate limit, one-time code, then the step. Null means an answer has already been sent. */
  async function admit(req: IncomingMessage, res: ServerResponse, call: SetupCall): Promise<Record<string, unknown> | null> {
    if (!(await guard.originOk(req))) {
      sendJson(res, 403, { error: 'Bad origin' })
      return null
    }
    const ip = o.ipOf(req)
    const gate = limiter.check(ip)
    if (!gate.allowed) {
      tooMany(res, gate.retryAfterMs)
      return null
    }
    const body = readJsonObject(await readJsonBody(req))
    // Booked before the compare, so a burst of parallel guesses cannot all pass check() before one is recorded.
    limiter.fail(ip)
    const given = body && field(body, 'code')
    if (given === null || !setupCodeMatches(o.codeHash, given)) {
      o.log(`setup code refused from ${ip}`)
      sendJson(res, 401, { error: BAD_CODE })
      return null
    }
    limiter.succeed(ip)
    if (!allowsSetupCall(await step(), call)) {
      sendJson(res, 409, { error: WRONG_STEP })
      return null
    }
    return body
  }

  async function password(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await admit(req, res, 'password')
    if (!body) return
    const raw = field(body, 'password')
    if (raw === null || raw === '') return sendJson(res, 400, { error: 'Enter a password.' })
    const problem = await savePassword(auth, raw)
    if (problem) return sendJson(res, 400, { error: problem })
    o.log('setup: password set')
    sendJson(res, 200, { step: await step() })
  }

  async function totpStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await admit(req, res, 'totp-start')
    if (!body) return
    // A reload starts over with a fresh secret; the old pending one was never stored.
    pendingSecret = newTotpSecret()
    const uri = otpauthUri(pendingSecret)
    sendJson(res, 200, { secret: pendingSecret, otpauth: uri, qr: await qrcode.toDataURL(uri, { margin: 1, width: 240 }) })
  }

  async function totpConfirm(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await admit(req, res, 'totp-confirm')
    if (!body) return
    const given = field(body, 'totp')
    if (pendingSecret === null) return sendJson(res, 409, { error: 'Start again: this server has no pending authenticator secret.' })
    if (given === null) return sendJson(res, 400, { error: 'Enter the 6-digit code.' })
    const codes = await saveTotp(auth, pendingSecret, given, o.now())
    if (codes === null) return sendJson(res, 400, { error: 'That code is not valid. Try the next one.' })
    pendingSecret = null
    o.log('setup: two-factor sign-in set')
    // Saved before they are sent, so every code shown already works. They are shown once and kept nowhere else.
    sendJson(res, 200, { step: await step(), recoveryCodes: codes })
  }

  async function check(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!(await admit(req, res, 'check'))) return
    sendJson(res, 200, { claude: await o.claudeStatus() })
  }

  async function finish(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!(await admit(req, res, 'finish'))) return
    o.log('setup finished')
    res.writeHead(204, { 'Content-Length': 0 })
    res.end()
    // After the answer: the caller tears these routes down, and nothing may answer here again.
    o.onFinish()
  }

  return {
    /** True when this request was answered here. */
    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
      const path = (req.url ?? '/').split(/[?#]/)[0]!
      const method = req.method ?? 'GET'
      if (Object.hasOwn(PAGES, path) && (method === 'GET' || method === 'HEAD')) {
        servePage(req, res, path)
        return true
      }
      if (path === '/api/setup/state' && (method === 'GET' || method === 'HEAD')) {
        // No secret in it, so no code needed: the page only learns where to resume.
        sendJson(res, 200, { step: await step() })
        return true
      }
      const call = Object.hasOwn(CALLS, path) ? CALLS[path]! : null
      if (call === null) return false
      if (method !== 'POST') {
        sendJson(res, 405, { error: 'Method not allowed' })
        return true
      }
      if (call === 'password') await password(req, res)
      else if (call === 'totp-start') await totpStart(req, res)
      else if (call === 'totp-confirm') await totpConfirm(req, res)
      else if (call === 'check') await check(req, res)
      else await finish(req, res)
      return true
    }
  }
}
