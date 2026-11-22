import { describe, expect, it } from 'vitest'
import { USE_ITEM_TEXT, handleFor, problemsOf, reachableFrom, renameHandle, stepHandles } from '../src/workflowGraph'
import { renameStepAgent } from '../src/workflowRename'
import { NOTIFY_INBOX_BODY_MAX, NOTIFY_TITLE_MAX, PICK_CHAT, PICK_MEMBERS, PROMPT_MAX, portsOf, summaryOf } from '../src/workflows'
import type { Edge, Step, Workflow, WorkflowRun } from '../src/workflows'

const pos = { x: 0, y: 0 }
const trig = (id = 't'): Step => ({ id, kind: 'trigger', handle: id, name: 'Trigger', ...pos })
const agent = (id: string, over: Partial<Extract<Step, { kind: 'agent' }>> = {}): Step => ({
  id,
  kind: 'agent',
  handle: id,
  name: id,
  agent: 'writer',
  prompt: 'Say hi',
  cwd: '/tmp',
  ...pos,
  ...over
})
const foreach = (id: string, over: Partial<Extract<Step, { kind: 'foreach' }>> = {}): Step => ({
  id,
  kind: 'foreach',
  handle: id,
  name: id,
  agent: 'writer',
  prompt: 'Check {{item}}',
  cwd: '/tmp',
  ...pos,
  ...over
})
const llm = (id: string, over: Partial<Extract<Step, { kind: 'llm' }>> = {}): Step => ({
  id,
  kind: 'llm',
  handle: id,
  name: id,
  prompt: 'Summarize',
  model: 'haiku',
  ...pos,
  ...over
})
const edge = (from: string, to: string, port: Edge['port'] = 'out'): Edge => ({ id: `${from}-${to}`, from, port, to })
const agents = [
  { name: 'writer', error: null },
  { name: 'other', error: null },
  { name: 'broken', error: 'bad file' }
]
const wf = (steps: Step[], edges: Edge[]): Pick<Workflow, 'trigger' | 'steps' | 'edges'> => ({ trigger: { kind: 'manual' }, steps, edges })
const check = (steps: Step[], edges: Edge[]) => problemsOf(wf(steps, edges), agents, 'zumi-bot')
const texts = (steps: Step[], edges: Edge[], id: string) =>
  check(steps, edges)
    .filter((p) => p.stepId === id)
    .map((p) => p.text)

const chatStep = (id: string, over: Partial<Extract<Step, { kind: 'chat' }>> = {}): Step => ({
  id,
  kind: 'chat',
  handle: id,
  name: id,
  chat: 'c1',
  prompt: 'x',
  ...pos,
  ...over
})
const roomFrom = (id: string, over: Partial<Extract<Step, { kind: 'room' }>> = {}): Step => ({
  id,
  kind: 'room',
  handle: id,
  name: id,
  room: '',
  prompt: 'x',
  members: ['writer', 'other'],
  role: '',
  cwd: '/w',
  ...pos,
  ...over
})

