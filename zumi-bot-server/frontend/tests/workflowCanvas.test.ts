import { describe, expect, it } from 'vitest'
import type { CanvasGroup, Edge, Note, Step, WorkflowInput } from '@zumibot/shared/workflows'
import { handleFor, type Problem } from '@zumibot/shared/workflowGraph'
import {
  STEP_LABELS,
  addStep,
  connect,
  dirty,
  idsOf,
  insertStep,
  newWorkflow,
  removeEdge,
  removeStep,
  removeItems,
  moveStep,
  moveItems,
  renameStep,
  snap,
  stepSummary,
  toFlow,
  randomId,
  type CollapsedGroupFlowNode,
  type FlowNode,
  type GroupFlowNode,
  type NoteFlowNode
} from '../src/state/workflowCanvas'

const seq = () => {
  let n = 0
  return () => `id${++n}`
}
const ID_RE = /^[A-Za-z0-9-]{1,64}$/
const HANDLE_RE = /^[a-z0-9-]{1,32}$/

const base = (): WorkflowInput => newWorkflow('UTC', seq())
const triggerId = (w: WorkflowInput) => w.steps[0].id

describe('newWorkflow', () => {
  it('has only a manual trigger at 0,0, off, named New workflow', () => {
    const w = newWorkflow('Asia/Baghdad', seq())
    expect(w.id).toBeNull()
    expect(w.name).toBe('New workflow')
    expect(w.enabled).toBe(false)
    expect(w.timeZone).toBe('Asia/Baghdad')
    expect(w.trigger).toEqual({ kind: 'manual' })
    expect(w.edges).toEqual([])
    expect(w.steps).toHaveLength(1)
    expect(w.steps[0]).toMatchObject({ kind: 'trigger', x: 0, y: 0, handle: 'trigger' })
  })
})

describe('STEP_LABELS', () => {
  it('lists Room then For each right after Agent', () => {
    expect(Object.keys(STEP_LABELS)).toEqual([
      'agent',
      'room',
      'foreach',
      'llm',
      'condition',
      'approval',
      'wait',
      'notify',
      'http',
      'transform',
      'workflow',
      'chat'
    ])
    expect(STEP_LABELS.foreach).toBe('For each')
  })
})

describe('addStep', () => {
  const cases: [Parameters<typeof addStep>[1], string, Record<string, unknown>][] = [
    ['llm', 'LLM', { model: 'haiku', effort: 'low', prompt: '' }],
    ['condition', 'Condition', { model: 'haiku', question: '' }],
    ['approval', 'Approval', { question: 'Approve?', editable: true }],
    ['wait', 'Wait', { minutes: 5 }],
    ['notify', 'Notify', { title: '' }],
    ['agent', 'Agent', { agent: '', prompt: '', cwd: '' }],
    ['foreach', 'For each', { agent: '', prompt: '', cwd: '' }]
  ]
  for (const [kind, label, defaults] of cases) {
    it(`${kind} gets its defaults, label and handle`, () => {
      const { w, stepId } = addStep(base(), kind, { x: 10, y: 20 }, undefined, seq())
      const s = w.steps.find((x) => x.id === stepId)!
      expect(s).toEqual({ id: stepId, handle: handleFor(label, new Set(['trigger'])), name: label, kind, x: 10, y: 20, ...defaults })
      expect(w.steps).toHaveLength(2)
    })
  }

  it('a second step of a kind gets a -2 handle', () => {
    const a = addStep(base(), 'wait', { x: 0, y: 0 }, undefined, seq())
    const b = addStep(a.w, 'wait', { x: 0, y: 0 }, undefined, seq())
    expect(b.w.steps.map((s) => s.handle)).toEqual(['trigger', 'wait', 'wait-2'])
  })

  it('connects from a port when asked', () => {
    const w0 = base()
    const { w, stepId } = addStep(w0, 'llm', { x: 1, y: 1 }, { stepId: triggerId(w0), port: 'out' }, seq())
    expect(w.edges).toHaveLength(1)
    expect(w.edges[0]).toMatchObject({ from: triggerId(w0), port: 'out', to: stepId })
  })

  it('does not mutate its input', () => {
    const w0 = base()
    const snap = JSON.stringify(w0)
    addStep(w0, 'agent', { x: 0, y: 0 }, { stepId: triggerId(w0), port: 'out' }, seq())
    expect(JSON.stringify(w0)).toBe(snap)
  })
})

