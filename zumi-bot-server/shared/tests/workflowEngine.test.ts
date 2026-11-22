import { describe, expect, it } from 'vitest'
import { capHit, deliver, joinText, newState, outcome, retryAllowance, takeStarts } from '../src/workflowEngine'
import type { EngineState } from '../src/workflowEngine'
import { RUN_VISITS_MAX, STEP_VISITS_MAX } from '../src/workflows'
import type { Delivery, Edge, Step, Visit } from '../src/workflows'

const pos = { x: 0, y: 0 }
const step = (id: string): Step => ({ id, kind: id === 't' ? 'trigger' : 'wait', handle: id, name: id, minutes: 1, ...pos }) as Step
const edge = (from: string, to: string, port: Edge['port'] = 'out'): Edge => ({ id: `${from}-${to}`, from, port, to })
const wf = (ids: string[], edges: Edge[]) => newState({ steps: ids.map(step), edges })
let seq = 0
const visit = (stepId: string, status: Visit['status'], over: Partial<Visit> = {}): Visit => ({
  id: `v${++seq}`,
  stepId,
  n: 1,
  status,
  input: '',
  inputs: [],
  output: `${stepId} out`,
  port: 'out',
  startedAt: 0,
  ...over
})
const withVisits = (s: EngineState, ...vs: Visit[]): EngineState => ({ ...s, visits: [...s.visits, ...vs] })
const ids = (r: ReturnType<typeof takeStarts>) => r.starts.map((x) => x.stepId)

// A and B each hold one input and miss another that the other can still produce (via q and r).
const mutual = [edge('A', 'B'), edge('B', 'A'), edge('B', 'q'), edge('q', 'A'), edge('A', 'r'), edge('r', 'B')]
const mutualInbox = { A: [{ edgeId: 'B-A', from: 'B', text: 'b' }], B: [{ edgeId: 'A-B', from: 'A', text: 'a' }] }

describe('takeStarts', () => {
  it('fan-out starts both targets', () => {
    let s = wf(['t', 'A', 'B'], [edge('t', 'A'), edge('t', 'B')])
    const t = visit('t', 'done')
    s = deliver(withVisits(s, t), t)
    const r = takeStarts(s)
    expect(ids(r)).toEqual(['A', 'B'])
    expect(r.starts[0].inputs).toEqual([{ edgeId: 't-A', from: 't', text: 't out' }])
    expect(r.state.inbox.A).toEqual([])
    expect(s.inbox.A).toHaveLength(1) // the input state is not mutated
  })

  it('join waits for a running branch', () => {
    const edges = [edge('A', 'J'), edge('B', 'J')]
    const a = visit('A', 'done')
    let s = deliver(withVisits(wf(['A', 'B', 'J'], edges), a, visit('B', 'running')), a)
    expect(ids(takeStarts(s))).toEqual([])
    const b = visit('B', 'done')
    s = deliver(withVisits({ ...s, visits: s.visits.filter((v) => v.stepId !== 'B') }, b), b)
    const r = takeStarts(s)
    expect(ids(r)).toEqual(['J'])
    expect(r.starts[0].inputs.map((i) => i.from)).toEqual(['A', 'B'])
  })

  it('join inputs are in edge order, not arrival order', () => {
    const edges = [edge('A', 'J'), edge('B', 'J')]
    const b = visit('B', 'done')
    let s = deliver(withVisits(wf(['A', 'B', 'J'], edges), b, visit('A', 'running')), b)
    const a = visit('A', 'done')
    s = deliver(withVisits({ ...s, visits: s.visits.filter((v) => v.stepId !== 'A') }, a), a)
    expect(s.inbox.J.map((d) => d.from)).toEqual(['B', 'A']) // arrival order in the inbox itself
    const r = takeStarts(s)
    expect(r.starts[0].inputs.map((i) => i.from)).toEqual(['A', 'B'])
    expect(joinText(r.starts[0].inputs, { A: 'Alpha', B: 'Beta' })).toBe('From Alpha:\nA out\n\nFrom Beta:\nB out')
    expect(s.inbox.J.map((d) => d.from)).toEqual(['B', 'A']) // input state not mutated
  })

  it('repeat deliveries on one edge keep arrival order', () => {
    const edges = [edge('A', 'J')]
    const s: EngineState = {
      ...wf(['A', 'J'], edges),
      inbox: {
        J: [
          { edgeId: 'A-J', from: 'A', text: '1' },
          { edgeId: 'A-J', from: 'A', text: '2' }
        ]
      }
    }
    expect(takeStarts(s).starts[0].inputs.map((i) => i.text)).toEqual(['1', '2'])
  })

  it('branch not taken does not block join', () => {
    const edges = [edge('C', 'X', 'yes'), edge('C', 'Y', 'no'), edge('X', 'J'), edge('Y', 'J')]
    const c = visit('C', 'done', { port: 'yes' })
    let s = deliver(withVisits(wf(['C', 'X', 'Y', 'J'], edges), c), c)
    const first = takeStarts(s)
    expect(ids(first)).toEqual(['X'])
    s = first.state
    const x = visit('X', 'done')
    s = deliver(withVisits(s, x), x)
    const r = takeStarts(s)
    expect(ids(r)).toEqual(['J'])
    expect(r.starts[0].inputs).toHaveLength(1)
  })

  it('loop restarts a step', () => {
    const edges = [edge('t', 'A'), edge('A', 'C'), edge('C', 'W', 'no'), edge('W', 'A')]
    let s = wf(['t', 'A', 'C', 'W'], edges)
    const t = visit('t', 'done')
    s = deliver(withVisits(s, t), t)
    s = takeStarts(s).state
    const a1 = visit('A', 'done')
    s = deliver(withVisits(s, a1), a1)
    s = takeStarts(s).state
    const c = visit('C', 'done', { port: 'no' })
    s = deliver(withVisits(s, c), c)
    s = takeStarts(s).state
    const w = visit('W', 'done')
    s = deliver(withVisits(s, w), w)
    const r = takeStarts(s)
    expect(ids(r)).toEqual(['A'])
    expect(r.starts[0].inputs[0].from).toBe('W')
    // the engine does not count visits itself: the caller numbers the new visit
    expect(s.visits.filter((v) => v.stepId === 'A').length + 1).toBe(2)
  })

  it('one visit at a time', () => {
    const t = visit('t', 'done')
    const s = deliver(withVisits(wf(['t', 'A'], [edge('t', 'A')]), t, visit('A', 'running')), t)
    const r = takeStarts(s)
    expect(ids(r)).toEqual([])
    expect(r.state.inbox.A).toHaveLength(1) // kept for after that visit
  })

  it('pass 2 breaks mutual wait', () => {
    const s: EngineState = { ...wf(['A', 'B', 'q', 'r'], mutual), inbox: mutualInbox }
    expect(ids(takeStarts(s)).sort()).toEqual(['A', 'B'])
  })

  it('pass 2 does not fire while something is live', () => {
    const s = withVisits({ ...wf(['A', 'B', 'q', 'r', 'L'], mutual), inbox: mutualInbox }, visit('L', 'running'))
    expect(ids(takeStarts(s))).toEqual([])
  })

  it('halted starts nothing', () => {
    const t = visit('t', 'done')
    const s = deliver(withVisits({ ...wf(['t', 'A'], [edge('t', 'A')]), halted: true }, t), t)
    const r = takeStarts(s)
    expect(r.starts).toEqual([])
    expect(r.state.inbox.A).toHaveLength(1)
  })
})

