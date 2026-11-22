import { describe, expect, it } from 'vitest'
import type { UsageDay, UsageRow, UsageSummary } from '@zumibot/shared/usageReport'
import {
  chartBars,
  chipTotalLabel,
  costLabel,
  chatRowOpens,
  formatMetric,
  formatTokens,
  formatUsd,
  localDay,
  rangeQuery,
  share,
  sortRows,
  sourceSplit,
  tabRows,
  totalsBoxes
} from '../src/state/usageReport'

const row = (key: string, costUsd: number, tokens: number): UsageRow => ({
  key,
  label: key,
  costUsd,
  tokens,
  estimated: false,
  unpriced: false
})

describe('formatUsd', () => {
  it('formats money', () => {
    expect(formatUsd(1.59)).toBe('$1.59')
    expect(formatUsd(0.0012)).toBe('$0.0012')
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd(1234.5)).toBe('$1,234.50')
    expect(formatUsd(0.00999)).toBe('$0.01')
    expect(formatUsd(0.004)).toBe('$0.0040')
    expect(formatUsd(0.00001)).toBe('<$0.0001')
    expect(formatUsd(0.0001)).toBe('$0.0001')
  })
  it('returns $0.00 for NaN, Infinity and negatives', () => {
    expect(formatUsd(NaN)).toBe('$0.00')
    expect(formatUsd(Infinity)).toBe('$0.00')
    expect(formatUsd(-3)).toBe('$0.00')
  })
})

describe('formatTokens', () => {
  it('abbreviates', () => {
    expect(formatTokens(842)).toBe('842')
    expect(formatTokens(180_780)).toBe('180.78K')
    expect(formatTokens(48_200_000)).toBe('48.20M')
  })
  it('never shows four digits before a unit', () => {
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1000)).toBe('1.00K')
    expect(formatTokens(999_999)).toBe('1.00M')
    expect(formatTokens(1_000_000)).toBe('1.00M')
    expect(formatTokens(999_999_999)).toBe('1.00B')
    expect(formatTokens(NaN)).toBe('0')
  })
})

describe('rangeQuery', () => {
  const now = Date.parse('2026-10-31T10:00:00Z')
  it('starts at local midnight N-1 days earlier', () => {
    const q = rangeQuery(30, now, 'Asia/Baghdad', null, null)
    expect(q.from).toBe(Date.parse('2026-10-01T21:00:00Z'))
    expect(q.to).toBeNull()
    expect(q.timeZone).toBe('Asia/Baghdad')
  })
  it('handles a zone behind UTC and passes filters', () => {
    const q = rangeQuery(7, now, 'America/New_York', 'a', 'c')
    expect(q.from).toBe(Date.parse('2026-10-25T04:00:00Z'))
    expect(q.agent).toBe('a')
    expect(q.chatId).toBe('c')
  })
  it('falls back to UTC for an invalid zone', () => {
    const q = rangeQuery(1, now, 'Not/AZone', null, null)
    expect(q.timeZone).toBe('UTC')
    expect(q.from).toBe(Date.parse('2026-10-31T00:00:00Z'))
  })
  it('crosses a DST fall-back (London)', () => {
    expect(rangeQuery(7, now, 'Europe/London', null, null).from).toBe(Date.parse('2026-10-24T23:00:00Z'))
  })
  it('handles a half-hour zone (Kolkata)', () => {
    expect(rangeQuery(10, now, 'Asia/Kolkata', null, null).from).toBe(Date.parse('2026-10-21T18:30:00Z'))
  })
  it('handles spring-forward day (New York)', () => {
    expect(rangeQuery(2, Date.parse('2026-03-08T15:00:00Z'), 'America/New_York', null, null).from).toBe(Date.parse('2026-03-07T05:00:00Z'))
  })
  it('all has no lower bound', () => {
    expect(rangeQuery('all', now, 'UTC', null, null).from).toBeNull()
  })
})

describe('sortRows', () => {
  it('sorts descending by metric, ties by label', () => {
    const rows = [row('b', 1, 5), row('a', 1, 5), row('c', 2, 1)]
    expect(sortRows(rows, 'cost').map((r) => r.key)).toEqual(['c', 'a', 'b'])
    expect(sortRows(rows, 'tokens').map((r) => r.key)).toEqual(['a', 'b', 'c'])
  })
})

describe('share', () => {
  it('gives one decimal percent', () => {
    const rows = [row('a', 1.5, 10), row('b', 1.3, 30)]
    expect(share(rows[0], rows, 'cost')).toBe('53.6%')
    expect(share(rows[0], rows, 'tokens')).toBe('25.0%')
    expect(share(row('z', 0, 0), [row('z', 0, 0)], 'cost')).toBe('0.0%')
  })
})

