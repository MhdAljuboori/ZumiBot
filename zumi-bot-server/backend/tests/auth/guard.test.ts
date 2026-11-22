import type { IncomingMessage } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AuthStore, sessionKeyOf } from '../../src/auth/authStore'
import { clientIp, createGate } from '../../src/auth/guard'
import { createLimiter } from '../../src/auth/rateLimit'
import type { Config } from '../../src/config'

const ORIGIN = 'https://zumibot.test'
const SECRET = 'local-secret-0123456789-0123456789-abcdef'

let dir: string
let clock: number
let auth: AuthStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cb-guard-'))
  clock = 1_700_000_000_000
  auth = new AuthStore(dir, () => clock)
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const config = (over: Partial<Config> = {}): Config => ({
  mode: 'vps',
  port: 0,
  dataDir: dir,
  vaultKeyFile: join(dir, '..', 'unused-vault.key'),
  agentsDir: dir,
  webDir: dir,
  origin: ORIGIN,
  localSecret: null,
  migrateFrom: null,
  ...over
})

const gateFor = (c: Config, a: AuthStore = auth) =>
  createGate({
    config: c,
    auth: a,
    limiter: createLimiter({ now: () => clock }),
    hub: () => {
      throw new Error('unused')
    },
    log: () => {}
  })

const req = (headers: Record<string, string> = {}, method = 'GET', remote = '127.0.0.1'): IncomingMessage =>
  ({ headers, method, socket: { remoteAddress: remote } }) as unknown as IncomingMessage

describe('gate.authorize (vps)', () => {
  it('no cookie → not authorized', async () => {
    expect(await gateFor(config()).authorize(req())).toBe(false)
  })

  it('a valid session authorizes', async () => {
    const token = await auth.createSession()
    const gate = gateFor(config())
    expect(await gate.authorize(req({ cookie: `a=b; cb_session=${token}` }))).toBe(true)
  })

  it('an unknown token does not', async () => {
    expect(await gateFor(config()).authorize(req({ cookie: 'cb_session=nope' }))).toBe(false)
  })

  it('an expired session does not', async () => {
    const token = await auth.createSession()
    clock += 31 * 24 * 3600 * 1000
    expect(await gateFor(config()).authorize(req({ cookie: `cb_session=${token}` }))).toBe(false)
  })

  it('a throwing session check denies instead of crashing', async () => {
    const broken = {
      checkSession: async () => {
        throw new Error('auth.json is not valid JSON')
      }
    } as unknown as AuthStore
    expect(await gateFor(config(), broken).authorize(req({ cookie: 'cb_session=x' }))).toBe(false)
  })

  it('a cb_local cookie does not authorize in vps mode', async () => {
    expect(await gateFor(config()).authorize(req({ cookie: `cb_local=${SECRET}` }))).toBe(false)
  })

  it('sessionKey is the sha256 of the cookie, empty without one', () => {
    const gate = gateFor(config())
    expect(gate.sessionKey(req({ cookie: 'cb_session=tok' }))).toBe(sessionKeyOf('tok'))
    expect(gate.sessionKey(req())).toBe('')
  })
})

describe('gate.originOk', () => {
  it('a wrong Origin on POST fails originOk', async () => {
    expect(await gateFor(config()).originOk(req({ origin: 'https://evil.test' }, 'POST'))).toBe(false)
  })

  it('missing Origin on POST fails', async () => {
    expect(await gateFor(config()).originOk(req({}, 'POST'))).toBe(false)
  })

  it('the right Origin on POST passes', async () => {
    expect(await gateFor(config()).originOk(req({ origin: ORIGIN }, 'POST'))).toBe(true)
  })

  it('GET without Origin passes originOk', async () => {
    expect(await gateFor(config()).originOk(req({}, 'GET'))).toBe(true)
  })

  it('the upgrade path enforces Origin whatever the headers say', async () => {
    const gate = gateFor(config())
    const up = { upgrade: true }
    expect(await gate.originOk(req({}), up)).toBe(false)
    expect(await gate.originOk(req({ origin: 'https://evil.test' }), up)).toBe(false)
    expect(await gate.originOk(req({ upgrade: 'websocket, x' }), up)).toBe(false)
    expect(await gate.originOk(req({ upgrade: 'websocket, x', origin: 'https://evil.test' }), up)).toBe(false)
    expect(await gate.originOk(req({ upgrade: 'websocket, x', origin: ORIGIN }), up)).toBe(true)
  })

  it('an empty configured origin never matches', async () => {
    const gate = gateFor(config({ mode: 'local', origin: '', localSecret: SECRET }))
    expect(await gate.originOk(req({ origin: '' }, 'POST'))).toBe(false)
  })
})

describe('login assets', () => {
  it('missing assets fail at construction, not at the first request', () => {
    expect(() =>
      createGate({
        config: config(),
        auth,
        limiter: createLimiter({ now: () => clock }),
        hub: () => {
          throw new Error('x')
        },
        log: () => {},
        loginDir: join(dir, 'nope')
      })
    ).toThrow()
  })
})