describe('capHit and retryAllowance', () => {
  const many = (stepId: string, n: number) => Array.from({ length: n }, () => visit(stepId, 'done'))

  it('capHit at 20 per step and 200 per run', () => {
    const s = wf(['A', 'B'], [])
    expect(capHit(withVisits(s, ...many('A', STEP_VISITS_MAX - 1)), 'A')).toBe(false)
    expect(capHit(withVisits(s, ...many('A', STEP_VISITS_MAX)), 'A')).toBe(true)
    expect(capHit(withVisits(s, ...many('A', STEP_VISITS_MAX)), 'B')).toBe(false)
    const spread = withVisits(s, ...Array.from({ length: 10 }, (_, i) => many(`s${i}`, 19)).flat(), ...many('B', 9))
    expect(spread.visits).toHaveLength(RUN_VISITS_MAX - 1)
    expect(capHit(spread, 'B')).toBe(false)
    expect(capHit(withVisits(spread, visit('B', 'done')), 'B')).toBe(true)
  })

  it('retryAllowance gives 20 more and 200 more', () => {
    const s = withVisits({ ...wf(['A'], []), halted: true }, ...many('A', STEP_VISITS_MAX))
    expect(capHit(s, 'A')).toBe(true)
    const r = retryAllowance(s, 'A')
    expect(r.allowance.perStep.A).toBe(STEP_VISITS_MAX * 2)
    expect(r.allowance.total).toBe(STEP_VISITS_MAX + RUN_VISITS_MAX)
    expect(r.halted).toBe(false)
    expect(capHit(r, 'A')).toBe(false)
    expect(s.halted).toBe(true)
    expect(s.allowance).toEqual({ perStep: {}, total: RUN_VISITS_MAX })
  })

  it('one Retry of a capped loop A→C→A gives every step at its allowance 20 more rounds, not only the retried one', () => {
    // A failed its 21st visit at the cap; C ran 20 times, so it is at its allowance too. B ran less and is left alone.
    const loop = wf(['t', 'A', 'C', 'B'], [edge('t', 'A'), edge('A', 'C'), edge('C', 'A', 'no'), edge('C', 'B', 'yes')])
    const s = withVisits(
      { ...loop, halted: true },
      visit('t', 'done'),
      ...many('A', STEP_VISITS_MAX),
      visit('A', 'failed'),
      ...many('C', STEP_VISITS_MAX),
      ...many('B', 3)
    )
    let r = retryAllowance(s, 'A')
    expect(r.allowance.perStep).toEqual({ A: STEP_VISITS_MAX + 1 + STEP_VISITS_MAX, C: STEP_VISITS_MAX * 2 })
    expect(r.allowance.total).toBe(s.visits.length + RUN_VISITS_MAX)
    // 20 more rounds of the loop fit, and the 21st round's A hits the cap again.
    for (let round = 0; round < STEP_VISITS_MAX; round++) {
      expect(capHit(r, 'A')).toBe(false)
      r = withVisits(r, visit('A', 'done'))
      expect(capHit(r, 'C')).toBe(false)
      r = withVisits(r, visit('C', 'done'))
    }
    expect(capHit(r, 'A')).toBe(true)
    expect(capHit(r, 'C')).toBe(true)
    expect(capHit(r, 'B')).toBe(false)
  })

  it("a later Retry raises the allowance again from each capped step's own count", () => {
    const s = withVisits(
      { ...wf(['A', 'C'], []), allowance: { perStep: { A: 40, C: 40 }, total: 400 }, halted: true },
      ...many('A', 41),
      ...many('C', 25)
    )
    expect(retryAllowance(s, 'A').allowance.perStep).toEqual({ A: 61, C: 40 })
  })
})

