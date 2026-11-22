import { describe, expect, it } from 'vitest'
import { workflowsFromPath, workflowsPath } from '../src/state/route'

describe('workflows route', () => {
  it('reads the list, a workflow and one of its runs', () => {
    expect(workflowsFromPath('/workflows')).toEqual({ workflowId: null, runId: null })
    expect(workflowsFromPath('/workflows/w1')).toEqual({ workflowId: 'w1', runId: null })
    expect(workflowsFromPath('/workflows/w1/runs/r9')).toEqual({ workflowId: 'w1', runId: 'r9' })
    expect(workflowsFromPath('/workflows/a%20b/runs/c%2Fd')).toEqual({ workflowId: 'a b', runId: 'c/d' })
  })

  it("reads a run's audit tab", () => {
    expect(workflowsFromPath('/workflows/w1/runs/r9/audit')).toEqual({ workflowId: 'w1', runId: 'r9', audit: true })
    expect(workflowsFromPath('/workflows/w1/runs/r9')).toEqual({ workflowId: 'w1', runId: 'r9' }) // no audit key
  })

  it('routes nothing else', () => {
    const bad = [
      '/',
      '',
      '/workflow',
      '/workflows/',
      '/workflows/w1/',
      '/workflows/w1/runs',
      '/workflows/w1/runs/',
      '/workflows/w1/runs/r/x',
      '/workflows/w1/other/r',
      '/workflows//runs/r',
      '/workflowsx',
      '/workflows/%E0%A4%A',
      '/workflows/w1/runs/%E0%A4%A',
      '/todos/w1',
      '/workflows/w1/runs/r9/audit/',
      '/workflows/w1/runs/r9/canvas',
      '/workflows/w1/audit',
      '/workflows/w1/runs//audit'
    ]
    for (const p of bad) expect(workflowsFromPath(p), p).toBeNull()
  })

  it('round-trips through workflowsPath', () => {
    expect(workflowsPath(null)).toBe('/workflows')
    expect(workflowsPath('w1')).toBe('/workflows/w1')
    expect(workflowsPath('w1', null)).toBe('/workflows/w1')
    expect(workflowsPath('w1', 'r9')).toBe('/workflows/w1/runs/r9')
    for (const [workflowId, runId] of [
      [null, null],
      ['a', null],
      ['a b', 'c/d'],
      ['%', 'é']
    ] as const) {
      expect(workflowsFromPath(workflowsPath(workflowId, runId))).toEqual({ workflowId, runId })
    }
  })

  it('round-trips the audit tab', () => {
    expect(workflowsPath('w1', 'r9', true)).toBe('/workflows/w1/runs/r9/audit')
    expect(workflowsPath('w1', null, true)).toBe('/workflows/w1') // no run, no tab
    for (const [workflowId, runId, audit] of [
      ['a b', 'c/d', true],
      ['w', 'r', false]
    ] as const) {
      expect(workflowsFromPath(workflowsPath(workflowId, runId, audit))).toEqual({ workflowId, runId, ...(audit ? { audit: true } : {}) })
    }
  })

  it('has no run without a workflow', () => {
    expect(workflowsPath(null, 'r9')).toBe('/workflows')
  })
})