describe('problemsOf', () => {
  it('asks for a chat and for two agents', () => {
    const p = check([trig(), chatStep('c', { chat: '' }), roomFrom('r', { members: ['writer'] })], [edge('t', 'c'), edge('t', 'r')])
    expect(p.map((x) => x.text)).toEqual(expect.arrayContaining([PICK_CHAT, PICK_MEMBERS]))
    expect(texts([trig(), roomFrom('r', { members: ['writer'] })], [edge('t', 'r')], 'r')).not.toContain('Pick a room')
  })

  it('judges each room member as an agent step', () => {
    const t = texts([trig(), roomFrom('r', { members: ['writer', 'zumi-bot', 'gone', 'broken'] })], [edge('t', 'r')], 'r')
    expect(t).toEqual(
      expect.arrayContaining(['Zumi Bot cannot be a workflow step', 'Agent "gone" not found', 'Agent "broken" has an error'])
    )
  })

  it('a chat step and a room from agents need a prompt, and a copied room still needs a room', () => {
    expect(texts([trig(), chatStep('c', { prompt: ' ' })], [edge('t', 'c')], 'c')).toEqual(['Write a prompt'])
    expect(texts([trig(), roomFrom('r', { prompt: '' })], [edge('t', 'r')], 'r')).toEqual(['Write a prompt'])
    const copied: Step = { id: 'r', kind: 'room', handle: 'r', name: 'r', room: '', prompt: 'x', ...pos }
    expect(texts([trig(), copied], [edge('t', 'r')], 'r')).toEqual(['Pick a room'])
    expect(texts([trig(), chatStep('c', { prompt: 'x {{steps.nope.output}}' })], [edge('t', 'c')], 'c')).toEqual([
      'No step has the handle "nope"'
    ])
    expect(texts([trig(), chatStep('c', { prompt: 'x'.repeat(PROMPT_MAX + 1) })], [edge('t', 'c')], 'c')).toHaveLength(1)
  })

  it('valid three-step workflow has no problems', () => {
    expect(check([trig(), agent('a'), llm('b')], [edge('t', 'a'), edge('a', 'b')])).toEqual([])
  })

  it('needs exactly one trigger', () => {
    const want = [{ stepId: null, text: 'A workflow needs exactly one trigger' }]
    expect(check([agent('a')], [])).toContainEqual(want[0])
    expect(check([trig('t1'), trig('t2')], [])).toContainEqual(want[0])
    expect(check([trig('t1'), trig('t2')], []).filter((p) => p.stepId === null)).toEqual(want)
  })

  it('edge into trigger', () => {
    const p = check([trig(), agent('a')], [edge('t', 'a'), edge('a', 't')])
    expect(p).toContainEqual({ stepId: 't', text: 'Nothing can lead into the trigger' })
  })

  it('unreachable step', () => {
    expect(texts([trig(), agent('a'), llm('b')], [edge('t', 'a')], 'b')).toEqual(['No path from the trigger reaches this step'])
  })

  it('agent problems', () => {
    const t = (name: string) => texts([trig(), agent('a', { agent: name })], [edge('t', 'a')], 'a')
    expect(t('')).toEqual(['Pick an agent'])
    expect(t('x')).toEqual(['Agent "x" not found'])
    expect(t('broken')).toEqual(['Agent "broken" has an error'])
    expect(t('zumi-bot')).toEqual(['Zumi Bot cannot be a workflow step'])
  })

  it('empty fields', () => {
    const steps: Step[] = [
      trig(),
      agent('a', { prompt: ' ' }),
      llm('l', { prompt: '' }),
      { id: 'c', kind: 'condition', handle: 'c', name: 'c', question: '', model: 'haiku', ...pos },
      { id: 'p', kind: 'approval', handle: 'p', name: 'p', question: ' ', editable: true, ...pos },
      { id: 'n', kind: 'notify', handle: 'n', name: 'n', title: '', ...pos }
    ]
    const edges = ['a', 'l', 'c', 'p', 'n'].map((id) => edge('t', id))
    expect(texts(steps, edges, 'a')).toEqual(['Write a prompt'])
    expect(texts(steps, edges, 'l')).toEqual(['Write a prompt'])
    expect(texts(steps, edges, 'c')).toEqual(['Write a question'])
    expect(texts(steps, edges, 'p')).toEqual(['Write a question'])
    expect(texts(steps, edges, 'n')).toEqual(['Write a title'])
  })

  it('caps', () => {
    const long = 'x'.repeat(PROMPT_MAX + 1)
    expect(texts([trig(), agent('a', { prompt: long })], [edge('t', 'a')], 'a')).toEqual(['Prompt is over 20 000 characters'])
    const wait = (minutes: number): Step => ({ id: 'w', kind: 'wait', handle: 'w', name: 'w', minutes, ...pos })
    for (const m of [0, 1441]) expect(texts([trig(), wait(m)], [edge('t', 'w')], 'w')).toEqual(['Wait between 1 and 1440 minutes'])
    expect(
      texts(
        [trig(), wait(1), wait(1440)].map((s, i) => (i === 2 ? { ...s, id: 'w2', handle: 'w2' } : s)),
        [edge('t', 'w'), edge('t', 'w2')],
        'w'
      )
    ).toEqual([])
    const notify = (title: string): Step => ({ id: 'n', kind: 'notify', handle: 'n', name: 'n', title, ...pos })
    expect(texts([trig(), notify('x'.repeat(NOTIFY_TITLE_MAX + 1))], [edge('t', 'n')], 'n')).toEqual(['Title is over 80 characters'])
    expect(texts([trig(), notify('x'.repeat(NOTIFY_TITLE_MAX))], [edge('t', 'n')], 'n')).toEqual([])
    // The body is the Inbox's text (20 000), not the push's 200.
    const withBody = (body: string): Step => ({ id: 'n', kind: 'notify', handle: 'n', name: 'n', title: 'T', body, ...pos })
    expect(texts([trig(), withBody('x'.repeat(NOTIFY_INBOX_BODY_MAX))], [edge('t', 'n')], 'n')).toEqual([])
    expect(texts([trig(), withBody('x'.repeat(NOTIFY_INBOX_BODY_MAX + 1))], [edge('t', 'n')], 'n')).toEqual([
      'Body is over 20 000 characters'
    ])
  })

  it('duplicate handle', () => {
    const steps = [trig(), agent('a', { handle: 'same' }), llm('b', { handle: 'same' })]
    const edges = [edge('t', 'a'), edge('a', 'b')]
    expect(texts(steps, edges, 'a')).toEqual(['Another step has this handle'])
    expect(texts(steps, edges, 'b')).toEqual(['Another step has this handle'])
  })

  it('unknown step handle', () => {
    const steps = [trig(), agent('a', { prompt: 'Use {{steps.nope.output}} and {{steps.t.output}}' })]
    expect(texts(steps, [edge('t', 'a')], 'a')).toEqual(['No step has the handle "nope"'])
  })

  it('a loop back edge is fine', () => {
    expect(check([trig(), agent('a'), llm('b')], [edge('t', 'a'), edge('a', 'b'), edge('b', 'a')])).toEqual([])
  })
})

