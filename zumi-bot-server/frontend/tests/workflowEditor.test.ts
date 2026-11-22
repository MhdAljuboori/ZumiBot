import { describe, expect, it } from 'vitest'
import { spendCapRefusal } from '@zumibot/shared/engine'
import type { AgentSummary, ChatMeta } from '@zumibot/shared/types'
import { defaultTrigger } from '@zumibot/shared/workflowEvents'
import type { Visit, Workflow, WorkflowTrigger, WorkflowInput, WorkflowRunSummary, WorkflowsSnapshot } from '@zumibot/shared/workflows'
import { addStep, connect, dirty, newWorkflow, setHandle, updateStep } from '../src/state/workflowCanvas'
import {
  adoptClean,
  adoptSaved,
  DEFAULT_SCHEDULE,
  savedChange,
  applySelect,
  itemsSelection,
  picked,
  pickedCount,
  pruneSelection,
  removableCount,
  selectAllItems,
  duplicateLabel,
  editorKey,
  edgeLabel,
  fitInView,
  freeSpot,
  panInto,
  generalProblems,
  firstFieldIndex,
  isTypingTarget,
  latestVisitInput,
  newestStepInput,
  recentRuns,
  refusalText,
  runStatusLabel,
  sameSelection,
  saveNotice,
  shownWorkflow,
  stepAgents,
  switchTrigger,
  templateFields,
  toInput,
  workflowCapBlocker,
  workflowRows,
  type Selection
} from '../src/state/workflowEditor'

const seq = () => {
  let n = 0
  return () => `id${++n}`
}
const HANDLE_RE = /^[a-z0-9-]{1,32}$/

// trigger → llm (handle "llm") → notify (handle "notify"), notify's title naming the llm's output.
function sample(): { w: WorkflowInput; trigger: string; llm: string; notify: string } {
  const gen = seq()
  let w = newWorkflow('UTC', gen)
  const trigger = w.steps[0].id
  const a = addStep(w, 'llm', { x: 200, y: 0 }, { stepId: trigger, port: 'out' }, gen)
  const b = addStep(a.w, 'notify', { x: 400, y: 0 }, { stepId: a.stepId, port: 'out' }, gen)
  w = updateStep(b.w, b.stepId, { title: 'Got {{steps.llm.output}}', body: '{{ steps.llm.output }} and {{steps.other.output}}' })
  return { w, trigger, llm: a.stepId, notify: b.stepId }
}

const visit = (stepId: string, input: string, n = 1): Visit => ({
  id: `${stepId}-${n}-${input}`,
  stepId,
  n,
  status: 'done',
  input,
  inputs: [],
  startedAt: n
})
const summary = (id: string, startedAt: number, status: WorkflowRunSummary['status'] = 'done'): WorkflowRunSummary => ({
  id,
  workflowId: 'w1',
  via: 'manual',
  status,
  late: false,
  startedAt,
  waiting: [],
  failed: []
})
const workflow = (id: string, name: string, extra: Partial<Workflow> = {}): Workflow => ({
  id,
  name,
  enabled: false,
  timeZone: 'UTC',
  trigger: { kind: 'manual' },
  steps: [],
  edges: [],
  nextRunAt: null,
  createdAt: 0,
  updatedAt: 0,
  ...extra
})

describe('notes in toInput', () => {
  it('a workflow stored before notes opens with notes [] and is not dirty', () => {
    const old = workflow('w1', 'Old')
    expect('notes' in old).toBe(false)
    expect(toInput(old).notes).toEqual([])
    expect(dirty(toInput(old), toInput(old))).toBe(false)
  })
})

describe('groups in toInput', () => {
  it('a workflow stored before groups opens with groups [] and is not dirty', () => {
    const old = workflow('w1', 'Old')
    expect('groups' in old).toBe(false)
    expect(toInput(old).groups).toEqual([])
    expect(dirty(toInput(old), toInput(old))).toBe(false)
  })

  it('keeps the groups it has', () => {
    const g = { id: 'g1', name: 'G', steps: ['a'], notes: [] }
    expect(toInput(workflow('w1', 'New', { groups: [g] })).groups).toEqual([g])
  })
})

describe('duplicateLabel', () => {
  it('says the save when there is something to save first', () => {
    expect(duplicateLabel(false, true)).toBe('Duplicate')
    expect(duplicateLabel(true, true)).toBe('Save and duplicate')
    expect(duplicateLabel(false, false)).toBe('Save and duplicate') // a new workflow was never saved
  })
})

describe('shownWorkflow', () => {
  const wf = (id: string, name = id): Workflow => ({
    id,
    name,
    enabled: false,
    timeZone: 'UTC',
    trigger: { kind: 'manual' },
    steps: [],
    edges: [],
    nextRunAt: null,
    createdAt: 1,
    updatedAt: 1
  })

  it('takes the listed workflow, else the duplicate just made, whose push may come after the answer', () => {
    const copy = wf('C', 'Copy')
    expect(shownWorkflow([wf('A')], 'A', null)?.id).toBe('A')
    expect(shownWorkflow([wf('A')], 'C', copy)).toBe(copy)
    expect(shownWorkflow([wf('A')], 'B', copy)).toBeNull()
    expect(shownWorkflow([wf('A'), wf('C', 'Pushed')], 'C', copy)?.name).toBe('Pushed') // the push wins once it lists it
  })
})

