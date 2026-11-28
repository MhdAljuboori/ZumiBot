import type { AuditRecord } from '@zumibot/shared/audit'
import { DISPATCH_TOOLS, type DispatchEntry, type DispatchStep } from '@zumibot/shared/dispatch'
import type { Engine } from '@zumibot/shared/engine'
import { PLAN_TOOL } from '@zumibot/shared/plans'
import { QUESTION_TOOL } from '@zumibot/shared/questions'
import { toolSummary } from '@zumibot/shared/toolSummary'
import type { ChatItem } from '@zumibot/shared/types'
import type { CostRecord, TokenCounts } from '@zumibot/shared/usageReport'
import {
  XRAY_LOG_SLACK_MS,
  type TurnXray,
  type XrayCall,
  type XrayCard,
  type XrayGap,
  type XrayOutcome,
  type XrayRun,
  type XrayStep,
  type XrayTotals
} from '@zumibot/shared/xray'
import type { LogRequest } from './xrayLogs'

type ToolItem = Extract<ChatItem, { type: 'tool' }>
type CardItem = Extract<ChatItem, { type: 'approval' }>
type ToolStep = Extract<DispatchStep, { kind: 'tool' }>

export interface XrayInput {
  chatId: string
  itemId: string
  agent: string
  engine: Engine
  items: readonly ChatItem[] // the turn's own items, in order
  turnStart: number | null // when its user message was sent, when the turn follows one
  entries: readonly DispatchEntry[] // the chat's dispatch entries (only this turn's are used)
  audit: readonly AuditRecord[] | null // the chat's records around the turn; null: no audit log here
  costs: readonly CostRecord[] // the turn's own run costs
  main: readonly LogRequest[] | null // the agent's session log around the turn; null: none found
  subagents: readonly { toolUseId: string | null; requests: readonly LogRequest[] }[]
  running: boolean
  now: number
}

// Cards Auto mode, a chat rule, an agent rule or a step rule let through as they were made: nothing waited on the user.
const AUTO_STATUSES = new Set(['auto-allowed', 'auto-allowed-agent', 'auto-allowed-workflow'])
const BLOCKED_STATUSES = new Set(['denied', 'skipped', 'sent-back', 'unanswered'])

const zero = (): TokenCounts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
const countsOf = (r: LogRequest): TokenCounts => ({
  input: r.tokens.input,
  output: r.tokens.output,
  cacheRead: r.tokens.cacheRead,
  cacheWrite: r.tokens.cacheWrite5m + r.tokens.cacheWrite1h
})
const cardKind = (tool: string): XrayCard => (tool === QUESTION_TOOL ? 'question' : tool === PLAN_TOOL ? 'plan' : 'approval')

/** How long a card waited, and whether that is known: a card closed before answer times were kept has none. */
function waitOf(card: CardItem, running: boolean, now: number): { waitMs: number | null; waitUnknown: boolean } {
  if (card.answeredTs !== undefined) return { waitMs: Math.max(0, card.answeredTs - card.ts), waitUnknown: false }
  if (card.status === 'pending') return { waitMs: running ? Math.max(0, now - card.ts) : null, waitUnknown: !running }
  return { waitMs: null, waitUnknown: true }
}

/** Total time covered by the intervals (overlaps counted once). */
export function unionMs(spans: readonly [number, number][]): number {
  const sorted = [...spans].filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])
  let total = 0
  let curA = -Infinity
  let curB = -Infinity
  for (const [a, b] of sorted) {
    if (a > curB) {
      if (curB > curA) total += curB - curA
      curA = a
      curB = b
    } else curB = Math.max(curB, b)
  }
  if (curB > curA) total += curB - curA
  return total
}

const isDeniedDecision = (r: AuditRecord | undefined): boolean => r !== undefined && (r.decision.kind.startsWith('denied') || r.outcome === 'denied')

/**
 * Groups calls under the logged requests that asked for them, oldest first. Each request starts when the one before it
 * could hand back (its own end, or its calls' latest result), the first at the run's start. Calls no request names go into a
 * request-less step at their own time. Without a log, every call goes into one such step.
 */
