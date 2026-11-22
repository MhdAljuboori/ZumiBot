import { describe, expect, it } from 'vitest'
import {
  DISPATCH_ENTRIES_MAX,
  DISPATCH_FILE_MAX,
  DISPATCH_INPUT_MAX,
  DISPATCH_STEPS_HEAD,
  DISPATCH_STEPS_MAX,
  capInput,
  capSteps,
  capText,
  pruneEntries,
  summaryOf,
  type DispatchEntry,
  type DispatchStep
} from '../src/dispatch'

const entry = (id: string, startedAt: number, extra: Partial<DispatchEntry> = {}): DispatchEntry => ({
  id,
  parent: null,
  turn: 't1',
  description: 'd',
  subagentType: null,
  prompt: 'p',
  status: 'running',
  now: null,
  usage: { tokens: null, toolUses: null, durationMs: null },
  steps: [],
  report: null,
  startedAt,
  endedAt: null,
  updatedAt: startedAt,
  ...extra
})

describe('capText', () => {
  it('capText keeps the head and counts the rest', () => {
    expect(capText('a'.repeat(25), 20)).toBe('a'.repeat(20) + '… 5 more characters')
  })
  it('leaves text at or under the cap alone', () => {
    const s = 'b'.repeat(20)
    expect(capText(s, 20)).toBe(s)
  })
})

describe('capInput', () => {
  it('capInput leaves small input and cuts big JSON', () => {
    const small = { command: 'ls' }
    expect(capInput(small)).toBe(small)
    const big = { content: 'x'.repeat(DISPATCH_INPUT_MAX + 10) }
    const cut = capInput(big)
    expect(typeof cut).toBe('string')
    expect((cut as string).length).toBe(DISPATCH_INPUT_MAX)
    expect((cut as string).startsWith('{"content":"xxx')).toBe(true)
  })
  it('keeps input that cannot be turned into JSON as null', () => {
    const loop: Record<string, unknown> = {}
    loop.self = loop
    expect(capInput(loop)).toBeNull()
  })
})

describe('capSteps', () => {
  it('capSteps keeps first 50 and newest 950 with a gap marker', () => {
    const steps: DispatchStep[] = Array.from({ length: 1200 }, (_, i) => ({ kind: 'text', text: String(i), ts: i }))
    const out = capSteps(steps)
    expect(out).toHaveLength(DISPATCH_STEPS_MAX + 1)
    expect(out[DISPATCH_STEPS_HEAD - 1]).toEqual({ kind: 'text', text: '49', ts: 49 })
    expect(out[DISPATCH_STEPS_HEAD]).toEqual({ kind: 'gap', dropped: 200, ts: 50 })
    expect(out[DISPATCH_STEPS_HEAD + 1]).toEqual({ kind: 'text', text: '250', ts: 250 })
    expect(out[out.length - 1]).toEqual({ kind: 'text', text: '1199', ts: 1199 })
  })
  it('leaves a short list alone', () => {
    const steps: DispatchStep[] = [{ kind: 'text', text: 'a', ts: 1 }]
    expect(capSteps(steps)).toBe(steps)
  })
  it('adds to an earlier gap instead of making a second one', () => {
    const steps: DispatchStep[] = Array.from({ length: 1200 }, (_, i) => ({ kind: 'text', text: String(i), ts: i }))
    const once = capSteps(steps)
    const more = [...once, ...Array.from({ length: 10 }, (_, i) => ({ kind: 'text' as const, text: `n${i}`, ts: 2000 + i }))]
    const twice = capSteps(more)
    expect(twice).toHaveLength(DISPATCH_STEPS_MAX + 1)
    expect(twice.filter((s) => s.kind === 'gap')).toEqual([{ kind: 'gap', dropped: 210, ts: 50 }])
  })
})

describe('pruneEntries', () => {
  it('pruneEntries keeps newest 200 by startedAt', () => {
    const list = Array.from({ length: DISPATCH_ENTRIES_MAX + 5 }, (_, i) => entry(`e${i}`, 1000 - i))
    const out = pruneEntries(list)
    expect(out).toHaveLength(DISPATCH_ENTRIES_MAX)
    expect(out[0].id).toBe('e0')
    expect(out.some((e) => e.id === `e${DISPATCH_ENTRIES_MAX}`)).toBe(false)
  })
  it('leaves a short list alone', () => {
    const list = [entry('a', 1)]
    expect(pruneEntries(list)).toBe(list)
  })
  it('pruneEntries keeps the newest entries within the byte budget, and always the newest one', () => {
    const big = (id: string, startedAt: number) => entry(id, startedAt, { report: 'r'.repeat(Math.floor(DISPATCH_FILE_MAX / 3)) })
    const out = pruneEntries([big('old', 1), big('mid', 2), big('new', 3), big('newest', 4)])
    expect(out.map((e) => e.id)).toEqual(['new', 'newest'])
    const huge = entry('one', 1, { report: 'r'.repeat(DISPATCH_FILE_MAX + 5) })
    expect(pruneEntries([huge]).map((e) => e.id)).toEqual(['one'])
  })
})

describe('summaryOf', () => {
  it('summaryOf drops steps, prompt, report and lists open tools', () => {
    const e = entry('a', 1, {
      report: 'r',
      steps: [
        { kind: 'text', text: 'hi', ts: 1 },
        { kind: 'tool', id: 'x', name: 'Read', input: {}, result: 'ok', isError: false, ts: 2, doneTs: 3 },
        { kind: 'tool', id: 'y', name: 'Bash', input: {}, result: null, isError: false, ts: 4 }
      ]
    })
    const s = summaryOf(e)
    expect(s).not.toHaveProperty('steps')
    expect(s).not.toHaveProperty('prompt')
    expect(s).not.toHaveProperty('report')
    expect(s.stepCount).toBe(3)
    expect(s.openTools).toEqual(['y'])
    expect(s.id).toBe('a')
  })
})