describe('editorKey', () => {
  it('keys a new editor by its fresh number, a saved one by its id, and nothing by nothing', () => {
    expect(editorKey({ workflowId: null, fresh: 3 }, null)).toBe('new-3')
    expect(editorKey({ workflowId: 'A' }, null)).toBe('wf-A')
    expect(editorKey({ workflowId: null }, null)).toBeNull()
  })

  it("keeps the new editor's key once its first save gives it an id, so it is not remounted mid-edit", () => {
    const adopted = { id: 'A', key: editorKey({ workflowId: null, fresh: 1 }, null)! }
    expect(editorKey({ workflowId: 'A' }, adopted)).toBe('new-1')
    expect(editorKey({ workflowId: 'B' }, adopted)).toBe('wf-B')
  })

  it("never gives a later New the adopted editor's key: New, Save, New makes a blank editor, not the saved one", () => {
    // App's counter only grows: the first New is 1, the second 2, whatever the route held in between.
    let seq = 0
    const first = editorKey({ workflowId: null, fresh: ++seq }, null)!
    const adopted = { id: 'A', key: first } // Save: the address becomes /workflows/A, the route drops `fresh`
    const shownForA = editorKey({ workflowId: 'A' }, adopted)
    const second = editorKey({ workflowId: null, fresh: ++seq }, adopted)
    expect(shownForA).toBe('new-1')
    expect(second).toBe('new-2')
    expect(second).not.toBe(shownForA)
  })

  it('never gives a saved workflow a key a new editor could have', () => {
    expect(editorKey({ workflowId: 'new-1' }, null)).toBe('wf-new-1')
  })
})

describe('setHandle', () => {
  it('sanitizes the typed text and rewrites the placeholders that named the old handle', () => {
    const { w, llm, notify } = sample()
    const r = setHandle(w, llm, 'Sum Up!')
    expect(r.steps.find((s) => s.id === llm)!.handle).toBe('sum-up')
    const n = r.steps.find((s) => s.id === notify) as Record<string, unknown>
    expect(n.title).toBe('Got {{steps.sum-up.output}}')
    // Inner spaces kept, and a placeholder naming another handle untouched.
    expect(n.body).toBe('{{ steps.sum-up.output }} and {{steps.other.output}}')
  })

  it('gives a name with no Latin letters the fallback handle, so the user can still edit it', () => {
    const { w, llm } = sample()
    const h = setHandle(w, llm, 'تلخيص').steps.find((s) => s.id === llm)!.handle
    expect(h).toBe('step')
    expect(h).toMatch(HANDLE_RE)
  })

  it("never takes another step's handle, and caps the length at 32", () => {
    const { w, llm } = sample()
    expect(setHandle(w, llm, 'notify').steps.find((s) => s.id === llm)!.handle).toBe('notify-2')
    const long = setHandle(w, llm, 'a'.repeat(50)).steps.find((s) => s.id === llm)!.handle
    expect(long).toMatch(HANDLE_RE)
    expect(long).toHaveLength(32)
  })

  it('returns the same workflow when nothing changes or the step is unknown', () => {
    const { w, llm } = sample()
    expect(setHandle(w, llm, 'llm')).toBe(w)
    expect(setHandle(w, 'nope', 'x')).toBe(w)
  })

  it('keeps the name', () => {
    const { w, llm } = sample()
    expect(setHandle(w, llm, 'x').steps.find((s) => s.id === llm)!.name).toBe('LLM')
  })
})

describe('updateStep', () => {
  it('sets fields and drops the ones set to undefined', () => {
    const { w, llm } = sample()
    const r = updateStep(updateStep(w, llm, { system: 'Be brief', effort: 'high' }), llm, { effort: undefined })
    expect(r.steps.find((s) => s.id === llm)).toMatchObject({ system: 'Be brief', model: 'haiku' })
    expect(r.steps.find((s) => s.id === llm)).not.toHaveProperty('effort')
  })

  it('never changes the id, kind or handle', () => {
    const { w, llm } = sample()
    const r = updateStep(w, llm, { id: 'x', kind: 'wait', handle: 'zzz' })
    expect(r.steps.find((s) => s.id === llm)).toMatchObject({ id: llm, kind: 'llm', handle: 'llm' })
  })

  it('returns the same workflow for an unknown step', () => {
    const { w } = sample()
    expect(updateStep(w, 'nope', { prompt: 'x' })).toBe(w)
  })
})

