import { describe, expect, it } from 'vitest'
import type { ItemRun, RunProgress, Step, Visit, WorkflowRun, WorkflowRunSummary } from '@zumibot/shared/workflows'
import type { StepRunState } from '../src/state/workflowCanvas'
import {
  approvalQuestion,
  canRetry,
  canRetryItem,
  canStop,
  chatBarText,
  costByStep,
  costText,
  durationText,
  edgeRuns,
  fetchOrder,
  groupRunState,
  itemsCountText,
  needsPolling,
  pendingApproval,
  progressText,
  runCostText,
  runHref,
  stepStates,
  summaryKey,
  timeline,
  viaText,
  visitPauseText,
  visitsOf,
  waitsUntil
} from '../src/state/workflowRun'

const base = { handle: 'h', name: 'S', x: 0, y: 0 }
const steps: Step[] = [
  { ...base, id: 't', kind: 'trigger', handle: 'trigger', name: 'Trigger' },
  { ...base, id: 'a', kind: 'approval', handle: 'ok', name: 'OK?', question: 'Go?', editable: true },
  { ...base, id: 'l', kind: 'llm', handle: 'llm', name: 'Summarise', prompt: 'x', model: 'haiku' }
]
let seq = 0
const visit = (stepId: string, n: number, status: Visit['status'], startedAt: number, extra: Partial<Visit> = {}): Visit => ({
  id: `v${++seq}`,
  stepId,
  n,
  status,
  input: `in ${stepId}${n}`,
  inputs: [],
  startedAt,
  ...extra
})
const run = (visits: Visit[], status: WorkflowRun['status'] = 'running', extra: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: 'r1',
  workflowId: 'w1',
  via: 'manual',
  late: false,
  status,
  snapshot: { steps, edges: [] },
  visits,
  inbox: {},
  allowance: { perStep: {}, total: 200 },
  halted: false,
  startedAt: 0,
  ...extra
})

describe('edgeRuns', () => {
  it('counts every delivery a visit started from and every one still waiting, by edge', () => {
    const d = (edgeId: string, from: string) => ({ edgeId, from, text: 'x' })
    const r = run(
      [
        visit('a', 1, 'done', 1, { inputs: [d('e1', 't')] }),
        visit('l', 1, 'done', 2, { inputs: [d('e2', 'a'), d('e3', 'x')] }),
        visit('l', 2, 'running', 3, { inputs: [d('e2', 'a')] })
      ],
      'running',
      { inbox: { l: [d('e2', 'a')], a: [d('e4', 'l')] } }
    )
    expect(edgeRuns(r)).toEqual({ e1: 1, e2: 3, e3: 1, e4: 1 })
  })
  it('is empty for a run that carried nothing yet', () => {
    expect(edgeRuns(run([visit('t', 1, 'running', 1)]))).toEqual({})
  })
})

describe('stepStates', () => {
  it('has the latest visit status and the visit count of each step that ran', () => {
    const r = run([visit('t', 1, 'done', 1), visit('l', 1, 'running', 2)])
    expect(stepStates(r)).toEqual({ t: { status: 'done', visits: 1 }, l: { status: 'running', visits: 1 } })
  })
  it('counts a looped step three times and shows its last visit', () => {
    const r = run([visit('l', 1, 'done', 1), visit('l', 2, 'done', 2), visit('l', 3, 'waiting', 3)])
    expect(stepStates(r).l).toEqual({ status: 'waiting', visits: 3 })
  })
  it('shows done for a failed visit that a later one got past', () => {
    const r = run([visit('l', 1, 'failed', 1, { error: 'x' }), visit('l', 2, 'done', 2)])
    expect(stepStates(r).l).toEqual({ status: 'done', visits: 2 })
  })
  it('leaves steps that never ran out', () => {
    expect(stepStates(run([]))).toEqual({})
  })
  it('shows an open visit the user paused as paused', () => {
    expect(stepStates(run([visit('l', 1, 'running', 1, { paused: true })])).l).toEqual({ status: 'paused', visits: 1 })
    expect(stepStates(run([visit('l', 1, 'stopped', 1, { paused: true })])).l).toEqual({ status: 'stopped', visits: 1 })
  })
  it('shows a For each visit paused while its item in hand is paused, and running once Resume carried it on', () => {
    const items = (i2: Partial<ItemRun>): ItemRun[] => [
      { id: 'i1', n: 1, text: 'a', status: 'failed', paused: true },
      { id: 'i2', n: 2, text: 'b', status: 'running', ...i2 }
    ]
    expect(stepStates(run([visit('f', 1, 'running', 1, { items: items({ paused: true }) })])).f).toEqual({ status: 'paused', visits: 1 })
    // An ended item's leftover flag (Continued by hand) pauses nothing.
    expect(stepStates(run([visit('f', 1, 'running', 1, { items: items({ resumes: 1 }) })])).f).toEqual({ status: 'running', visits: 1 })
    expect(stepStates(run([visit('f', 1, 'stopped', 1, { items: items({ status: 'stopped', paused: true }) })])).f).toEqual({
      status: 'stopped',
      visits: 1
    })
  })
  it('shows a For each visit running while one of several open items still runs', () => {
    const items: ItemRun[] = [
      { id: 'i1', n: 1, text: 'a', status: 'running', paused: true },
      { id: 'i2', n: 2, text: 'b', status: 'running' }
    ]
    expect(stepStates(run([visit('f', 1, 'running', 1, { items })])).f).toEqual({ status: 'running', visits: 1 })
    const both = items.map((i) => ({ ...i, paused: true as const }))
    expect(stepStates(run([visit('f', 1, 'running', 1, { items: both })])).f).toEqual({ status: 'paused', visits: 1 })
  })
})