describe('outcome', () => {
  it('running visit is running', () => {
    expect(outcome(withVisits(wf(['A', 'B'], []), visit('A', 'running'), visit('B', 'waiting')))).toBe('running')
  })
  it('only a waiting visit is waiting', () => {
    expect(outcome(withVisits(wf(['A'], []), visit('A', 'waiting')))).toBe('waiting')
  })
  it('a pending inbox that can fire keeps the run running', () => {
    const t = visit('t', 'done')
    expect(outcome(deliver(withVisits(wf(['t', 'A'], [edge('t', 'A')]), t), t))).toBe('running')
  })
  it('nothing live with a failed latest visit is failed', () => {
    expect(outcome(withVisits({ ...wf(['A', 'B'], []), halted: true }, visit('A', 'done'), visit('B', 'failed')))).toBe('failed')
  })
  it('a failed visit followed by a done one is done', () => {
    expect(outcome(withVisits(wf(['A'], []), visit('A', 'failed'), visit('A', 'done', { n: 2 })))).toBe('done')
  })
  it('a halted run with an unfired inbox is failed, not running', () => {
    const t = visit('t', 'done')
    const s = deliver(withVisits({ ...wf(['t', 'A', 'B'], [edge('t', 'A')]), halted: true }, t, visit('B', 'failed')), t)
    expect(outcome(s)).toBe('failed')
  })
  it('finished run is done', () => {
    expect(outcome(withVisits(wf(['A'], []), visit('A', 'done')))).toBe('done')
  })
})

describe('ids named like Object.prototype members', () => {
  // The server refuses such ids; the engine still reads its maps by own keys only, so one could never break a run.
  it('deliver, takeStarts, capHit and joinText treat them as plain keys', () => {
    const t = visit('t', 'done')
    const s = deliver(withVisits(wf(['t', 'constructor', 'toString'], [edge('t', 'constructor'), edge('t', 'toString')]), t), t)
    expect(s.inbox.constructor).toEqual([{ edgeId: 't-constructor', from: 't', text: 't out' }])
    expect(ids(takeStarts(s))).toEqual(['constructor', 'toString'])
    expect(capHit(s, 'constructor')).toBe(false)
    const capped = withVisits(s, ...Array.from({ length: STEP_VISITS_MAX }, () => visit('valueOf', 'done')))
    expect(capHit(capped, 'valueOf')).toBe(true)
    const d = (from: string, text: string): Delivery => ({ edgeId: `${from}-J`, from, text })
    expect(joinText([d('constructor', 'one'), d('toString', 'two')], {})).toBe('From constructor:\none\n\nFrom toString:\ntwo')
  })
})

describe('joinText', () => {
  const d = (from: string, text: string): Delivery => ({ edgeId: `${from}-J`, from, text })
  it('single input unchanged', () => {
    expect(joinText([d('a', 'hello\nworld')], { a: 'Alpha' })).toBe('hello\nworld')
  })
  it('two inputs labelled in order', () => {
    expect(joinText([d('a', 'one'), d('b', 'two')], { a: 'Alpha', b: 'Beta' })).toBe('From Alpha:\none\n\nFrom Beta:\ntwo')
  })
  it('falls back to the id for an unknown name', () => {
    expect(joinText([d('a', 'one'), d('z', 'two')], { a: 'Alpha' })).toBe('From Alpha:\none\n\nFrom z:\ntwo')
  })
})