describe('ids', () => {
  it('random ids satisfy the server rules', () => {
    for (let i = 0; i < 200; i++) expect(randomId()).toMatch(ID_RE)
  })
  it('a generator that gives bad or taken ids is skipped', () => {
    const w0 = base()
    const out = ['constructor', '__proto__', 'has space', 'x'.repeat(65), triggerId(w0), 'fine']
    let i = 0
    const { stepId } = addStep(w0, 'wait', { x: 0, y: 0 }, undefined, () => out[i++])
    expect(stepId).toBe('fine')
  })
  it('an Arabic name still gives a valid handle after rename', () => {
    const { w, stepId } = addStep(base(), 'wait', { x: 0, y: 0 }, undefined, seq())
    const r = renameStep(w, stepId, 'خطوة')
    const h = r.steps.find((s) => s.id === stepId)!.handle
    expect(h).toMatch(HANDLE_RE)
    expect(h).toBe('step')
  })
})

describe('insertStep', () => {
  // One counter for the whole test, so no two calls hand out the same id.
  const chain = () => {
    let n = 0
    const gen = () => `g${++n}`
    const w0 = newWorkflow('UTC', gen)
    const a = addStep(w0, 'llm', { x: 300, y: 0 }, { stepId: triggerId(w0), port: 'out' }, gen)
    return { w: a.w, llm: a.stepId, edge: a.w.edges[0].id, gen }
  }

  it('puts the new step into the edge: source port to it, its first port to the old target', () => {
    const { w, llm, edge, gen } = chain()
    const r = insertStep(w, edge, 'condition', { x: 150, y: 0 }, gen)
    expect(r.stepId).not.toBeNull()
    expect(r.w.edges.some((e) => e.id === edge)).toBe(false)
    expect(r.w.edges.map((e) => [e.from, e.port, e.to])).toEqual([
      [triggerId(w), 'out', r.stepId],
      [r.stepId, 'yes', llm]
    ])
    expect(r.w.steps.find((s) => s.id === r.stepId)).toMatchObject({ kind: 'condition', x: 150, y: 0 })
  })

  it('keeps the branch port of the edge it splits', () => {
    const { w, llm, gen } = chain()
    const c = addStep(w, 'approval', { x: 600, y: 0 }, { stepId: llm, port: 'out' }, gen)
    const n = addStep(c.w, 'notify', { x: 900, y: 0 }, { stepId: c.stepId, port: 'rejected' }, gen)
    const rejected = n.w.edges.find((e) => e.port === 'rejected')!
    const r = insertStep(n.w, rejected.id, 'wait', { x: 750, y: 0 }, gen)
    expect(r.w.edges.filter((e) => e.from === c.stepId).map((e) => [e.port, e.to])).toEqual([['rejected', r.stepId]])
    expect(r.w.edges.filter((e) => e.from === r.stepId).map((e) => [e.port, e.to])).toEqual([['out', n.stepId]])
  })

  it('an unknown edge changes nothing', () => {
    const { w } = chain()
    const r = insertStep(w, 'nope', 'wait', { x: 0, y: 0 })
    expect(r.w).toBe(w)
    expect(r.stepId).toBeNull()
  })
})

describe('connect', () => {
  const two = () => {
    const w0 = base()
    const a = addStep(w0, 'condition', { x: 0, y: 0 }, undefined, seq())
    const b = addStep(a.w, 'wait', { x: 0, y: 0 }, undefined, seq())
    return { w: b.w, t: triggerId(w0), c: a.stepId, k: b.stepId }
  }

  it('adds an edge with a valid id', () => {
    const { w, t, k } = two()
    const r = connect(w, { stepId: t, port: 'out' }, k, seq())
    expect(r.edges).toHaveLength(1)
    expect(r.edges[0]).toMatchObject({ from: t, port: 'out', to: k })
    expect(r.edges[0].id).toMatch(ID_RE)
  })
  it('refuses an edge into the trigger', () => {
    const { w, k, t } = two()
    expect(connect(w, { stepId: k, port: 'out' }, t)).toBe(w)
  })
  it('refuses a self edge', () => {
    const { w, k } = two()
    expect(connect(w, { stepId: k, port: 'out' }, k)).toBe(w)
  })
  it('refuses a duplicate edge but allows the other port to the same target', () => {
    const { w, c, k } = two()
    const r = connect(w, { stepId: c, port: 'yes' }, k, seq())
    expect(connect(r, { stepId: c, port: 'yes' }, k)).toBe(r)
    expect(connect(r, { stepId: c, port: 'no' }, k, seq()).edges).toHaveLength(2)
  })
  it('refuses a port the kind lacks, and unknown steps', () => {
    const { w, t, c, k } = two()
    expect(connect(w, { stepId: t, port: 'yes' }, k)).toBe(w)
    expect(connect(w, { stepId: c, port: 'out' }, k)).toBe(w)
    expect(connect(w, { stepId: 'nope', port: 'out' }, k)).toBe(w)
    expect(connect(w, { stepId: t, port: 'out' }, 'nope')).toBe(w)
  })
})

