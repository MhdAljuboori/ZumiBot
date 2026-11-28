// Turn X-ray: one reply's timeline, put together when asked from what the server already keeps: the chat's items (times,
// cards), the dispatch file (subagents), the audit log (who allowed each call), the usage records (the run's exact cost)
// and the CLI's session logs (each model request's tokens). Nothing new is stored but the cards' answer time.
// See docs/architecture/turn-xray.md.

import type { AuditDecision } from './audit'
import type { DispatchStatus } from './dispatch'
import type { Engine } from './engine'
import type { TokenCounts } from './usageReport'

/** What kind of card a call waited on: a permission card, a question card (AskUserQuestion) or a plan card (ExitPlanMode). */
export type XrayCard = 'approval' | 'question' | 'plan'

/** ok, error (it ran and failed), blocked (it never ran: denied or refused), running, cut (the turn ended before its result). */
export type XrayOutcome = 'ok' | 'error' | 'blocked' | 'running' | 'cut'

export interface XrayCall {
  id: string // the tool use id
  tool: string
  summary: string // one line on what it did (toolSummary)
  startedAt: number
  endedAt: number | null // null while it runs, or when it never got a result
  card: XrayCard | null
  cardStatus: string | null // the card's ApprovalStatus
  // How long its card waited on you. null: no card, or one closed before answer times were kept (`waitUnknown`).
  waitMs: number | null
  waitUnknown: boolean
  decision: AuditDecision | null // from the audit log; null when no record was found
  outcome: XrayOutcome
  run: XrayRun | null // the subagent an Agent/Task call started
}

/** One model request: what it cost, and the tool calls it asked for. */
export interface XrayStep {
  id: string | null // the API message id; null: calls no logged request could be matched to
  model: string | null
  startedAt: number
  endedAt: number
  tokens: TokenCounts | null // null: no session log line for it
  costUsd: number | null // priced from the table (shared/src/pricing.ts); null: unpriced or no tokens
  wrote: boolean // it wrote text or thinking, not only tool calls
  calls: XrayCall[]
}

/** The agent's own run, or a subagent's. */
export interface XrayRun {
  name: string
  type: string | null // a subagent's type
  startedAt: number
  endedAt: number | null
  status: DispatchStatus
  steps: XrayStep[]
}

export interface XrayTotals {
  durationMs: number
  modelMs: number // the agent's own requests (its subagents run inside its tool time)
  waitMs: number // wall clock with at least one card waiting on you
  toolMs: number // the rest: tools running, subagents included
  tokens: TokenCounts // every logged request, subagents included
  stepUsd: number // the priced requests' sum
  unpriced: boolean // some request's model is not in the price table
  exactUsd: number | null // what the run's `result` said it cost (usage records); null: none yet, or none kept
  requests: number
  calls: number
  subagents: number
  cards: number
}

/**
 * What the timeline could not show. noLog: no session log was found, so requests and tokens are missing (Codex, ACP and
 * remote agents keep none here). waitUnknown: a card closed before answer times were kept. noAudit: the audit log holds no
 * record for some calls (cleared by its cap, or a run on another machine).
 */
export type XrayGap = 'noLog' | 'waitUnknown' | 'noAudit'

export interface TurnXray {
  chatId: string
  itemId: string // the reply's message the X-ray was asked for
  agent: string
  engine: Engine
  startedAt: number
  endedAt: number | null // null while it runs
  running: boolean
  run: XrayRun
  totals: XrayTotals
  gaps: XrayGap[]
}

export const XRAY_LOG_SLACK_MS = 2_000 // a request logged this close outside the turn's window still counts as its own