describe('visitPauseText', () => {
  it('says how to go on with a paused visit, then that it was resumed', () => {
    expect(visitPauseText(visit('l', 1, 'running', 1, { paused: true }))).toBe('Paused by you · press Resume in its chat to continue')
    expect(visitPauseText(visit('l', 1, 'running', 1, { resumes: 1 }))).toBe('Resumed after a pause')
    expect(visitPauseText(visit('l', 1, 'done', 1, { resumes: 2 }))).toBe('Resumed after 2 pauses')
  })
  it('says a Room visit hit its turn limit', () => {
    expect(visitPauseText(visit('r', 1, 'waiting', 1, { capped: true }))).toBe('Room hit its turn limit · post in the room to continue')
  })
  it('says the turn limit only while the visit is open', () => {
    expect(visitPauseText(visit('r', 1, 'running', 1, { capped: true }))).toBe('Room hit its turn limit · post in the room to continue')
    expect(visitPauseText(visit('r', 1, 'failed', 1, { capped: true }))).toBeNull()
    expect(visitPauseText(visit('r', 1, 'stopped', 1, { capped: true }))).toBeNull()
    expect(visitPauseText(visit('r', 1, 'done', 1, { capped: true }))).toBeNull()
  })
  it('is null for a visit never paused, and for a stopped one that was', () => {
    expect(visitPauseText(visit('l', 1, 'running', 1))).toBeNull()
    expect(visitPauseText(visit('l', 1, 'stopped', 1, { paused: true }))).toBeNull()
  })
  it('says the same for a For each item, and nothing on its visit, whose items each say it', () => {
    const paused: ItemRun = { id: 'i1', n: 1, text: 'a', status: 'running', paused: true }
    expect(visitPauseText(paused)).toBe('Paused by you · press Resume in its chat to continue')
    expect(visitPauseText({ ...paused, status: 'done', paused: undefined, resumes: 1 })).toBe('Resumed after a pause')
    expect(visitPauseText({ ...paused, status: 'pending', paused: undefined })).toBeNull()
    expect(visitPauseText(visit('f', 1, 'running', 1, { items: [paused] }))).toBeNull()
  })
})

describe('visitsOf', () => {
  it('lists one step newest first', () => {
    const v1 = visit('l', 1, 'done', 1),
      v2 = visit('l', 2, 'done', 2),
      other = visit('t', 1, 'done', 0)
    expect(visitsOf(run([other, v1, v2]), 'l')).toEqual([v2, v1])
    expect(visitsOf(run([other]), 'l')).toEqual([])
  })
})

describe('timeline', () => {
  it('orders every visit by start time and keeps arrival order on a tie', () => {
    const a = visit('t', 1, 'done', 5),
      b = visit('l', 1, 'done', 1),
      c = visit('a', 1, 'done', 5)
    expect(timeline(run([a, b, c]))).toEqual([b, a, c])
  })
  it('does not reorder the run', () => {
    const r = run([visit('t', 1, 'done', 5), visit('l', 1, 'done', 1)])
    const before = r.visits.map((v) => v.id)
    timeline(r)
    expect(r.visits.map((v) => v.id)).toEqual(before)
  })
})

