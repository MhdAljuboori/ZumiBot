import { priceCodex, type CodexTokens } from '@zumibot/shared/pricing'
import type { RunCost } from '../usage/runCost'

// Codex reports tokens, never USD: the cost is worked out from the price table, or left null (unpriced).
export function codexRunCost(model: string | null, t: CodexTokens): RunCost {
  const usd = model ? priceCodex(model, t) : null
  return {
    totalUsd: usd ?? 0,
    models: {
      [model ?? 'unknown']: {
        input: Math.max(0, t.input - t.cachedInput),
        cacheRead: t.cachedInput,
        cacheWrite: 0,
        output: t.output,
        costUsd: usd
      }
    }
  }
}

/**
 * A turn's cost over several spends (the main thread's requests and each subagent's): tokens of one model are summed before
 * pricing, other models stay apart, and the total is what is priced. One spend gives exactly codexRunCost.
 */
export function codexTurnCost(spends: readonly { model: string | null; tokens: CodexTokens }[]): RunCost {
  const sums = new Map<string | null, CodexTokens>()
  for (const { model, tokens } of spends) {
    const s = sums.get(model) ?? { input: 0, cachedInput: 0, output: 0 }
    sums.set(model, { input: s.input + tokens.input, cachedInput: s.cachedInput + tokens.cachedInput, output: s.output + tokens.output })
  }
  const cost: RunCost = { totalUsd: 0, models: {} }
  for (const [model, t] of sums) {
    const one = codexRunCost(model, t)
    cost.totalUsd += one.totalUsd
    Object.assign(cost.models, one.models)
  }
  return cost
}