describe('chartBars', () => {
  const days: UsageDay[] = [
    { day: '2026-10-29', exactUsd: 1, estimatedUsd: 1, exactTokens: 10, estimatedTokens: 0 },
    { day: '2026-10-31', exactUsd: 0.5, estimatedUsd: 0, exactTokens: 100, estimatedTokens: 100 }
  ]
  it('fills gaps and scales to the tallest day', () => {
    const bars = chartBars(days, 'cost', '2026-10-28', '2026-10-31')
    expect(bars.map((b) => b.day)).toEqual(['2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31'])
    expect(bars[0]).toMatchObject({ exact: 0, estimated: 0, exactHeight: 0, estimatedHeight: 0 })
    expect(bars[1].exactHeight + bars[1].estimatedHeight).toBeCloseTo(1)
    expect(bars[3].exactHeight).toBeCloseTo(0.25)
  })
  it('uses token fields for tokens', () => {
    const bars = chartBars(days, 'tokens', null, '2026-10-31')
    expect(bars.map((b) => b.day)).toEqual(['2026-10-29', '2026-10-30', '2026-10-31'])
    expect(bars[2].exact).toBe(100)
    expect(bars[2].exactHeight + bars[2].estimatedHeight).toBeCloseTo(1)
  })
  it('is empty-safe', () => {
    expect(chartBars([], 'cost', null, '2026-10-31')).toEqual([])
  })
})

describe('page helpers', () => {
  it('localDay reads the calendar day in the zone', () => {
    const t = Date.UTC(2026, 9, 31, 23, 30)
    expect(localDay(t, 'UTC')).toBe('2026-10-31')
    expect(localDay(t, 'Asia/Baghdad')).toBe('2026-11-01')
    expect(localDay(t, 'Not/AZone')).toBe('2026-10-31')
  })
  it('sourceSplit gives shares of the known total and survives zero', () => {
    const s = { exactUsd: 1, estimatedUsd: 3, exactTokens: 10, estimatedTokens: 0 }
    expect(sourceSplit(s, 'cost')).toMatchObject({ total: 4, exactPct: '25.0%', estimatedPct: '75.0%' })
    expect(sourceSplit(s, 'tokens')).toMatchObject({ exactPct: '100.0%', estimatedPct: '0.0%' })
    expect(sourceSplit({ exactUsd: 0, estimatedUsd: 0, exactTokens: 0, estimatedTokens: 0 }, 'cost').exactPct).toBe('0.0%')
  })
  it('formatMetric picks dollars or tokens', () => {
    expect(formatMetric(1.5, 'cost')).toBe('$1.50')
    expect(formatMetric(1500, 'tokens')).toBe('1.50K')
  })
  it('totalsBoxes lists the eight totals', () => {
    const boxes = totalsBoxes({ tokens: { input: 100, output: 200, cacheRead: 1000, cacheWrite: 300 }, userMessages: 7, chats: 2 })
    expect(boxes.map((b) => b.value)).toEqual(['600', '1.60K', '1.00K', '100', '300', '200', '7', '2'])
  })
  it('tabRows sorts by the metric but keeps days as given', () => {
    const s = {
      byModel: [row('a', 1, 9), row('b', 2, 1)],
      byAgent: [],
      byChat: [],
      byDay: [row('2026-10-01', 1, 1), row('2026-10-02', 5, 5)]
    } as unknown as UsageSummary
    expect(tabRows(s, 'model', 'cost').map((r) => r.key)).toEqual(['b', 'a'])
    expect(tabRows(s, 'model', 'tokens').map((r) => r.key)).toEqual(['a', 'b'])
    expect(tabRows(s, 'day', 'cost').map((r) => r.key)).toEqual(['2026-10-01', '2026-10-02'])
  })
  it('only live chat rows open a chat', () => {
    expect(chatRowOpens('chat', row('c1', 1, 1))).toBe(true)
    expect(chatRowOpens('chat', { ...row('c1', 1, 1), label: 'Deleted chat' })).toBe(false)
    expect(chatRowOpens('agent', row('x', 1, 1))).toBe(false)
  })
  it('a workflow row opens no chat, since none exists for it', () => {
    expect(chatRowOpens('chat', { ...row('workflow:w1', 1, 1), label: 'Workflow: Digest' })).toBe(false)
    expect(chatRowOpens('chat', { ...row('workflow:w1', 1, 1), label: 'Workflow (deleted)' })).toBe(false)
  })
})

describe('costLabel and chipTotalLabel', () => {
  it('dashes an unpriced zero, keeps real amounts', () => {
    expect(costLabel(0, true)).toBe('–')
    expect(costLabel(0, false)).toBe('$0.00')
    expect(costLabel(1.5, true)).toBe('$1.50')
  })
  it('chip total is a dash only when every model is unpriced', () => {
    const r = (unpriced: boolean) => ({ ...row('m', 0, 1), unpriced })
    expect(chipTotalLabel({ costUsd: 0, byModel: [r(true)] })).toBe('–')
    expect(chipTotalLabel({ costUsd: 0, byModel: [r(true), r(false)] })).toBe('$0.00')
    expect(chipTotalLabel({ costUsd: 2, byModel: [r(true)] })).toBe('$2.00')
  })
})
