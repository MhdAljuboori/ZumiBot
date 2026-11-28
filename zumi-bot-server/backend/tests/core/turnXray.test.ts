import { expect, test } from 'vitest'
import type { AuditDecision, AuditRecord } from '@zumibot/shared/audit'
import type { DispatchEntry } from '@zumibot/shared/dispatch'
import type { ChatItem } from '@zumibot/shared/types'
import type { CostRecord } from '@zumibot/shared/usageReport'
import { buildXray, stepsOf, unionMs, type XrayInput } from '../../src/core/xray/turnXray'
import { turnItems } from '../../src/core/xray/xrayService'
import type { LogRequest } from '../../src/core/xray/xrayLogs'

const T = 1_000_000

const tool = (id: string, name: string, ts: number, doneTs: number | undefined, extra: Partial<ChatItem> = {}): ChatItem =>
  ({ type: 'tool', id, name, input: { command: `run ${id}` }, result: doneTs === undefined ? null : 'ok', isError: false, blocked: false, ts, ...(doneTs === undefined ? {} : { doneTs }), ...extra }) as ChatItem

const card = (id: string, toolUseId: string | null, toolName: string, ts: number, status: string, answeredTs?: number): ChatItem =>
  ({ type: 'approval', id, toolUseId, toolName, input: {}, description: null, reason: null, status, ts, ...(answeredTs === undefined ? {} : { answeredTs }) }) as ChatItem

const req = (id: string, startedAt: number, endedAt: number, toolIds: string[], output = 100, costUsd: number | null = 0.01): LogRequest => ({
  id,
  model: 'claude-opus-5-5',
  startedAt,
  endedAt,
  tokens: { input: 10, output, cacheRead: 1000, cacheWrite5m: 50, cacheWrite1h: 0, fast: false },
  costUsd,
  toolIds,
  wrote: toolIds.length === 0
})

const record = (itemId: string | null, tool: string, ts: number, decision: AuditDecision, parent: string | null = null): AuditRecord =>
  ({ v: 1, id: `r-${tool}-${ts}`, ts, durationMs: 0, machine: 'm', chatId: 'c1', itemId, turnId: null, agent: 'dev', subagent: null, parentToolUseId: parent, engine: 'claude', runKind: 'chat', mode: 'default', isolation: 'off', tool, input: {}, inputCut: null, decision, outcome: 'ok', error: null, prev: '' }) as AuditRecord

const cost = (s: number, e: number, usd: number): CostRecord => ({
  kind: 'cost',
  id: `cost-${s}`,
  chatId: 'c1',
  agent: 'dev',
  at: e,
  sessionId: 's1',
  window: [s, e],
  models: { 'claude-opus-5-5': { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, costUsd: usd } },
  v: 2
})

const base = (over: Partial<XrayInput>): XrayInput => ({
  chatId: 'c1',
  itemId: 'a1',
  agent: 'dev',
  engine: 'claude',
  items: [],
  turnStart: T,
  entries: [],
  audit: [],
  costs: [],
  main: null,
  subagents: [],
  running: false,
  now: T + 100_000,
  ...over
})

test('unionMs counts overlapping spans once', () => {
  expect(unionMs([[0, 10], [5, 15], [20, 25], [30, 30]])).toBe(20)
  expect(unionMs([])).toBe(0)
})

test('stepsOf groups calls under the request that asked for them, each starting when the one before could hand back', () => {
  const calls = [
    { id: 't1', startedAt: T + 2000, endedAt: T + 5000 },
    { id: 't2', startedAt: T + 2000, endedAt: T + 3000 },
    { id: 'orphan', startedAt: T + 7000, endedAt: T + 7500 }
  ].map((c) => ({ ...c, tool: 'Bash', summary: '', card: null, cardStatus: null, waitMs: null, waitUnknown: false, decision: null, outcome: 'ok' as const, run: null }))
  const steps = stepsOf(T, [req('m1', T + 1000, T + 2000, ['t1', 't2']), req('m2', T + 6000, T + 9000, [])], calls)
  expect(steps.map((s) => [s.id, s.startedAt - T, s.endedAt - T, s.calls.map((c) => c.id)])).toEqual([
    ['m1', 0, 2000, ['t1', 't2']],
    ['m2', 5000, 9000, []],
    [null, 7000, 7500, ['orphan']]
  ])
  // Without a log, every call goes into one step with no request.
  const flat = stepsOf(T, null, calls)
  expect(flat).toHaveLength(1)
  expect(flat[0]).toMatchObject({ id: null, tokens: null, startedAt: T + 2000, endedAt: T + 7500 })
})

