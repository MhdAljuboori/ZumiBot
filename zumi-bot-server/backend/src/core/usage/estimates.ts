import { canonicalModel } from '@zumibot/shared/pricing'
import type { CostRecord, ModelSpend } from '@zumibot/shared/usageReport'
import type { LogMessage } from './sessionLogs'

export interface SessionOwner {
  sessionId: string
  chatId: string
  agent: string
  chatCreatedAt: number
}
export interface EstimateBucket {
  chatId: string
  agent: string
  hour: number
  model: string
  spend: ModelSpend
} // hour = start of the UTC hour, ms

const HOUR = 3_600_000

/** Pure: logged messages no exact record covers, each counted once, bucketed by chat, agent, hour and model. */
export function estimate(
  owners: readonly SessionOwner[],
  logs: ReadonlyMap<string, readonly LogMessage[]>,
  exact: readonly CostRecord[]
): EstimateBucket[] {
  // Ids, not times: a forked session repeats the same message ids in its own file
  const covered = new Set<string>()
  for (const r of exact) {
    if (!r.sessionId || !r.window) continue
    const [a, b] = r.window
    for (const m of logs.get(r.sessionId) ?? []) if (m.at >= a && m.at <= b) covered.add(m.id)
  }
  // Oldest chat first, so a forked copy of history lands on the chat that made it; input order must not matter
  const ordered = [...owners].sort((x, y) => x.chatCreatedAt - y.chatCreatedAt || (x.chatId < y.chatId ? -1 : x.chatId > y.chatId ? 1 : 0))
  const seen = new Set<string>()
  const buckets = new Map<string, EstimateBucket>()
  for (const o of ordered) {
    for (const m of logs.get(o.sessionId) ?? []) {
      if (covered.has(m.id) || seen.has(m.id)) continue
      seen.add(m.id)
      const hour = Math.floor(m.at / HOUR) * HOUR
      const model = canonicalModel(m.model)
      const key = JSON.stringify([o.chatId, o.agent, hour, model])
      let b = buckets.get(key)
      if (!b)
        buckets.set(
          key,
          (b = { chatId: o.chatId, agent: o.agent, hour, model, spend: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 } })
        )
      const s = b.spend
      s.input += m.tokens.input
      s.output += m.tokens.output
      s.cacheRead += m.tokens.cacheRead
      s.cacheWrite += m.tokens.cacheWrite5m + m.tokens.cacheWrite1h
      // One unpriced message makes the whole bucket unpriced; its tokens still count
      s.costUsd = s.costUsd === null || m.costUsd === null ? null : s.costUsd + m.costUsd
    }
  }
  return [...buckets.values()]
}
