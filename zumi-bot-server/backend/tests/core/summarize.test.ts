import { describe, expect, it } from 'vitest'
import { MODERATOR_AGENT, type CostRecord, type MessageRecord, type ModelSpend, type UsageQuery } from '@zumibot/shared/usageReport'
import type { EstimateBucket } from '../../src/core/usage/estimates'
import { summarize, type SummaryInput } from '../../src/core/usage/summarize'

const T = Date.parse('2026-10-30T12:00:00Z')
const spend = (o: Partial<ModelSpend> = {}): ModelSpend => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, ...o })
const cost = (id: string, o: Partial<CostRecord> & { m?: Record<string, ModelSpend> } = {}): CostRecord => ({
  kind: 'cost',
  id,
  chatId: 'c1',
  agent: 'alice',
  at: T,
  sessionId: null,
  window: null,
  models: o.m ?? { 'claude-sonnet-5': spend({ costUsd: 1 }) },
  ...o
})
const msg = (id: string, chatId = 'c1', at = T): MessageRecord => ({ kind: 'msg', id, chatId, at })
const bucket = (o: Partial<EstimateBucket> = {}): EstimateBucket => ({
  chatId: 'c1',
  agent: 'alice',
  hour: T,
  model: 'claude-sonnet-5',
  spend: spend({ costUsd: 0.5 }),
  ...o
})
const q = (o: Partial<UsageQuery> = {}): UsageQuery => ({ from: null, to: null, agent: null, chatId: null, timeZone: 'UTC', ...o })
const input = (o: Partial<SummaryInput> = {}): SummaryInput => ({
  records: [],
  estimates: [],
  chats: new Map([
    ['c1', { title: 'One' }],
    ['c2', { title: 'Two' }]
  ]),
  estimating: false,
  agentLabel: (a) => (a === MODERATOR_AGENT ? 'Room moderator' : a),
  ...o
})

