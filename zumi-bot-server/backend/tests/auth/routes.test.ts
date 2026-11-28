import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { AuthStore, sessionKeyOf } from '../../src/auth/authStore'
import { createGate } from '../../src/auth/guard'
import { hashPassword } from '../../src/auth/password'
import { createLimiter, type Limiter } from '../../src/auth/rateLimit'
import { newRecoveryCodes } from '../../src/auth/recovery'
import { newTotpSecret, totpAt } from '../../src/auth/totp'
import type { Config } from '../../src/config'
import { AttachmentStore } from '../../src/core/attachments/attachmentStore'
import { createAppServer } from '../../src/http/server'
import { SECURITY_HEADERS } from '../../src/http/headers'
import { createHub, type Hub } from '../../src/rpc/hub'

const ORIGIN = 'https://zumibot.test'
const PASSWORD = 'correct horse battery staple'
const WRONG_PW = 'wrong-password-submitted-12345'
const GENERIC = 'Wrong password or code.'

let passwordHash: string
beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD)
})

interface Rig {
  base: string
  port: number
  dir: string
  auth: AuthStore
  hub: Hub
  limiter: Limiter
  logs: string[]
  secret: string
  clock: { now: number }
  code(): string
  login(body: unknown, headers?: Record<string, string>): Promise<Response>
  close(): Promise<void>
}

async function startRig(
  o: {
    mode?: 'vps' | 'local'
    sessionEnded?: (key: string | 'all') => void
    pingMs?: number
    auth?: (dir: string, now: () => number) => AuthStore
    limiter?: (l: Limiter) => Limiter
    configure?: boolean
  } = {}
): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), 'cb-routes-'))
  const clock = { now: 1_700_000_000_000 }
  const now = () => clock.now
  const auth = o.auth ? o.auth(dir, now) : new AuthStore(dir, now)
  const secret = newTotpSecret()
  if (o.configure !== false && !o.auth) {
    await auth.setPassword(passwordHash)
    await auth.setTotp(secret, newRecoveryCodes().hashes)
  }
  const mode = o.mode ?? 'vps'
  const config: Config = {
    mode,
    port: 0,
    dataDir: dir,
    vaultKeyFile: join(dir, '..', 'unused-vault.key'),
    agentsDir: dir,
    webDir: dir,
    origin: mode === 'vps' ? ORIGIN : '',
    localSecret: mode === 'local' ? 'L'.repeat(40) : null,
    migrateFrom: null
  }
  const limiter = o.limiter ? o.limiter(createLimiter({ now })) : createLimiter({ now })
  const logs: string[] = []
  let hub!: Hub
  const gate = createGate({ config, auth, limiter, hub: () => hub, log: (l) => logs.push(l), sessionEnded: o.sessionEnded })
  hub = createHub(
    {},
    { pingMs: o.pingMs ?? 30_000, closeGraceMs: 200, isValid: mode === 'vps' ? (k) => auth.checkSessionKey(k) : async () => true }
  )
  const server: Server = createAppServer({
    gate,
    hub,
    attachments: new AttachmentStore(join(dir, 'att'), () => 'id'),
    webDir: dir,
    sessionKey: (r) => gate.sessionKey(r)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  const base = `http://127.0.0.1:${port}`
  return {
    base,
    port,
    dir,
    auth,
    hub,
    limiter,
    logs,
    secret,
    clock,
    code: () => {
      // each TOTP step works once, so move to a fresh step per login
      clock.now += 30_000
      return totpAt(secret, clock.now)
    },
    login: (body, headers = {}) =>
      fetch(`${base}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body)
      }),
    close: async () => {
      hub.closeSession('all')
      hub.dispose()
      server.closeAllConnections()
      await new Promise<void>((r) => server.close(() => r()))
      await rm(dir, { recursive: true, force: true })
    }
  }
}

let rig: Rig
afterEach(() => rig?.close())

const cookieOf = (res: Response): string => (res.headers.get('set-cookie') ?? '').split(';')[0]!

function openSocket(r: Rig, cookie: string): Promise<{ ws: WebSocket; closed: Promise<number> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${r.port}/ws`, { origin: ORIGIN, headers: { cookie } })
  const closed = new Promise<number>((res) => ws.on('close', (code) => res(code)))
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve({ ws, closed }))
    ws.on('error', reject)
  })
}

