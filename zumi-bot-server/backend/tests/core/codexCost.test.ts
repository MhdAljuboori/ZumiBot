import { describe, expect, it } from 'vitest'
import { CODEX_PRICING, priceCodex } from '@zumibot/shared/pricing'
import { codexRunCost, codexTurnCost } from '../../src/core/codex/codexCost'

const t = { input: 2_000_000, cachedInput: 500_000, output: 1_000_000 }

describe('codexRunCost', () => {
  it('prices uncached input, cached input and output apart', () => {
    for (const [m, r] of Object.entries(CODEX_PRICING)) {
      const usd = 1.5 * r.input + 0.5 * r.cachedInput + 1 * r.output
      expect(priceCodex(m, t)).toBeCloseTo(usd, 6)
      const c = codexRunCost(m, t)
      expect(c.totalUsd).toBeCloseTo(usd, 6)
      expect(c.models[m]).toEqual({ input: 1_500_000, cacheRead: 500_000, cacheWrite: 0, output: 1_000_000, costUsd: c.totalUsd })
    }
  })

  it('has verified rates for the models the CLI offered', () => {
    expect(CODEX_PRICING['gpt-6-astra']).toEqual({ input: 10, cachedInput: 1, output: 50 })
    expect(Object.keys(CODEX_PRICING).length).toBeGreaterThan(0)
  })

  it('leaves an unknown model unpriced, not $0', () => {
    expect(priceCodex('nope', t)).toBeNull()
    const c = codexRunCost('nope', t)
    expect(c.models.nope.costUsd).toBeNull()
    expect(c.totalUsd).toBe(0)
    expect(c.models.nope.input).toBe(1_500_000)
  })

  it('keys a missing model as unknown', () => {
    const c = codexRunCost(null, t)
    expect(Object.keys(c.models)).toEqual(['unknown'])
    expect(c.models.unknown.costUsd).toBeNull()
  })

  it('never goes negative when cached exceeds input', () => {
    expect(codexRunCost('nope', { input: 10, cachedInput: 20, output: 0 }).models.nope.input).toBe(0)
  })
})

// A turn's spend: the main thread's requests and its subagents', each priced on its own model.
describe('codexTurnCost', () => {
  it('one spend is exactly codexRunCost', () => {
    expect(codexTurnCost([{ model: 'gpt-6-astra', tokens: t }])).toEqual(codexRunCost('gpt-6-astra', t))
    expect(codexTurnCost([{ model: null, tokens: t }])).toEqual(codexRunCost(null, t))
  })

  it('sums spends of one model before pricing, keeps other models apart, and totals what is priced', () => {
    const half = { input: 1_000_000, cachedInput: 250_000, output: 500_000 }
    const c = codexTurnCost([
      { model: 'gpt-6-astra', tokens: half },
      { model: 'gpt-6-luna', tokens: t },
      { model: 'gpt-6-astra', tokens: half },
      { model: 'nope', tokens: t }
    ])
    expect(c.models['gpt-6-astra']).toEqual(codexRunCost('gpt-6-astra', t).models['gpt-6-astra'])
    expect(c.models['gpt-6-luna']).toEqual(codexRunCost('gpt-6-luna', t).models['gpt-6-luna'])
    expect(c.models.nope.costUsd).toBeNull()
    expect(Object.keys(c.models)).toEqual(['gpt-6-astra', 'gpt-6-luna', 'nope'])
    expect(c.totalUsd).toBeCloseTo(priceCodex('gpt-6-astra', t)! + priceCodex('gpt-6-luna', t)!, 9)
  })

  it('no spend is a zero cost with no models', () => {
    expect(codexTurnCost([])).toEqual({ totalUsd: 0, models: {} })
  })
})
