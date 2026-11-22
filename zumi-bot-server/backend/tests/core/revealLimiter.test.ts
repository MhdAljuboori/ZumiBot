import { describe, expect, it } from 'vitest'
import { createRevealLimiter } from '../../src/core/vault/revealLimiter'

describe('createRevealLimiter', () => {
  it('allows 30 in a rolling minute, then frees a slot as the oldest ages out', () => {
    let t = 0
    const l = createRevealLimiter({ now: () => t })
    for (let i = 0; i < 30; i++) {
      t = i * 1000
      expect(l.take()).toBe(true)
    }
    t = 30_000
    expect(l.take()).toBe(false)
    t = 59_999
    expect(l.take()).toBe(false)
    t = 60_000
    expect(l.take()).toBe(true)
    expect(l.take()).toBe(false)
  })
})