describe('graph helpers', () => {
  it('reachableFrom includes the start and follows loops', () => {
    const edges = [edge('a', 'b'), edge('b', 'a'), edge('b', 'c'), edge('x', 'y')]
    expect([...reachableFrom(edges, ['a'])].sort()).toEqual(['a', 'b', 'c'])
    expect([...reachableFrom([], ['z'])]).toEqual(['z'])
  })

  it('handleFor', () => {
    expect(handleFor('Say good evening', new Set())).toBe('say-good-evening')
    expect(handleFor('Say good evening', new Set(['say-good-evening']))).toBe('say-good-evening-2')
    expect(handleFor('Say good evening', new Set(['say-good-evening', 'say-good-evening-2']))).toBe('say-good-evening-3')
    expect(handleFor('', new Set())).toBe('step')
    expect(handleFor('  !!  ', new Set())).toBe('step')
    expect(handleFor('Ünï Çode & más', new Set())).toBe('n-ode-m-s')
    const long = handleFor('a'.repeat(50), new Set())
    expect(long).toHaveLength(32)
    expect(handleFor('a'.repeat(50), new Set([long]))).toHaveLength(32)
  })

  it('renameHandle rewrites only the placeholders naming that handle, keeping their spacing', () => {
    expect(
      renameHandle('a {{steps.one.output}} b {{ steps.one.output }} {{steps.one-2.output}} {{steps.two.output}}', 'one', 'first')
    ).toBe('a {{steps.first.output}} b {{ steps.first.output }} {{steps.one-2.output}} {{steps.two.output}}')
    expect(renameHandle('{{steps.a.b.output}} steps.one.output', 'one', 'x')).toBe('{{steps.a.b.output}} steps.one.output')
  })

  it('stepHandles', () => {
    expect(stepHandles('a {{steps.one.output}} b {{ steps.two-x.output }} {{steps.one.output}} {{input}}')).toEqual(['one', 'two-x'])
    expect(stepHandles('{{steps.a.b.output}}')).toEqual([])
  })
})

describe('workflows', () => {
  it('portsOf', () => {
    expect(portsOf('condition')).toEqual(['yes', 'no'])
    expect(portsOf('approval')).toEqual(['approved', 'rejected'])
    for (const k of ['trigger', 'agent', 'llm', 'wait', 'notify'] as const) expect(portsOf(k)).toEqual(['out'])
  })

  it('summaryOf lists waiting steps and steps whose latest visit failed', () => {
    const v = (id: string, stepId: string, n: number, status: WorkflowRun['visits'][number]['status']) => ({
      id,
      stepId,
      n,
      status,
      input: '',
      inputs: [],
      startedAt: n
    })
    const run: WorkflowRun = {
      id: 'r',
      workflowId: 'w',
      via: 'manual',
      late: false,
      status: 'waiting',
      snapshot: { steps: [], edges: [] },
      visits: [v('1', 'a', 1, 'failed'), v('2', 'a', 2, 'done'), v('3', 'b', 1, 'failed'), v('4', 'c', 1, 'waiting')],
      inbox: {},
      allowance: { perStep: {}, total: 200 },
      halted: true,
      startedAt: 1
    }
    expect(summaryOf(run)).toEqual({
      id: 'r',
      workflowId: 'w',
      via: 'manual',
      status: 'waiting',
      late: false,
      error: undefined,
      startedAt: 1,
      endedAt: undefined,
      waiting: ['c'],
      failed: ['b']
    })
  })

  it('summaryOf carries progress only while a for each visit is open', () => {
    const base = {
      id: 'r',
      workflowId: 'w',
      via: 'manual' as const,
      late: false,
      status: 'running' as const,
      snapshot: { steps: [], edges: [] },
      inbox: {},
      allowance: { perStep: {}, total: 200 },
      halted: false,
      startedAt: 1
    }
    const v = (status: WorkflowRun['visits'][number]['status']): WorkflowRun['visits'][number] => ({
      id: '1',
      stepId: 'f',
      n: 1,
      status,
      input: '',
      inputs: [],
      startedAt: 1,
      items: [{ id: 'i', n: 1, text: 'A', status: 'running' }]
    })
    expect(summaryOf({ ...base, visits: [v('running')] }).progress).toEqual([{ stepId: 'f', done: 0, failed: 0, total: 1, current: 'A' }])
    expect('progress' in summaryOf({ ...base, visits: [v('done')] })).toBe(false)
    expect('progress' in summaryOf({ ...base, visits: [] })).toBe(false)
  })
})

