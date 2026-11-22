import { describe, expect, it } from 'vitest'
import {
  HISTORY_CHARS_MAX,
  HISTORY_KEPT,
  pruneVersions,
  routineChanges,
  routineDef,
  sameDef,
  summarizeVersions,
  workflowChanges,
  workflowDef,
  type DefinitionVersion,
  type RoutineDef,
  type WorkflowDef
} from '../src/definitionHistory'
import type { Routine } from '../src/routines'
import type { Step, Workflow } from '../src/workflows'

const trig: Step = { id: 't', kind: 'trigger', handle: 'trigger', name: 'Start', x: 0, y: 0 }
const agent = (o: Partial<Extract<Step, { kind: 'agent' }>> = {}): Step => ({
  id: 's1',
  kind: 'agent',
  handle: 'one',
  name: 'One',
  x: 100,
  y: 0,
  agent: 'A',
  prompt: 'p',
  cwd: '/tmp',
  ...o
})
const flow = (o: Partial<Workflow> = {}): Workflow => ({
  id: 'w',
  name: 'Flow',
  enabled: true,
  timeZone: 'UTC',
  trigger: { kind: 'manual' },
  steps: [trig, agent()],
  edges: [{ id: 'e1', from: 't', port: 'out', to: 's1' }],
  nextRunAt: 5,
  createdAt: 1,
  updatedAt: 2,
  ...o
})
const def = (o: Partial<Workflow> = {}): WorkflowDef => workflowDef(flow(o))
const routine = (o: Partial<Routine> = {}): Routine => ({
  id: 'r',
  name: 'Daily',
  enabled: true,
  timeZone: 'UTC',
  trigger: { kind: 'manual' },
  target: { kind: 'new-chat', agent: 'a', cwd: '/w' },
  prompt: 'Go',
  nextRunAt: null,
  createdAt: 1,
  updatedAt: 2,
  ...o
})

describe('workflowDef and routineDef', () => {
  it('keep only the definition: no on/off, times or webhook sample', () => {
    const d = def({ trigger: { kind: 'webhook', sample: { method: 'POST', query: {}, body: { secret: 1 }, receivedAt: 3 }, filters: [] } })
    expect(Object.keys(d)).toEqual(['name', 'timeZone', 'trigger', 'steps', 'edges', 'notes', 'groups'])
    expect(d.trigger).toEqual({ kind: 'webhook', sample: null, filters: [] })
    // A save switching it off is the same definition.
    expect(sameDef(def(), workflowDef(flow({ enabled: false, updatedAt: 99, nextRunAt: null })))).toBe(true)
    expect(sameDef(def(), def({ notes: [] }))).toBe(true) // absent notes and groups read as none
  })

  it('read a routine saved before the policies with their defaults, so its first save with them is no change', () => {
    const old = routineDef(routine())
    const saved = routineDef(routine({ limitPolicy: 'wait', missedPolicy: 'run-once', sessionPolicy: 'continue' }))
    expect(sameDef(old, saved)).toBe(true)
    expect(
      routineDef(routine({ trigger: { kind: 'webhook', sample: { method: 'POST', query: {}, body: 1, receivedAt: 1 }, condition: 'x' } }))
        .trigger
    ).toEqual({ kind: 'webhook', sample: null, condition: 'x' })
  })
})

describe('workflow run settings in history', () => {
  it('a workflow saved before run settings equals its next save, and the policies are a change', () => {
    const old = flow()
    expect(sameDef(workflowDef(old), workflowDef({ ...old }))).toBe(true)
    expect(Object.keys(workflowDef(old))).toEqual(['name', 'timeZone', 'trigger', 'steps', 'edges', 'notes', 'groups'])
    expect(workflowChanges(workflowDef(old), workflowDef({ ...old, limitPolicy: 'skip' }))).toEqual(['Run settings changed'])
    expect(workflowChanges(workflowDef(old), workflowDef({ ...old, missedPolicy: 'skip' }))).toEqual(['Run settings changed'])
    expect(Object.keys(workflowDef({ ...old, spendCap: 2, limitPolicy: 'skip', missedPolicy: 'skip' })).slice(-3)).toEqual([
      'spendCap',
      'limitPolicy',
      'missedPolicy'
    ])
    const hook = flow({ trigger: { kind: 'webhook', sample: null, filters: [] } })
    expect(workflowDef({ ...hook, trigger: { ...hook.trigger, condition: 'a PR' } as Workflow['trigger'] }).trigger).toEqual({
      kind: 'webhook',
      sample: null,
      filters: [],
      condition: 'a PR'
    })
    expect(workflowDef(hook).trigger).toEqual({ kind: 'webhook', sample: null, filters: [] })
  })
})

