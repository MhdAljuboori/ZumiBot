import { expect, test } from 'vitest'
import { estimate, type SessionOwner } from '../../src/core/usage/estimates'
import type { LogMessage } from '../../src/core/usage/sessionLogs'
import type { CostRecord } from '@zumibot/shared/usageReport'

const H = 3_600_000
const tok = (input: number, output = 0, w5 = 0, w1 = 0) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite5m: w5,
  cacheWrite1h: w1,
  fast: false
})
const msg = (id: string, at: number, input = 10, costUsd: number | null = 1, model = 'claude-sonnet-5-5'): LogMessage => ({
  id,
  at,
  model,
  tokens: tok(input),
  costUsd
})
const owner = (sessionId: string, chatId: string, chatCreatedAt: number, agent = 'a'): SessionOwner => ({
  sessionId,
  chatId,
  agent,
  chatCreatedAt
})
const exact = (sessionId: string, window: [number, number]): CostRecord => ({
  kind: 'cost',
  id: 'r',
  chatId: 'A',
  agent: 'a',
  at: window[1],
  sessionId,
  window,
  models: {}
})
const total = (bs: ReturnType<typeof estimate>) => bs.reduce((n, b) => n + b.spend.input, 0)

test('estimate buckets by chat, agent, hour and model', () => {
  const logs = new Map([['S', [msg('m1', 5 * H + 10, 10, 1), msg('m2', 5 * H + 20, 5, 2), msg('m3', 6 * H, 1, 1)]]])
  const out = estimate([owner('S', 'A', 1)], logs, [])
  expect(out).toHaveLength(2)
  const b = out.find((x) => x.hour === 5 * H)!
  expect(b).toMatchObject({ chatId: 'A', agent: 'a', model: 'claude-sonnet-5-5' })
  expect(b.spend).toEqual({ input: 15, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 3 })
})

test('estimate sums cacheWrite as 5m plus 1h', () => {
  const m: LogMessage = { id: 'm', at: 0, model: 'claude-sonnet-5-5', tokens: tok(0, 0, 3, 4), costUsd: 1 }
  expect(estimate([owner('S', 'A', 1)], new Map([['S', [m]]]), [])[0].spend.cacheWrite).toBe(7)
})

test("estimate skips messages inside an exact record's window", () => {
  const logs = new Map([['S', [msg('m0', 1 * H), msg('m1', 2 * H), msg('m2', 3 * H), msg('m3', 4 * H)]]])
  const out = estimate([owner('S', 'A', 1)], logs, [exact('S', [2 * H, 3 * H])])
  expect(total(out)).toBe(20)
  expect(out.map((b) => b.hour).sort((x, y) => x - y)).toEqual([1 * H, 4 * H])
})

test('an exact record arriving later shrinks the estimate by the same amount', () => {
  const logs = new Map([['S', [msg('m0', 1 * H, 10, 1), msg('m1', 2 * H, 7, 2), msg('m2', 2 * H + 5, 3, 4)]]])
  const without = estimate([owner('S', 'A', 1)], logs, [])
  const withRec = estimate([owner('S', 'A', 1)], logs, [exact('S', [2 * H, 2 * H + 10])])
  expect(total(without) - total(withRec)).toBe(10)
  const cost = (bs: typeof without) => bs.reduce((n, b) => n + (b.spend.costUsd ?? 0), 0)
  expect(cost(without) - cost(withRec)).toBe(6)
})

test('a fork copy of exact history counts nowhere', () => {
  const logs = new Map([
    ['S1', [msg('msg_1', 2 * H)]],
    ['S2', [msg('msg_1', 2 * H)]]
  ])
  const out = estimate([owner('S1', 'A', 1), owner('S2', 'B', 2)], logs, [exact('S1', [2 * H, 2 * H])])
  expect(out).toEqual([])
})

test('a fork copy of estimated history goes to the chat created first', () => {
  const logs = new Map([
    ['S1', [msg('msg_1', 2 * H)]],
    ['S2', [msg('msg_1', 2 * H)]]
  ])
  // owners listed newest first: ordering must not depend on input order
  const out = estimate([owner('S2', 'B', 2), owner('S1', 'A', 1)], logs, [])
  expect(out.map((b) => b.chatId)).toEqual(['A'])
  expect(total(out)).toBe(10)
})

test('ties on creation time are broken by chat id', () => {
  const logs = new Map([
    ['S1', [msg('x', 0)]],
    ['S2', [msg('x', 0)]]
  ])
  expect(estimate([owner('S2', 'B', 1), owner('S1', 'A', 1)], logs, []).map((b) => b.chatId)).toEqual(['A'])
})

test('a session named by two chats counts once', () => {
  const logs = new Map([['S', [msg('m1', 0)]]])
  const out = estimate([owner('S', 'A', 1), owner('S', 'B', 2)], logs, [])
  expect(out).toHaveLength(1)
  expect(total(out)).toBe(10)
})

test('an unpriced message makes the bucket cost null but keeps its tokens', () => {
  const logs = new Map([['S', [msg('m1', 0, 10, 1), msg('m2', 1, 5, null), msg('m3', 2, 1, 1)]]])
  const out = estimate([owner('S', 'A', 1)], logs, [])
  expect(out).toHaveLength(1)
  expect(out[0].spend.costUsd).toBeNull()
  expect(out[0].spend.input).toBe(16)
})