describe('templateFields', () => {
  it('lists input, the other steps by handle and trigger.text, never the step itself or the trigger step', () => {
    const { w, notify } = sample()
    expect(templateFields(w, notify, null)).toEqual(['input', 'steps.llm.output', 'trigger.text'])
  })

  it("adds the webhook test call's body and query fields under trigger.", () => {
    const { w, llm } = sample()
    const hooked = { ...w, trigger: { kind: 'webhook' as const, sample: null, filters: [] } }
    const call = { method: 'POST', query: { ref: 'main' }, body: { pr: { title: 'Fix' }, action: 'opened' }, receivedAt: 1 }
    expect(templateFields(hooked, llm, call)).toEqual([
      'input',
      'steps.notify.output',
      'trigger.text',
      'trigger.query.ref',
      'trigger.body.pr.title',
      'trigger.body.action'
    ])
  })

  it('offers no trigger.text for a schedule, whose trigger hands on no text', () => {
    const { w, llm } = sample()
    const timed = { ...w, trigger: { kind: 'schedule' as const, schedule: DEFAULT_SCHEDULE } }
    expect(templateFields(timed, llm, null)).toEqual(['input', 'steps.notify.output'])
  })
})

describe('templateFields for event triggers', () => {
  it("offers trigger.text and the sample call's leaf paths for an email trigger", () => {
    const { w, llm } = sample()
    const mailed = { ...w, trigger: defaultTrigger('email') }
    const fields = templateFields(mailed, llm, null)
    expect(fields).toContain('trigger.text')
    expect(fields).toContain('trigger.body.subject')
    expect(fields).toContain('trigger.body.from.address')
  })
  it("lists the file sample's paths for a file trigger, without a webhook call", () => {
    const { w, llm } = sample()
    expect(templateFields({ ...w, trigger: defaultTrigger('file') }, llm, null)).toContain('trigger.body.files.0.path')
  })
})

describe('templateFields for For each', () => {
  it('offers item fields in a foreach prompt only', () => {
    const { w, trigger } = sample()
    const added = addStep(w, 'foreach', { x: 0, y: 0 }, { stepId: trigger, port: 'out' }, seq())
    const fields = templateFields(added.w, added.stepId, null)
    expect(fields.slice(0, 4)).toEqual(['input', 'item', 'item.number', 'item.total'])
    expect(fields).toContain('steps.llm.output')
    expect(templateFields(added.w, w.steps.find((s) => s.kind === 'llm')!.id, null)).not.toContain('item')
  })
})

describe('stepAgents', () => {
  const a = (name: string, error: string | null = null, builtIn = false): AgentSummary => ({
    filePath: `/a/${name}.md`,
    name,
    description: '',
    color: null,
    icon: null,
    error,
    builtIn
  })
  it('keeps loadable agents and drops Zumi Bot and broken ones', () => {
    expect(stepAgents([a('ok'), a('broken', 'bad yaml'), a('zumi-bot', null, true)]).map((x) => x.name)).toEqual(['ok'])
  })
})

describe('generalProblems', () => {
  it('keeps only the problems no step carries', () => {
    const p = [
      { stepId: null, text: 'A workflow needs exactly one trigger' },
      { stepId: 's1', text: 'Write a prompt' }
    ]
    expect(generalProblems(p)).toEqual([p[0]])
  })
})

describe('switchTrigger', () => {
  it('makes each kind fresh', () => {
    expect(switchTrigger('manual', {})).toEqual({ kind: 'manual' })
    expect(switchTrigger('schedule', {})).toEqual({ kind: 'schedule', schedule: DEFAULT_SCHEDULE })
    expect(switchTrigger('webhook', {})).toEqual({ kind: 'webhook', sample: null, filters: [] })
  })
  it('starts an event kind from its default trigger', () => {
    for (const kind of ['reply', 'todo', 'inbox', 'file', 'email'] as const) expect(switchTrigger(kind, {})).toEqual(defaultTrigger(kind))
  })
  it("brings back an event kind's earlier settings", () => {
    const file = { ...defaultTrigger('file'), path: '/home/u/inv' } as WorkflowTrigger
    expect(switchTrigger('file', { file })).toBe(file)
  })
  it('brings back what the kind had earlier', () => {
    const hook = { kind: 'webhook' as const, sample: null, filters: [{ field: 'body.action', equals: 'opened' }] }
    expect(switchTrigger('webhook', { webhook: hook })).toBe(hook)
  })
})