export function stepsOf(runStart: number, requests: readonly LogRequest[] | null, calls: XrayCall[]): XrayStep[] {
  if (requests === null || requests.length === 0) {
    if (calls.length === 0) return []
    const ends = calls.map((c) => c.endedAt ?? c.startedAt)
    return [
      {
        id: null,
        model: null,
        startedAt: Math.min(...calls.map((c) => c.startedAt)),
        endedAt: Math.max(...ends),
        tokens: null,
        costUsd: null,
        wrote: false,
        calls
      }
    ]
  }
  const byId = new Map(calls.map((c) => [c.id, c]))
  const used = new Set<string>()
  const steps: XrayStep[] = []
  let boundary = runStart
  for (const r of requests) {
    const own = r.toolIds.flatMap((id) => {
      const c = byId.get(id)
      if (!c || used.has(id)) return []
      used.add(id)
      return [c]
    })
    const startedAt = Math.min(Math.max(boundary, runStart), r.endedAt)
    steps.push({
      id: r.id,
      model: r.model,
      startedAt,
      endedAt: r.endedAt,
      tokens: countsOf(r),
      costUsd: r.costUsd,
      wrote: r.wrote,
      calls: own
    })
    boundary = Math.max(r.endedAt, ...own.map((c) => c.endedAt ?? c.startedAt))
  }
  const loose = calls.filter((c) => !used.has(c.id))
  for (const c of loose) {
    steps.push({ id: null, model: null, startedAt: c.startedAt, endedAt: c.endedAt ?? c.startedAt, tokens: null, costUsd: null, wrote: false, calls: [c] })
  }
  return steps.sort((a, b) => a.startedAt - b.startedAt)
}

/** Every step and call of a run, its subagents' included. */
function* walk(run: XrayRun): Generator<{ step: XrayStep; depth: number }> {
  for (const step of run.steps) {
    yield { step, depth: 0 }
    for (const c of step.calls) if (c.run) for (const inner of walk(c.run)) yield { ...inner, depth: inner.depth + 1 }
  }
}

/** The turn's window: the run's spawn (its cost record), else its message, else its first item; to its result or last item. */
function windowOf(x: XrayInput): { start: number; end: number | null } {
  const spawned = x.costs.flatMap((c) => (c.window ? [c.window[0]] : []))
  const first = x.items.length > 0 ? Math.min(...x.items.map((i) => i.ts)) : x.now
  const start = spawned.length > 0 ? Math.min(...spawned) : (x.turnStart ?? first)
  if (x.running) return { start, end: null }
  const lasts = x.items.map((i) =>
    Math.max(i.ts, 'doneTs' in i && typeof i.doneTs === 'number' ? i.doneTs : 0, i.type === 'approval' ? (i.answeredTs ?? 0) : 0)
  )
  const results = x.costs.flatMap((c) => (c.window ? [c.window[1]] : []))
  const end = Math.max(start, ...lasts, ...results)
  return { start, end }
}

