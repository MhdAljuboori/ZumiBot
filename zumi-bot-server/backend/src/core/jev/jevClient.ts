import type { JevCheck } from '@zumibot/shared/jev'

export const JEV_URL = 'https://openrouter.ai/api/alpha/decisions'
export const JEV_MODEL = 'typesafe/jev-1.14'
export const JEV_TIMEOUT_MS = 8_000

export type JevQuestion =
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] }

export type JevAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number> }
  | { type: 'score'; probabilities: Record<string, number> } // keyed by the level's index, as a string

export type JevAnswers = Record<string, JevAnswer>

export interface JevClient {
  /** Null on any failure (no key, network, timeout, a bad answer): callers then carry on as if Jev were off. */
  decide(state: unknown, questions: Record<string, JevQuestion>, signal?: AbortSignal): Promise<JevAnswers | null>
  /** One tiny call, so the settings dialog can say whether the key works. */
  check(): Promise<JevCheck>
}

export interface JevClientDeps {
  key(): Promise<string | null>
  fetch?: typeof fetch
  timeoutMs?: number
  log?(line: string): void
}

type Outcome = { ok: true; answers: JevAnswers } | { ok: false; status: number | null }

const isProb = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1

function probabilities(v: unknown): Record<string, number> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const out: Record<string, number> = {}
  for (const [k, p] of Object.entries(v)) {
    if (!isProb(p)) return null
    out[k] = p
  }
  return out
}

// The API marks probabilities optional; every use here needs them, so an answer without them counts as none.
function answerFor(q: JevQuestion, raw: unknown): JevAnswer | null {
  if (!raw || typeof raw !== 'object') return null
  const a = raw as Record<string, unknown>
  if (a.type !== q.type) return null
  if (q.type === 'noul') return isProb(a.noul) ? { type: 'noul', noul: a.noul } : null
  const probs = probabilities(a.probabilities)
  if (!probs) return null
  if (q.type === 'choice') {
    return typeof a.choice === 'string' && Object.hasOwn(q.criteria, a.choice)
      ? { type: 'choice', choice: a.choice, probabilities: probs }
      : null
  }
  return { type: 'score', probabilities: probs }
}

export function createJevClient(d: JevClientDeps): JevClient {
  const fetchFn = d.fetch ?? fetch
  const log = d.log ?? ((l: string) => console.error(l))

  async function call(state: unknown, questions: Record<string, JevQuestion>, signal?: AbortSignal): Promise<Outcome> {
    const key = await d.key()
    if (!key) return { ok: false, status: null }
    if (signal?.aborted) return { ok: false, status: 0 }
    const timeout = AbortSignal.timeout(d.timeoutMs ?? JEV_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetchFn(JEV_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: JEV_MODEL, state, questions }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout
      })
    } catch (err) {
      // The name only (AbortError, TimeoutError, TypeError): a message could quote the request.
      if (!signal?.aborted) log(`jev: request failed (${err instanceof Error ? err.name : 'error'})`)
      return { ok: false, status: 0 }
    }
    if (!res.ok) {
      log(`jev: HTTP ${res.status}`)
      return { ok: false, status: res.status }
    }
    let body: unknown
    try {
      body = await res.json()
    } catch {
      log('jev: the answer was not JSON')
      return { ok: false, status: res.status }
    }
    const raw = body && typeof body === 'object' ? (body as { answers?: unknown }).answers : undefined
    const answers: JevAnswers = {}
    for (const [name, q] of Object.entries(questions)) {
      const a = raw && typeof raw === 'object' ? answerFor(q, (raw as Record<string, unknown>)[name]) : null
      if (!a) {
        log(`jev: no usable answer for "${name}"`)
        return { ok: false, status: res.status }
      }
      answers[name] = a
    }
    return { ok: true, answers }
  }

  return {
    decide: async (state, questions, signal) => {
      const out = await call(state, questions, signal)
      return out.ok ? out.answers : null
    },
    check: async () => {
      const out = await call('ZumiBot is checking its OpenRouter key.', { ok: { type: 'noul', instructions: 'Is this a key check?' } })
      if (out.ok) return { ok: true }
      if (out.status === null) return { ok: false, error: 'No OpenRouter key is set.' }
      if (out.status === 0) return { ok: false, error: 'Could not reach OpenRouter.' }
      if (out.status === 401 || out.status === 403) return { ok: false, error: 'OpenRouter did not accept the key.' }
      if (out.status === 402) return { ok: false, error: 'The OpenRouter account has no credits left.' }
      return { ok: false, error: `Jev did not answer (HTTP ${out.status}).` }
    }
  }
}