describe('problemsOf foreach', () => {
  const t = (over: Partial<Extract<Step, { kind: 'foreach' }>>) => texts([trig(), foreach('f', over)], [edge('t', 'f')], 'f')
  it('checks a foreach step like an agent step', () => {
    expect(t({})).toEqual([])
    expect(t({ agent: '' })).toEqual(['Pick an agent'])
    expect(t({ agent: 'zumi-bot' })).toEqual(['Zumi Bot cannot be a workflow step'])
    expect(t({ prompt: '' })).toEqual(['Write a prompt'])
    expect(t({ prompt: 'Check it' })).toEqual([USE_ITEM_TEXT])
    expect(t({ prompt: 'Check {{ item }}' })).toEqual([])
    expect(t({ prompt: '{{item}}' + 'x'.repeat(PROMPT_MAX) })).toEqual(['Prompt is over 20 000 characters'])
  })
})

describe('room step problems', () => {
  const room = (over: Partial<Extract<Step, { kind: 'room' }>> = {}): Step => ({
    id: 'r',
    kind: 'room',
    handle: 'r',
    name: 'r',
    room: 'room-1',
    prompt: '{{input}}',
    ...pos,
    ...over
  })
  const t = (over: Partial<Extract<Step, { kind: 'room' }>>) => texts([trig(), room(over)], [edge('t', 'r')], 'r')
  it('needs a room and a prompt, within the cap and naming known steps', () => {
    expect(t({})).toEqual([])
    expect(t({ room: '' })).toEqual(['Pick a room'])
    expect(t({ prompt: '  ' })).toEqual(['Write a prompt'])
    expect(t({ prompt: '{{steps.nope.output}}' })).toEqual(['No step has the handle "nope"'])
    expect(t({ prompt: 'x'.repeat(PROMPT_MAX + 1) })).toEqual(['Prompt is over 20 000 characters'])
  })
})

describe('renameStepAgent', () => {
  it('renames an agent or For each agent, a room member and a command agent, and leaves the rest untouched', () => {
    const cmd = { agent: 'a', name: 'go' }
    expect(renameStepAgent(agent('s', { agent: 'a' }), 'a', 'z')).toMatchObject({ agent: 'z' })
    expect(renameStepAgent(foreach('f', { agent: 'a', command: cmd }), 'a', 'z')).toMatchObject({
      agent: 'z',
      command: { agent: 'z', name: 'go' }
    })
    expect(renameStepAgent(roomFrom('r', { members: ['a', 'b'], command: cmd }), 'a', 'z')).toMatchObject({
      members: ['z', 'b'],
      command: { agent: 'z' }
    })
    expect(renameStepAgent(chatStep('c', { command: cmd }), 'a', 'z')).toMatchObject({ command: { agent: 'z' } })
    const same = agent('s', { agent: 'b' })
    expect(renameStepAgent(same, 'a', 'z')).toBeNull()
    expect(renameStepAgent(llm('l'), 'a', 'z')).toBeNull()
    expect(renameStepAgent(roomFrom('r', { members: ['b', 'c'] }), 'a', 'z')).toBeNull()
    // A new object: the caller's step is never changed in place.
    const orig = foreach('f', { agent: 'a' })
    renameStepAgent(orig, 'a', 'z')
    expect(orig).toMatchObject({ agent: 'a' })
  })
})