export function buildXray(x: XrayInput): TurnXray {
  const { start, end } = windowOf(x)
  const until = end ?? x.now
  const cards = new Map<string, CardItem>()
  const looseCards: CardItem[] = []
  for (const i of x.items) {
    if (i.type !== 'approval') continue
    if (i.toolUseId) cards.set(i.toolUseId, i)
    else looseCards.push(i)
  }
  const audit = x.audit ?? []
  const mainAudit = new Map(audit.filter((r) => r.parentToolUseId === null && r.itemId !== null).map((r) => [r.itemId!, r]))
  const entries = new Map(x.entries.map((e) => [e.id, e]))
  const subLogs = x.subagents

  const cardFields = (id: string) => {
    const card = cards.get(id)
    if (!card || AUTO_STATUSES.has(card.status)) return { card: null, cardStatus: card?.status ?? null, waitMs: null, waitUnknown: false }
    return { card: cardKind(card.toolName), cardStatus: card.status, ...waitOf(card, x.running, x.now) }
  }

  // A subagent's audit records, matched to its tool steps by tool name in announce order (they carry no tool use id).
  const subAudit = (entryId: string): ((tool: string) => AuditRecord | undefined) => {
    const queues = new Map<string, AuditRecord[]>()
    for (const r of audit.filter((a) => a.parentToolUseId === entryId).sort((a, b) => a.ts - b.ts)) {
      const q = queues.get(r.tool) ?? []
      q.push(r)
      queues.set(r.tool, q)
    }
    return (tool) => queues.get(tool)?.shift()
  }

  const logFor = (e: DispatchEntry): readonly LogRequest[] | null => {
    const byMeta = subLogs.find((s) => s.toolUseId === e.id)
    if (byMeta) return byMeta.requests
    const ids = new Set(e.steps.flatMap((s) => (s.kind === 'tool' || s.kind === 'agent' ? [s.id] : [])))
    const byTools = subLogs.find((s) => s.toolUseId === null && s.requests.some((r) => r.toolIds.some((id) => ids.has(id))))
    return byTools ? byTools.requests : null
  }

  const seen = new Set<string>() // a broken file could make an entry its own ancestor
  const entryRun = (e: DispatchEntry): XrayRun => {
    seen.add(e.id)
    const auditOf = subAudit(e.id)
    const calls: XrayCall[] = []
    for (const s of e.steps) {
      if (s.kind === 'tool') calls.push(subCall(s, e, auditOf(s.name)))
      else if (s.kind === 'agent') {
        const child = entries.get(s.id)
        calls.push(agentCall(s.id, child, s.ts, auditOf('Agent') ?? auditOf('Task')))
      }
    }
    return {
      name: e.description || 'Agent',
      type: e.subagentType,
      startedAt: e.startedAt,
      endedAt: e.endedAt,
      status: e.status,
      steps: stepsOf(e.startedAt, logFor(e), calls)
    }
  }

  const agentCall = (id: string, child: DispatchEntry | undefined, ts: number, rec: AuditRecord | undefined): XrayCall => {
    const run = child && !seen.has(child.id) ? entryRun(child) : null
    const outcome: XrayOutcome = !child
      ? x.running
        ? 'running'
        : 'cut'
      : child.status === 'running'
        ? 'running'
        : child.status === 'done'
          ? 'ok'
          : child.status === 'failed'
            ? 'error'
            : 'cut'
    return {
      id,
      tool: 'Agent',
      summary: child?.description || 'Agent',
      startedAt: child?.startedAt ?? ts,
      endedAt: child?.endedAt ?? null,
      ...cardFields(id),
      decision: rec?.decision ?? null,
      outcome: isDeniedDecision(rec) ? 'blocked' : outcome,
      run
    }
  }

  const subCall = (s: ToolStep, e: DispatchEntry, rec: AuditRecord | undefined): XrayCall => {
    const open = s.result === null && s.doneTs === undefined
    const outcome: XrayOutcome = isDeniedDecision(rec)
      ? 'blocked'
      : open
        ? e.status === 'running'
          ? 'running'
          : 'cut'
        : s.isError
          ? 'error'
          : 'ok'
    return {
      id: s.id,
      tool: s.name,
      summary: toolSummary(s.name, s.input),
      startedAt: s.ts,
      endedAt: s.doneTs ?? (open ? null : s.ts),
      ...cardFields(s.id),
      decision: rec?.decision ?? null,
      outcome,
      run: null
    }
  }

  const mainCall = (t: ToolItem): XrayCall => {
    const rec = mainAudit.get(t.id)
    const child = DISPATCH_TOOLS.has(t.name) ? entries.get(t.id) : undefined
    if (child) {
      const call = agentCall(t.id, child, t.ts, rec)
      return { ...call, startedAt: t.ts, endedAt: child.endedAt ?? t.doneTs ?? null }
    }
    const card = cards.get(t.id)
    const open = t.result === null && t.doneTs === undefined
    const outcome: XrayOutcome =
      t.blocked || isDeniedDecision(rec) || (card !== undefined && BLOCKED_STATUSES.has(card.status))
        ? 'blocked'
        : open
          ? x.running
            ? 'running'
            : 'cut'
          : t.isError
            ? 'error'
            : 'ok'
    return {
      id: t.id,
      tool: t.name,
      summary: toolSummary(t.name, t.input),
      startedAt: t.ts,
      endedAt: t.doneTs ?? (open ? null : t.ts),
      ...cardFields(t.id),
      decision: rec?.decision ?? null,
      outcome,
      run: null
    }
  }

  const tools = x.items.filter((i): i is ToolItem => i.type === 'tool')
  const calls = tools.map(mainCall)
  const callIds = new Set(calls.map((c) => c.id))
  // The agent's requests in the turn: logged inside its window, or naming one of its calls (a clock a little off).
  const lo = start - XRAY_LOG_SLACK_MS
  const hi = until + XRAY_LOG_SLACK_MS
  const requests = x.main?.filter((r) => (r.endedAt >= lo && r.startedAt <= hi) || r.toolIds.some((id) => callIds.has(id))) ?? null

  const last = [...x.items].reverse().find((i) => i.type === 'error' || (i.type === 'notice' && (i.kind === 'stopped' || i.kind === 'interrupted')))
  const run: XrayRun = {
    name: x.agent,
    type: null,
    startedAt: start,
    endedAt: end,
    status: x.running ? 'running' : last?.type === 'error' ? 'failed' : last?.type === 'notice' ? (last.kind === 'stopped' ? 'stopped' : 'interrupted') : 'done',
    steps: stepsOf(start, requests, calls)
  }

  // Totals over every level; the time split over the agent's own wall clock.
  const all = [...walk(run)]
  const tokens = zero()
  let stepUsd = 0
  let unpriced = false
  let requestCount = 0
  for (const { step } of all) {
    if (step.id !== null) requestCount++
    if (step.tokens) {
      tokens.input += step.tokens.input
      tokens.output += step.tokens.output
      tokens.cacheRead += step.tokens.cacheRead
      tokens.cacheWrite += step.tokens.cacheWrite
      if (step.costUsd === null) unpriced = true
      else stepUsd += step.costUsd
    }
  }
  const everyCall = all.flatMap(({ step }) => step.calls)
  const waits: [number, number][] = []
  for (const c of [...cards.values(), ...looseCards]) {
    if (AUTO_STATUSES.has(c.status)) continue
    const w = waitOf(c, x.running, x.now)
    if (w.waitMs !== null) waits.push([c.ts, c.ts + w.waitMs])
  }
  const durationMs = Math.max(0, until - start)
  const modelMs = run.steps.reduce((sum, s) => sum + (s.id === null ? 0 : Math.max(0, s.endedAt - s.startedAt)), 0)
  const waitMs = unionMs(waits)
  const priced = x.costs.flatMap((c) => Object.values(c.models).flatMap((m) => (m.costUsd === null ? [] : [m.costUsd])))
  const totals: XrayTotals = {
    durationMs,
    modelMs,
    waitMs,
    toolMs: Math.max(0, durationMs - modelMs - waitMs),
    tokens,
    stepUsd,
    unpriced,
    exactUsd: priced.length > 0 ? priced.reduce((a, b) => a + b, 0) : null,
    requests: requestCount,
    calls: everyCall.length,
    subagents: everyCall.filter((c) => c.run !== null).length,
    cards: everyCall.filter((c) => c.card !== null).length + looseCards.filter((c) => !AUTO_STATUSES.has(c.status)).length
  }

  const gaps: XrayGap[] = []
  if (requests === null || (requests.length === 0 && x.items.length > 0)) gaps.push('noLog')
  if (everyCall.some((c) => c.waitUnknown)) gaps.push('waitUnknown')
  if (!x.running && everyCall.some((c) => c.decision === null && c.outcome !== 'running')) gaps.push('noAudit')

  return {
    chatId: x.chatId,
    itemId: x.itemId,
    agent: x.agent,
    engine: x.engine,
    startedAt: start,
    endedAt: end,
    running: x.running,
    run,
    totals,
    gaps
  }
}