test('buildXray: requests, card waits, decisions, the time split and the exact cost', () => {
  const items: ChatItem[] = [
    { type: 'thinking', id: 'th', text: '', ts: T + 500, doneTs: T + 1000 } as ChatItem,
    tool('t1', 'Bash', T + 2000, T + 12_000),
    card('req1', 't1', 'Bash', T + 2100, 'allowed-once', T + 8100),
    tool('t2', 'Read', T + 2000, T + 2500),
    { type: 'assistant', id: 'a1', text: 'done', ts: T + 15_000, end: { session: 's1', at: 'u9' } } as ChatItem
  ]
  const x = buildXray(
    base({
      items,
      costs: [cost(T, T + 15_000, 0.42)],
      main: [req('m0', T - 60_000, T - 59_000, []), req('m1', T + 1000, T + 2000, ['t1', 't2']), req('m2', T + 13_000, T + 15_000, [])],
      audit: [record('t1', 'Bash', T + 2000, { kind: 'approvedByUser', scope: 'once' }), record('t2', 'Read', T + 2000, { kind: 'allowedByMode' })]
    })
  )
  expect(x.startedAt).toBe(T)
  expect(x.endedAt).toBe(T + 15_000)
  expect(x.running).toBe(false)
  expect(x.run.status).toBe('done')
  expect(x.run.steps.map((s) => s.id)).toEqual(['m1', 'm2']) // the earlier turn's request stays out
  const [bash, read] = x.run.steps[0]!.calls
  expect(bash).toMatchObject({ id: 't1', card: 'approval', cardStatus: 'allowed-once', waitMs: 6000, waitUnknown: false, outcome: 'ok' })
  expect(bash!.decision).toEqual({ kind: 'approvedByUser', scope: 'once' })
  expect(bash!.summary).toContain('run t1')
  expect(read).toMatchObject({ card: null, waitMs: null, decision: { kind: 'allowedByMode' } })
  expect(x.totals).toMatchObject({
    durationMs: 15_000,
    modelMs: 2000 + 3000, // m1: 0→2 s; m2: from t1's result (12 s) to 15 s
    waitMs: 6000,
    toolMs: 15_000 - 5000 - 6000,
    exactUsd: 0.42,
    requests: 2,
    calls: 2,
    cards: 1,
    subagents: 0
  })
  expect(x.totals.tokens).toEqual({ input: 20, output: 200, cacheRead: 2000, cacheWrite: 100 })
  expect(x.totals.stepUsd).toBeCloseTo(0.02)
  expect(x.gaps).toEqual([])
})

test('buildXray nests a subagent with its own requests, steps, decisions and a nested dispatch', () => {
  const entry = (id: string, parent: string | null, steps: DispatchEntry['steps'], startedAt: number, endedAt: number): DispatchEntry => ({
    id,
    parent,
    turn: 'x',
    description: `job ${id}`,
    subagentType: 'Explore',
    prompt: '',
    status: 'done',
    now: null,
    usage: { tokens: null, toolUses: null, durationMs: null },
    steps,
    report: 'ok',
    startedAt,
    endedAt,
    updatedAt: endedAt
  })
  const entries = [
    entry(
      'ag1',
      null,
      [
        { kind: 'tool', id: 's1', name: 'Grep', input: { pattern: 'x' }, result: 'hit', isError: false, ts: T + 3000, doneTs: T + 3500 },
        { kind: 'agent', id: 'ag2', ts: T + 4000 },
        { kind: 'tool', id: 's2', name: 'Bash', input: { command: 'ls' }, result: null, isError: false, ts: T + 6000, doneTs: T + 9000 }
      ],
      T + 2000,
      T + 10_000
    ),
    entry('ag2', 'ag1', [], T + 4000, T + 5000)
  ]
  const x = buildXray(
    base({
      items: [
        tool('ag1', 'Agent', T + 2000, T + 10_000),
        card('req2', 's2', 'Bash', T + 6100, 'denied', T + 7100),
        { type: 'assistant', id: 'a1', text: 'ok', ts: T + 11_000 } as ChatItem
      ],
      entries,
      main: [req('m1', T + 1000, T + 2000, ['ag1']), req('m2', T + 10_500, T + 11_000, [])],
      subagents: [
        { toolUseId: 'ag1', requests: [req('sa1', T + 2500, T + 3000, ['s1']), req('sa2', T + 5500, T + 6000, ['s2'], 50, null)] },
        { toolUseId: null, requests: [req('sb1', T + 4200, T + 4800, [])] } // no meta file, and no tool to match it by: unread
      ],
      audit: [
        record('ag1', 'Agent', T + 2000, { kind: 'allowedByMode' }),
        record('ag1', 'Grep', T + 3000, { kind: 'allowedByMode' }, 'ag1'),
        record('ag1', 'Agent', T + 4000, { kind: 'allowedByMode' }, 'ag1'),
        record('ag1', 'Bash', T + 6000, { kind: 'deniedByUser' }, 'ag1')
      ]
    })
  )
  const agentCall = x.run.steps[0]!.calls[0]!
  expect(agentCall).toMatchObject({ id: 'ag1', tool: 'Agent', summary: 'job ag1', outcome: 'ok', startedAt: T + 2000, endedAt: T + 10_000 })
  const sub = agentCall.run!
  expect(sub).toMatchObject({ name: 'job ag1', type: 'Explore', status: 'done' })
  // The nested Agent call is in no logged request here, so it stands at its own time.
  expect(sub.steps.map((s) => [s.id, s.startedAt - T, s.calls.map((c) => c.id)])).toEqual([
    ['sa1', 2000, ['s1']],
    ['sa2', 3500, ['s2']],
    [null, 4000, ['ag2']]
  ])
  const nested = sub.steps.find((s) => s.calls.some((c) => c.id === 'ag2'))!.calls[0]!
  expect(nested).toMatchObject({ tool: 'Agent', summary: 'job ag2', decision: { kind: 'allowedByMode' } })
  expect(nested.run).toMatchObject({ name: 'job ag2', steps: [] })
  const bash = sub.steps.find((s) => s.id === 'sa2')!.calls[0]!
  expect(bash).toMatchObject({ card: 'approval', cardStatus: 'denied', waitMs: 1000, outcome: 'blocked', decision: { kind: 'deniedByUser' } })
  expect(x.totals).toMatchObject({ requests: 4, calls: 4, subagents: 2, cards: 1, unpriced: true, waitMs: 1000 })
})

