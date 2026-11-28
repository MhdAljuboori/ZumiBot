import { describe, expect, it } from 'vitest'
import type { TurnXray, XrayCall, XrayRun, XrayStep } from '@zumibot/shared/xray'
import {
  barOf,
  cacheShare,
  callBars,
  callLabel,
  costText,
  countsLine,
  fineUsd,
  modelLabel,
  spanText,
  splitOf,
  stepLine,
  stepTitle,
  waitText,
  xrayRows
} from '../src/state/xray'

const call = (id: string, over: Partial<XrayCall> = {}): XrayCall => ({
  id,
  tool: 'Bash',
  summary: id,
  startedAt: 100,
  endedAt: 200,
  card: null,
  cardStatus: null,
  waitMs: null,
  waitUnknown: false,
  decision: null,
  outcome: 'ok',
  run: null,
  ...over
})
const step = (id: string | null, calls: XrayCall[], over: Partial<XrayStep> = {}): XrayStep => ({
  id,
  model: 'claude-opus-5-5',
  startedAt: 0,
  endedAt: 100,
  tokens: { input: 100, output: 50, cacheRead: 900, cacheWrite: 0 },
  costUsd: 0.0123,
  wrote: false,
  calls,
  ...over
})
const run = (steps: XrayStep[]): XrayRun => ({ name: 'dev', type: null, startedAt: 0, endedAt: 1000, status: 'done', steps })
const xray = (over: Partial<TurnXray['totals']>): TurnXray => ({
  chatId: 'c',
  itemId: 'a',
  agent: 'dev',
  engine: 'claude',
  startedAt: 0,
  endedAt: 1000,
  running: false,
  run: run([]),
  gaps: [],
  totals: {
    durationMs: 1000,
    modelMs: 250,
    waitMs: 500,
    toolMs: 250,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    stepUsd: 0.5,
    unpriced: false,
    exactUsd: null,
    requests: 2,
    calls: 1,
    subagents: 0,
    cards: 0,
    ...over
  }
})

describe('xrayRows', () => {
  const sub = run([step('s1', [call('inner')])])
  const r = run([step('m1', [call('a'), call('ag', { tool: 'Agent', run: sub })]), step(null, [call('loose')]), step('m2', [], { wrote: true })])

  it('puts each request before its calls, and folds a subagent until it is opened', () => {
    expect(xrayRows(r, new Set()).map((x) => [x.kind, x.kind === 'step' ? x.step.id : x.call.id, x.depth])).toEqual([
      ['step', 'm1', 0],
      ['call', 'a', 1],
      ['call', 'ag', 1],
      ['call', 'loose', 0], // no logged request: its calls alone, at the request's level
      ['step', 'm2', 0]
    ])
    const ag = xrayRows(r, new Set()).find((x) => x.kind === 'call' && x.call.id === 'ag')
    expect(ag).toMatchObject({ folded: true })
  })

  it('shows an opened subagent’s own requests and calls under its Agent call', () => {
    const rows = xrayRows(r, new Set(['ag']))
    expect(rows.map((x) => [x.kind === 'step' ? x.step.id : x.call.id, x.depth])).toEqual([
      ['m1', 0],
      ['a', 1],
      ['ag', 1],
      ['s1', 2],
      ['inner', 3],
      ['loose', 0],
      ['m2', 0]
    ])
    expect(new Set(rows.map((x) => x.key)).size).toBe(rows.length)
  })
})

describe('bars', () => {
  it('places a span in percent of the turn, with a sliver for a tiny one', () => {
    expect(barOf(250, 750, 0, 1000)).toEqual({ left: 25, width: 50 })
    expect(barOf(500, 500, 0, 1000)).toEqual({ left: 50, width: 0.6 })
    expect(barOf(-50, 2000, 0, 1000)).toEqual({ left: 0, width: 100 })
  })

  it('draws a running call to now and its card wait from its start', () => {
    const b = callBars(call('x', { startedAt: 0, endedAt: null, outcome: 'running', card: 'approval', waitMs: 300 }), 0, 1000, 600)
    expect(b.run).toEqual({ left: 0, width: 60 })
    expect(b.wait).toEqual({ left: 0, width: 30 })
    expect(callBars(call('y'), 0, 1000, 0).wait).toBeNull()
  })
})