describe('item selection', () => {
  const kindOf = (id: string) => (id.startsWith('n') ? 'note' : id.startsWith('g') ? 'group' : 'step') as 'step' | 'note' | 'group'
  const step = (id: string): Selection => ({ kind: 'step', id })
  const edge: Selection = { kind: 'edge', id: 'e1' }
  const pick = (id: string, selected = true) => ({ id, selected })

  it('picked lists the ids of every kind, none for an edge or nothing', () => {
    expect(picked(null)).toEqual({ steps: [], notes: [], groups: [] })
    expect(picked(edge)).toEqual({ steps: [], notes: [], groups: [] })
    expect(picked(step('a'))).toEqual({ steps: ['a'], notes: [], groups: [] })
    expect(picked({ kind: 'note', id: 'n1' })).toEqual({ steps: [], notes: ['n1'], groups: [] })
    expect(picked({ kind: 'items', steps: ['a'], notes: ['n1'], groups: ['g1'] })).toEqual({ steps: ['a'], notes: ['n1'], groups: ['g1'] })
    expect(pickedCount(picked({ kind: 'items', steps: ['a', 'b'], notes: ['n1'], groups: [] }))).toBe(3)
  })
  it('itemsSelection is nothing, one item of its kind, or items', () => {
    expect(itemsSelection({})).toBeNull()
    expect(itemsSelection({ steps: ['a'] })).toEqual({ kind: 'step', id: 'a' })
    expect(itemsSelection({ notes: ['n1'] })).toEqual({ kind: 'note', id: 'n1' })
    expect(itemsSelection({ groups: ['g1'] })).toEqual({ kind: 'group', id: 'g1' })
    expect(itemsSelection({ steps: ['a', 'a'], notes: ['n1'] })).toEqual({ kind: 'items', steps: ['a'], notes: ['n1'], groups: [] })
    expect(itemsSelection({ steps: ['a', 'b'] })).toEqual({ kind: 'items', steps: ['a', 'b'], notes: [], groups: [] })
  })
  it('applySelect grows with each pick and shrinks back to one step', () => {
    let s = applySelect(null, [pick('a')], kindOf)
    expect(s).toEqual(step('a'))
    s = applySelect(s, [pick('b')], kindOf)
    expect(s).toEqual({ kind: 'items', steps: ['a', 'b'], notes: [], groups: [] })
    s = applySelect(s, [pick('b', false)], kindOf)
    expect(s).toEqual(step('a'))
    expect(applySelect(s, [pick('a', false)], kindOf)).toBeNull()
  })
  it('applySelect adds and removes items of every kind', () => {
    let s = applySelect(null, [pick('a')], kindOf)
    s = applySelect(s, [pick('n1'), pick('g1')], kindOf)
    expect(s).toEqual({ kind: 'items', steps: ['a'], notes: ['n1'], groups: ['g1'] })
    expect(applySelect(s, [pick('n1', false), pick('g1', false)], kindOf)).toEqual(step('a'))
  })
  it('applySelect takes a plain click as that item alone', () => {
    const s: Selection = { kind: 'items', steps: ['a', 'b'], notes: [], groups: [] }
    expect(applySelect(s, [pick('c'), pick('a', false), pick('b', false)], kindOf)).toEqual(step('c'))
  })
  it('applySelect ignores an id of no known kind', () => {
    expect(applySelect(step('a'), [pick('zz')], () => null)).toEqual(step('a'))
  })
  it('applySelect keeps an edge until an item is picked', () => {
    expect(applySelect(edge, [pick('a', false)], kindOf)).toBe(edge)
    expect(applySelect(edge, [], kindOf)).toBe(edge)
    expect(applySelect(edge, [pick('a')], kindOf)).toEqual(step('a'))
  })
  it('sameSelection compares kind and members', () => {
    const items = (...steps: string[]): Selection => ({ kind: 'items', steps, notes: [], groups: [] })
    expect(sameSelection(null, null)).toBe(true)
    expect(sameSelection(step('a'), step('a'))).toBe(true)
    expect(sameSelection(step('a'), { kind: 'edge', id: 'a' })).toBe(false)
    expect(sameSelection(step('n1'), { kind: 'note', id: 'n1' })).toBe(false)
    expect(sameSelection(items('a', 'b'), items('a', 'b'))).toBe(true)
    expect(sameSelection(items('a', 'b'), items('b', 'a'))).toBe(false)
    expect(sameSelection(items('a', 'b'), { kind: 'items', steps: ['a', 'b'], notes: ['n1'], groups: [] })).toBe(false)
    expect(sameSelection(items('a', 'b'), null)).toBe(false)
  })
  it('pruneSelection drops ids the workflow no longer has', () => {
    const w = { ...newWorkflow('UTC', seq()), steps: [{ id: 'a' } as WorkflowInput['steps'][number]], notes: [], groups: [] }
    expect(pruneSelection({ kind: 'items', steps: ['a', 'gone'], notes: ['n-gone'], groups: [] }, w, new Set())).toEqual({
      kind: 'step',
      id: 'a'
    })
    expect(pruneSelection({ kind: 'edge', id: 'gone' }, w, new Set())).toBeNull()
  })
  it('pruneSelection keeps the notes the workflow has and drops the rest', () => {
    const w = { ...newWorkflow('UTC', seq()), notes: [{ id: 'n1', x: 0, y: 0, width: 240, height: 160, color: 1 as const, text: '' }] }
    expect(pruneSelection({ kind: 'items', steps: [], notes: ['n1', 'n2'], groups: [] }, w, new Set())).toEqual({ kind: 'note', id: 'n1' })
    expect(pruneSelection({ kind: 'note', id: 'n2' }, w, new Set())).toBeNull()
  })
  it('pruneSelection keeps an existing edge and a collapsed group', () => {
    const { w } = sample()
    const e = w.edges[0].id
    expect(pruneSelection({ kind: 'edge', id: e }, w, new Set())).toEqual({ kind: 'edge', id: e })
    const wg = { ...w, groups: [{ id: 'g1' }, { id: 'g2' }] }
    expect(pruneSelection({ kind: 'group', id: 'g1' }, wg, new Set(['g1']))).toEqual({ kind: 'group', id: 'g1' })
    expect(pruneSelection({ kind: 'group', id: 'g1' }, wg, new Set())).toBeNull()
    expect(pruneSelection(null, wg, new Set())).toBeNull()
  })
  it('pruneSelection drops the steps and notes a collapsed group hides, and keeps what an expanded one holds', () => {
    const { w, llm, notify } = sample()
    const wg = {
      ...w,
      notes: [{ id: 'n1', x: 0, y: 0, width: 240, height: 160, color: 1 as const, text: '' }],
      groups: [{ id: 'g1', name: 'G', steps: [llm, notify], notes: ['n1'] }]
    }
    const sel: Selection = { kind: 'items', steps: [llm, notify], notes: ['n1'], groups: [] }
    expect(pruneSelection(sel, wg, new Set(['g1']))).toBeNull()
    expect(pruneSelection(sel, wg, new Set())).toEqual(sel)
    expect(pruneSelection({ kind: 'items', steps: [llm], notes: [], groups: ['g1'] }, wg, new Set(['g1']))).toEqual({
      kind: 'group',
      id: 'g1'
    })
  })
  it('pruneSelection drops a collapsed group the workflow no longer has, and keeps the collapsed ones among items', () => {
    const { w, llm } = sample()
    const wg = { ...w, groups: [{ id: 'g1' }, { id: 'g2' }] }
    expect(pruneSelection({ kind: 'group', id: 'g9' }, wg, new Set(['g9']))).toBeNull()
    expect(pruneSelection({ kind: 'items', steps: [llm], notes: [], groups: ['g1', 'g2', 'g9'] }, wg, new Set(['g2', 'g9']))).toEqual({
      kind: 'items',
      steps: [llm],
      notes: [],
      groups: ['g2']
    })
  })
})

