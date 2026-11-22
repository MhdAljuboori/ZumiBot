import { describe, expect, it } from 'vitest'
import type { ItemRun, Step, Visit, WorkflowRun } from '@zumibot/shared/workflows'
import { CONDITION_TEXT } from '@zumibot/shared/workflows'
import { auditLog, clockTime, foldText, FOLD_CHARS } from '../src/state/auditLog'

const base = { handle: 'h', name: 'S', x: 0, y: 0 }
const steps: Step[] = [
  { ...base, id: 't', kind: 'trigger', handle: 'trigger', name: 'Trigger' },
  { ...base, id: 'c', kind: 'condition', handle: 'cond', name: 'Is it?', prompt: 'x', model: 'haiku' },
  { ...base, id: 'l', kind: 'llm', handle: 'llm', name: ' Summarise ', prompt: 'x', model: 'haiku' },
  { ...base, id: 'a', kind: 'approval', handle: 'ok', name: 'OK?', question: 'Go?', editable: true },
  { ...base, id: 'w', kind: 'wait', handle: 'wait', name: '', minutes: 5 },
  { ...base, id: 'n', kind: 'notify', handle: 'note', name: 'Tell', title: 'x', body: 'y' },
  { ...base, id: 'f', kind: 'foreach', handle: 'each', name: 'Each', agent: 'a', prompt: 'x', cwd: '/' }
] as Step[]
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

