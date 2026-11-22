import { describe, expect, it } from 'vitest'
import { newTotpSecret, otpauthUri, totpAt, verifyTotp } from '../../src/auth/totp'

const S = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

describe('totp', () => {
  it('matches the RFC 6238 SHA-1 vectors', () => {
    expect(totpAt(S, 59_000)).toBe('287082')
    expect(totpAt(S, 1111111109_000)).toBe('081804')
    expect(totpAt(S, 1234567890_000)).toBe('005924')
    expect(totpAt(S, 2000000000_000)).toBe('279037')
  })

  it('verifyTotp accepts ±1 step and rejects ±2', () => {
    const now = 1111111109_000
    const step = Math.floor(now / 30_000)
    expect(verifyTotp(S, totpAt(S, now), now, 0)).toBe(step)
    expect(verifyTotp(S, totpAt(S, now - 30_000), now, 0)).toBe(step - 1)
    expect(verifyTotp(S, totpAt(S, now + 30_000), now, 0)).toBe(step + 1)
    expect(verifyTotp(S, totpAt(S, now - 60_000), now, 0)).toBeNull()
    expect(verifyTotp(S, totpAt(S, now + 60_000), now, 0)).toBeNull()
  })

  it('verifyTotp rejects a step <= lastStep (reuse)', () => {
    const now = 1111111109_000
    const step = Math.floor(now / 30_000)
    expect(verifyTotp(S, totpAt(S, now), now, step)).toBeNull()
    expect(verifyTotp(S, totpAt(S, now), now, step + 1)).toBeNull()
    expect(verifyTotp(S, totpAt(S, now), now, step - 1)).toBe(step)
  })

  it('rejects non-6-digit input', () => {
    const now = 1111111109_000
    expect(verifyTotp(S, '08180', now, 0)).toBeNull()
    expect(verifyTotp(S, '0818040', now, 0)).toBeNull()
    expect(verifyTotp(S, 'abcdef', now, 0)).toBeNull()
    expect(verifyTotp(S, '', now, 0)).toBeNull()
  })

  it('makes a base32 secret of 32 chars and an otpauth uri', () => {
    const s = newTotpSecret()
    expect(s).toMatch(/^[A-Z2-7]{32}$/)
    expect(newTotpSecret()).not.toBe(s)
    expect(otpauthUri(s)).toBe(`otpauth://totp/ZumiBot:zumibot?secret=${s}&issuer=ZumiBot&algorithm=SHA1&digits=6&period=30`)
  })
})