describe('isTypingTarget', () => {
  it('counts text fields, selects, textareas and editable content', () => {
    expect(isTypingTarget({ tagName: 'INPUT', type: 'text' })).toBe(true)
    expect(isTypingTarget({ tagName: 'input' })).toBe(true)
    expect(isTypingTarget({ tagName: 'TEXTAREA' })).toBe(true)
    expect(isTypingTarget({ tagName: 'SELECT' })).toBe(true)
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true)
  })
  it('leaves out checkboxes, buttons, the canvas and nothing focused', () => {
    expect(isTypingTarget({ tagName: 'INPUT', type: 'checkbox' })).toBe(false)
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false)
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: false })).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})

describe('firstFieldIndex', () => {
  const select = { tagName: 'SELECT' }
  const prompt = { tagName: 'DIV', isContentEditable: true }
  it('passes a model select by for the first text field, as Enter and a double-click open an LLM step at its prompt', () => {
    expect(firstFieldIndex([select, select, prompt, prompt])).toBe(2)
    expect(firstFieldIndex([{ tagName: 'INPUT', type: 'number' }])).toBe(0)
    expect(firstFieldIndex([{ tagName: 'INPUT', type: 'checkbox' }, { tagName: 'TEXTAREA' }])).toBe(1)
  })
  it('skips disabled and read-only fields, and takes the first other control when no text field is left', () => {
    expect(firstFieldIndex([{ tagName: 'TEXTAREA', disabled: true }, { tagName: 'INPUT', readOnly: true }, prompt])).toBe(2)
    expect(firstFieldIndex([{ tagName: 'SELECT', disabled: true }, select, { tagName: 'INPUT', type: 'checkbox' }])).toBe(1)
    expect(firstFieldIndex([{ tagName: 'TEXTAREA', disabled: true }])).toBe(-1)
    expect(firstFieldIndex([])).toBe(-1)
  })
})

describe('freeSpot', () => {
  it('keeps a free point and rounds it', () => {
    expect(freeSpot({ steps: [] }, { x: 10.4, y: 19.6 })).toEqual({ x: 10, y: 20 })
  })
  it('moves right of a step that would cover the point, so the new step never hides it', () => {
    expect(freeSpot({ steps: [{ id: 't', x: 0, y: 0 }] } as never, { x: 10, y: 5 })).toEqual({ x: 290, y: 5 })
  })
  it('goes further right past a short row', () => {
    const { w } = sample() // steps at (0,0), (200,0), (400,0)
    expect(freeSpot(w, { x: 205, y: 3 })).toEqual({ x: 765, y: 3 })
  })
  it('goes below when the row is full, then above', () => {
    const row = (y: number) => [-280, 0, 280, 560, 840].map((x) => ({ id: `${x},${y}`, x, y }))
    expect(freeSpot({ steps: row(0) } as never, { x: 0, y: 0 })).toEqual({ x: 0, y: 120 })
    expect(freeSpot({ steps: [...row(0), ...row(120)] } as never, { x: 0, y: 0 })).toEqual({ x: 0, y: -120 })
  })
})

