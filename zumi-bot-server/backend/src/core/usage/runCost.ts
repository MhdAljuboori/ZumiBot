import type { ModelSpends } from '@zumibot/shared/usageReport'

export interface RunCost {
  totalUsd: number
  models: ModelSpends
}

type Obj = Record<string, any>
const num = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0)

// A CLI `result` line (stream-json) or the whole `--output-format json` output: what the run really cost.
export function parseRunCost(root: unknown): RunCost | null {
  if (!root || typeof root !== 'object') return null
  const r = root as Obj
  const totalUsd = r.total_cost_usd
  if (typeof totalUsd !== 'number' || !Number.isFinite(totalUsd) || totalUsd < 0) return null
  const models: ModelSpends = {}
  if (r.modelUsage && typeof r.modelUsage === 'object') {
    for (const [name, m] of Object.entries(r.modelUsage as Obj)) {
      if (!m || typeof m !== 'object') continue
      models[name] = {
        input: num(m.inputTokens),
        output: num(m.outputTokens),
        cacheRead: num(m.cacheReadInputTokens),
        cacheWrite: num(m.cacheCreationInputTokens),
        costUsd: typeof m.costUSD === 'number' && Number.isFinite(m.costUSD) ? m.costUSD : null
      }
    }
  }
  // No per-model breakdown: keep the run's totals under one unnamed model rather than losing them.
  if (!Object.keys(models).length) {
    const u = r.usage && typeof r.usage === 'object' ? (r.usage as Obj) : {}
    const spend = {
      input: num(u.input_tokens),
      output: num(u.output_tokens),
      cacheRead: num(u.cache_read_input_tokens),
      cacheWrite: num(u.cache_creation_input_tokens)
    }
    if (!spend.input && !spend.output && !spend.cacheRead && !spend.cacheWrite) return null
    models.unknown = { ...spend, costUsd: totalUsd }
  }
  return { totalUsd, models }
}