describe('remove and move', () => {
  const graph = () => {
    const w0 = base()
    const a = addStep(w0, 'wait', { x: 0, y: 0 }, { stepId: triggerId(w0), port: 'out' }, seq())
    const b = addStep(a.w, 'notify', { x: 5, y: 5 }, { stepId: a.stepId, port: 'out' }, seq())
    return { w: b.w, t: triggerId(w0), a: a.stepId, b: b.stepId }
  }
  it('removes a step and its edges both ways', () => {
    const { w, a, b } = graph()
    const r = removeStep(w, a)
    expect(r.steps.map((s) => s.id)).not.toContain(a)
    expect(r.steps.map((s) => s.id)).toContain(b)
    expect(r.edges).toEqual([])
  })
  it('never removes the trigger', () => {
    const { w, t } = graph()
    expect(removeStep(w, t)).toBe(w)
  })
  it('removeEdge drops one edge', () => {
    const { w } = graph()
    const r = removeEdge(w, w.edges[0].id)
    expect(r.edges).toHaveLength(1)
    expect(removeEdge(w, 'nope')).toBe(w)
  })
  it('moveStep changes only that step position', () => {
    const { w, a, b } = graph()
    const r = moveStep(w, a, 40, 50)
    expect(r.steps.find((s) => s.id === a)).toMatchObject({ x: 40, y: 50 })
    expect(r.steps.find((s) => s.id === b)).toMatchObject({ x: 5, y: 5 })
    expect(moveStep(w, 'nope', 1, 1)).toBe(w)
  })
  const P = (steps: string[], notes: string[] = []) => ({ steps, notes, groups: [] })
  const note = (id: string, over: Partial<Note> = {}): Note => ({ id, x: 0, y: 0, width: 240, height: 160, color: 1, text: 'hi', ...over })
  it('moveItems moves every listed step in one edit and leaves the rest', () => {
    const { w, t, a, b } = graph()
    const r = moveItems(w, [
      { id: a, x: 100, y: 200 },
      { id: b, x: 105, y: 205 },
      { id: 'nope', x: 1, y: 1 }
    ])
    expect(r.steps.find((s) => s.id === a)).toMatchObject({ x: 100, y: 200 })
    expect(r.steps.find((s) => s.id === b)).toMatchObject({ x: 105, y: 205 })
    expect(r.steps.find((s) => s.id === t)).toMatchObject({ x: 0, y: 0 })
    expect(r.edges).toBe(w.edges)
  })
  it('moveItems moves a step and a note in one edit', () => {
    const { w, a } = graph()
    const wn = { ...w, notes: [note('n1'), note('n2', { x: 7, y: 7 })] }
    const r = moveItems(wn, [
      { id: a, x: 100, y: 200 },
      { id: 'n1', x: 60, y: 80 }
    ])
    expect(r.steps.find((s) => s.id === a)).toMatchObject({ x: 100, y: 200 })
    expect(r.notes![0]).toMatchObject({ x: 60, y: 80 })
    expect(r.notes![1]).toBe(wn.notes[1])
  })
  it('moveItems hands back the same workflow when nothing moved', () => {
    const { w, a, b } = graph()
    expect(moveItems(w, [])).toBe(w)
    expect(
      moveItems(w, [
        { id: a, x: 0, y: 0 },
        { id: b, x: 5, y: 5 }
      ])
    ).toBe(w)
    expect(moveItems(w, [{ id: 'nope', x: 9, y: 9 }])).toBe(w)
    const wn = { ...w, notes: [note('n1')] }
    expect(moveItems(wn, [{ id: 'n1', x: 0, y: 0 }])).toBe(wn)
  })
  it('removeItems removes every listed step and their edges, never the trigger', () => {
    const { w, t, a, b } = graph()
    const r = removeItems(w, P([t, a, b]))
    expect(r.steps.map((s) => s.id)).toEqual([t])
    expect(r.edges).toEqual([])
    const one = removeItems(w, P([b, 'nope']))
    expect(one.steps.map((s) => s.id)).toEqual([t, a])
    expect(one.edges).toHaveLength(1)
  })
  it('removeItems removes the picked notes and steps together, keeping the trigger', () => {
    const { w, t, a, b } = graph()
    const wn = { ...w, notes: [note('n1'), note('n2')] }
    const r = removeItems(wn, P([t, a], ['n1']))
    expect(r.steps.map((s) => s.id)).toEqual([t, b])
    expect(r.notes!.map((n) => n.id)).toEqual(['n2'])
    expect(r.edges).toEqual([])
    expect(removeItems(wn, P([], ['n2'])).notes!.map((n) => n.id)).toEqual(['n1'])
  })
  it('removeItems hands back the same workflow when nothing can go', () => {
    const { w, t } = graph()
    expect(removeItems(w, P([t]))).toBe(w)
    expect(removeItems(w, P(['nope'], ['gone']))).toBe(w)
    expect(removeItems({ ...w, notes: [note('n1')] }, P([t]))).toEqual({ ...w, notes: [note('n1')] })
    const wg = { ...w, groups: [{ id: 'g1', name: 'G', steps: ['a'], notes: [] }] }
    expect(removeItems(wg, { steps: [t], notes: [], groups: ['gone'] })).toBe(wg)
  })
  it('removeItems takes a picked group with its members and their edges', () => {
    const { w, t, a, b } = graph()
    const wg = { ...w, notes: [note('n1'), note('n2')], groups: [{ id: 'g1', name: 'G', steps: [a, b], notes: ['n1'] }] }
    const r = removeItems(wg, { steps: [], notes: [], groups: ['g1'] })
    expect(r.steps.map((s) => s.id)).toEqual([t])
    expect(r.notes!.map((n) => n.id)).toEqual(['n2'])
    expect(r.edges).toEqual([])
    expect(r.groups).toEqual([])
  })
  it('removeStep takes the step out of its group, and the group once it is too small', () => {
    const { w, a, b } = graph()
    const wg = { ...w, notes: [note('n1')], groups: [{ id: 'g1', name: 'G', steps: [a, b], notes: ['n1'] }] }
    expect(removeStep(wg, a).groups).toEqual([{ id: 'g1', name: 'G', steps: [b], notes: ['n1'] }])
    expect(removeStep(removeStep(wg, a), b).groups).toEqual([])
  })
})