describe('words and numbers', () => {
  it('spanText', () => {
    expect(spanText(850)).toBe('850 ms')
    expect(spanText(4200)).toBe('4.2 s')
    expect(spanText(38_000)).toBe('38 s')
    expect(spanText(185_000)).toBe('3 min 5 s')
    expect(spanText(120_000)).toBe('2 min')
    expect(spanText(3_720_000)).toBe('1 h 2 min')
    expect(spanText(-1)).toBe('0 ms')
  })

  it('modelLabel', () => {
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5')
    expect(modelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(modelLabel('claude-sonnet-5-5[1m]')).toBe('Sonnet 5.5')
    expect(modelLabel('gpt-x')).toBe('gpt-x')
    expect(modelLabel(null)).toBe('Model')
  })

  it('stepLine, stepTitle and cacheShare', () => {
    expect(stepLine(step('m', []))).toBe('1.00K in · 50 out · 90% cache · $0.0123')
    expect(stepLine(step('m', [], { costUsd: null }))).toBe('1.00K in · 50 out · 90% cache')
    expect(stepLine(step('m', [], { tokens: null }))).toBe('')
    expect(cacheShare({ input: 0, output: 5, cacheRead: 0, cacheWrite: 0 })).toBeNull()
    expect([fineUsd(0), fineUsd(0.00001), fineUsd(0.5), fineUsd(2.5)]).toEqual(['$0', '<$0.0001', '$0.5000', '$2.50'])
    expect(stepTitle(step('m', [], { wrote: true }))).toBe('Wrote')
    expect(stepTitle(step('m', [call('a')], { wrote: true }))).toBe('Thought, 1 call')
    expect(stepTitle(step('m', [call('a'), call('b')]))).toBe('2 calls')
  })

  it('callLabel says the tool once, and a subagent by its type and task', () => {
    expect(callLabel(call('a', { tool: 'Read', summary: 'Read /work/a.ts' }))).toEqual({ tool: 'Read', rest: '/work/a.ts' })
    expect(callLabel(call('a', { tool: 'Bash', summary: 'Bash(npm test)' }))).toEqual({ tool: 'Bash', rest: 'npm test' })
    expect(callLabel(call('a', { tool: 'mcp__x__y', summary: 'Asked ann' }))).toEqual({ tool: 'mcp__x__y', rest: 'Asked ann' })
    const sub = { name: 'job', type: 'Explore', startedAt: 0, endedAt: 1, status: 'done' as const, steps: [] }
    expect(callLabel(call('a', { tool: 'Agent', summary: 'Find callers', run: sub }))).toEqual({ tool: 'Explore', rest: 'Find callers' })
  })

  it('waitText names the card and says when the wait is unknown or still running', () => {
    expect(waitText(call('a'))).toBeNull()
    expect(waitText(call('a', { card: 'approval', waitMs: 6000 }))).toBe('Waited 6.0 s for your approval')
    expect(waitText(call('a', { card: 'question', waitUnknown: true }))).toBe('Your question · wait unknown')
    expect(waitText(call('a', { card: 'plan', waitMs: 2000, outcome: 'running', cardStatus: 'pending' }))).toBe('Waiting 2.0 s for your plan')
  })

  it('costText prefers the exact cost, else marks the priced sum as an estimate', () => {
    expect(costText(xray({ exactUsd: 0.42 }))).toEqual({ text: '$0.42', exact: true })
    expect(costText(xray({}))).toEqual({ text: '≈ $0.50', exact: false })
    expect(costText(xray({ requests: 0 }))).toEqual({ text: '–', exact: false })
  })

  it('splitOf and countsLine', () => {
    expect(splitOf(xray({}))).toEqual({ model: 25, wait: 50, tools: 25 })
    expect(splitOf(xray({ durationMs: 0 }))).toEqual({ model: 0, tools: 0, wait: 0 })
    expect(countsLine(xray({}))).toBe('2 requests · 1 tool call')
    expect(countsLine(xray({ requests: 1, calls: 3, subagents: 1, cards: 2 }))).toBe('1 request · 3 tool calls · 1 subagent · 2 cards')
  })
})
