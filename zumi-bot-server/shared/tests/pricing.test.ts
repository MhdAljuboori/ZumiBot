import { describe, expect, it } from 'vitest'
import { CODEX_PRICING, canonicalModel, priceCodex, priceMessage, type MessageTokens } from '@zumibot/shared/pricing'

const zero: MessageTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, fast: false }
const M = 1_000_000

describe('pricing', () => {
  it('canonicalModel strips a date suffix', () => {
    expect(canonicalModel('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5')
    expect(canonicalModel('claude-opus-5-5')).toBe('claude-opus-5-5')
  })

  it('priceMessage prices each token kind', () => {
    const p = (k: keyof MessageTokens) => priceMessage('claude-opus-5-5', { ...zero, [k]: M })
    expect(p('input')).toBeCloseTo(4)
    expect(p('output')).toBeCloseTo(20)
    expect(p('cacheRead')).toBeCloseTo(0.2)
    expect(p('cacheWrite5m')).toBeCloseTo(5)
    expect(p('cacheWrite1h')).toBeCloseTo(8)
  })

  it('priceMessage switches Haiku 5.5 to the long-prompt rates above 100K', () => {
    // exactly 100K stays on base rates
    const atBase = { ...zero, input: 60_000, cacheRead: 40_000 }
    expect(priceMessage('claude-haiku-5-5', atBase)).toBeCloseTo((60_000 * 0.1) / M + (40_000 * 0.01) / M)
    // 60_001 input + 40_000 cache read = 100_001: long-prompt rates
    const base = { ...zero, input: 60_001, cacheRead: 40_000 }
    const long = (60_001 * 0.5) / M + (40_000 * 0.05) / M
    expect(priceMessage('claude-haiku-5-5', base)).toBeCloseTo(long)
    const plus = (k: keyof MessageTokens) => priceMessage('claude-haiku-5-5', { ...base, [k]: M })! - long
    expect(plus('output')).toBeCloseTo(2.5)
    expect(plus('cacheWrite5m')).toBeCloseTo(0.625)
    expect(plus('cacheWrite1h')).toBeCloseTo(1.0)
  })

  it('priceMessage doubles every rate in fast mode', () => {
    const t = { ...zero, input: 1000, output: 2000, cacheRead: 3000, cacheWrite5m: 400, cacheWrite1h: 500 }
    const std = priceMessage('claude-opus-5-5', t)!
    expect(priceMessage('claude-opus-5-5', { ...t, fast: true })).toBeCloseTo(std * 2)
    expect(priceMessage('claude-sonnet-5-5', { ...t, fast: true })).toBe(priceMessage('claude-sonnet-5-5', t))
  })

  it('priceMessage returns null for an unknown model', () => {
    expect(priceMessage('claude-future-9', { ...zero, input: 1 })).toBeNull()
  })
})

describe('priceCodex', () => {
  it('bills cached tokens at the cached rate, out of input', () => {
    const r = CODEX_PRICING['gpt-6-astra']
    expect(priceCodex('gpt-6-astra', { input: 2 * M, cachedInput: 0.5 * M, output: M })).toBeCloseTo(
      1.5 * r.input + 0.5 * r.cachedInput + r.output
    )
  })
  it('is null for an unknown model, even an Object.prototype name', () => {
    expect(priceCodex('nope', { input: 1, cachedInput: 0, output: 1 })).toBeNull()
    expect(priceCodex('constructor', { input: 1, cachedInput: 0, output: 1 })).toBeNull()
  })
})
