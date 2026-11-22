import { canonicalModel } from '@zumibot/shared/pricing'
import {
  tokensWithoutCacheReads,
  workflowIdOf,
  type ModelSpend,
  type TokenCounts,
  type UsageDay,
  type UsageQuery,
  type UsageRecord,
  type UsageRow,
  type UsageSummary
} from '@zumibot/shared/usageReport'
import type { EstimateBucket } from './estimates'

export interface SummaryInput {
  records: readonly UsageRecord[]
  estimates: readonly EstimateBucket[]
  chats: ReadonlyMap<string, { title: string }> // chats that still exist
  workflowNames?: ReadonlyMap<string, string> // workflow id -> name, for the rows a workflow's own calls make
  estimating: boolean
  agentLabel(agent: string): string // display name; MODERATOR_AGENT -> 'Room moderator'
}

interface Part {
  chatId: string
  agent: string
  at: number
  model: string
  spend: ModelSpend
  estimated: boolean
}

// A bad zone from the client must not break the page; UTC is the neutral fallback
function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  const opts = { year: 'numeric', month: '2-digit', day: '2-digit' } as const
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, ...opts })
  } catch {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', ...opts })
  }
}

const inRange = (at: number, q: UsageQuery): boolean => (q.from === null || at >= q.from) && (q.to === null || at < q.to)

export function summarize(input: SummaryInput, q: UsageQuery): UsageSummary {
  const parts: Part[] = []
  for (const r of input.records) {
    if (r.kind !== 'cost' || !inRange(r.at, q)) continue
    if ((q.chatId && r.chatId !== q.chatId) || (q.agent && r.agent !== q.agent)) continue
    for (const [model, spend] of Object.entries(r.models))
      parts.push({ chatId: r.chatId, agent: r.agent, at: r.at, model, spend, estimated: false })
  }
  for (const b of input.estimates) {
    if (!inRange(b.hour, q)) continue
    if ((q.chatId && b.chatId !== q.chatId) || (q.agent && b.agent !== q.agent)) continue
    parts.push({ chatId: b.chatId, agent: b.agent, at: b.hour, model: b.model, spend: b.spend, estimated: true })
  }

  const fmt = dayFormatter(q.timeZone)
  const tokens: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const rows = {
    model: new Map<string, UsageRow>(),
    agent: new Map<string, UsageRow>(),
    chat: new Map<string, UsageRow>(),
    day: new Map<string, UsageRow>()
  }
  const days = new Map<string, UsageDay>()
  const spentChats = new Set<string>()
  let exactUsd = 0,
    estimatedUsd = 0,
    exactTokens = 0,
    estimatedTokens = 0,
    unpricedTokens = 0

  const add = (map: Map<string, UsageRow>, key: string, label: string, p: Part, usd: number, tok: number, unpriced: boolean): void => {
    let row = map.get(key)
    if (!row) map.set(key, (row = { key, label, costUsd: 0, tokens: 0, estimated: false, unpriced: false }))
    row.costUsd += usd
    row.tokens += tok
    row.estimated ||= p.estimated
    row.unpriced ||= unpriced
  }

  for (const p of parts) {
    const s = p.spend
    const usd = s.costUsd ?? 0 // null = unpriced: no dollars, tokens still counted
    const tok = tokensWithoutCacheReads(s)
    const unpriced = s.costUsd === null
    tokens.input += s.input
    tokens.output += s.output
    tokens.cacheRead += s.cacheRead
    tokens.cacheWrite += s.cacheWrite
    if (unpriced) unpricedTokens += tok
    spentChats.add(p.chatId)

    const day = fmt.format(new Date(p.at))
    let d = days.get(day)
    if (!d) days.set(day, (d = { day, exactUsd: 0, estimatedUsd: 0, exactTokens: 0, estimatedTokens: 0 }))
    if (p.estimated) {
      estimatedUsd += usd
      estimatedTokens += tok
      d.estimatedUsd += usd
      d.estimatedTokens += tok
    } else {
      exactUsd += usd
      exactTokens += tok
      d.exactUsd += usd
      d.exactTokens += tok
    }

    const chat = input.chats.get(p.chatId)
    const wf = workflowIdOf(p.chatId)
    const chatLabel =
      wf !== null
        ? input.workflowNames?.has(wf)
          ? `Workflow: ${input.workflowNames.get(wf)}`
          : 'Workflow (deleted)'
        : chat
          ? chat.title || 'Untitled chat'
          : 'Deleted chat'
    add(rows.model, canonicalModel(p.model), canonicalModel(p.model), p, usd, tok, unpriced)
    add(rows.agent, p.agent, input.agentLabel(p.agent), p, usd, tok, unpriced)
    add(rows.chat, p.chatId, chatLabel, p, usd, tok, unpriced)
    add(rows.day, day, day, p, usd, tok, unpriced)
  }

  let userMessages = 0
  for (const r of input.records) {
    if (r.kind !== 'msg' || !inRange(r.at, q)) continue
    if (q.chatId && r.chatId !== q.chatId) continue
    if (q.agent && !spentChats.has(r.chatId)) continue
    userMessages++
  }

  const byCost = (m: Map<string, UsageRow>): UsageRow[] => [...m.values()].sort((a, b) => b.costUsd - a.costUsd)
  return {
    costUsd: exactUsd + estimatedUsd,
    exactUsd,
    estimatedUsd,
    tokens,
    exactTokens,
    estimatedTokens,
    unpricedTokens,
    chats: spentChats.size,
    userMessages,
    days: [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
    byModel: byCost(rows.model),
    byAgent: byCost(rows.agent),
    byChat: byCost(rows.chat),
    byDay: [...rows.day.values()].sort((a, b) => (a.key < b.key ? 1 : -1)),
    estimating: input.estimating
  }
}