describe('pendingApproval', () => {
  it('chooses the oldest waiting approval visit', () => {
    const late = visit('a', 2, 'waiting', 9),
      early = visit('a', 1, 'waiting', 3)
    expect(pendingApproval(run([late, early], 'waiting'))).toBe(early)
  })
  it('ignores answered visits and waiting steps that are not approvals', () => {
    const r = run([visit('a', 1, 'done', 1), visit('l', 1, 'waiting', 2)], 'waiting')
    expect(pendingApproval(r)).toBeNull()
  })
  it('is null for an ended run, whatever its visits say', () => {
    expect(pendingApproval(run([visit('a', 1, 'waiting', 1)], 'stopped'))).toBeNull()
  })
})

describe('canRetry', () => {
  it('is true for a failed visit that is its step latest', () => {
    const f = visit('l', 1, 'failed', 1)
    expect(canRetry(run([f], 'failed'), f)).toBe(true)
  })
  it('is false on an old failure that a later visit got past', () => {
    const old = visit('l', 1, 'failed', 1),
      done = visit('l', 2, 'done', 2)
    const r = run([old, done], 'done')
    expect(canRetry(r, old)).toBe(false)
    expect(canRetry(r, done)).toBe(false)
  })
  it('is false for a visit that did not fail', () => {
    const v = visit('l', 1, 'done', 1)
    expect(canRetry(run([v]), v)).toBe(false)
  })
  it('is false once the run was stopped or skipped', () => {
    const f = visit('l', 1, 'failed', 1)
    expect(canRetry(run([f], 'stopped'), f)).toBe(false)
  })
  it('is true while other steps still run', () => {
    const f = visit('l', 1, 'failed', 1)
    expect(canRetry(run([f, visit('t', 1, 'running', 2)], 'running'), f)).toBe(true)
  })
})

describe('canStop', () => {
  it('is for a running or waiting run only', () => {
    expect(canStop(run([], 'running'))).toBe(true)
    expect(canStop(run([], 'waiting'))).toBe(true)
    for (const s of ['done', 'failed', 'stopped', 'skipped'] as const) expect(canStop(run([], s))).toBe(false)
  })
})

describe('needsPolling', () => {
  it('is on while an unfinished run has a running visit', () => {
    expect(needsPolling(run([visit('l', 1, 'running', 1)]))).toBe(true)
  })
  it('is off for a run only waiting on the user, and for an ended run', () => {
    expect(needsPolling(run([visit('a', 1, 'waiting', 1)], 'waiting'))).toBe(false)
    expect(needsPolling(run([visit('l', 1, 'running', 1, { paused: true })]))).toBe(false) // Resume pushes a change
    expect(needsPolling(run([visit('l', 1, 'running', 1)], 'stopped'))).toBe(false)
  })
  it('is off for a running For each visit, which the pushed progress follows; a running plain visit beside it still polls', () => {
    const items: ItemRun[] = [
      { id: 'i1', n: 1, text: 'a', status: 'done', output: 'x' },
      { id: 'i2', n: 2, text: 'b', status: 'running' },
      { id: 'i3', n: 3, text: 'c', status: 'pending' }
    ]
    const each = visit('l', 1, 'running', 1, { items })
    expect(needsPolling(run([each]))).toBe(false)
    expect(needsPolling(run([each, visit('a', 1, 'running', 2)]))).toBe(true)
    // A paused item changes nothing: its pause and its Resume are in the pushed progress too.
    expect(
      needsPolling(run([visit('l', 1, 'running', 1, { items: items.map((i) => (i.id === 'i2' ? { ...i, paused: true as const } : i)) })]))
    ).toBe(false)
  })
})

