import { describe, expect, it } from 'vitest'
import type { Step, Visit, WorkflowInput, WorkflowRun } from '@zumibot/shared/workflows'
import { addStep, connect, newWorkflow, setFailurePath, stepSummary, toFlow } from '../src/state/workflowCanvas'
import { templateFields } from '../src/state/workflowEditor'
import { parseClip } from '../src/state/workflowClipboard'
import { canRetry, parentLine, requestLine } from '../src/state/workflowRun'
import { stepDetail } from '../src/state/workflowPhone'

const seq = () => {
  let n = 0
  return () => `id${++n}`
}

function withHttp(): { w: WorkflowInput; id: string; gen: () => string } {
  const gen = seq()
  const w0 = newWorkflow('UTC', gen)
  const added = addStep(w0, 'http', { x: 300, y: 0 }, { stepId: w0.steps[0].id, port: 'out' }, gen)
  return { w: added.w, id: added.stepId, gen }
}

describe('new steps on the canvas', () => {
  it('a new HTTP step starts from its defaults and reads as its request', () => {
    const { w, id } = withHttp()
    const s = w.steps.find((x) => x.id === id)!
    expect(s).toMatchObject({
      kind: 'http',
      name: 'HTTP request',
      handle: 'http-request',
      method: 'GET',
      url: '',
      headers: [],
      bodyType: 'json'
    })
    expect(stepSummary({ ...s, url: 'https://api.example.com/x' } as Step)).toBe('GET https://api.example.com/x')
    expect(stepDetail(s)).toBe('HTTP · GET')
  })

  it('the failure path adds the error port, and turning it off drops its connections', () => {
    const { w, id, gen } = withHttp()
    // No error port yet: a connection from it is refused.
    const notify = addStep(w, 'notify', { x: 600, y: 200 }, undefined, gen)
    expect(connect(notify.w, { stepId: id, port: 'error' }, notify.stepId, gen)).toBe(notify.w)
    const on = setFailurePath(notify.w, id, true)
    expect(on.steps.find((x) => x.id === id)).toMatchObject({ onFailure: 'branch' })
    const wired = connect(on, { stepId: id, port: 'error' }, notify.stepId, gen)
    expect(wired.edges.filter((e) => e.port === 'error')).toHaveLength(1)
    expect(toFlow(wired, []).edges.find((e) => e.sourceHandle === 'error')).toMatchObject({ label: 'Failed' })
    const off = setFailurePath(wired, id, false)
    expect(off.steps.find((x) => x.id === id)).not.toHaveProperty('onFailure')
    expect(off.edges.filter((e) => e.port === 'error')).toEqual([])
    // A step that never fails by itself has no setting to turn on.
    expect(setFailurePath(off, notify.stepId, true)).toBe(off)
  })

  it('{{key}} is offered only in an HTTP step that picked a key', () => {
    const { w, id } = withHttp()
    expect(templateFields(w, id, null)).not.toContain('key')
    const keyed = { ...w, steps: w.steps.map((s) => (s.id === id ? ({ ...s, key: 'item-1' } as Step) : s)) }
    expect(templateFields(keyed, id, null)).toContain('key')
  })

  it('a pasted failure path keeps its error edge', () => {
    const steps = [
      {
        id: 'a',
        kind: 'http',
        handle: 'a',
        name: 'A',
        x: 0,
        y: 0,
        method: 'GET',
        url: 'https://x.example/',
        headers: [],
        bodyType: 'json',
        onFailure: 'branch'
      },
      { id: 'b', kind: 'notify', handle: 'b', name: 'B', x: 0, y: 0, title: 't' }
    ]
    const clip = parseClip(
      JSON.stringify({
        zumibot: 'workflow-clip',
        v: 1,
        steps,
        edges: [{ id: 'e', from: 'a', port: 'error', to: 'b' }],
        notes: [],
        groups: []
      })
    )
    expect(clip?.edges).toEqual([{ id: 'e', from: 'a', port: 'error', to: 'b' }])
    const off = steps.map((s) => ({ ...s, onFailure: undefined }))
    expect(
      parseClip(
        JSON.stringify({
          zumibot: 'workflow-clip',
          v: 1,
          steps: off,
          edges: [{ id: 'e', from: 'a', port: 'error', to: 'b' }],
          notes: [],
          groups: []
        })
      )
    ).toBeNull()
  })
})

describe('the run view for the new steps', () => {
  const visit = (over: Partial<Visit>): Visit => ({
    id: 'v',
    stepId: 's',
    n: 1,
    status: 'failed',
    input: '',
    inputs: [],
    startedAt: 0,
    ...over
  })
  const run = (visits: Visit[], over: Partial<WorkflowRun> = {}): WorkflowRun => ({
    id: 'r',
    workflowId: 'w',
    via: 'manual',
    late: false,
    status: 'failed',
    snapshot: { steps: [], edges: [] },
    visits,
    inbox: {},
    allowance: { perStep: {}, total: 200 },
    halted: false,
    startedAt: 0,
    ...over
  })

  it('offers no Retry for a failure that took the failure path', () => {
    const handled = visit({ port: 'error', error: 'HTTP 500' })
    expect(canRetry(run([handled], { status: 'done' }), handled)).toBe(false)
    const halted = visit({ error: 'HTTP 500' })
    expect(canRetry(run([halted]), halted)).toBe(true)
  })

  it('reads a request line and a parent link', () => {
    expect(requestLine({ method: 'POST', url: 'https://a.example/x?t=[vault: K]', status: 201 })).toBe(
      'POST https://a.example/x?t=[vault: K] · 201'
    )
    expect(requestLine({ method: 'GET', url: 'https://a.example/' })).toBe('GET https://a.example/')
    expect(parentLine(run([]))).toBeNull()
    expect(
      parentLine(run([], { parent: { workflowId: 'w0', runId: 'r0', visitId: 'v0', name: 'Main', stepName: 'Check', depth: 1 } }))
    ).toEqual({ text: 'Started by Main › Check', href: '/workflows/w0/runs/r0' })
  })
})