describe('panInto', () => {
  const view = { left: 100, top: 50, right: 700, bottom: 650 }
  it('stays put for a box already in view', () => {
    expect(panInto({ left: 200, top: 100, right: 400, bottom: 200 }, view, 20)).toEqual({ dx: 0, dy: 0 })
  })
  it('pans just enough to bring a box past the right or bottom edge in', () => {
    expect(panInto({ left: 600, top: 600, right: 800, bottom: 700 }, view, 20)).toEqual({ dx: 120, dy: 70 })
  })
  it('pans the other way for a box past the left or top edge', () => {
    expect(panInto({ left: 50, top: 0, right: 250, bottom: 80 }, view, 20)).toEqual({ dx: -70, dy: -70 })
  })
})

describe('fitInView', () => {
  const view = { left: 0, top: 0, right: 1000, bottom: 600 }
  const size = { w: 240, h: 84 }
  it('keeps a point whose step already fits', () => {
    expect(fitInView({ x: 100, y: 100 }, view, size)).toEqual({ x: 100, y: 100 })
  })
  it('pulls a step dropped near the right or bottom edge back inside', () => {
    expect(fitInView({ x: 950, y: 580 }, view, size)).toEqual({ x: 760, y: 516 })
  })
  it('pushes one past the left or top edge back in', () => {
    expect(fitInView({ x: -30, y: -10 }, view, size)).toEqual({ x: 0, y: 0 })
  })
})

describe('saveNotice', () => {
  const problem = [{ stepId: 's', text: 'Write a prompt' }]
  it('says a workflow asked on was saved off', () => {
    expect(saveNotice(true, { enabled: false }, problem)).toMatch(/^Saved, but the workflow stays off/)
  })
  it('points at the folders when the editor sees no problem itself', () => {
    expect(saveNotice(true, { enabled: false }, [])).toMatch(/folder exists/)
  })
  it('warns when a workflow that stays on has problems', () => {
    expect(saveNotice(true, { enabled: true }, problem)).toMatch(/runs fail/)
    expect(saveNotice(false, { enabled: true }, problem)).toMatch(/runs fail/)
  })
  it('says nothing for a plain save', () => {
    expect(saveNotice(true, { enabled: true }, [])).toBeNull()
    expect(saveNotice(false, { enabled: false }, problem)).toBeNull()
  })
})

describe('refusalText', () => {
  const msg = 'This workflow has problems: fix them before running'
  it('keeps the server text when the editor shows problems', () => {
    expect(refusalText(msg, [{ stepId: 's', text: 'x' }], false)).toBe(msg)
  })
  it('adds the folder hint when the editor sees none, and asks for a save when there are edits', () => {
    expect(refusalText(msg, [], true)).toBe(
      `${msg} Check that each Agent step's folder exists. Save your changes first: the saved workflow is what runs.`
    )
  })
  it('passes any other error through as it is', () => {
    expect(refusalText('Too many runs in progress', [], true)).toBe('Too many runs in progress')
  })
})

describe('latestVisitInput and newestStepInput', () => {
  it("takes the step's latest visit in a run", () => {
    expect(latestVisitInput({ visits: [visit('a', 'one'), visit('b', 'x'), visit('a', 'two', 2)] }, 'a')).toBe('two')
    expect(latestVisitInput({ visits: [visit('b', 'x')] }, 'a')).toBeNull()
  })

  it('reads runs newest first, skipping skipped ones, until one reached the step', async () => {
    const runs = [summary('old', 1), summary('skip', 9, 'skipped'), summary('new', 5), summary('mid', 3)]
    const asked: string[] = []
    const store: Record<string, Visit[]> = { new: [visit('b', 'x')], mid: [visit('a', 'from mid')], old: [visit('a', 'from old')] }
    const got = await newestStepInput(runs, 'a', async (id) => {
      asked.push(id)
      return { visits: store[id] }
    })
    expect(got).toBe('from mid')
    expect(asked).toEqual(['new', 'mid'])
  })

  it('gives null when no run reached the step, a run is gone or a fetch fails, and stops after max runs', async () => {
    const runs = [summary('r1', 3), summary('r2', 2), summary('r3', 1)]
    const asked: string[] = []
    const got = await newestStepInput(
      runs,
      'a',
      async (id) => {
        asked.push(id)
        if (id === 'r1') return null
        throw new Error('gone')
      },
      2
    )
    expect(got).toBeNull()
    expect(asked).toEqual(['r1', 'r2'])
  })
})