describe('summaryKey', () => {
  const s = (extra: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary => ({
    id: 'r1',
    workflowId: 'w1',
    via: 'manual',
    status: 'running',
    late: false,
    startedAt: 0,
    waiting: [],
    failed: [],
    ...extra
  })
  it('changes with the status, the waiting steps, the failed steps and the end', () => {
    const k = summaryKey(s())
    expect(summaryKey(s())).toBe(k)
    expect(summaryKey(s({ status: 'waiting' }))).not.toBe(k)
    expect(summaryKey(s({ waiting: ['a'] }))).not.toBe(k)
    expect(summaryKey(s({ failed: ['l'] }))).not.toBe(k)
    expect(summaryKey(s({ endedAt: 5 }))).not.toBe(k)
    expect(summaryKey(s({ costUsd: 0.2 }))).not.toBe(k) // a cost that lands after the run ended
    expect(summaryKey(s({ progress: [{ stepId: 'f', done: 1, failed: 0, total: 3, current: 'a' }] }))).not.toBe(k)
    const p = (extra: Partial<RunProgress> = {}): WorkflowRunSummary =>
      s({ progress: [{ stepId: 'f', done: 1, failed: 0, total: 3, current: 'a', ...extra }] })
    expect(summaryKey(p())).toBe(summaryKey(p()))
    expect(summaryKey(p({ current: 'b' }))).not.toBe(summaryKey(p()))
    expect(summaryKey(p({ done: 2 }))).not.toBe(summaryKey(p()))
    expect(summaryKey(p({ failed: 1 }))).not.toBe(summaryKey(p()))
    expect(summaryKey(p({ paused: true }))).not.toBe(summaryKey(p())) // an item paused, or carried on by Resume
  })
  it('is empty without a summary', () => {
    expect(summaryKey(undefined)).toBe('')
  })
})

describe('run cost', () => {
  it('shows nothing when no visit reported a cost', () => {
    expect(costText(undefined)).toBeNull()
    expect(costText(0)).toBeNull()
    expect(runCostText(run([visit('t', 1, 'done', 1), visit('a', 1, 'done', 2)], 'done'))).toBeNull()
  })
  it('sums every visit, says so far while the run can still spend, and plain once it ended', () => {
    const visits = [visit('l', 1, 'failed', 1, { costUsd: 0.012 }), visit('l', 2, 'done', 2, { costUsd: 0.5 }), visit('a', 1, 'done', 3)]
    expect(runCostText(run(visits, 'running'))).toBe('$0.51 so far')
    expect(runCostText(run(visits, 'waiting'))).toBe('$0.51 so far')
    expect(runCostText(run(visits, 'done'))).toBe('$0.51')
    expect(runCostText(run(visits, 'stopped'))).toBe('$0.51')
    expect(costText(0.004)).toBe('$0.0040')
  })
  it('splits the cost by step, the costliest first, counting the visits that paid', () => {
    const r = run(
      [
        visit('l', 1, 'done', 1, { costUsd: 0.1 }),
        visit('x', 1, 'done', 2, { costUsd: 0.3 }),
        visit('l', 2, 'done', 3, { costUsd: 0.1 }),
        visit('l', 3, 'stopped', 4),
        visit('a', 1, 'done', 5)
      ],
      'done'
    )
    expect(costByStep(r)).toEqual([
      { stepId: 'x', usd: 0.3, visits: 1 },
      { stepId: 'l', usd: 0.2, visits: 2 }
    ])
    expect(costByStep(run([visit('a', 1, 'done', 1)]))).toEqual([])
  })
})

describe('chat bar', () => {
  const link = { workflowId: 'w 1', runId: 'r/1', stepId: 'l', name: 'Nightly' }
  it('names the step and the workflow, and links to the run address', () => {
    expect(chatBarText(link, 'Summarise')).toEqual({ lead: 'Step "Summarise" of workflow Nightly', href: '/workflows/w%201/runs/r%2F1' })
  })
  it('falls back when the step is gone from the workflow', () => {
    expect(chatBarText(link, undefined).lead).toBe('A step of workflow Nightly')
    expect(chatBarText(link, '  ').lead).toBe('A step of workflow Nightly')
  })
  it('names the item when the chat belongs to one', () => {
    expect(chatBarText({ ...link, name: 'W5 audit', item: { n: 3, total: 36 } }, 'Scan').lead).toBe(
      'Item 3 of 36 · Step "Scan" of workflow W5 audit'
    )
    expect(chatBarText({ ...link, name: 'W5 audit', item: { n: 3, total: 36 } }, undefined).lead).toBe(
      'Item 3 of 36 · A step of workflow W5 audit'
    )
  })
  it('runHref is the route the app serves', () => {
    expect(runHref('w1', 'r1')).toBe('/workflows/w1/runs/r1')
  })
})

describe('durationText', () => {
  it('reads seconds, minutes and hours of an ended visit', () => {
    expect(durationText(0, 400)).toBe('<1 s')
    expect(durationText(0, 2300)).toBe('2 s')
    expect(durationText(0, 65_000)).toBe('1 min 5 s')
    expect(durationText(0, 3_600_000 + 120_000)).toBe('1 h 2 min')
  })
  it('never goes negative', () => {
    expect(durationText(10, 5)).toBe('<1 s')
  })
})

describe('approvalQuestion', () => {
  const step = (question: string) => ({ ...base, id: 'a', kind: 'approval' as const, question, editable: true })
  it('shows the question as the visit filled it, not the template', () => {
    expect(
      approvalQuestion(visit('a', 1, 'waiting', 1, { question: 'Post on "Login broken"?' }), step('Post on "{{trigger.body.title}}"?'))
    ).toBe('Post on "Login broken"?')
  })
  it('falls back to the step question for a visit stored before the filled one was kept', () => {
    expect(approvalQuestion(visit('a', 1, 'waiting', 1), step('Ship it?'))).toBe('Ship it?')
  })
  it('asks Approve? when the question is empty either way', () => {
    expect(approvalQuestion(visit('a', 1, 'waiting', 1, { question: ' ' }), step('{{trigger.text}}'))).toBe('Approve?')
    expect(approvalQuestion(visit('a', 1, 'waiting', 1), step(''))).toBe('Approve?')
  })
})

describe('waitsUntil', () => {
  it('is the due time of an open visit that holds one: a running Wait, a limit wait, a waiting visit', () => {
    expect(waitsUntil(visit('w', 1, 'running', 1, { until: 500 }))).toBe(500)
    expect(waitsUntil(visit('w', 1, 'waiting', 1, { until: 600 }))).toBe(600)
  })
  it('is null once the visit ended, or when it holds no due time', () => {
    expect(waitsUntil(visit('w', 1, 'done', 1, { until: 500 }))).toBeNull()
    expect(waitsUntil(visit('w', 1, 'stopped', 1, { until: 500 }))).toBeNull()
    expect(waitsUntil(visit('l', 1, 'running', 1))).toBeNull()
  })
})

describe('fetchOrder', () => {
  it('shows a slow answer when nothing newer landed, and skips poll ticks while a fetch is out', () => {
    const o = fetchOrder()
    const a = o.start()
    expect(o.busy()).toBe(true) // the poll skips this tick instead of superseding the slow fetch
    expect(o.land(a)).toBe(true)
    expect(o.busy()).toBe(false)
  })
  it('drops an answer older than the one already shown', () => {
    const o = fetchOrder()
    const old = o.start()
    const fresh = o.start()
    expect(o.land(fresh)).toBe(true)
    expect(o.land(old)).toBe(false)
    expect(o.busy()).toBe(false)
  })
  it('keeps an older answer that lands first, then the newer one', () => {
    const o = fetchOrder()
    const old = o.start()
    const fresh = o.start()
    expect(o.land(old)).toBe(true)
    expect(o.busy()).toBe(true)
    expect(o.land(fresh)).toBe(true)
  })
  it('after a reset, answers to earlier fetches are dropped and no longer count as out', () => {
    const o = fetchOrder()
    const before = o.start()
    o.reset()
    expect(o.busy()).toBe(false)
    expect(o.land(before)).toBe(false)
    const after = o.start()
    expect(o.land(after)).toBe(true)
  })
})

describe('groupRunState', () => {
  const st = (status: StepRunState['status']): StepRunState => ({ status, visits: 1 })
  it('groupRunState: failed beats waiting beats running beats done', () => {
    expect(groupRunState({ a: st('done'), b: st('failed') }, ['a', 'b'])).toBe('failed')
    expect(groupRunState({ a: st('paused'), b: st('running') }, ['a', 'b'])).toBe('waiting')
    expect(groupRunState({ a: st('running'), b: st('done') }, ['a', 'b'])).toBe('running')
    expect(groupRunState({ a: st('done') }, ['a', 'b'])).toBe('done')
    expect(groupRunState({}, ['a', 'b'])).toBeNull()
  })
  it('counts only the group steps, shows waiting for a waiting step, and nothing once a step was stopped', () => {
    expect(groupRunState({ a: st('waiting'), b: st('running') }, ['a', 'b'])).toBe('waiting')
    expect(groupRunState({ a: st('done'), z: st('failed') }, ['a', 'b'])).toBe('done')
    expect(groupRunState({ a: st('done'), b: st('stopped') }, ['a', 'b'])).toBeNull()
    expect(groupRunState({ a: st('idle') }, ['a', 'b'])).toBeNull()
    expect(groupRunState({ a: st('failed'), b: st('stopped') }, ['a', 'b'])).toBe('failed')
  })
})

describe('progressText', () => {
  it('counts the item in hand, with its name when known', () => {
    expect(progressText({ stepId: 'f', done: 2, failed: 0, total: 36, current: 'Gallery View' })).toBe('3 / 36 · Gallery View')
    expect(progressText({ stepId: 'f', done: 2, failed: 0, total: 36, current: null })).toBe('2 / 36')
  })
  it('counts failed items as ended, since the run goes on past them', () => {
    expect(progressText({ stepId: 'f', done: 2, failed: 1, total: 36, current: 'X' })).toBe('4 / 36 · X')
    expect(progressText({ stepId: 'f', done: 2, failed: 1, total: 36, current: null })).toBe('3 / 36')
  })
  it('says when the item in hand is paused', () => {
    expect(progressText({ stepId: 'f', done: 2, failed: 0, total: 36, current: 'Inbox', paused: true })).toBe('3 / 36 · Inbox · paused')
  })
  it('counts several items in hand instead of naming one, and how many of them are paused', () => {
    expect(progressText({ stepId: 'f', done: 2, failed: 1, total: 36, current: 'Inbox', running: 3 })).toBe('6 / 36 · 3 running')
    expect(progressText({ stepId: 'f', done: 2, failed: 0, total: 36, current: 'Inbox', running: 2, paused: true, pausedItems: 1 })).toBe(
      '4 / 36 · 2 running · 1 paused'
    )
  })
})

const item = (n: number, status: ItemRun['status'], extra: Partial<ItemRun> = {}): ItemRun => ({
  id: `i${n}`,
  n,
  text: `t${n}`,
  status,
  ...extra
})

describe('itemsCountText', () => {
  it('lists done, failed and to go, leaving out zero parts but done', () => {
    const items = [
      ...Array.from({ length: 31 }, (_, i) => item(i, 'done')),
      item(40, 'failed'),
      item(41, 'failed'),
      item(42, 'pending'),
      item(43, 'pending'),
      item(44, 'pending')
    ]
    expect(itemsCountText(items)).toBe('31 done · 2 failed · 3 to go')
    // a running or waiting item is in no part
    expect(
      itemsCountText([
        ...Array.from({ length: 31 }, (_, i) => item(i, 'done')),
        item(40, 'failed'),
        item(41, 'failed'),
        item(42, 'running'),
        item(43, 'pending'),
        item(44, 'pending')
      ])
    ).toBe('31 done · 2 failed · 2 to go')
    expect(itemsCountText([item(1, 'done')])).toBe('1 done')
    expect(itemsCountText([item(1, 'done'), item(2, 'pending')])).toBe('1 done · 1 to go')
  })
})

describe('canRetryItem', () => {
  const v = visit('l', 1, 'failed', 1)
  it('is for a failed item, carried or not, of a visit canRetry allows', () => {
    const r = run([v], 'failed')
    expect(canRetryItem(r, v, item(1, 'failed'))).toBe(true)
    expect(canRetryItem(r, v, item(1, 'failed', { carried: true }))).toBe(true)
    expect(canRetryItem(r, v, item(1, 'done'))).toBe(false)
    expect(canRetryItem(r, v, item(1, 'pending'))).toBe(false)
  })
  it('is false when the visit cannot be retried', () => {
    const d = visit('l', 1, 'done', 1)
    expect(canRetryItem(run([d], 'done'), d, item(1, 'failed'))).toBe(false)
    expect(canRetryItem(run([v], 'stopped'), v, item(1, 'failed'))).toBe(false)
  })
})

describe('viaText', () => {
  it('names the event of an event run and keeps the plain words for the rest', () => {
    expect(viaText({ via: 'event', event: { kind: 'todo' } })).toBe('To-do added')
    expect(viaText({ via: 'event' })).toBe('Event')
    expect(viaText({ via: 'chat' })).toBe('From chat')
    expect(viaText({ via: 'webhook' })).toBe('Webhook')
  })
})
