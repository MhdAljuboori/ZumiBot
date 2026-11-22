import { describe, expect, it } from 'vitest'
import type { Step, WorkflowEdge } from '@zumibot/shared/workflows'
import { phoneSteps, stepDetail } from '../src/state/workflowPhone'

const base = (id: string, x: number, y: number) => ({ id, handle: id, name: '', x, y })
const trigger: Step = { ...base('t', 0, 0), kind: 'trigger' }
const agent = (id: string, x: number, y: number, name = ''): Step => ({
  ...base(id, x, y),
  name,
  kind: 'agent',
  agent: 'scout',
  prompt: 'p',
  cwd: '/'
})
const edge = (from: string, to: string, port: WorkflowEdge['port'] = 'out'): WorkflowEdge => ({ id: `${from}-${to}`, from, port, to })

describe('phoneSteps', () => {
  it('lists steps by distance from the trigger, then as drawn, with the trigger and unreached steps handled', () => {
    const steps: Step[] = [
      agent('lost', -500, 0, 'Lost'),
      agent('c', 640, 100, 'C'),
      agent('b', 640, -100, 'B'),
      agent('a', 320, 0, 'A'),
      trigger
    ]
    const edges = [edge('t', 'a'), edge('a', 'b'), edge('a', 'c'), edge('c', 'a')]
    expect(phoneSteps({ steps, edges }).map((s) => s.name)).toEqual(['A', 'B', 'C', 'Lost'])
  })

  it('names an unnamed step by its kind', () => {
    expect(phoneSteps({ steps: [trigger, agent('a', 1, 0)], edges: [edge('t', 'a')] })[0]).toEqual({
      id: 'a',
      kind: 'agent',
      name: 'Agent',
      detail: 'Agent · @scout'
    })
  })
})

describe('stepDetail', () => {
  it('adds the setting that tells steps apart', () => {
    expect(stepDetail({ ...base('w', 0, 0), kind: 'wait', minutes: 90 })).toBe('Wait · 90 min')
    expect(stepDetail({ ...base('w', 0, 0), kind: 'wait', minutes: 120 })).toBe('Wait · 2 h')
    expect(stepDetail({ ...base('w', 0, 0), kind: 'wait', minutes: 2880 })).toBe('Wait · 2 d')
    expect(stepDetail({ ...base('l', 0, 0), kind: 'llm', prompt: '', model: 'haiku' })).toBe('LLM · haiku')
    expect(stepDetail({ ...base('n', 0, 0), kind: 'notify', title: 'x' })).toBe('Notify')
    expect(stepDetail({ ...base('f', 0, 0), kind: 'foreach', agent: '', prompt: '', cwd: '/' })).toBe('For each')
  })
})