describe('pruneVersions', () => {
  const v = (n: number, size = 10): DefinitionVersion<{ t: string }> => ({
    id: `v${n}`,
    savedAt: n,
    source: 'editor',
    def: { t: 'x'.repeat(size) }
  })
  it('keeps the newest HISTORY_KEPT', () => {
    const all = Array.from({ length: HISTORY_KEPT + 5 }, (_, i) => v(i))
    expect(pruneVersions(all)).toEqual(all.slice(0, HISTORY_KEPT))
  })
  it('stops at the size cap but always keeps the newest', () => {
    const big = HISTORY_CHARS_MAX / 2
    expect(pruneVersions([v(1, big), v(2, big), v(3, 5)]).map((x) => x.id)).toEqual(['v1'])
    expect(pruneVersions([v(1, HISTORY_CHARS_MAX * 2)]).map((x) => x.id)).toEqual(['v1'])
  })
})

describe('workflowChanges', () => {
  it('names what changed', () => {
    const before = def()
    expect(workflowChanges(null, before)).toEqual([])
    expect(workflowChanges(before, def({ name: 'New' }))).toEqual(['Renamed'])
    expect(workflowChanges(before, def({ trigger: { kind: 'schedule', schedule: { freq: 'daily', time: '09:00', days: [1] } } }))).toEqual([
      'Trigger changed'
    ])
    expect(workflowChanges(before, def({ steps: [trig, agent({ prompt: 'q' })] }))).toEqual(['Step “One” changed'])
    expect(workflowChanges(before, def({ steps: [trig, agent(), agent({ id: 's2', handle: 'two', name: 'Two' })] }))).toEqual([
      'Step “Two” added'
    ])
    expect(workflowChanges(before, def({ steps: [trig], edges: [] }))).toEqual(['Step “One” removed', 'Connections changed'])
    expect(workflowChanges(before, def({ steps: [trig, agent(), agent({ id: 's2' }), agent({ id: 's3' })] }))).toEqual(['2 steps added'])
  })
  it('says the layout changed only when nothing else did', () => {
    expect(workflowChanges(def(), def({ steps: [trig, agent({ x: 400 })] }))).toEqual(['Layout changed'])
    expect(workflowChanges(def(), def({ name: 'N', steps: [trig, agent({ x: 400 })] }))).toEqual(['Renamed'])
  })
})

describe('routineChanges', () => {
  it('names what changed', () => {
    const a: RoutineDef = routineDef(routine())
    expect(routineChanges(a, routineDef(routine({ prompt: 'Other' })))).toEqual(['Prompt changed'])
    expect(routineChanges(a, routineDef(routine({ target: { kind: 'new-chat', agent: 'b', cwd: '/w' }, sessionPolicy: 'fresh' })))).toEqual(
      ['Target changed', 'Settings changed']
    )
  })
})

describe('summarizeVersions', () => {
  it('compares each version with the one before it and marks the one equal to the saved definition', () => {
    const v1: DefinitionVersion<WorkflowDef> = { id: 'v1', savedAt: 1, source: 'earlier', def: def() }
    const v2: DefinitionVersion<WorkflowDef> = { id: 'v2', savedAt: 2, source: 'restore', restoredFrom: 1, def: def({ name: 'B' }) }
    expect(summarizeVersions([v2, v1], def({ name: 'B' }), workflowChanges)).toEqual([
      { id: 'v2', savedAt: 2, source: 'restore', restoredFrom: 1, current: true, changes: ['Renamed'] },
      { id: 'v1', savedAt: 1, source: 'earlier', current: false, changes: [] }
    ])
  })
})