describe('idsOf', () => {
  it('holds step, note, edge and group ids: one id space for every new id', () => {
    const w = {
      ...base(),
      notes: [{ id: 'n1', x: 0, y: 0, width: 240, height: 160, color: 1 as const, text: '' }],
      groups: [{ id: 'g1', name: 'G', steps: [], notes: [] }]
    }
    expect([...idsOf(w)].sort()).toEqual(['g1', 'id1', 'n1'])
  })
})

describe('renameStep', () => {
  const setup = () => {
    let w = base()
    const a = addStep(w, 'llm', { x: 0, y: 0 }, undefined, seq())
    const b = addStep(a.w, 'notify', { x: 0, y: 0 }, undefined, seq())
    const c = addStep(b.w, 'agent', { x: 0, y: 0 }, undefined, seq())
    w = c.w
    const set = (id: string, patch: Record<string, unknown>) => {
      w = { ...w, steps: w.steps.map((s) => (s.id === id ? ({ ...s, ...patch } as Step) : s)) }
    }
    set(b.stepId, { title: 'Got {{steps.llm.output}}', body: 'and {{ steps.llm.output }} again, keep {{steps.agent.output}}' })
    set(c.stepId, { prompt: 'Use {{  steps.llm.output  }}', cwd: '/tmp' })
    set(a.stepId, { system: 'self {{steps.llm.output}}' })
    return { w, llm: a.stepId, notify: b.stepId, agent: c.stepId }
  }

  it('moves an auto handle with the name and rewrites every field of every step', () => {
    const { w, llm, notify, agent } = setup()
    const r = renameStep(w, llm, 'Summary')
    const get = (id: string) => r.steps.find((s) => s.id === id)! as Record<string, unknown>
    expect(get(llm)).toMatchObject({ name: 'Summary', handle: 'summary' })
    expect(get(notify).title).toBe('Got {{steps.summary.output}}')
    expect(get(notify).body).toBe('and {{ steps.summary.output }} again, keep {{steps.agent.output}}')
    expect(get(agent).prompt).toBe('Use {{  steps.summary.output  }}')
    expect(get(llm).system).toBe('self {{steps.summary.output}}')
    expect(get(agent).cwd).toBe('/tmp')
  })
  it('leaves everything but the name alone when the user edited the handle', () => {
    const { w, llm } = setup()
    const edited = { ...w, steps: w.steps.map((s) => (s.id === llm ? { ...s, handle: 'mine' } : s)) }
    const r = renameStep(edited, llm, 'Summary')
    expect(r.steps.find((s) => s.id === llm)).toMatchObject({ name: 'Summary', handle: 'mine' })
    expect(r.steps.filter((s) => s.id !== llm)).toEqual(edited.steps.filter((s) => s.id !== llm))
  })
  it('takes -2 when the new handle is taken, and does not touch similar handles', () => {
    const { w, llm, notify } = setup()
    const r = renameStep(w, llm, 'Notify')
    expect(r.steps.find((s) => s.id === llm)!.handle).toBe('notify-2')
    expect((r.steps.find((s) => s.id === notify) as Record<string, unknown>).title).toBe('Got {{steps.notify-2.output}}')
    const r2 = renameStep(w, llm, 'Agent X')
    expect((r2.steps.find((s) => s.id === notify) as Record<string, unknown>).body).toContain('{{steps.agent.output}}')
  })
  it('a same-handle rename only changes the name, and unknown ids change nothing', () => {
    const { w, llm } = setup()
    const r = renameStep(w, llm, 'llm')
    expect(r.steps.find((s) => s.id === llm)).toMatchObject({ name: 'llm', handle: 'llm' })
    expect(renameStep(w, 'nope', 'x')).toBe(w)
  })
  it('the trigger can be renamed too', () => {
    const w = base()
    const r = renameStep(w, triggerId(w), 'Start')
    expect(r.steps[0]).toMatchObject({ name: 'Start', handle: 'start' })
  })
})

