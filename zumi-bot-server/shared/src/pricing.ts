// API list prices, USD per MTok (claude-api skill, cached 2026-10-06).
export interface Rates {
  input: number
  output: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
}
export interface ModelPricing {
  base: Rates
  longPrompt?: { over: number; rates: Rates }
  fastMultiplier?: number
}

// Cache writes are 1.25x input (5m) and 2x input (1h).
const rates = (input: number, output: number, cacheRead: number, cacheWrite5m: number, cacheWrite1h: number): Rates => ({
  input,
  output,
  cacheRead,
  cacheWrite5m,
  cacheWrite1h
})

export const PRICING: Record<string, ModelPricing> = {
  'claude-fable-5-1': { base: rates(10, 50, 0.25, 12.5, 20) },
  'claude-opus-5-5': { base: rates(4, 20, 0.2, 5, 8), fastMultiplier: 2 },
  'claude-opus-5': { base: rates(5, 25, 0.5, 6.25, 10), fastMultiplier: 2 },
  'claude-sonnet-5-5': { base: rates(2, 10, 0.2, 2.5, 4) },
  'claude-sonnet-5': { base: rates(2, 10, 0.2, 2.5, 4) },
  'claude-haiku-5-5': {
    base: rates(0.1, 0.5, 0.01, 0.125, 0.2),
    longPrompt: { over: 100_000, rates: rates(0.5, 2.5, 0.05, 0.625, 1) }
  },
  'claude-haiku-4-5': { base: rates(1, 5, 0.1, 1.25, 2) }
}

export interface MessageTokens {
  input: number
  output: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
  fast: boolean
}

const tokenCount = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/** A message's `usage` (the CLI's stream or its session log) as priced tokens; null when it has none. */
export function usageTokens(u: unknown): MessageTokens | null {
  if (!u || typeof u !== 'object') return null
  const o = u as Record<string, unknown>
  const c = o.cache_creation && typeof o.cache_creation === 'object' ? (o.cache_creation as Record<string, unknown>) : null
  // No TTL split: count every write as 5-minute (the default)
  return {
    input: tokenCount(o.input_tokens),
    output: tokenCount(o.output_tokens),
    cacheRead: tokenCount(o.cache_read_input_tokens),
    cacheWrite5m: c ? tokenCount(c.ephemeral_5m_input_tokens) : tokenCount(o.cache_creation_input_tokens),
    cacheWrite1h: c ? tokenCount(c.ephemeral_1h_input_tokens) : 0,
    fast: o.speed === 'fast'
  }
}

// Logs name dated ids ('-20251001'); the table is keyed by the undated one.
export function canonicalModel(model: string): string {
  return model.replace(/\[\d+m\]$/, '').replace(/-\d{8}$/, '') // '[1m]' marks the long-context variant, same price
}

// null = model not in PRICING, so callers show "unpriced" instead of $0.
export function priceMessage(model: string, t: MessageTokens): number | null {
  const p = PRICING[canonicalModel(model)]
  if (!p) return null
  // The long-prompt tier depends on this one message's whole prompt.
  const prompt = t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h
  const r = p.longPrompt && prompt > p.longPrompt.over ? p.longPrompt.rates : p.base
  const usd =
    (t.input * r.input +
      t.output * r.output +
      t.cacheRead * r.cacheRead +
      t.cacheWrite5m * r.cacheWrite5m +
      t.cacheWrite1h * r.cacheWrite1h) /
    1e6
  return t.fast && p.fastMultiplier ? usd * p.fastMultiplier : usd
}

// Codex API list prices, USD per MTok, Standard tier, short context (<= 272K input tokens).
// Source: https://developers.openai.com/api/docs/pricing, read 2026-11-09, for the models `codex app-server` `model/list` offered that day.
// A turn's tokens are summed over its requests, so the long-context tier (per request, over 272K) cannot be told apart: it is left out.
// gpt-5.6-sol's price is promotional until 2026-11-30 (the page gives no later rate).
export interface CodexRates {
  input: number
  cachedInput: number
  output: number
}
export interface CodexTokens {
  input: number
  cachedInput: number
  output: number
}

export const CODEX_PRICING: Record<string, CodexRates> = {
  'gpt-6.1-sol': { input: 2, cachedInput: 0.1, output: 10 },
  'gpt-6-astra': { input: 10, cachedInput: 1, output: 50 },
  'gpt-6.1-terra': { input: 1, cachedInput: 0.05, output: 5 },
  'gpt-6-sol': { input: 2, cachedInput: 0.2, output: 10 },
  'gpt-6-luna': { input: 0.1, cachedInput: 0.01, output: 0.5 },
  'gpt-5.6-sol': { input: 4, cachedInput: 0.4, output: 20 },
  'gpt-5.6-terra': { input: 2, cachedInput: 0.2, output: 12 },
  'gpt-5.6-luna': { input: 0.2, cachedInput: 0.02, output: 1.2 }
}

// OpenAI's `input` includes the cached part, so only the rest is billed at the input rate.
// null = model not in CODEX_PRICING, so callers show "unpriced" instead of $0.
export function priceCodex(model: string, t: CodexTokens): number | null {
  const r = Object.hasOwn(CODEX_PRICING, model) ? CODEX_PRICING[model] : undefined
  if (!r) return null
  const uncached = Math.max(0, t.input - t.cachedInput)
  return (uncached * r.input + t.cachedInput * r.cachedInput + t.output * r.output) / 1e6
}