describe('runStatusLabel', () => {
  it('has words for every status, running included', () => {
    for (const s of ['running', 'waiting', 'done', 'failed', 'stopped', 'skipped'] as const) expect(runStatusLabel(s)).toMatch(/\w/)
    expect(runStatusLabel('waiting')).toBe('Waiting on you')
  })
})

describe('workflowRows and recentRuns', () => {
  const snap: WorkflowsSnapshot = {
    workflows: [workflow('b', 'beta', { enabled: true, trigger: { kind: 'webhook', sample: null, filters: [] } }), workflow('a', 'Alpha')],
    runs: { b: [summary('r1', 1, 'done'), summary('r2', 5, 'running'), summary('r3', 9, 'skipped')] }
  }
  it("sorts by name without case and carries the trigger summary and the newest real run's status", () => {
    expect(workflowRows(snap)).toEqual([
      { id: 'a', name: 'Alpha', enabled: false, trigger: 'manual', summary: 'Manual', dot: null },
      { id: 'b', name: 'beta', enabled: true, trigger: 'webhook', summary: 'Webhook', dot: 'running' }
    ])
  })
  it("lists a workflow's runs newest first, capped", () => {
    expect(recentRuns(snap, 'b').map((r) => r.id)).toEqual(['r3', 'r2', 'r1'])
    expect(recentRuns(snap, 'b', 2).map((r) => r.id)).toEqual(['r3', 'r2'])
    expect(recentRuns(snap, 'a')).toEqual([])
  })
})

describe('edgeLabel and toInput', () => {
  it('names both ends and the port', () => {
    const gen = seq()
    const w0 = newWorkflow('UTC', gen)
    const c = addStep(w0, 'condition', { x: 0, y: 0 }, { stepId: w0.steps[0].id, port: 'out' }, gen)
    const n = addStep(c.w, 'notify', { x: 0, y: 0 }, undefined, gen)
    const w = connect(n.w, { stepId: c.stepId, port: 'yes' }, n.stepId, gen)
    const yes = w.edges.find((e) => e.port === 'yes')!
    expect(edgeLabel(w, yes.id)).toBe('Condition → Notify (Yes)')
    expect(edgeLabel(w, w.edges[0].id)).toBe('Trigger → Condition')
    expect(edgeLabel(w, 'nope')).toBeNull()
  })
  it('keeps only what a save sends', () => {
    const w = workflow('a', 'A', { nextRunAt: 5 })
    expect(toInput(w)).toEqual({
      id: 'a',
      name: 'A',
      enabled: false,
      timeZone: 'UTC',
      trigger: { kind: 'manual' },
      steps: [],
      edges: [],
      notes: [],
      groups: []
    })
  })
})

describe('notes in the selection', () => {
  const n = (id: string) => ({ id, x: 0, y: 0, width: 240, height: 160, color: 1 as const, text: '' })
  it('selectAllItems picks every step and note, one item alone', () => {
    const { w } = sample()
    const wn = { ...w, notes: [n('n1'), n('n2')] }
    expect(selectAllItems(wn)).toEqual({ kind: 'items', steps: wn.steps.map((s) => s.id), notes: ['n1', 'n2'], groups: [] })
    expect(selectAllItems(newWorkflow('UTC', seq()))).toMatchObject({ kind: 'step' })
    expect(selectAllItems({ steps: [], notes: [n('n1')] })).toEqual({ kind: 'note', id: 'n1' })
    expect(selectAllItems({ steps: [] })).toBeNull()
  })
  it('removableCount counts the picked notes and every picked step but the trigger', () => {
    const { w: w0, trigger, llm } = sample()
    const w = { ...w0, notes: [n('n1'), n('n2')] }
    expect(removableCount(w, { steps: [trigger, llm], notes: ['n1', 'n2'], groups: [] })).toBe(3)
    expect(removableCount(w, { steps: [trigger], notes: [], groups: [] })).toBe(0)
    expect(removableCount(w, { steps: ['gone'], notes: ['n-gone'], groups: [] })).toBe(0)
  })
  it('removableCount counts what Delete takes with a picked group: its members, each once', () => {
    const { w: w0, trigger, llm, notify } = sample()
    const w = { ...w0, notes: [n('n1'), n('n2')], groups: [{ id: 'g1', name: 'G', steps: [llm, notify], notes: ['n1'] }] }
    expect(removableCount(w, { steps: [], notes: [], groups: ['g1'] })).toBe(3)
    expect(removableCount(w, { steps: [trigger, llm], notes: ['n1', 'n2'], groups: ['g1'] })).toBe(4)
    expect(removableCount(w, { steps: [], notes: [], groups: ['gone'] })).toBe(0)
  })
  it('selectAllItems with the collapsed groups picks them in place of their hidden members', () => {
    const { w: w0, trigger, llm, notify } = sample()
    const w = { ...w0, notes: [n('n1'), n('n2')], groups: [{ id: 'g1', name: 'G', steps: [llm, notify], notes: ['n1'] }] }
    expect(selectAllItems(w, new Set(['g1']))).toEqual({ kind: 'items', steps: [trigger], notes: ['n2'], groups: ['g1'] })
    expect(selectAllItems(w, new Set())).toEqual({ kind: 'items', steps: [trigger, llm, notify], notes: ['n1', 'n2'], groups: [] })
  })
})

