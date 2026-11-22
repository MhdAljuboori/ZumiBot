import { describe, expect, it } from 'vitest'
import { formatSetupCode, hashSetupCode, newSetupCode, normalizeSetupCode, setupCodeMatches } from '../../src/auth/setupCode'

describe('setup code', () => {
  it('is 16 base32 characters in groups of four', () => {
    const { code } = newSetupCode()
    expect(code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/)
    expect(normalizeSetupCode(code)).toHaveLength(16)
  })

  it('never returns the same code twice', () => {
    const codes = new Set(Array.from({ length: 50 }, () => newSetupCode().code))
    expect(codes.size).toBe(50)
  })

  it('keeps only a hash, which is not the code', () => {
    const { code, hash } = newSetupCode()
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).not.toContain(normalizeSetupCode(code))
  })

  it('accepts the code however it is typed back', () => {
    const { code, hash } = newSetupCode()
    const bare = normalizeSetupCode(code)
    for (const typed of [code, bare, code.toLowerCase(), bare.toLowerCase(), ` ${code} `, bare.replace(/(.{4})/g, '$1 ')]) {
      expect(setupCodeMatches(hash, typed)).toBe(true)
    }
  })

  it('refuses anything else, including an empty or malformed guess', () => {
    const { code, hash } = newSetupCode()
    const bare = normalizeSetupCode(code)
    for (const wrong of ['', '   ', bare.slice(0, 15), `${bare}A`, bare.replace(/[A-Z2-7]/, '1'), newSetupCode().code]) {
      expect(setupCodeMatches(hash, wrong)).toBe(false)
    }
  })

  it('refuses a guess that hashes to the stored value only after normalising away real characters', () => {
    // A code is compared by its hash, so a different code with the same shape must not pass.
    const hash = hashSetupCode('AAAABBBBCCCCDDDD')
    expect(setupCodeMatches(hash, 'aaaa-bbbb-cccc-dddd')).toBe(true)
    expect(setupCodeMatches(hash, 'AAAABBBBCCCCDDDE')).toBe(false)
  })

  it('formats any length in fours', () => {
    expect(formatSetupCode('ABCDEFGH')).toBe('ABCD-EFGH')
    expect(formatSetupCode('ABC')).toBe('ABC')
    expect(formatSetupCode('')).toBe('')
  })
})