describe('stepSummary', () => {
  const b = { id: 'x', handle: 'x', name: 'X', x: 0, y: 0 }
  it('describes every kind', () => {
    expect(stepSummary({ ...b, kind: 'agent', agent: 'reviewer', prompt: '', cwd: '', model: 'opus' })).toBe('reviewer · opus')
    expect(stepSummary({ ...b, kind: 'agent', agent: 'reviewer', prompt: '', cwd: '' })).toBe("reviewer · agent's model")
    expect(stepSummary({ ...b, kind: 'foreach', agent: 'helper', prompt: '', cwd: '' })).toBe('helper · for each line')
    expect(stepSummary({ ...b, kind: 'foreach', agent: '', prompt: '', cwd: '' })).toBe('No agent · for each line')
    expect(stepSummary({ ...b, kind: 'llm', prompt: '', model: 'haiku', effort: 'low' })).toBe('haiku · low')
    expect(stepSummary({ ...b, kind: 'condition', model: 'haiku', question: 'Is it ok?' })).toBe('Is it ok?')
    expect(stepSummary({ ...b, kind: 'condition', model: 'haiku', question: 'q'.repeat(100) })).toBe('q'.repeat(60))
    expect(stepSummary({ ...b, kind: 'approval', question: 'Approve this long question? '.repeat(5), editable: true })).toBe(
      'Approve this long question? '.repeat(5)
    )
    expect(stepSummary({ ...b, kind: 'wait', minutes: 5 })).toBe('Wait 5 min')
    expect(stepSummary({ ...b, kind: 'notify', title: 'Done' })).toBe('Done')
    expect(stepSummary({ ...b, kind: 'trigger' })).toBe('Trigger')
  })
  it('a chat step reads Pick a chat, the chat title or Chat not found', () => {
    const titles = (id: string): string | null => (id === 'c1' ? 'Daily notes' : null)
    expect(stepSummary({ ...b, kind: 'chat', chat: '', prompt: '' }, undefined, titles)).toBe('Pick a chat')
    expect(stepSummary({ ...b, kind: 'chat', chat: 'c1', prompt: '' }, undefined, titles)).toBe('Daily notes')
    expect(stepSummary({ ...b, kind: 'chat', chat: 'gone', prompt: '' }, undefined, titles)).toBe('Chat not found')
  })
  it('an llm without effort shows just the model', () => {
    expect(stepSummary({ ...b, kind: 'llm', prompt: '', model: 'sonnet' })).toBe('sonnet')
  })
})

