import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { AuthStore, sessionKeyOf } from '../../src/auth/authStore'
import { hashPassword, verifyPassword } from '../../src/auth/password'
import { newRecoveryCodes } from '../../src/auth/recovery'
import { totpAt } from '../../src/auth/totp'

const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
const PW = 'a long enough password'
const DAY = 86_400_000

let dir: string
let t: number
let store: AuthStore
let codes: string[]

beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-auth-'))
  t = 1_700_000_000_000
  store = new AuthStore(dir, () => t)
  await store.setPassword(await hashPassword(PW))
  const rc = newRecoveryCodes()
  codes = rc.codes
  await store.setTotp(SECRET, rc.hashes)
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('AuthStore', () => {
  it('setTotp with a lastStep rejects that step and older, accepts the next', async () => {
    const step = Math.floor(t / 30_000)
    await store.setTotp(SECRET, [], step)
    expect(await store.checkLogin(PW, totpAt(SECRET, t))).toBe(false)
    expect(await store.checkLogin(PW, totpAt(SECRET, t - 30_000))).toBe(false)
    expect(await store.checkLogin(PW, totpAt(SECRET, t + 30_000))).toBe(true)
  })

  it('reports what is configured', async () => {
    expect(await store.configured()).toEqual({ password: true, totp: true })
    const empty = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-auth-'))
    try {
      expect(await new AuthStore(empty, () => t).configured()).toEqual({ password: false, totp: false })
    } finally {
      await fs.rm(empty, { recursive: true, force: true })
    }
  })

  it('file mode is 0o600', async () => {
    if (process.platform !== 'win32') expect((await fs.stat(join(dir, 'auth.json'))).mode & 0o777).toBe(0o600)
    await store.createSession()
    if (process.platform !== 'win32') expect((await fs.stat(join(dir, 'auth.json'))).mode & 0o777).toBe(0o600)
  })

  it('checkLogin needs both password and code', async () => {
    expect(await store.checkLogin(PW, totpAt(SECRET, t))).toBe(true)
    t += 60_000
    expect(await store.checkLogin('wrong password at all', totpAt(SECRET, t))).toBe(false)
    expect(await store.checkLogin(PW, '000000')).toBe(false)
    expect(await store.checkLogin(PW, '')).toBe(false)
  })

  it('a recovery code works once', async () => {
    expect(await store.checkLogin(PW, codes[0])).toBe(true)
    expect(await store.checkLogin(PW, codes[0])).toBe(false)
    expect(await store.checkLogin(PW, codes[1].toLowerCase().replace('-', ' '))).toBe(true)
    expect(await store.checkLogin('wrong password at all', codes[2])).toBe(false)
    expect(await store.checkLogin(PW, codes[2])).toBe(true)
  })

  it('a TOTP code works once', async () => {
    const code = totpAt(SECRET, t)
    expect(await store.checkLogin(PW, code)).toBe(true)
    expect(await store.checkLogin(PW, code)).toBe(false)
    expect(await store.checkLogin(PW, totpAt(SECRET, t - 30_000))).toBe(false)
    expect(await store.checkLogin(PW, totpAt(SECRET, t + 30_000))).toBe(true)
  })

  it('a failed password does not consume the TOTP step', async () => {
    const code = totpAt(SECRET, t)
    expect(await store.checkLogin('wrong password at all', code)).toBe(false)
    expect(await store.checkLogin(PW, code)).toBe(true)
  })

  it('sessions expire after 30 days (fake now)', async () => {
    const token = await store.createSession()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await store.checkSession(token)).toBe(true)
    expect(await store.checkSessionKey(sessionKeyOf(token))).toBe(true)
    t += 30 * DAY - 1
    expect(await store.checkSession(token)).toBe(true)
    t += 2
    expect(await store.checkSession(token)).toBe(false)
    expect(await store.checkSessionKey(sessionKeyOf(token))).toBe(false)
  })

  it('revokeSession and revokeAll', async () => {
    const a = await store.createSession()
    const b = await store.createSession()
    await store.revokeSession(a)
    expect(await store.checkSession(a)).toBe(false)
    expect(await store.checkSession(b)).toBe(true)
    await store.revokeAll()
    expect(await store.checkSession(b)).toBe(false)
  })

  it('setPassword revokes sessions', async () => {
    const token = await store.createSession()
    await store.setPassword(await hashPassword('another long password'))
    expect(await store.checkSession(token)).toBe(false)
  })

  it('setTotp revokes sessions', async () => {
    const token = await store.createSession()
    await store.setTotp(SECRET, [])
    expect(await store.checkSession(token)).toBe(false)
  })

  it('the file never contains a raw session token', async () => {
    const token = await store.createSession()
    const raw = await fs.readFile(join(dir, 'auth.json'), 'utf8')
    expect(raw).not.toContain(token)
    expect(raw).toContain(sessionKeyOf(token))
    for (const c of codes) expect(raw).not.toContain(c.replace('-', ''))
  })

  it('reads fresh, so outside edits apply at once', async () => {
    const token = await store.createSession()
    const p = join(dir, 'auth.json')
    const data = JSON.parse(await fs.readFile(p, 'utf8'))
    data.sessions = []
    await fs.writeFile(p, JSON.stringify(data))
    expect(await store.checkSession(token)).toBe(false)
  })

  it('concurrent sessions do not lose updates', async () => {
    const tokens = await Promise.all(Array.from({ length: 8 }, () => store.createSession()))
    for (const tk of tokens) expect(await store.checkSession(tk)).toBe(true)
  })

  it('two concurrent logins with the same TOTP code: exactly one wins', async () => {
    const code = totpAt(SECRET, t)
    const r = await Promise.all([store.checkLogin(PW, code), store.checkLogin(PW, code)])
    expect(r.filter(Boolean)).toHaveLength(1)
  })

  it('two concurrent logins with the same recovery code: exactly one wins', async () => {
    const r = await Promise.all([store.checkLogin(PW, codes[0]), store.checkLogin(PW, codes[0])])
    expect(r.filter(Boolean)).toHaveLength(1)
  })

  it('a setPassword from another instance during verification fails the login and keeps sessions revoked', async () => {
    const other = new AuthStore(dir, () => t)
    const token = await store.createSession()
    const slow = new AuthStore(dir, () => t, {
      verify: async (pw, hash) => {
        const ok = await verifyPassword(pw, hash)
        await other.setPassword(await hashPassword('brand new long password'))
        return ok
      }
    })
    expect(await slow.checkLogin(PW, totpAt(SECRET, t))).toBe(false)
    expect(await store.checkSession(token)).toBe(false)
    expect(await store.checkLogin('brand new long password', totpAt(SECRET, t))).toBe(true)
  })

  it('a revokeAll from another instance during verification is not reverted', async () => {
    const other = new AuthStore(dir, () => t)
    const slow = new AuthStore(dir, () => t, {
      verify: async (pw, hash) => {
        const ok = await verifyPassword(pw, hash)
        const tk = await other.createSession()
        await other.revokeAll()
        void tk
        return ok
      }
    })
    const token = await store.createSession()
    expect(await slow.checkLogin(PW, totpAt(SECRET, t))).toBe(true)
    expect(await store.checkSession(token)).toBe(false)
  })

  it('a corrupt file throws a generic error that quotes none of its content', async () => {
    await fs.writeFile(join(dir, 'auth.json'), '{"passwordHash": "SECRETLEAK123" oops')
    const err = await store.configured().catch((e) => e as Error)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('auth.json is not valid JSON')
    expect((err as Error).message).not.toContain('SECRETLEAK')
  })

  it('accepts a TOTP code typed with a space', async () => {
    const c = totpAt(SECRET, t)
    expect(await store.checkLogin(PW, `${c.slice(0, 3)} ${c.slice(3)}`)).toBe(true)
  })
})