describe('local mode', () => {
  const local = () => gateFor(config({ mode: 'local', origin: '', localSecret: SECRET }))

  it('the right cb_local authorizes, a wrong one or cb_session does not', async () => {
    const gate = local()
    expect(await gate.authorize(req({ cookie: `cb_local=${SECRET}` }))).toBe(true)
    expect(await gate.authorize(req({ cookie: `cb_local=${SECRET}x` }))).toBe(false)
    expect(await gate.authorize(req({ cookie: 'cb_local=short' }))).toBe(false)
    const token = await auth.createSession()
    expect(await gate.authorize(req({ cookie: `cb_session=${token}` }))).toBe(false)
    expect(await gate.authorize(req())).toBe(false)
  })

  it('has no login routes', async () => {
    const gate = local()
    for (const url of ['/login', '/login.css', '/login.js', '/api/login', '/api/logout', '/api/logout-all']) {
      const writes: { status?: number } = {}
      const res = {
        writeHead: (s: number) => {
          writes.status = s
        },
        end: () => {},
        setHeader: () => {}
      }
      const r = { ...req({}, 'POST'), url } as IncomingMessage
      expect(await gate.handle(r, res as never)).toBe(true)
      expect(writes.status).toBe(404)
    }
  })
})

describe('clientIp', () => {
  it('keys IPv6 by /64: same prefix shares a bucket, others do not', () => {
    const a = clientIp(req({}, 'GET', '2001:db8:1:2:aaaa:bbbb:cccc:dddd'))
    const b = clientIp(req({}, 'GET', '2001:db8:1:2:1::1'))
    const c = clientIp(req({}, 'GET', '2001:db8:1:3::1'))
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(clientIp(req({ 'x-forwarded-for': '2001:db8:1:2::5' }))).toBe(a)
    expect(clientIp(req({ 'x-forwarded-for': '2001:DB8:0001:0002:ffff::1' }))).toBe(a)
  })

  it('treats IPv4-mapped addresses as IPv4', () => {
    expect(clientIp(req({}, 'GET', '::ffff:198.51.100.4'))).toBe('198.51.100.4')
    expect(clientIp(req({ 'x-forwarded-for': '::ffff:203.0.113.9' }))).toBe('203.0.113.9')
  })

  it('uses X-Forwarded-For only when the peer is 127.0.0.1', () => {
    expect(clientIp(req({ 'x-forwarded-for': '203.0.113.9' }, 'GET', '127.0.0.1'))).toBe('203.0.113.9')
    expect(clientIp(req({ 'x-forwarded-for': '203.0.113.9' }, 'GET', '198.51.100.4'))).toBe('198.51.100.4')
    expect(clientIp(req({}, 'GET', '127.0.0.1'))).toBe('127.0.0.1')
  })

  it('treats ::ffff:127.0.0.1 as the local proxy too', () => {
    expect(clientIp(req({ 'x-forwarded-for': '2001:db8::1' }, 'GET', '::ffff:127.0.0.1'))).toBe('2001:db8:0:0::/64')
  })

  it('ignores a forwarded value that is not an IP (no log injection)', () => {
    expect(clientIp(req({ 'x-forwarded-for': 'x\nlogin ok' }))).toBe('127.0.0.1')
    expect(clientIp(req({ 'x-forwarded-for': '1.2.3.4, x\nlogin ok' }))).toBe('127.0.0.1')
    expect(clientIp(req({ 'x-forwarded-for': '1.2.3.4, ' }))).toBe('127.0.0.1')
  })

  it('takes the rightmost address of a list: the one the local proxy appended, not what the client sent', () => {
    expect(clientIp(req({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }))).toBe('5.6.7.8')
    expect(clientIp(req({ 'x-forwarded-for': '127.0.0.1, 198.51.100.4,203.0.113.9' }))).toBe('203.0.113.9')
  })
})

it('composes chat, browser and desktop session revocation without changing the chat hub contract', async () => {
  const token = await auth.createSession(),
    closed: string[] = []
  const chat = { closeSession: (key: string) => closed.push(`chat:${key}`) }
  const browser = { closeSession: (key: string) => closed.push(`browser:${key}`) }
  const desktop = { closeSession: (key: string) => closed.push(`desktop:${key}`) }
  const gate = createGate({
    config: config(),
    auth,
    limiter: createLimiter({ now: () => clock }),
    hub: () => chat as never,
    browserHub: () => browser as never,
    desktopHub: () => desktop as never,
    log: () => {}
  })
  const writes: number[] = []
  const res = {
    writeHead: (status: number) => {
      writes.push(status)
    },
    end() {}
  }
  const request = { ...req({ cookie: `cb_session=${token}`, origin: ORIGIN }, 'POST'), url: '/api/logout' } as IncomingMessage
  await gate.handle(request, res as never)
  expect(writes).toEqual([204])
  expect(closed).toEqual([`chat:${sessionKeyOf(token)}`, `browser:${sessionKeyOf(token)}`, `desktop:${sessionKeyOf(token)}`])
  expect(await auth.checkSession(token)).toBe(false)
})