describe('toFlow', () => {
  it('maps steps and labelled edges to plain objects', () => {
    const w0 = base()
    const a = addStep(w0, 'condition', { x: 100, y: 50 }, { stepId: triggerId(w0), port: 'out' }, seq())
    const b = addStep(a.w, 'approval', { x: 300, y: 50 }, { stepId: a.stepId, port: 'yes' }, seq())
    const c = addStep(b.w, 'wait', { x: 500, y: 50 }, { stepId: b.stepId, port: 'rejected' }, seq())
    const problems: Problem[] = [
      { stepId: a.stepId, text: 'Write a question' },
      { stepId: null, text: 'global' }
    ]
    const flow = toFlow(c.w, problems, { [a.stepId]: { status: 'running', visits: 2 } })
    const node = flow.nodes.find((n) => n.id === a.stepId)! as FlowNode
    expect(node).toEqual({
      id: a.stepId,
      type: 'step',
      position: { x: 100, y: 50 },
      data: {
        step: c.w.steps.find((s) => s.id === a.stepId),
        summary: '',
        problems: ['Write a question'],
        state: { status: 'running', visits: 2 }
      }
    })
    const other = flow.nodes.find((n) => n.id === b.stepId)! as FlowNode
    expect(other.data.problems).toEqual([])
    expect('state' in other.data).toBe(false)
    expect(flow.edges.map((e) => [e.source, e.sourceHandle, e.target, e.label])).toEqual([
      [triggerId(w0), 'out', a.stepId, undefined],
      [a.stepId, 'yes', b.stepId, 'Yes'],
      [b.stepId, 'rejected', c.stepId, 'Rejected']
    ])
    expect(flow.edges.every((e) => typeof e.id === 'string')).toBe(true)
    expect('label' in flow.edges[0]).toBe(false)
  })
  it('labels no, and approved', () => {
    const w0 = base()
    const a = addStep(w0, 'condition', { x: 0, y: 0 }, undefined, seq())
    const b = addStep(a.w, 'approval', { x: 0, y: 0 }, undefined, seq())
    const c = connect(
      connect(b.w, { stepId: a.stepId, port: 'no' }, b.stepId, seq()),
      { stepId: b.stepId, port: 'approved' },
      a.stepId,
      seq()
    )
    expect(toFlow(c, []).edges.map((e) => e.label)).toEqual(['No', 'Approved'])
  })
})

describe('toFlow notes', () => {
  const note = (id: string, width: number, height: number): Note => ({ id, x: 10, y: 20, width, height, color: 3, text: 't' })
  it('emits note nodes below every step, the smaller note above the bigger one', () => {
    const w = { ...base(), notes: [note('big', 300, 300), note('small', 200, 100)] }
    const { nodes } = toFlow(w, [])
    const big = nodes.find((n) => n.id === 'big') as NoteFlowNode,
      small = nodes.find((n) => n.id === 'small') as NoteFlowNode
    expect(big).toEqual({
      id: 'big',
      type: 'note',
      position: { x: 10, y: 20 },
      width: 300,
      height: 300,
      zIndex: -1000,
      data: { note: w.notes[0] }
    })
    expect(small.zIndex).toBe(-999)
    expect(small.zIndex).toBeLessThan(0)
    expect(nodes.filter((n) => n.type === 'step')).toHaveLength(1)
  })
  it('puts the later note above an earlier one of the same area', () => {
    const w = { ...base(), notes: [note('a', 200, 100), note('b', 100, 200)] }
    const z = (id: string) => (toFlow(w, []).nodes.find((n) => n.id === id) as NoteFlowNode).zIndex
    expect(z('b')).toBeGreaterThan(z('a'))
  })
})