describe('vps routes', () => {
  beforeEach(async () => {
    rig = await startRig()
  })

  it('every route answers 401/302/4401 without a session', async () => {
    const root = await fetch(`${rig.base}/`, { redirect: 'manual' })
    expect(root.status).toBe(302)
    expect(root.headers.get('location')).toBe('/login')
    expect((await fetch(`${rig.base}/api/attachments/staged/x`, { redirect: 'manual' })).status).toBe(401)
    const stage = await fetch(`${rig.base}/api/attachments/stage`, { method: 'POST', headers: { origin: ORIGIN }, body: 'x' })
    expect(stage.status).toBe(401)
    const ws = new WebSocket(`ws://127.0.0.1:${rig.port}/ws`, { origin: ORIGIN })
    const code = await new Promise<number>((res, rej) => {
      ws.on('close', (c) => res(c))
      ws.on('error', rej)
    })
    expect(code).toBe(4401)
  })

  it('a WebSocket upgrade with a signed-in cookie but a bad or missing Origin is refused with 4401', async () => {
    const cookie = `cb_session=${await rig.auth.createSession()}`
    for (const origin of [undefined, 'https://evil.test']) {
      const ws = new WebSocket(`ws://127.0.0.1:${rig.port}/ws`, { origin, headers: { cookie } })
      const code = await new Promise<number>((res, rej) => {
        ws.on('close', (c) => res(c))
        ws.on('error', rej)
      })
      expect(code).toBe(4401)
    }
  })

  it('a chat or popout page without a session goes to /login with the way back; other pages to plain /login', async () => {
    const chat = await fetch(`${rig.base}/chat/x?popout=1`, { redirect: 'manual' })
    expect(chat.status).toBe(302)
    expect(chat.headers.get('location')).toBe('/login?next=%2Fchat%2Fx%3Fpopout%3D1')
    const settings = await fetch(`${rig.base}/settings/usage`, { redirect: 'manual' })
    expect(settings.headers.get('location')).toBe('/login')
  })

  it('/login while signed in goes back to a safe next path, else the root', async () => {
    const cookie = cookieOf(await rig.login({ password: PASSWORD, code: rig.code() }))
    const back = await fetch(`${rig.base}/login?next=${encodeURIComponent('/chat/x?popout=1')}`, {
      headers: { cookie },
      redirect: 'manual'
    })
    expect(back.status).toBe(302)
    expect(back.headers.get('location')).toBe('/chat/x?popout=1')
    const evil = await fetch(`${rig.base}/login?next=${encodeURIComponent('//evil.example')}`, { headers: { cookie }, redirect: 'manual' })
    expect(evil.headers.get('location')).toBe('/')
  })

  it('login sets the cookie with exactly the pinned attributes', async () => {
    const res = await rig.login({ password: PASSWORD, code: rig.code() })
    expect(res.status).toBe(204)
    const sc = res.headers.get('set-cookie')!
    expect(sc).toMatch(/^cb_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000$/)
    // and the cookie works
    const ok = await fetch(`${rig.base}/api/attachments/staged/x`, { headers: { cookie: cookieOf(res) } })
    expect(ok.status).not.toBe(401)
  })

  it('a recovery code logs in too, once', async () => {
    const { codes, hashes } = newRecoveryCodes()
    await rig.auth.setTotp(rig.secret, hashes)
    expect((await rig.login({ password: PASSWORD, code: codes[0] })).status).toBe(204)
    expect((await rig.login({ password: PASSWORD, code: codes[0] })).status).toBe(401)
  })

  it('wrong code is 401 with the generic message', async () => {
    const res = await rig.login({ password: PASSWORD, code: '000000' })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: GENERIC })
    expect(res.headers.get('set-cookie')).toBeNull()
    const wrongPw = await rig.login({ password: WRONG_PW, code: rig.code() })
    expect(wrongPw.status).toBe(401)
    expect(await wrongPw.json()).toEqual({ error: GENERIC })
  })

  it('malformed, oversize and mistyped bodies are 401 generic, never a stack', async () => {
    for (const body of [
      '{nope',
      JSON.stringify({ password: 1, code: 2 }),
      JSON.stringify({}),
      '[]',
      'null',
      JSON.stringify({ password: 'x'.repeat(5000), code: '1' })
    ]) {
      rig.clock.now += 60 * 60_000 // clear the throttle between cases
      const res = await rig.login(body)
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: GENERIC })
    }
  })

  it('a login from another origin is refused', async () => {
    const res = await rig.login({ password: PASSWORD, code: rig.code() }, { origin: 'https://evil.test' })
    expect(res.status).toBe(403)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('after 3 wrong tries, an immediate 4th is 429 with Retry-After 1', async () => {
    const valid = rig.code() // moves the fake clock, so take it before the failures
    for (let i = 0; i < 3; i++) expect((await rig.login({ password: PASSWORD, code: '000000' })).status).toBe(401)
    const res = await rig.login({ password: PASSWORD, code: valid })
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('1')
    expect(await res.json()).toEqual({ error: 'Too many tries. Try again in 1 seconds.', retryAfterSec: 1 })
  })

  it('a failed login logs "login failed from <ip>" and the log never contains the submitted password or code', async () => {
    await rig.login({ password: WRONG_PW, code: '135790' }, { 'x-forwarded-for': '203.0.113.7' })
    expect(rig.logs).toEqual(['login failed from 203.0.113.7'])
    const all = rig.logs.join('\n')
    expect(all).not.toContain(WRONG_PW)
    expect(all).not.toContain('135790')
  })

  it('throttling is per client IP (X-Forwarded-For from the local proxy)', async () => {
    for (let i = 0; i < 3; i++) await rig.login({ password: PASSWORD, code: '000000' }, { 'x-forwarded-for': '203.0.113.7' })
    expect((await rig.login({ password: PASSWORD, code: '000000' }, { 'x-forwarded-for': '203.0.113.7' })).status).toBe(429)
    expect((await rig.login({ password: PASSWORD, code: rig.code() }, { 'x-forwarded-for': '203.0.113.8' })).status).toBe(204)
  })

  it('logout-all closes an open socket with 4401 and the old cookie then gets 401', async () => {
    const cookie = `cb_session=${await rig.auth.createSession()}`
    const { closed } = await openSocket(rig, cookie)
    const res = await fetch(`${rig.base}/api/logout-all`, { method: 'POST', headers: { cookie, origin: ORIGIN } })
    expect(res.status).toBe(204)
    expect(res.headers.get('set-cookie')).toMatch(/^cb_session=; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=0$/)
    expect(await closed).toBe(4401)
    expect((await fetch(`${rig.base}/api/attachments/staged/x`, { headers: { cookie } })).status).toBe(401)
  })

  it('logout clears only its own session', async () => {
    const a = `cb_session=${await rig.auth.createSession()}`
    const b = `cb_session=${await rig.auth.createSession()}`
    const sa = await openSocket(rig, a)
    const sb = await openSocket(rig, b)
    let bClosed = false
    void sb.closed.then(() => (bClosed = true))
    const res = await fetch(`${rig.base}/api/logout`, { method: 'POST', headers: { cookie: a, origin: ORIGIN } })
    expect(res.status).toBe(204)
    expect(await sa.closed).toBe(4401)
    expect(await rig.auth.checkSession(b.split('=')[1]!)).toBe(true)
    expect((await fetch(`${rig.base}/api/attachments/staged/x`, { headers: { cookie: a } })).status).toBe(401)
    expect((await fetch(`${rig.base}/api/attachments/staged/x`, { headers: { cookie: b } })).status).not.toBe(401)
    await new Promise((r) => setTimeout(r, 50))
    expect(bClosed).toBe(false)
    sb.ws.close()
  })

  it('logout needs a session and the right origin', async () => {
    const cookie = `cb_session=${await rig.auth.createSession()}`
    expect((await fetch(`${rig.base}/api/logout`, { method: 'POST', headers: { origin: ORIGIN } })).status).toBe(401)
    expect((await fetch(`${rig.base}/api/logout`, { method: 'POST', headers: { cookie } })).status).toBe(403)
    expect((await fetch(`${rig.base}/api/logout-all`, { method: 'POST', headers: { cookie, origin: 'https://evil.test' } })).status).toBe(
      403
    )
    expect(await rig.auth.checkSession(cookie.split('=')[1]!)).toBe(true)
  })

  it('the login page is served with SECURITY_HEADERS and no session', async () => {
    for (const [path, type] of [
      ['/login', 'text/html'],
      ['/login.css', 'text/css'],
      ['/login.js', 'text/javascript'],
      ['/favicon.png', 'image/png']
    ] as const) {
      const res = await fetch(`${rig.base}${path}`, { redirect: 'manual' })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain(type)
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(res.headers.get(k)).toBe(v)
      const text = await res.text()
      expect(text.length).toBeGreaterThan(50)
      if (path === '/login') {
        expect(text).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/i) // no inline script
        expect(text).not.toMatch(/<style/i)
        expect(text).not.toMatch(/\sstyle=/i)
        expect(text).not.toMatch(/\son\w+=/i)
        expect(text).toContain('autocomplete="one-time-code"')
        expect(text).toContain('inputmode="numeric"')
      }
    }
  })

  it('the login form posts, never gets: no credentials in the URL without JS', async () => {
    const { readFile } = await import('node:fs/promises')
    const html = await readFile(join(__dirname, '../../src/http/login/login.html'), 'utf8')
    expect(html).toMatch(/<form[^>]*\smethod="post"/i)
    expect(html).toMatch(/<form[^>]*\saction="\/login"/i)
  })

  it('a native form POST /login is 401, never a page', async () => {
    const res = await fetch(`${rig.base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN },
      body: `password=${PASSWORD}&code=123456`,
      redirect: 'manual'
    })
    expect(res.status).toBe(401)
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(rig.logs.join()).not.toContain(PASSWORD)
  })

  it('GET /login ignores and never echoes the query string', async () => {
    const res = await fetch(`${rig.base}/login?password=hunter2xyz&code=654321`)
    expect(res.status).toBe(200)
    expect(await res.text()).not.toMatch(/hunter2xyz|654321/)
  })

  it('a signed-in GET /login redirects to /', async () => {
    const cookie = `cb_session=${await rig.auth.createSession()}`
    const res = await fetch(`${rig.base}/login`, { headers: { cookie }, redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')
  })
})

describe('sign-out signal', () => {
  let ended: (string | 'all')[]
  beforeEach(async () => {
    ended = []
    rig = await startRig({ sessionEnded: (k) => ended.push(k) })
  })

  it('logout reports the session key, never the token', async () => {
    const token = await rig.auth.createSession()
    await fetch(`${rig.base}/api/logout`, { method: 'POST', headers: { cookie: `cb_session=${token}`, origin: ORIGIN } })
    expect(ended).toEqual([sessionKeyOf(token)])
    expect(ended).not.toContain(token)
  })

  it('logout-all reports all', async () => {
    const cookie = `cb_session=${await rig.auth.createSession()}`
    await fetch(`${rig.base}/api/logout-all`, { method: 'POST', headers: { cookie, origin: ORIGIN } })
    expect(ended).toEqual(['all'])
  })

  it('a throwing hook does not break the sign-out', async () => {
    await rig.close()
    rig = await startRig({
      sessionEnded: () => {
        throw new Error('hook broke')
      }
    })
    const cookie = `cb_session=${await rig.auth.createSession()}`
    const res = await fetch(`${rig.base}/api/logout`, { method: 'POST', headers: { cookie, origin: ORIGIN } })
    expect(res.status).toBe(204)
  })
})

describe('session revocation from outside', () => {
  it('set-password through a second AuthStore on the same dir closes an open socket with 4401 within 2 ping intervals', async () => {
    rig = await startRig({ pingMs: 50 })
    const cookie = `cb_session=${await rig.auth.createSession()}`
    const { closed } = await openSocket(rig, cookie)
    const t0 = Date.now()
    await new AuthStore(rig.dir, () => rig.clock.now).setPassword(await hashPassword('another password entirely'))
    expect(await closed).toBe(4401)
    expect(Date.now() - t0).toBeLessThan(2000)
  })
})

describe('login failure handling', () => {
  it('a throwing AuthStore → 401 generic, logs "login error" without detail', async () => {
    const boom = (dir: string, now: () => number) => {
      const a = new AuthStore(dir, now)
      a.checkLogin = async () => {
        throw new Error('auth.json is not valid JSON hunter2')
      }
      return a
    }
    rig = await startRig({ auth: boom })
    const res = await rig.login({ password: WRONG_PW, code: '123456' })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: GENERIC })
    expect(rig.logs).toEqual(['login error'])
    expect(rig.logs.join()).not.toContain('hunter2')
  })

  it('a throwing createSession → 401 generic', async () => {
    const boom = (dir: string, now: () => number) => {
      const a = new AuthStore(dir, now)
      a.checkLogin = async () => true
      a.createSession = async () => {
        throw new Error('disk full')
      }
      return a
    }
    rig = await startRig({ auth: boom })
    const res = await rig.login({ password: PASSWORD, code: '123456' })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: GENERIC })
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('an unconfigured server answers the same generic 401', async () => {
    rig = await startRig({ configure: false })
    const res = await rig.login({ password: PASSWORD, code: '123456' })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: GENERIC })
  })

  it('a corrupt auth.json denies session checks and logins without crashing', async () => {
    rig = await startRig()
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(rig.dir, 'auth.json'), '{ corrupt')
    const res = await rig.login({ password: PASSWORD, code: '123456' })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: GENERIC })
    expect((await fetch(`${rig.base}/api/attachments/staged/x`, { headers: { cookie: 'cb_session=abc' } })).status).toBe(401)
  })
})

describe('login concurrency', () => {
  const deferred = () => {
    let resolve!: () => void
    const promise = new Promise<void>((r) => (resolve = r))
    return { promise, resolve }
  }

  it('25 concurrent POST /api/login from one IP: one checkLogin at a time, at most 1 non-429', async () => {
    let running = 0
    let max = 0
    let calls = 0
    const slow = (dir: string, now: () => number) => {
      const a = new AuthStore(dir, now)
      a.checkLogin = async () => {
        calls++
        running++
        max = Math.max(max, running)
        await new Promise((r) => setTimeout(r, 300))
        running--
        return false
      }
      return a
    }
    rig = await startRig({ auth: slow })
    const results = await Promise.all(Array.from({ length: 25 }, () => rig.login({ password: WRONG_PW, code: '123456' })))
    const statuses = results.map((r) => r.status)
    expect(statuses.filter((s) => s !== 429).length).toBeLessThanOrEqual(1)
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(24)
    expect(max).toBe(1)
    expect(calls).toBeLessThanOrEqual(1)
    for (const r of results.filter((x) => x.status === 429)) expect(r.headers.get('retry-after')).toMatch(/^\d+$/)
  })

  it('the failure is recorded before checkLogin finishes, and success clears it', async () => {
    const events: string[] = []
    const gate = deferred()
    const started = deferred()
    const hooked = (dir: string, now: () => number) => {
      const a = new AuthStore(dir, now)
      a.checkLogin = async () => {
        events.push('checkLogin:start')
        started.resolve()
        await gate.promise
        events.push('checkLogin:end')
        return true
      }
      return a
    }
    rig = await startRig({
      auth: hooked,
      limiter: (l) => ({
        ...l,
        fail: (ip) => {
          events.push('fail')
          l.fail(ip)
        },
        succeed: (ip) => {
          events.push('succeed')
          l.succeed(ip)
        }
      })
    })
    const pending = rig.login({ password: PASSWORD, code: '123456' })
    await started.promise
    expect(events).toEqual(['fail', 'checkLogin:start'])
    expect(rig.limiter.size()).toBe(1) // reserved while the check is still running
    gate.resolve()
    const res = await pending
    expect(res.status).toBe(204)
    expect(events).toEqual(['fail', 'checkLogin:start', 'checkLogin:end', 'succeed'])
    expect(rig.limiter.size()).toBe(0)
  })

  it('at most 2 checkLogin run at once across different IPs', async () => {
    let running = 0
    let max = 0
    const slow = (dir: string, now: () => number) => {
      const a = new AuthStore(dir, now)
      a.checkLogin = async () => {
        running++
        max = Math.max(max, running)
        await new Promise((r) => setTimeout(r, 60))
        running--
        return false
      }
      return a
    }
    rig = await startRig({ auth: slow })
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => rig.login({ password: WRONG_PW, code: '123456' }, { 'x-forwarded-for': `203.0.113.${10 + i}` }))
    )
    expect(results.every((r) => r.status === 401)).toBe(true)
    expect(max).toBe(2)
  })
})

describe('local mode', () => {
  it('has no /login (404) and no /api/login (404)', async () => {
    rig = await startRig({ mode: 'local' })
    expect((await fetch(`${rig.base}/login`, { redirect: 'manual' })).status).toBe(404)
    expect((await fetch(`${rig.base}/login.js`, { redirect: 'manual' })).status).toBe(404)
    const res = await rig.login({ password: PASSWORD, code: '123456' }, { origin: 'http://127.0.0.1' })
    expect(res.status).toBe(404)
    expect((await fetch(`${rig.base}/api/logout`, { method: 'POST' })).status).toBe(404)
  })

  it('serves /favicon.png from the web dir, and only with the secret', async () => {
    rig = await startRig({ mode: 'local' })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(rig.dir, 'favicon.png'), 'png')
    expect((await fetch(`${rig.base}/favicon.png`, { redirect: 'manual' })).status).toBe(302)
    const res = await fetch(`${rig.base}/favicon.png`, { headers: { cookie: `cb_local=${'L'.repeat(40)}` } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(await res.text()).toBe('png')
  })
})
