import { spendCapBlocker } from '@zumibot/shared/capAgents'
import { engineCaps, type Engine, type EngineCaps } from '@zumibot/shared/engine'
import { capUsd, type AgentCapStatus } from '@zumibot/shared/spendCaps'
import type { AgentSummary } from '@zumibot/shared/types'

/** One agent's row in Settings › Usage › Spend caps. */
export interface CapRow {
  agent: string
  line: string // "$3.12 of $5.00 today"
  pct: number // 0 to 100, how far into the day's limit
  raised: string | null // "Raised from $5.00" once Allow more today moved the limit past the cap
  over: boolean
  action: string // the Allow more button's words
}

export function capRow(s: AgentCapStatus): CapRow {
  const pct = s.limitUsd > 0 ? Math.max(0, Math.min(100, (s.spentUsd / s.limitUsd) * 100)) : 100
  return {
    agent: s.agent,
    line: `${capUsd(s.spentUsd)} of ${capUsd(s.limitUsd)} today`,
    pct,
    raised: s.limitUsd > s.capUsd + 1e-9 ? `Raised from ${capUsd(s.capUsd)}` : null,
    over: s.over,
    action: `Allow ${capUsd(s.capUsd)} more today`
  }
}

/**
 * The fixed sentence for an agent whose daily cap can never trip (its engine reports no cost, so a hand edit or a sync left a cap
 * on it), shown in its Usage row in place of a live cap; null for an agent whose cap can hold.
 */
export const capBlockedOf = (agent: string, agents: readonly AgentSummary[], caps: (e: Engine) => EngineCaps = engineCaps): string | null =>
  spendCapBlocker({ agents: [agent], chats: [] }, agents, () => null, caps)
