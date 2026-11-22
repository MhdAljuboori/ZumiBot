import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthStore } from '../../src/auth/authStore'
import { newRecoveryCodes, hashRecovery, normalizeRecovery } from '../../src/auth/recovery'
import { savePassword, saveTotp } from '../../src/auth/setupSteps'
import { newTotpSecret, totpAt } from '../../src/auth/totp'
import { removeDir } from '../support/platform'

const NOW = 1_700_000_000_000
const PASSWORD = 'correct horse battery staple'

let dir: string | null = null
afterEach(async () => {
  if (dir) removeDir(dir)
  dir = null
})

async function store(): Promise<AuthStore> {
  dir = await mkdtemp(join(tmpdir(), 'cb-setup-steps-'))
  return new AuthStore(dir, () => NOW)
}

describe('savePassword', () => {
  it('refuses a short password and stores nothing', async () => {
    const auth = await store()
    expect(await savePassword(auth, 'short')).toBe('Use at least 16 characters.')
    expect((await auth.configured()).password).toBe(false)
  })

  it('counts the NFKC length, so a composed spelling is not shorter than it looks', async () => {
    const auth = await store()
    // 16 full-width characters normalise to 16 ASCII ones.
    expect(await savePassword(auth, 'ａ'.repeat(16))).toBeNull()
    expect((await auth.configured()).password).toBe(true)
  })

  it('stores a password sign-in can use', async () => {
    const auth = await store()
    expect(await savePassword(auth, PASSWORD)).toBeNull()
    const secret = newTotpSecret()
    await auth.setTotp(secret, newRecoveryCodes().hashes)
    expect(await auth.checkLogin(PASSWORD, totpAt(secret, NOW))).toBe(true)
    expect(await auth.checkLogin('something else entirely', totpAt(secret, NOW))).toBe(false)
  })

  it('signs every stored session out', async () => {
    const auth = await store()
    await savePassword(auth, PASSWORD)
    const token = await auth.createSession()
    expect(await auth.checkSession(token)).toBe(true)
    await savePassword(auth, `${PASSWORD} again`)
    expect(await auth.checkSession(token)).toBe(false)
  })
})

describe('saveTotp', () => {
  it('refuses a wrong code and stores nothing', async () => {
    const auth = await store()
    const secret = newTotpSecret()
    expect(await saveTotp(auth, secret, '000000', NOW)).toBeNull()
    expect((await auth.configured()).totp).toBe(false)
  })

  it('accepts spaces in the typed code', async () => {
    const auth = await store()
    const secret = newTotpSecret()
    const code = totpAt(secret, NOW)
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`
    expect(await saveTotp(auth, secret, spaced, NOW)).not.toBeNull()
  })

  it('returns ten recovery codes that are already saved', async () => {
    const auth = await store()
    const secret = newTotpSecret()
    await savePassword(auth, PASSWORD)
    const codes = await saveTotp(auth, secret, totpAt(secret, NOW), NOW)
    expect(codes).toHaveLength(10)
    expect(new Set(codes).size).toBe(10)
    // Every code handed out signs in, once.
    for (const code of codes!) {
      expect(await auth.checkLogin(PASSWORD, code)).toBe(true)
      expect(await auth.checkLogin(PASSWORD, code)).toBe(false)
    }
  })

  it('stores only the hashes of those codes', async () => {
    const auth = await store()
    const secret = newTotpSecret()
    const codes = await saveTotp(auth, secret, totpAt(secret, NOW), NOW)
    const hashes = codes!.map((c) => hashRecovery(normalizeRecovery(c)))
    expect(new Set(hashes).size).toBe(10)
  })

  it('burns the confirmation code, so it cannot be replayed to sign in', async () => {
    const auth = await store()
    const secret = newTotpSecret()
    await savePassword(auth, PASSWORD)
    const code = totpAt(secret, NOW)
    expect(await saveTotp(auth, secret, code, NOW)).not.toBeNull()
    expect(await auth.checkLogin(PASSWORD, code)).toBe(false)
    // The next 30 s step still works.
    expect(await auth.checkLogin(PASSWORD, totpAt(secret, NOW + 30_000))).toBe(true)
  })
})