describe('auditLog', () => {
  it('gives no log while the run is going', () => {
    expect(auditLog(run([visit('t', 1, 'done', 0)], 'running'))).toBeNull()
    expect(auditLog(run([visit('t', 1, 'done', 0)], 'waiting'))).toBeNull()
  })

  it('lists visits by start time, ties in arrival order, numbered from 2, without the trigger visit', () => {
    const m = auditLog(
      run([visit('t', 1, 'done', 0), visit('l', 1, 'done', 5), visit('c', 1, 'done', 3), visit('w', 1, 'done', 3)], 'done')
    )!
    expect(m.entries.map((e) => [e.n, e.visit.stepId])).toEqual([
      [2, 'c'],
      [3, 'w'],
      [4, 'l']
    ])
  })

  it('labels visits only for a step that ran more than once', () => {
    const m = auditLog(
      run([visit('t', 1, 'done', 0), visit('l', 1, 'done', 1), visit('c', 1, 'done', 2), visit('l', 2, 'done', 3)], 'done')
    )!
    expect(m.entries.map((e) => [e.visit.stepId, e.visitLabel])).toEqual([
      ['l', 'Visit 1'],
      ['c', null],
      ['l', 'Visit 2']
    ])
  })

  it("reads a manual run's whitespace-only input as no input", () => {
    expect(auditLog(run([visit('t', 1, 'done', 7)], 'done', { input: ' \n\t ' }))!.trigger.text).toBe('')
    expect(auditLog(run([visit('t', 1, 'done', 7)], 'done', { input: ' YES ' }))!.trigger.text).toBe(' YES ')
  })

  it('builds the trigger for manual, schedule, webhook and a skipped run with no visits', () => {
    const manual = auditLog(run([visit('t', 1, 'done', 7)], 'done', { input: 'YES' }))!
    expect(manual.trigger).toEqual({
      via: 'manual',
      label: 'Manual',
      icon: 'manual',
      body: null,
      late: false,
      at: 7,
      callLine: null,
      text: 'YES',
      parent: null,
      condition: null
    })
    expect(auditLog(run([visit('t', 1, 'done', 7)], 'done'))!.trigger.text).toBe('')

    const sched = auditLog(run([visit('t', 1, 'done', 7)], 'done', { via: 'schedule', late: true }))!
    expect(sched.trigger).toMatchObject({ via: 'schedule', late: true, text: null, callLine: null })

    const body = { action: 'opened' }
    const hook = auditLog(
      run([visit('t', 1, 'done', 7)], 'done', {
        via: 'webhook',
        call: { method: 'POST', query: { a: '1', b: '2' }, body, receivedAt: 1 }
      })
    )!
    expect(hook.trigger.callLine).toBe('POST ?a=1&b=2')
    expect(hook.trigger.text).toBe(JSON.stringify(body, null, 2))
    const plain = auditLog(run([], 'done', { via: 'webhook', call: { method: 'POST', query: {}, body, receivedAt: 1 } }))!
    expect(plain.trigger.callLine).toBe('POST')
    const fromVisit = auditLog(
      run([visit('t', 1, 'done', 7, { output: 'stored' })], 'done', {
        via: 'webhook',
        call: { method: 'POST', query: {}, body, receivedAt: 1 }
      })
    )!
    expect(fromVisit.trigger.text).toBe('stored')

    const skipped = auditLog(run([], 'skipped', { via: 'webhook', startedAt: 40, endedAt: 41, error: 'Filter did not match' }))!
    expect(skipped.trigger.at).toBe(40)
    expect(skipped.entries).toEqual([])
    expect(skipped.end).toEqual({ status: 'skipped', at: 41, error: 'Filter did not match' })
  })

  it('labels the trigger of event and chat runs, with the body and the text', () => {
    const body = { chat: { id: 'c1', title: 'Plans', folder: '/x' }, outcome: 'ok' }
    const call = { method: 'EVENT' as const, query: {}, body, receivedAt: 1 }
    const ev = auditLog(run([visit('t', 1, 'done', 7)], 'done', { via: 'event', event: { kind: 'email' }, call, input: 'Subject: hi' }))!
    expect(ev.trigger).toMatchObject({ via: 'event', label: 'Email arrived', icon: 'email', body, text: 'Subject: hi', callLine: null })
    const lost = auditLog(run([visit('t', 1, 'done', 7)], 'done', { via: 'event', input: '' }))!
    expect(lost.trigger).toMatchObject({ label: 'Event', icon: 'manual', body: null, text: '' })
    const chatCall = { method: 'EVENT' as const, query: {}, body: { chat: 'Plans', text: 'go', lastReply: 'ok' }, receivedAt: 1 }
    const chat = auditLog(
      run([visit('t', 1, 'done', 7)], 'done', { via: 'chat', chat: { chatId: 'c1', title: 'Plans' }, call: chatCall, input: 'go' })
    )!
    expect(chat.trigger).toMatchObject({ via: 'chat', label: 'From chat Plans', icon: 'manual', body: chatCall.body, text: 'go' })
    expect(auditLog(run([visit('t', 1, 'done', 7)], 'done', { via: 'chat' }))!.trigger.label).toBe('From chat')
    expect(auditLog(run([visit('t', 1, 'done', 7)], 'done', { via: 'chat', input: '  ' }))!.trigger.text).toBe('')
  })

  it('labels the other triggers', () => {
    const t = (extra: Partial<WorkflowRun>) => auditLog(run([visit('t', 1, 'done', 7)], 'done', extra))!.trigger
    expect(t({ via: 'schedule' })).toMatchObject({ label: 'Schedule', icon: 'schedule', body: null })
    expect(t({ via: 'webhook' })).toMatchObject({ label: 'Webhook', icon: 'webhook', body: null })
    expect(t({ via: 'workflow' })).toMatchObject({ label: 'Sub-workflow', body: null })
  })

  it("names a sub-workflow run's parent, and marks a failure that took the failure path", () => {
    const parent = { workflowId: 'w0', runId: 'r0', visitId: 'v0', name: 'Main', stepName: 'Check', depth: 1 }
    const sub = auditLog(run([visit('t', 1, 'done', 7)], 'done', { via: 'workflow', input: 'from main', parent }))!
    expect(sub.trigger).toMatchObject({ via: 'workflow', text: 'from main', parent })
    const handled = auditLog(run([visit('t', 1, 'done', 7), visit('a', 1, 'failed', 8, { port: 'error', error: 'HTTP 500' })], 'done'))!
    expect(handled.entries[0]).toMatchObject({ handled: true, answer: 'Failure path' })
    const halted = auditLog(run([visit('t', 1, 'done', 7), visit('a', 1, 'failed', 8, { error: 'HTTP 500' })], 'failed'))!
    expect(halted.entries[0]).toMatchObject({ handled: false, answer: null })
  })

  it('hides Output for condition, wait and notify only', () => {
    const m = auditLog(
      run(
        ['c', 'w', 'n', 'l', 'a', 'f'].map((s, i) => visit(s, 1, 'done', i + 1)),
        'done'
      )
    )!
    expect(m.entries.map((e) => [e.kind, e.showOutput])).toEqual([
      ['condition', false],
      ['wait', false],
      ['notify', false],
      ['llm', true],
      ['approval', true],
      ['foreach', true]
    ])
  })

  it('says the port in words and the approval question', () => {
    const m = auditLog(
      run(
        [
          visit('c', 1, 'done', 1, { port: 'yes' }),
          visit('c', 2, 'done', 2, { port: 'no' }),
          visit('a', 1, 'done', 3, { port: 'rejected', question: 'Sure?' }),
          visit('l', 1, 'done', 4, { port: 'out' })
        ],
        'done'
      )
    )!
    expect(m.entries.map((e) => e.answer)).toEqual(['Yes', 'No', 'Rejected', null])
    expect(m.entries[2].question).toBe('Sure?')
    expect(m.entries[3].question).toBeNull()
  })

  it('marks an approval edited only when the approved text changed', () => {
    const edited = (extra: Partial<Visit>) => auditLog(run([visit('a', 1, 'done', 1, { input: 'x', ...extra })], 'done'))!.entries[0]
    expect(edited({ port: 'approved', output: 'y\n\nNote from the user: hi', note: 'hi' }).edited).toBe(true)
    expect(edited({ port: 'approved', output: 'x\n\nNote from the user: hi', note: 'hi' }).edited).toBe(false)
    expect(edited({ port: 'approved', output: 'x' }).edited).toBe(false)
    const rej = edited({ port: 'rejected', output: 'x' })
    expect(rej.edited).toBe(false)
    expect(rej.answer).toBe('Rejected')
  })

  it('names a blank step by its kind and a missing step as A step', () => {
    const m = auditLog(run([visit('l', 1, 'done', 1), visit('w', 1, 'done', 2), visit('gone', 1, 'done', 3)], 'done'))!
    expect(m.entries.map((e) => [e.name, e.kind])).toEqual([
      ['Summarise', 'llm'],
      ['Wait', 'wait'],
      ['A step', null]
    ])
    expect(m.entries[2].step).toBeUndefined()
  })

  it('falls back to the run end for a visit that never ended', () => {
    const m = auditLog(run([visit('l', 1, 'stopped', 1), visit('c', 1, 'done', 2, { endedAt: 50 })], 'stopped', { endedAt: 90 }))!
    expect(m.entries.map((e) => e.endedAt)).toEqual([90, 50])
    expect(m.end).toEqual({ status: 'stopped', at: 90, error: null })
  })

  it('lists For each items in list order, carried ones kept', () => {
    const items: ItemRun[] = [
      { id: 'i3', n: 3, text: 'c', status: 'done' },
      { id: 'i1', n: 1, text: 'a', status: 'done' },
      { id: 'i2', n: 2, text: 'b', status: 'failed', carried: true }
    ]
    const m = auditLog(run([visit('f', 1, 'done', 1, { items }), visit('l', 1, 'done', 2)], 'done'))!
    expect(m.entries[0].items!.map((i) => i.n)).toEqual([1, 2, 3])
    expect(m.entries[0].items![1].carried).toBe(true)
    expect(m.entries[1].items).toBeNull()
    expect(items.map((i) => i.n)).toEqual([3, 1, 2]) // the run's own list is not reordered
  })

  it('carries the visit error and the run error to the end', () => {
    const m = auditLog(run([visit('l', 1, 'failed', 1, { error: 'boom' })], 'failed', { error: 'Ran too many times', endedAt: 5 }))!
    expect(m.end).toEqual({ status: 'failed', at: 5, error: 'Ran too many times' })
  })
})

