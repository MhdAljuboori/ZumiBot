import {
  tokensWithoutCacheReads,
  workflowIdOf,
  type UsageDay,
  type UsageQuery,
  type UsageRow,
  type UsageSummary
} from '@zumibot/shared/usageReport'

export type UsageRange = 7 | 30 | 90 | 'all'
export type UsageMetric = 'cost' | 'tokens'
export type UsageTab = 'model' | 'agent' | 'chat' | 'day'

const DAY_MS = 86_400_000

/** Zone offset (ms east of UTC) at an instant, read back through Intl: no date library. */
function offsetAt(ms: number, timeZone: string): number {
  const p: Record<string, number> = {}
  for (const x of new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric'
  }).formatToParts(new Date(ms)))
    if (x.type !== 'literal') p[x.type] = Number(x.value)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000
}

/** Local midnight (as UTC ms) of the zone's calendar day `back` days before `now`. */
function localMidnight(now: number, timeZone: string, back: number): number {
  const local = new Date(now + offsetAt(now, timeZone))
  const wall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - back)
  // Offset can differ at midnight from now's (DST), so settle it with a second pass.
  let guess = wall - offsetAt(wall, timeZone)
  guess = wall - offsetAt(guess, timeZone)
  return guess
}

/** An unknown zone name would make Intl throw, so use UTC instead. */
function validZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return timeZone
  } catch {
    return 'UTC'
  }
}

export function rangeQuery(range: UsageRange, now: number, timeZone: string, agent: string | null, chatId: string | null): UsageQuery {
  const zone = validZone(timeZone)
  const from = range === 'all' ? null : localMidnight(now, zone, range - 1)
  return { from, to: null, agent, chatId, timeZone: zone }
}

export function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0.00' // NaN, Infinity and negatives never reach the page as odd text
  // Judge "under a cent" on the rounded value, so 0.00999 reads $0.01, not $0.0100.
  const digits = n.toFixed(2) === '0.00' ? 4 : 2
  if (digits === 4 && n.toFixed(4) === '0.0000') return '<$0.0001' // positive, but not even a hundredth of a cent
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0'
  if (n < 1000) return String(Math.round(n))
  // Round first, then pick the unit, so 999_999 is 1.00M and never 1000.00K.
  const k = (n / 1000).toFixed(2)
  if (k !== '1000.00' && n < 1e6) return k + 'K'
  const m = (n / 1e6).toFixed(2)
  if (m !== '1000.00' && n < 1e9) return m + 'M'
  return (n / 1e9).toFixed(2) + 'B'
}

const value = (r: UsageRow, metric: UsageMetric): number => (metric === 'cost' ? r.costUsd : r.tokens)

export function sortRows(rows: readonly UsageRow[], metric: UsageMetric): UsageRow[] {
  return [...rows].sort((a, b) => value(b, metric) - value(a, metric) || a.label.localeCompare(b.label))
}

export function share(row: UsageRow, rows: readonly UsageRow[], metric: UsageMetric): string {
  const total = rows.reduce((s, r) => s + value(r, metric), 0)
  return (total > 0 ? (value(row, metric) / total) * 100 : 0).toFixed(1) + '%'
}

export interface Bar {
  day: string
  exact: number
  estimated: number
  exactHeight: number
  estimatedHeight: number
} // heights 0..1 of the tallest day

const dayMs = (d: string): number => Date.parse(d + 'T00:00:00Z')

export function chartBars(days: readonly UsageDay[], metric: UsageMetric, firstDay: string | null, lastDay: string): Bar[] {
  const start = firstDay ?? days[0]?.day
  if (!start) return []
  const byDay = new Map(days.map((d) => [d.day, d]))
  const bars: Bar[] = []
  for (let t = dayMs(start); t <= dayMs(lastDay); t += DAY_MS) {
    const day = new Date(t).toISOString().slice(0, 10)
    const d = byDay.get(day)
    const exact = d ? (metric === 'cost' ? d.exactUsd : d.exactTokens) : 0
    const estimated = d ? (metric === 'cost' ? d.estimatedUsd : d.estimatedTokens) : 0
    bars.push({ day, exact, estimated, exactHeight: 0, estimatedHeight: 0 })
  }
  const max = Math.max(0, ...bars.map((b) => b.exact + b.estimated))
  if (max > 0)
    for (const b of bars) {
      b.exactHeight = b.exact / max
      b.estimatedHeight = b.estimated / max
    }
  return bars
}

export const metricValue = value

/** The zone's calendar day ('YYYY-MM-DD') at an instant, for the chart's first and last bars. */
export function localDay(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: validZone(timeZone), year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(ms)
  )
}

export interface SourceSplit {
  exact: number
  estimated: number
  total: number
  exactPct: string
  estimatedPct: string
}

/** The hero's exact / estimated split on the chosen metric (tokens: without cache reads). */
export function sourceSplit(
  s: Pick<UsageSummary, 'exactUsd' | 'estimatedUsd' | 'exactTokens' | 'estimatedTokens'>,
  metric: UsageMetric
): SourceSplit {
  const exact = metric === 'cost' ? s.exactUsd : s.exactTokens
  const estimated = metric === 'cost' ? s.estimatedUsd : s.estimatedTokens
  const total = exact + estimated
  const pct = (n: number): string => (total > 0 ? (n / total) * 100 : 0).toFixed(1) + '%'
  return { exact, estimated, total, exactPct: pct(exact), estimatedPct: pct(estimated) }
}

export const formatMetric = (n: number, metric: UsageMetric): string => (metric === 'cost' ? formatUsd(n) : formatTokens(n))

/** The eight totals boxes, in the order the page shows them. */
export function totalsBoxes(s: Pick<UsageSummary, 'tokens' | 'userMessages' | 'chats'>): { label: string; value: string }[] {
  const t = s.tokens
  const base = tokensWithoutCacheReads(t)
  return [
    { label: 'Tokens without cache reads', value: formatTokens(base) },
    { label: 'Processed with cache reads', value: formatTokens(base + t.cacheRead) },
    { label: 'Cached input', value: formatTokens(t.cacheRead) },
    { label: 'Uncached input', value: formatTokens(t.input) },
    { label: 'Cache creation', value: formatTokens(t.cacheWrite) },
    { label: 'Output', value: formatTokens(t.output) },
    { label: 'User messages', value: String(s.userMessages) },
    { label: 'Chats', value: String(s.chats) }
  ]
}

/** Rows of a breakdown tab: by the metric, except days, which stay newest first. */
export function tabRows(s: UsageSummary, tab: UsageTab, metric: UsageMetric): UsageRow[] {
  if (tab === 'day') return s.byDay
  return sortRows(tab === 'model' ? s.byModel : tab === 'agent' ? s.byAgent : s.byChat, metric)
}

/** A chat row opens its chat, unless the chat was deleted or the row is a workflow's own calls (no chat exists for it). */
export const chatRowOpens = (tab: UsageTab, row: UsageRow): boolean =>
  tab === 'chat' && row.label !== 'Deleted chat' && workflowIdOf(row.key) === null

/** A dollar cell: a model with no price shows a dash while it adds nothing, never a misleading $0.00. */
export const costLabel = (costUsd: number, unpriced: boolean): string => (unpriced && costUsd === 0 ? '–' : formatUsd(costUsd))

/** The chip's headline: a chat whose only usage is unpriced has no dollar total to show. */
export const chipTotalLabel = (s: Pick<UsageSummary, 'costUsd' | 'byModel'>): string =>
  s.costUsd === 0 && s.byModel.length > 0 && s.byModel.every((r) => r.unpriced) ? '–' : formatUsd(s.costUsd)
