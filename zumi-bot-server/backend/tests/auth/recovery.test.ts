import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { newRecoveryCodes, normalizeRecovery } from '../../src/auth/recovery'

describe('recovery codes', () => {
  it('makes 10 unique codes matching the format', () => {
    const { codes, hashes } = newRecoveryCodes()
    expect(codes).toHaveLength(10)
    expect(new Set(codes).size).toBe(10)
    for (const c of codes) expect(c).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/)
    expect(hashes).toHaveLength(10)
    expect(hashes[0]).toBe(createHash('sha256').update(normalizeRecovery(codes[0])).digest('hex'))
  })

  it('normalizes input', () => {
    expect(normalizeRecovery(' abcde-fghij ')).toBe('ABCDEFGHIJ')
  })
})
