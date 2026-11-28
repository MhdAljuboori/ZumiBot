// Turn X-ray's pure rules: the rows the timeline draws, where each bar sits, and the words and numbers on them
// (docs/architecture/turn-xray.md). The panel itself only lays these out.

import type { TokenCounts } from '@zumibot/shared/usageReport'
import type { TurnXray, XrayCall, XrayGap, XrayOutcome, XrayRun, XrayStep } from '@zumibot/shared/xray'
import { formatTokens, formatUsd } from './usageReport'

export type XrayRow =
  | { kind: 'step'; key: string; depth: number; step: XrayStep }
  | { kind: 'call'; key: string; depth: number; call: XrayCall; folded: boolean }

/**
 * The timeline as rows, oldest first: each model request, then the calls it asked for one level in. A subagent's own
 * requests and calls sit under its Agent call, shown only while that call is in `open` (they start folded). A step with no
 * logged request draws only its calls.
 */
export function xrayRows(run: XrayRun, open: ReadonlySet<string>, depth = 0): XrayRow[] {
  const rows: XrayRow[] = []
  for (const [i, step] of run.steps.entries()) {
    const inner = step.id === null ? depth : depth + 1
    if (step.id !== null) rows.push({ kind: 'step', key: `${depth}:${step.id}:${i}`, depth, step })
    for (const call of step.calls) {
      const folded = call.run !== null && !open.has(call.id)
      rows.push({ kind: 'call', key: `call:${call.id}`, depth: inner, call, folded })
      if (call.run && !folded) rows.push(...xrayRows(call.run, open, inner + 1))
    }
  }
  return rows
}

/** Where a span sits on the turn's time axis, in percent; a tiny span keeps a sliver so it can be seen. */
export function barOf(start: number, end: number, t0: number, t1: number): { left: number; width: number } {
  const total = Math.max(1, t1 - t0)
  const left = Math.min(100, Math.max(0, ((start - t0) / total) * 100))
  const right = Math.min(100, Math.max(left, ((end - t0) / total) * 100))
  return { left, width: Math.max(0.6, right - left) }
}

/** A call's bar: from its start to its result (now, while it runs), with its card's wait as the first part of it. */
export function callBars(
  c: XrayCall,
  t0: number,
  t1: number,
  now: number
): { run: { left: number; width: number }; wait: { left: number; width: number } | null } {
  const end = c.endedAt ?? (c.outcome === 'running' ? now : c.startedAt)
  const run = barOf(c.startedAt, end, t0, t1)
  // The card shows a moment after the call is announced; its answer time is all that is kept, so the wait is drawn from the start.
  const wait = c.waitMs !== null && c.waitMs > 0 ? barOf(c.startedAt, Math.min(end, c.startedAt + c.waitMs), t0, t1) : null
  return { run, wait }
}

/** `850 ms`, `4.2 s`, `38 s`, `3 min 5 s`, `1 h 2 min`. */
export function spanText(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0 ms'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
  const s = Math.round(ms / 1000)
  if (s < 3600) return s % 60 === 0 ? `${s / 60} min` : `${Math.floor(s / 60)} min ${s % 60} s`
  const m = Math.round(s / 60)
  return m % 60 === 0 ? `${m / 60} h` : `${Math.floor(m / 60)} h ${m % 60} min`
}

/** `claude-opus-5-5` → `Opus 5.5`; a name it can't read stays as it is. */
export function modelLabel(model: string | null): string {
  if (!model) return 'Model'
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(model.replace(/\[\d+m\]$/, ''))
  if (!m) return model
  const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1)
  return m[3] !== undefined && m[3].length <= 2 ? `${family} ${m[2]}.${m[3]}` : `${family} ${m[2]}`
}

/** The share of the prompt read from the cache, 0–100; null when nothing was sent. */
export function cacheShare(t: TokenCounts): number | null {
  const prompt = t.input + t.cacheRead + t.cacheWrite
  return prompt > 0 ? Math.round((t.cacheRead / prompt) * 100) : null
}

export const tokenTotal = (t: TokenCounts): number => t.input + t.output + t.cacheRead + t.cacheWrite

/** One request's price: requests often cost a cent or less, so under a dollar it keeps four decimals (`$0.0123`). */
export function fineUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0'
  if (n >= 1) return formatUsd(n)
  return n < 0.00005 ? '<$0.0001' : `$${n.toFixed(4)}`
}