describe('toFlow groups', () => {
  const wait = (id: string, x: number, y: number): Step => ({ id, handle: id, name: id.toUpperCase(), kind: 'wait', x, y, minutes: 1 })
  const cond = (id: string, x: number, y: number): Step => ({
    id,
    handle: id,
    name: id.toUpperCase(),
    kind: 'condition',
    x,
    y,
    model: 'haiku',
    question: 'q'
  })
  const edge = (from: string, port: Edge['port'], to: string): Edge => ({ id: `${from}-${port}-${to}`, from, port, to })
  const g1: CanvasGroup = { id: 'g1', name: 'Deploy', steps: ['b', 'c'], notes: ['n1'] }
  // t → a → b → c (a condition: yes → d, no → e); g1 = b, c, n1, whose box is x 276..844, y -60..304.
  const w: WorkflowInput = {
    id: null,
    name: 'W',
    enabled: false,
    timeZone: 'UTC',
    trigger: { kind: 'manual' },
    steps: [
      { id: 't', handle: 'trigger', name: 'Trigger', kind: 'trigger', x: -300, y: 0 },
      wait('a', 0, 0),
      wait('b', 300, 0),
      cond('c', 600, 0),
      wait('d', 900, 0),
      wait('e', 900, 200)
    ],
    edges: [edge('t', 'out', 'a'), edge('a', 'out', 'b'), edge('b', 'out', 'c'), edge('c', 'yes', 'd'), edge('c', 'no', 'e')],
    notes: [
      { id: 'n1', x: 300, y: 120, width: 240, height: 160, color: 1, text: '' },
      { id: 'n2', x: 0, y: 400, width: 240, height: 160, color: 2, text: '' }
    ],
    groups: [g1]
  }
  const sizeOf = () => ({ width: 220, height: 80 })
  const ids = (nodes: { id: string }[]) => nodes.map((n) => n.id)

  it('emits no group node and hides nothing without opts, as before', () => {
    const { nodes, edges } = toFlow(w, [])
    expect(ids(nodes)).toEqual(['n1', 'n2', 't', 'a', 'b', 'c', 'd', 'e'])
    expect(edges.map((e) => e.id)).toEqual(w.edges.map((e) => e.id))
  })
  it('puts an expanded group box under everything, not selectable or draggable', () => {
    const { nodes, edges } = toFlow(w, [], undefined, { collapsed: new Set(), sizeOf })
    expect(ids(nodes)).toEqual(['g1', 'n1', 'n2', 't', 'a', 'b', 'c', 'd', 'e'])
    expect(nodes[0] as GroupFlowNode).toEqual({
      id: 'g1',
      type: 'groupBox',
      position: { x: 276, y: -60 },
      width: 568,
      height: 364,
      zIndex: -500,
      selectable: false,
      draggable: false,
      data: { group: g1, broken: null }
    })
    expect(edges).toHaveLength(5)
  })
  it('draws a box over the loose notes and under its own notes, every step and every edge', () => {
    const z = (id: string) =>
      (toFlow(w, [], undefined, { collapsed: new Set(), sizeOf }).nodes.find((n) => n.id === id) as { zIndex?: number }).zIndex ?? 0
    // n1 (a member) and n2 (loose) are the same size, so each keeps its place by list order among its own kind.
    expect([z('n2'), z('g1'), z('n1'), z('b')]).toEqual([-999, -500, -400, 0])
    expect(z('n2')).toBeLessThan(z('g1'))
    expect(z('g1')).toBeLessThan(z('n1'))
    // Without groups shown, a member note is drawn as any note.
    expect((toFlow(w, []).nodes.find((n) => n.id === 'n1') as { zIndex: number }).zIndex).toBe(-1000)
  })
  it('orders member notes among themselves by size, the smaller on top', () => {
    const big = { id: 'n3', x: 300, y: 300, width: 600, height: 400, color: 1 as const, text: '' }
    const w3 = { ...w, notes: [...w.notes, big], groups: [{ ...g1, notes: ['n1', 'n3'] }] }
    const nodes = toFlow(w3, [], undefined, { collapsed: new Set(), sizeOf }).nodes as { id: string; zIndex?: number }[]
    const z = (id: string) => nodes.find((n) => n.id === id)!.zIndex!
    expect(z('n3')).toBeLessThan(z('n1'))
    expect(z('n3')).toBeGreaterThan(-500)
    expect(z('n1')).toBeLessThan(0)
  })
  it('says why a group that breaks a rule will be ungrouped', () => {
    const broken = { ...w, edges: [...w.edges, edge('t', 'out', 'c')] }
    const node = toFlow(broken, [], undefined, { collapsed: new Set(), sizeOf }).nodes[0] as GroupFlowNode
    expect(node.data.broken).toBe('Steps outside can only connect into the first step of the group')
  })
  it('says it on a collapsed group too', () => {
    const broken = { ...w, edges: [...w.edges, edge('t', 'out', 'c')] }
    const node = toFlow(broken, [], undefined, { collapsed: new Set(['g1']), sizeOf }).nodes.at(-1) as CollapsedGroupFlowNode
    expect(node.type).toBe('groupCollapsed')
    expect(node.data.broken).toBe('Steps outside can only connect into the first step of the group')
  })
  it('folds a collapsed group into one node at the box top-left, with the exit ports that leave it', () => {
    const { nodes, edges } = toFlow(w, [], undefined, { collapsed: new Set(['g1']), sizeOf })
    expect(ids(nodes)).toEqual(['n2', 't', 'a', 'd', 'e', 'g1'])
    expect(nodes.at(-1) as CollapsedGroupFlowNode).toEqual({
      id: 'g1',
      type: 'groupCollapsed',
      position: { x: 276, y: -60 },
      width: 220,
      height: 64,
      selectable: true,
      draggable: true,
      data: { group: g1, ports: ['yes', 'no'], hasInput: true, counts: { steps: 2, notes: 1 }, broken: null }
    })
    expect(edges.map((e) => [e.id, e.source, e.sourceHandle, e.target, e.label])).toEqual([
      ['t-out-a', 't', 'out', 'a', undefined],
      ['a-out-b', 'a', 'out', 'g1', undefined],
      ['c-yes-d', 'g1', 'yes', 'd', 'Yes'],
      ['c-no-e', 'g1', 'no', 'e', 'No']
    ])
  })
  it('skips a group whose members are all gone, expanded or collapsed', () => {
    const stale = { ...w, groups: [g1, { id: 'g2', name: 'Gone', steps: ['zz'], notes: ['nn'] }] }
    expect(ids(toFlow(stale, [], undefined, { collapsed: new Set(), sizeOf }).nodes)).toEqual([
      'g1',
      'n1',
      'n2',
      't',
      'a',
      'b',
      'c',
      'd',
      'e'
    ])
    expect(ids(toFlow(stale, [], undefined, { collapsed: new Set(['g1', 'g2']), sizeOf }).nodes)).toEqual(['n2', 't', 'a', 'd', 'e', 'g1'])
  })
  it("names the box node type groupBox, never React Flow's own styled group type", () => {
    const types = toFlow(w, [], undefined, { collapsed: new Set(), sizeOf }).nodes.map((n) => n.type)
    expect(types[0]).toBe('groupBox')
    expect(types).not.toContain('group')
  })
  it('gives a collapsed group no input and no ports when nothing outside joins it', () => {
    const lone = { ...w, edges: [edge('b', 'out', 'c')] }
    const node = toFlow(lone, [], undefined, { collapsed: new Set(['g1']), sizeOf }).nodes.at(-1) as CollapsedGroupFlowNode
    expect(node.data).toMatchObject({ ports: [], hasInput: false })
  })
})

describe('dirty', () => {
  it('ignores key order, sees real changes and positions', () => {
    const w = base()
    const reordered: WorkflowInput = JSON.parse(
      JSON.stringify({
        edges: w.edges,
        notes: w.notes,
        groups: w.groups,
        steps: w.steps.map((s) => ({ y: s.y, x: s.x, kind: s.kind, name: s.name, handle: s.handle, id: s.id })),
        trigger: w.trigger,
        timeZone: w.timeZone,
        enabled: w.enabled,
        name: w.name,
        id: w.id
      })
    )
    expect(dirty(w, reordered)).toBe(false)
    expect(dirty(w, { ...w, name: 'x' })).toBe(true)
    expect(dirty(w, moveStep(w, triggerId(w), 1, 0))).toBe(true)
    expect(dirty(w, { ...w, enabled: true })).toBe(true)
  })
})

describe('snap', () => {
  it('rounds to the 20 px grid', () => {
    expect([snap(0), snap(9), snap(10), snap(-11), snap(333)]).toEqual([0, 0, 20, -20, 340])
  })
})