describe('adoptSaved', () => {
  const room = (rules: { tool: string }[]): import('@zumibot/shared/workflows').Step =>
    ({
      id: 'r',
      handle: 'r',
      name: 'R',
      x: 0,
      y: 0,
      kind: 'room',
      room: 'g',
      prompt: 'p',
      rules
    }) as import('@zumibot/shared/workflows').Step
  it("takes the saved workflow as the base and gives the draft the rules it gained, keeping the draft's own edits", () => {
    const base = toInput(workflow('w', 'Old', { steps: [room([])] }))
    const draft = { ...base, name: 'Mine' }
    const live = workflow('w', 'Old', { steps: [room([{ tool: 'Edit' }])], updatedAt: 5 })
    const out = adoptSaved(draft, base, live)
    expect(out.baseline).toEqual(toInput(live))
    expect(out.draft.name).toBe('Mine')
    expect(out.draft.steps).toEqual([room([{ tool: 'Edit' }])])
  })
  it("keeps the draft's on/off flip, and follows the saved one when the draft never flipped it", () => {
    const base = toInput(workflow('w', 'W', { enabled: false }))
    const live = workflow('w', 'W', { enabled: true, updatedAt: 2 })
    expect(adoptSaved(base, base, live).draft.enabled).toBe(true)
    expect(adoptSaved({ ...base, enabled: true }, base, { ...live, enabled: false }).draft.enabled).toBe(true)
  })
})

describe('adoptClean', () => {
  it('makes the saved workflow both the draft and the base', () => {
    const live = workflow('w', 'Saved', {
      enabled: true,
      steps: [
        {
          id: 'r',
          handle: 'r',
          name: 'R',
          x: 0,
          y: 0,
          kind: 'room',
          room: 'g',
          prompt: 'p',
          rules: [{ tool: 'Edit' }]
        } as import('@zumibot/shared/workflows').Step
      ],
      updatedAt: 9
    })
    const out = adoptClean(live)
    expect(out.draft).toEqual(toInput(live))
    expect(out.baseline).toEqual(toInput(live))
    expect(dirty(out.draft, out.baseline)).toBe(false)
  })
})

describe('savedChange', () => {
  const o = { saving: false, seenAt: 5, liveUpdatedAt: 6, dirty: false }
  it('replaces a clean draft and merges into a dirty one when the saved workflow is newer', () => {
    expect(savedChange(o)).toBe('replace')
    expect(savedChange({ ...o, dirty: true })).toBe('merge')
  })
  it('ignores what the editor already saw, older or equal', () => {
    expect(savedChange({ ...o, liveUpdatedAt: 5 })).toBe('seen')
    expect(savedChange({ ...o, liveUpdatedAt: 4 })).toBe('seen')
  })
  it('leaves a push alone while its own save is in flight, since that push may be the save itself', () => {
    expect(savedChange({ ...o, saving: true })).toBe('wait')
    expect(savedChange({ ...o, saving: true, dirty: true })).toBe('wait')
  })
})

describe('workflowCapBlocker', () => {
  const agent = (name: string, provider?: 'codex' | 'acp'): AgentSummary => ({
    filePath: `/a/${name}.md`,
    name,
    description: '',
    color: null,
    icon: null,
    error: null,
    builtIn: false,
    ...(provider ? { provider } : {})
  })
  const agents = [agent('ui'), agent('gem', 'acp')]
  const withAgent = (name: string): WorkflowInput => {
    const gen = seq()
    const w = newWorkflow('UTC', gen)
    const a = addStep(w, 'agent', { x: 200, y: 0 }, { stepId: w.steps[0].id, port: 'out' }, gen)
    return updateStep(a.w, a.stepId, { agent: name })
  }
  it('is null while every agent step reports a cost, and for a workflow with no agent step', () => {
    expect(workflowCapBlocker(withAgent('ui'), agents, [])).toBeNull()
    expect(workflowCapBlocker(newWorkflow('UTC', seq()), agents, [])).toBeNull()
  })
  it('names the agent whose engine has no cost, through an Agent step or a Chat step', () => {
    expect(workflowCapBlocker(withAgent('gem'), agents, [])).toBe(spendCapRefusal('acp', 'gem'))
    const gen = seq()
    const w = newWorkflow('UTC', gen)
    const c = addStep(w, 'chat', { x: 200, y: 0 }, { stepId: w.steps[0].id, port: 'out' }, gen)
    const chats: ChatMeta[] = [
      { id: 'c1', agentName: 'gem', sessionId: null, cwd: '/w', title: '', createdAt: 0, updatedAt: 0, inFlight: false }
    ]
    expect(workflowCapBlocker(updateStep(c.w, c.stepId, { chat: 'c1' }), agents, chats)).toBe(spendCapRefusal('acp', 'gem'))
  })
})