describe('summarize', () => {
  it('merges dated and 1m variants of a model into one row', () => {
    const m = { 'claude-sonnet-5-20261001': spend({ costUsd: 1 }), 'claude-sonnet-5[1m]': spend({ costUsd: 2 }) }
    const s = summarize(input({ records: [cost('a', { m })], estimates: [bucket()] }), q())
    expect(s.byModel.map((r) => r.key)).toEqual(['claude-sonnet-5'])
    expect(s.byModel[0].costUsd).toBeCloseTo(3.5)
  })

  it('ignores owner records', () => {
    const o = { kind: 'owner', id: 'o:s:c1', chatId: 'c1', sessionId: 's', agent: 'alice', at: T } as const
    expect(summarize(input({ records: [o] }), q()).userMessages).toBe(0)
  })

  it('splits exact and estimated cost', () => {
    const s = summarize(input({ records: [cost('a')], estimates: [bucket()] }), q())
    expect(s.costUsd).toBe(1.5)
    expect(s.exactUsd).toBe(1)
    expect(s.estimatedUsd).toBe(0.5)
    expect(s.byAgent[0]).toMatchObject({ key: 'alice', costUsd: 1.5, estimated: true })
  })

  it("token totals match the screenshot's arithmetic", () => {
    const rec = cost('a', { m: { 'claude-sonnet-5': spend({ input: 4_570, cacheRead: 9_000 }) } })
    const est = bucket({ spend: spend({ cacheWrite: 169_150, output: 7_060, cacheRead: 1_000 }) })
    const s = summarize(input({ records: [rec], estimates: [est] }), q())
    expect(s.exactTokens + s.estimatedTokens).toBe(180_780)
    expect(s.tokens.cacheRead).toBe(10_000)
    expect(s.tokens.input).toBe(4_570)
  })

  it('filters by agent and counts chats and messages in its chats only', () => {
    const s = summarize(
      input({
        records: [cost('a'), cost('b', { agent: 'bob', chatId: 'c2' }), msg('m1', 'c1'), msg('m2', 'c2'), msg('m3', 'c1')]
      }),
      q({ agent: 'alice' })
    )
    expect(s.costUsd).toBe(1)
    expect(s.chats).toBe(1)
    expect(s.userMessages).toBe(2)
    expect(s.byAgent.map((r) => r.key)).toEqual(['alice'])
  })

  it('filters by chat', () => {
    const s = summarize(
      input({
        records: [cost('a'), cost('b', { chatId: 'c2' }), msg('m1', 'c1'), msg('m2', 'c2')],
        estimates: [bucket({ chatId: 'c2' })]
      }),
      q({ chatId: 'c2' })
    )
    expect(s.costUsd).toBe(1.5)
    expect(s.chats).toBe(1)
    expect(s.userMessages).toBe(1)
    expect(s.byChat.map((r) => r.key)).toEqual(['c2'])
  })

  it('workflow cost rows are labelled by workflow name', () => {
    const rows = [cost('w1', { chatId: 'workflow:wf1', agent: '#workflow' }), cost('w2', { chatId: 'workflow:gone', agent: '#workflow' })]
    const s = summarize(input({ records: rows, workflowNames: new Map([['wf1', 'Nightly digest']]) }), q())
    expect(s.byChat.map((r) => [r.key, r.label]).sort()).toEqual([
      ['workflow:gone', 'Workflow (deleted)'],
      ['workflow:wf1', 'Workflow: Nightly digest']
    ])
    // without a snapshot no workflow is known, and a workflow id is never read as a chat
    expect(summarize(input({ records: rows }), q()).byChat.map((r) => r.label)).toEqual(['Workflow (deleted)', 'Workflow (deleted)'])
  })

  it('a deleted chat keeps its cost as Deleted chat', () => {
    const s = summarize(input({ records: [cost('a', { chatId: 'gone' })] }), q())
    expect(s.costUsd).toBe(1)
    expect(s.chats).toBe(1)
    expect(s.byChat[0]).toMatchObject({ key: 'gone', label: 'Deleted chat' })
  })

  it('an empty title is Untitled chat', () => {
    const s = summarize(input({ records: [cost('a')], chats: new Map([['c1', { title: '' }]]) }), q())
    expect(s.byChat[0].label).toBe('Untitled chat')
  })

  it('days follow the query time zone', () => {
    const at = Date.parse('2026-10-30T23:30:00Z')
    const r = [cost('a', { at })]
    expect(summarize(input({ records: r }), q({ timeZone: 'Asia/Baghdad' })).byDay[0].key).toBe('2026-10-31')
    expect(summarize(input({ records: r }), q({ timeZone: 'UTC' })).byDay[0].key).toBe('2026-10-30')
    expect(summarize(input({ records: r }), q({ timeZone: 'Not/AZone' })).byDay[0].key).toBe('2026-10-30')
  })

  it('range is from <= at < to, estimates use their hour', () => {
    const r = [cost('a', { at: 100 }), cost('b', { at: 200 })]
    const s = summarize(input({ records: r, estimates: [bucket({ hour: 200 }), bucket({ hour: 100 })] }), q({ from: 100, to: 200 }))
    expect(s.exactUsd).toBe(1)
    expect(s.estimatedUsd).toBe(0.5)
  })

  it('unpriced tokens are counted but add no dollars', () => {
    const rec = cost('a', {
      m: { mystery: spend({ input: 10, output: 5, cacheRead: 99, costUsd: null }), 'claude-sonnet-5': spend({ costUsd: 2 }) }
    })
    const s = summarize(input({ records: [rec] }), q())
    expect(s.costUsd).toBe(2)
    expect(s.unpricedTokens).toBe(15)
    const row = s.byModel.find((r) => r.key === 'mystery')!
    expect(row).toMatchObject({ costUsd: 0, tokens: 15, unpriced: true })
    expect(s.byAgent[0].unpriced).toBe(true)
  })

  it('rows are sorted by cost, days newest first', () => {
    const d1 = Date.parse('2026-10-28T10:00:00Z'),
      d2 = Date.parse('2026-10-29T10:00:00Z')
    const s = summarize(
      input({
        records: [
          cost('a', { at: d1, agent: 'cheap', m: { x: spend({ costUsd: 1 }) } }),
          cost('b', { at: d2, agent: 'pricey', m: { y: spend({ costUsd: 5 }) } })
        ]
      }),
      q()
    )
    expect(s.byAgent.map((r) => r.key)).toEqual(['pricey', 'cheap'])
    expect(s.byModel.map((r) => r.key)).toEqual(['y', 'x'])
    expect(s.byDay.map((r) => r.key)).toEqual(['2026-10-29', '2026-10-28'])
    expect(s.days.map((d) => d.day)).toEqual(['2026-10-28', '2026-10-29'])
  })

  it('the moderator row uses agentLabel', () => {
    const s = summarize(input({ records: [cost('a', { agent: MODERATOR_AGENT })] }), q())
    expect(s.byAgent[0]).toMatchObject({ key: MODERATOR_AGENT, label: 'Room moderator' })
  })

  it('passes estimating through', () => {
    expect(summarize(input({ estimating: true }), q()).estimating).toBe(true)
  })
})