describe('auditLog condition skip', () => {
  const skipped = (condition: WorkflowRun['condition']): WorkflowRun =>
    run([visit('t', 1, 'done', 0)], 'skipped', { via: 'webhook', error: CONDITION_TEXT, endedAt: 1, ...(condition ? { condition } : {}) })

  it("shows Jev's verdict in the trigger entry, and the skip's error on the end line", () => {
    const m = auditLog(skipped({ met: false, p: 0.12 }))!
    expect(m.trigger.condition).toBe(`${CONDITION_TEXT} (Jev: 12% likely)`)
    expect(m.end.error).toBe(CONDITION_TEXT)
  })

  it('reads a met call, a Jev failure and a run with no check', () => {
    expect(auditLog(skipped({ met: true, p: 0.9 }))!.trigger.condition).toBe('Condition met (Jev: 90% likely)')
    expect(auditLog(skipped({ met: null }))!.trigger.condition).toBe('Condition not checked: Jev did not answer, so the run went ahead')
    expect(auditLog(skipped(undefined))!.trigger.condition).toBeNull()
  })
})

describe('foldText', () => {
  it('keeps short text whole', () => {
    expect(foldText('a\nb')).toEqual({ preview: 'a\nb', more: false })
  })
  it('cuts at six lines', () => {
    expect(foldText('1\n2\n3\n4\n5\n6\n7').preview).toBe('1\n2\n3\n4\n5\n6')
    expect(foldText('1\n2\n3\n4\n5\n6\n7').more).toBe(true)
  })
  it('cuts long text at the character limit', () => {
    const long = 'x'.repeat(50_000)
    expect(foldText(long).preview.length).toBeLessThanOrEqual(FOLD_CHARS)
    expect(foldText(long).more).toBe(true)
  })
  it('cuts at a line break when one sits in the second half of the limit, else at the limit', () => {
    const near = `${'x'.repeat(450)}\n${'y'.repeat(2000)}`
    expect(foldText(near).preview).toBe('x'.repeat(450))
    const far = `${'x'.repeat(100)}\n${'y'.repeat(2000)}`
    expect(foldText(far).preview).toBe(far.slice(0, FOLD_CHARS))
  })
  it('does not call text with only trailing white space longer', () => {
    expect(foldText('a\nb\n\n')).toEqual({ preview: 'a\nb', more: false })
  })
})

describe('clockTime', () => {
  it('formats clock times in the workflow time zone', () => {
    expect(clockTime(Date.UTC(2026, 10, 8, 12, 2, 11), 'Asia/Dubai')).toBe('16:02:11')
  })
  it('shows midnight as 00, not 24', () => {
    expect(clockTime(Date.UTC(2026, 10, 8, 0, 0, 5), 'UTC')).toBe('00:00:05')
  })
})
