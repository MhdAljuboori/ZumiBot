// Wire and storage shapes for the Usage page and the per-chat cost chip.
export const MODERATOR_AGENT = '#moderator' // reserved agent name on records; shown as "Room moderator"
export const SUMMARY_AGENT = '#handoff' // reserved agent name on records; shown as "Room handoff"
export const WORKFLOW_AGENT = '#workflow' // reserved agent name on a workflow's LLM and Condition calls; shown as "Workflow step"
/** The chat id a workflow's own calls are recorded under: they have no chat, and Usage shows them by workflow. */
export const workflowUsageKey = (workflowId: string): string => `workflow:${workflowId}`
/** The workflow id inside a `workflowUsageKey`, or null for a real chat id. */
export const workflowIdOf = (chatId: string): string | null => (chatId.startsWith('workflow:') ? chatId.slice('workflow:'.length) : null)
export const KEEP_WARM_AGENT = '#keepwarm' // reserved agent name on records; shown as "Keep warm"

export interface TokenCounts {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}
export interface ModelSpend extends TokenCounts {
  costUsd: number | null
}
export type ModelSpends = Record<string, ModelSpend>

export interface CostRecord {
  kind: 'cost'
  id: string
  chatId: string
  agent: string
  at: number
  sessionId: string | null
  window: [number, number] | null
  models: ModelSpends
  v?: 2 // 2 = the run's own cost; absent on a session run = the session's totals so far (see wholeSessionCost)
}
export interface MessageRecord {
  kind: 'msg'
  id: string
  chatId: string
  at: number
}
// Which chat a Claude session belongs to, kept so a deleted chat's estimated history stays counted after a restart.
export interface OwnerRecord {
  kind: 'owner'
  id: string
  chatId: string
  sessionId: string
  agent: string
  at: number
} // at = the chat's creation time
export type UsageRecord = CostRecord | MessageRecord | OwnerRecord

/**
 * A resumed CLI reports the session's cost so far, not the run's, and records written before v2 stored that as the run's
 * cost (a long chat counted each turn's history again). Such a record is left out, and the session's log is estimated instead.
 */
export const wholeSessionCost = (r: CostRecord): boolean => r.sessionId !== null && r.v !== 2

export interface UsageQuery {
  from: number | null
  to: number | null
  agent: string | null
  chatId: string | null
  timeZone: string
}
export interface UsageRow {
  key: string
  label: string
  costUsd: number
  tokens: number
  estimated: boolean
  unpriced: boolean
}
export interface UsageDay {
  day: string
  exactUsd: number
  estimatedUsd: number
  exactTokens: number
  estimatedTokens: number
} // day = 'YYYY-MM-DD'
export interface UsageSummary {
  costUsd: number
  exactUsd: number
  estimatedUsd: number
  tokens: TokenCounts // exact + estimated
  exactTokens: number
  estimatedTokens: number // without cache reads
  unpricedTokens: number
  chats: number
  userMessages: number
  days: UsageDay[] // days with data, ascending
  byModel: UsageRow[]
  byAgent: UsageRow[]
  byChat: UsageRow[]
  byDay: UsageRow[] // cost descending; byDay newest first
  estimating: boolean // the first estimate pass has not finished
}

export const tokensWithoutCacheReads = (t: TokenCounts): number => t.input + t.cacheWrite + t.output
