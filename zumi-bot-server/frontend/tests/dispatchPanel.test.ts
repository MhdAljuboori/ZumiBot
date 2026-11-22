import { describe, expect, it } from 'vitest'
import type { DispatchStep, DispatchSummary } from '@zumibot/shared/dispatch'
import {
  agentBody,
  dispatchBadge,
  groupDispatch,
  linkState,
  stepsLabel,
  stepsShown,
  usageLine,
  waitingIds
} from '../src/state/dispatchPanel'

const s = (id: string, extra: Partial<DispatchSummary> = {}): DispatchSummary => ({
  id,
  parent: null,
  turn: 't1',
  description: id,
  subagentType: null,
  status: 'done',
  now: null,
  usage: { tokens: null, toolUses: null, durationMs: null },
  startedAt: 1000,
  endedAt: 2000,
  updatedAt: 2000,
  stepCount: 0,
  openTools: [],
  ...extra
})
const fmt = (ms: number) => `at ${ms}`

describe('groupDispatch', () => {
  it('groups by turn, newest group first, labelled This reply then by time', () => {
    const g = groupDispatch(
      [s('a', { turn: 'old', startedAt: 10 }), s('b', { turn: 'new', startedAt: 50 }), s('c', { turn: 'old', startedAt: 20 })],
      fmt
    )
    expect(g.map((x) => [x.turn, x.label, x.rows.map((r) => r.s.id)])).toEqual([
      ['new', 'This reply', ['b']],
      ['old', 'at 10', ['a', 'c']]
    ])
  })
  it('puts each nested agent under its parent, depth first', () => {
    const g = groupDispatch(
      [
        s('a', { startedAt: 1 }),
        s('b', { startedAt: 2 }),
        s('n', { parent: 'a', startedAt: 3 }),
        s('m', { parent: 'n', startedAt: 4 }),
        s('o', { parent: 'a', startedAt: 5 })
      ],
      fmt
    )
    expect(g[0].rows.map((r) => [r.s.id, r.depth])).toEqual([
      ['a', 0],
      ['n', 1],
      ['m', 2],
      ['o', 1],
      ['b', 0]
    ])
  })
  it('an orphan is a root', () => {
    const g = groupDispatch([s('n', { parent: 'gone' })], fmt)
    expect(g[0].rows).toEqual([{ s: expect.objectContaining({ id: 'n' }), depth: 0 }])
  })
  it('a room group carries the member', () => {
    expect(groupDispatch([s('a', { member: 'alice' })], fmt)[0].member).toBe('alice')
  })
  it('nothing makes no groups', () => {
    expect(groupDispatch([], fmt)).toEqual([])
  })
})

describe('usageLine', () => {
  it('running: tool uses, tokens and time so far', () => {
    expect(
      usageLine(
        s('a', { status: 'running', startedAt: 0, endedAt: null, usage: { tokens: 41_000, toolUses: 7, durationMs: null } }),
        72_000
      )
    ).toBe('7 tool uses · 41k tokens · 1m 12s')
  })
  it('ended: status first, duration from usage, seconds padded after minutes', () => {
    expect(usageLine(s('a', { usage: { tokens: 63_400, toolUses: 12, durationMs: 125_000 } }), 0)).toBe(
      'Done · 12 tool uses · 63k tokens · 2m 05s'
    )
  })
  it('falls back to start and end times, one tool use, small token counts', () => {
    expect(
      usageLine(s('a', { status: 'failed', startedAt: 1000, endedAt: 49_000, usage: { tokens: 950, toolUses: 1, durationMs: null } }), 0)
    ).toBe('Failed · 1 tool use · 950 tokens · 48s')
  })
  it('leaves out what is unknown', () => {
    expect(usageLine(s('a', { status: 'stopped', endedAt: null }), 0)).toBe('Stopped')
    expect(usageLine(s('a', { status: 'interrupted', startedAt: 0, endedAt: 3000 }), 0)).toBe('Interrupted · 3s')
  })
})

describe('dispatchBadge', () => {
  it('counts running agents first, else all, else nothing', () => {
    expect(dispatchBadge([s('a', { status: 'running' }), s('b', { status: 'running' }), s('c')])).toEqual({ text: '2 running', live: true })
    expect(dispatchBadge([s('a'), s('b')])).toEqual({ text: '2', live: false })
    expect(dispatchBadge([])).toBeNull()
  })
})

describe('waitingIds', () => {
  it('names the agents whose open tool call has a pending approval card', () => {
    const list = [s('a', { status: 'running', openTools: ['t1'] }), s('b', { status: 'running', openTools: ['t2'] })]
    expect([...waitingIds(list, new Set(['t2', 'zz']))]).toEqual(['b'])
  })
})

describe('linkState', () => {
  it('running, ended or no entry for the chat row', () => {
    const list = [s('a', { status: 'running' }), s('b')]
    expect(linkState(list, 'a')).toBe('running')
    expect(linkState(list, 'b')).toBe('ended')
    expect(linkState(list, 'c')).toBeNull()
    expect(linkState(null, 'a')).toBeNull()
  })
})

describe('agentBody', () => {
  const tool = (id: string, name: string, input: unknown): DispatchStep => ({
    kind: 'tool',
    id,
    name,
    input,
    result: 'ok',
    isError: false,
    ts: 1
  })
  it('an old entry: the SubagentHandback message is the report and the call is no step', () => {
    const body = agentBody({
      steps: [tool('g', 'Grep', { pattern: 'a' }), tool('h', 'SubagentHandback', { message: '## Answer' })],
      report: 'This agent\'s report was delivered to you as a message from "a1" (its SubagentHandback call).'
    })
    expect(body).toEqual({ steps: [tool('g', 'Grep', { pattern: 'a' })], report: '## Answer' })
  })
  it('the last handback wins; one with no message, or capped to a string, stays a step', () => {
    const capped = tool('c', 'SubagentHandback', '{"message":"cut')
    const body = agentBody({
      steps: [tool('h1', 'SubagentHandback', { message: 'first' }), capped, tool('h2', 'SubagentHandback', { message: 'second' })],
      report: null
    })
    expect(body).toEqual({ steps: [capped], report: 'second' })
  })
  it('an entry without a handback is unchanged', () => {
    const steps: DispatchStep[] = [{ kind: 'text', text: 'hi', ts: 1 }]
    expect(agentBody({ steps, report: 'done' })).toEqual({ steps, report: 'done' })
  })
})

describe('stepsShown', () => {
  it('shows the steps while running or with no report, folds them under a report, and the reader decides once toggled', () => {
    expect(stepsShown(null, true, true)).toBe(true)
    expect(stepsShown(null, false, false)).toBe(true)
    expect(stepsShown(null, false, true)).toBe(false)
    expect(stepsShown(true, false, true)).toBe(true)
    expect(stepsShown(false, true, false)).toBe(false)
  })
  it('labels the count', () => {
    expect(stepsLabel(1)).toBe('1 step')
    expect(stepsLabel(23)).toBe('23 steps')
  })
})