/** A request's line: `12.4K in · 380 out · 92% cache · $0.0312`; the price is left out for an unpriced model. */
export function stepLine(s: XrayStep): string {
  if (!s.tokens) return ''
  const t = s.tokens
  const parts = [`${formatTokens(t.input + t.cacheRead + t.cacheWrite)} in`, `${formatTokens(t.output)} out`]
  const share = cacheShare(t)
  if (share !== null) parts.push(`${share}% cache`)
  if (s.costUsd !== null) parts.push(fineUsd(s.costUsd))
  return parts.join(' · ')
}

/** What a request did, in a few words. */
export function stepTitle(s: XrayStep): string {
  const n = s.calls.length
  if (n === 0) return s.wrote ? 'Wrote' : 'Request'
  const calls = `${n} ${n === 1 ? 'call' : 'calls'}`
  return s.wrote ? `Thought, ${calls}` : calls
}

/**
 * A call's row title as the tool, bold, and what it did. The summary already starts with the tool's name (`Read /a.ts`,
 * `Bash(npm test)`), so that part is not said twice; a subagent reads as its type and its task.
 */
export function callLabel(c: XrayCall): { tool: string; rest: string } {
  if (c.run) return { tool: c.run.type ?? 'Agent', rest: c.summary }
  if (!c.summary.startsWith(c.tool)) return { tool: c.tool, rest: c.summary }
  let rest = c.summary.slice(c.tool.length).trim()
  if (rest.startsWith('(') && rest.endsWith(')')) rest = rest.slice(1, -1).trim()
  return { tool: c.tool, rest }
}

export const OUTCOME_TEXT: Record<XrayOutcome, string> = {
  ok: 'Ran',
  error: 'Failed',
  blocked: 'Did not run',
  running: 'Running',
  cut: 'No result'
}

export const CARD_TEXT = { approval: 'approval', question: 'question', plan: 'plan' } as const

/** The wait chip: `Waited 6.0 s for your approval`; null when no card waited, `wait unknown` when its time was not kept. */
export function waitText(c: XrayCall): string | null {
  if (c.card === null) return null
  const what = CARD_TEXT[c.card]
  if (c.waitUnknown || c.waitMs === null) return `Your ${what} · wait unknown`
  return c.outcome === 'running' && c.cardStatus === 'pending'
    ? `Waiting ${spanText(c.waitMs)} for your ${what}`
    : `Waited ${spanText(c.waitMs)} for your ${what}`
}

/** The header's cost: the run's exact cost when its result said it, else the priced requests' sum, marked as an estimate. */
export function costText(x: TurnXray): { text: string; exact: boolean } {
  if (x.totals.exactUsd !== null) return { text: formatUsd(x.totals.exactUsd), exact: true }
  if (x.totals.requests === 0) return { text: '–', exact: false }
  return { text: `≈ ${formatUsd(x.totals.stepUsd)}`, exact: false }
}

/** The wall clock split three ways, each a share of the turn (percent, summing to 100 when the turn took any time). */
export function splitOf(x: TurnXray): { model: number; tools: number; wait: number } {
  const d = x.totals.durationMs
  if (d <= 0) return { model: 0, tools: 0, wait: 0 }
  const model = (x.totals.modelMs / d) * 100
  const wait = (x.totals.waitMs / d) * 100
  return { model, wait, tools: Math.max(0, 100 - model - wait) }
}

export function countsLine(x: TurnXray): string {
  const t = x.totals
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`
  const parts = [n(t.requests, 'request', 'requests'), n(t.calls, 'tool call', 'tool calls')]
  if (t.subagents > 0) parts.push(n(t.subagents, 'subagent', 'subagents'))
  if (t.cards > 0) parts.push(n(t.cards, 'card', 'cards'))
  return parts.join(' · ')
}

export const GAP_TEXT: Record<XrayGap, string> = {
  noLog: "No session log was found for this reply, so its model requests and their tokens aren't shown. Codex, ACP and remote agents keep none here.",
  waitUnknown: 'Some cards were answered before ZumiBot kept answer times, so their wait is unknown.',
  noAudit: "Some calls have no audit record (the audit log's size cap dropped it, or the reply ran on another machine), so who allowed them isn't shown."
}
