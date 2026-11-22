import { describe, expect, it } from 'vitest'
import type { Workflow, WorkflowRunSummary, WorkflowsSnapshot } from '@zumibot/shared/workflows'
import { anyWaiting, lastRunStatus, triggerSummary } from '../src/state/workflows'

const run = (over: Partial<WorkflowRunSummary>): WorkflowRunSummary => ({
  id: 'r' + Math.random(),
  workflowId: 'w1',
  via: 'manual',
  status: 'done',
  late: false,
  startedAt: 1,
  waiting: [],
  failed: [],
  ...over
})
const wf = (id: string): Workflow => ({
  id,
  name: id,
  enabled: true,
  timeZone: 'UTC',
  trigger: { kind: 'manual' },
  steps: [],
  edges: [],
  nextRunAt: null,
  createdAt: 0,
  updatedAt: 0
})
const snap = (runs: Record<string, WorkflowRunSummary[]>): WorkflowsSnapshot => ({ workflows: Object.keys(runs).map(wf), runs })

describe('triggerSummary', () => {
  it('names the three kinds', () => {
    expect(triggerSummary({ kind: 'manual' }, 'UTC')).toBe('Manual')
    expect(triggerSummary({ kind: 'webhook', sample: null, filters: [] }, 'UTC')).toBe('Webhook')
    expect(triggerSummary({ kind: 'schedule', schedule: { freq: 'daily', time: '07:00', days: [0, 1, 2, 3, 4, 5, 6] } }, 'UTC')).toBe(
      'Every day at 7:00 AM'
    )
  })
})

describe('triggerSummary for event kinds', () => {
  it('names each by its label', () => {
    expect(triggerSummary({ kind: 'reply', filters: [] }, 'UTC')).toBe('Reply ended')
    expect(triggerSummary({ kind: 'todo', filters: [] }, 'UTC')).toBe('To-do added')
    expect(triggerSummary({ kind: 'inbox', filters: [] }, 'UTC')).toBe('Inbox message')
    expect(triggerSummary({ kind: 'email', account: '', host: '', port: 993, folder: 'INBOX', filters: [] }, 'UTC')).toBe('Email arrived')
  })
  it("adds the watched folder's name for a file trigger once a path is set", () => {
    const file = { kind: 'file' as const, path: '/home/u/inv', pattern: '', changes: ['added' as const], filters: [] }
    expect(triggerSummary(file, 'UTC')).toBe('File changed · inv')
    expect(triggerSummary({ ...file, path: '/home/u/inv/' }, 'UTC')).toBe('File changed · inv')
    expect(triggerSummary({ ...file, path: '' }, 'UTC')).toBe('File changed')
  })
})

describe('anyWaiting', () => {
  it('is true while some run waits on the user', () => {
    expect(anyWaiting(snap({ w1: [run({ status: 'done' }), run({ status: 'waiting', waiting: ['s1'] })] }))).toBe(true)
  })
  it('ignores running, finished and failed runs, and an empty snapshot', () => {
    expect(anyWaiting(snap({ w1: [run({ status: 'running' }), run({ status: 'failed' }), run({ status: 'stopped' })], w2: [] }))).toBe(
      false
    )
    expect(anyWaiting({ workflows: [], runs: {} })).toBe(false)
  })
})

describe('lastRunStatus', () => {
  it("is the newest run's status, a skipped call aside", () => {
    const s = snap({
      w1: [
        run({ status: 'done', startedAt: 1 }),
        run({ status: 'failed', startedAt: 5 }),
        run({ status: 'skipped', startedAt: 9 }),
        run({ status: 'running', startedAt: 3 })
      ]
    })
    expect(lastRunStatus(s, 'w1')).toBe('failed')
  })
  it('is null with no run, no unskipped run or no such workflow', () => {
    expect(lastRunStatus(snap({ w1: [] }), 'w1')).toBeNull()
    expect(lastRunStatus(snap({ w1: [run({ status: 'skipped' })] }), 'w1')).toBeNull()
    expect(lastRunStatus(snap({ w1: [] }), 'nope')).toBeNull()
  })
})