test('buildXray while running: open calls run, a pending card waits until now, nothing is called missing', () => {
  const x = buildXray(
    base({
      running: true,
      now: T + 20_000,
      items: [tool('t1', 'Bash', T + 1000, undefined), card('r1', 't1', 'Bash', T + 1100, 'pending')],
      main: []
    })
  )
  expect(x.endedAt).toBeNull()
  expect(x.run.status).toBe('running')
  const call = x.run.steps[0]!.calls[0]!
  expect(call).toMatchObject({ outcome: 'running', endedAt: null, waitMs: 18_900, waitUnknown: false })
  expect(x.totals.durationMs).toBe(20_000)
  expect(x.gaps).toEqual(['noLog'])
})

test('buildXray says what it could not show: no log, a card answered before answer times, a call with no audit record', () => {
  const x = buildXray(
    base({
      engine: 'codex',
      items: [
        tool('t1', 'Bash', T + 1000, T + 2000),
        card('r1', 't1', 'Bash', T + 1100, 'allowed-once'),
        tool('t2', 'Bash', T + 3000, undefined, { blocked: true } as Partial<ChatItem>),
        card('r2', 't2', 'Bash', T + 3100, 'auto-allowed'),
        { type: 'notice', id: 'n', kind: 'stopped', text: 'Stopped.', ts: T + 4000 } as ChatItem
      ],
      audit: null
    })
  )
  expect(x.run.status).toBe('stopped')
  expect(x.run.steps).toHaveLength(1)
  const [a, b] = x.run.steps[0]!.calls
  expect(a).toMatchObject({ card: 'approval', waitMs: null, waitUnknown: true })
  expect(b).toMatchObject({ card: null, outcome: 'blocked' }) // an auto-allowed card never waited
  expect(x.gaps).toEqual(['noLog', 'waitUnknown', 'noAudit'])
  expect(x.totals.exactUsd).toBeNull()
})

test('turnItems finds one reply: its agent’s run of items, cut at turn ends, and the item before it', () => {
  const user = (id: string, ts: number): ChatItem => ({ type: 'user', id, text: id, ts }) as ChatItem
  const said = (id: string, agent: string, ts: number, end = false): ChatItem =>
    ({ type: 'assistant', id, text: id, ts, agent, ...(end ? { end: { session: 's', at: 'x', agent } } : {}) }) as ChatItem
  const items: ChatItem[] = [
    user('u1', 1),
    tool('t1', 'Bash', 2, 3, { agent: 'ann' } as Partial<ChatItem>),
    said('a1', 'ann', 4, true),
    said('a2', 'ann', 5, true), // ann again, a turn of her own
    said('b1', 'bob', 6, true),
    { type: 'user', id: 'run', text: '', ts: 7, run: { id: 'r' } } as unknown as ChatItem,
    said('a3', 'ann', 8)
  ]
  expect(turnItems(items, 'a1', '')).toMatchObject({ items: [items[1], items[2]], before: items[0], agent: 'ann', last: false })
  expect(turnItems(items, 'a2', '')!.items.map((i) => i.id)).toEqual(['a2'])
  expect(turnItems(items, 'a3', '')).toMatchObject({ agent: 'ann', last: true })
  expect(turnItems(items, 'a3', '')!.before?.id).toBe('b1') // the hidden Run result does not split anything
  expect(turnItems(items, 'u1', '')).toBeNull()
  // A room turn still running: its stamped items, wherever another member's sit between them.
  const live: ChatItem[] = [
    user('u2', 10),
    { ...said('c1', 'cat', 11), turn: 'T1' } as ChatItem,
    { ...said('d1', 'dan', 12), turn: 'T2' } as ChatItem,
    { ...tool('t9', 'Bash', 13, 14), agent: 'cat', turn: 'T1' } as ChatItem,
    { ...said('c2', 'cat', 15), turn: 'T1' } as ChatItem
  ]
  expect(turnItems(live, 'c2', '')).toMatchObject({ agent: 'cat', last: true })
  expect(turnItems(live, 'c2', '')!.items.map((i) => i.id)).toEqual(['c1', 't9', 'c2'])
  expect(turnItems(live, 'c2', '')!.before?.id).toBe('u2')
  expect(turnItems(items, 'nope', '')).toBeNull()
})
