import { describe, expect, it } from 'vitest'
import { parseStep, parseTrigger, parseWorkflowInput } from '@zumibot/shared/workflowInput'

// A valid input whose trigger step has id `t`.
const input = (o: Record<string, unknown> = {}): unknown => ({
  id: null,
  name: 'Flow',
  enabled: false,
  timeZone: 'UTC',
  trigger: { kind: 'manual' },
  steps: [{ id: 't', handle: 'trigger', name: 'Trigger', x: 0, y: 0, kind: 'trigger' }],
  edges: [],
  ...o
})

describe('For each steps in parseWorkflowInput', () => {
  const trig = { id: 't', handle: 'trigger', name: 'Trigger', x: 0, y: 0, kind: 'trigger' }
  const each = {
    id: 'e',
    handle: 'each',
    name: 'Each',
    x: 260,
    y: 0,
    kind: 'foreach',
    agent: 'helper',
    prompt: 'Check {{item}}',
    cwd: '/tmp'
  }

  it("keeps an agent step's keys, the model only when given, and drops the rest", () => {
    const steps = parseWorkflowInput(input({ steps: [trig, { ...each, model: 'opus', evil: 1 }] })).steps
    expect(steps[1]).toEqual({ ...each, model: 'opus' })
    expect(parseWorkflowInput(input({ steps: [trig, each] })).steps[1]).not.toHaveProperty('model')
  })

  it('keeps a concurrency of 2 or 3, clamps other numbers, and stores one at a time as no key', () => {
    const conc = (c: unknown) =>
      (parseWorkflowInput(input({ steps: [trig, { ...each, concurrency: c }] })).steps[1] as { concurrency?: number }).concurrency
    expect(conc(2)).toBe(2)
    expect(conc(3)).toBe(3)
    expect(conc(9)).toBe(3)
    expect(conc(2.4)).toBe(2)
    expect(conc(1)).toBeUndefined()
    expect(conc(0)).toBeUndefined()
    expect(conc(null)).toBeUndefined()
    expect(() => parseWorkflowInput(input({ steps: [trig, { ...each, concurrency: '2' }] }))).toThrow(/^Invalid workflow$/)
  })

  it('refuses a bad model or a missing prompt', () => {
    for (const bad of [{ model: 'gpt' }, { prompt: undefined }, { agent: 3 }])
      expect(() => parseWorkflowInput(input({ steps: [trig, { ...each, ...bad }] })), JSON.stringify(bad)).toThrow(/^Invalid workflow$/)
  })
})

describe('notes in parseWorkflowInput', () => {
  const good = { id: 'n1', x: 0, y: 0, width: 240, height: 160, color: 1, text: '## Hi' }

  it('reads absent notes as none', () => expect(parseWorkflowInput(input()).notes).toEqual([]))

  it('keeps a valid note, a custom color lower-cased, and clamps the size', () => {
    const w = parseWorkflowInput(input({ notes: [good, { ...good, id: 'n2', color: '#AABBCC', width: 10, height: 99_999 }] }))
    expect(w.notes![0]).toEqual(good)
    expect(w.notes![1]).toMatchObject({ color: '#aabbcc', width: 150, height: 5_000 })
  })

  it('refuses bad notes', () => {
    for (const notes of [
      [{ ...good, color: 8 }],
      [{ ...good, color: 'red' }],
      [{ ...good, x: Infinity }],
      [{ ...good, text: 'x'.repeat(10_001) }],
      [good, good],
      [{ ...good, id: 't' }],
      [{ ...good, id: 'constructor' }],
      Array.from({ length: 101 }, (_, i) => ({ ...good, id: `n${i}` }))
    ])
      expect(() => parseWorkflowInput(input({ notes })), JSON.stringify(notes).slice(0, 80)).toThrow(/^Invalid workflow$/)
  })

  it('drops keys it does not know', () => {
    expect(parseWorkflowInput(input({ notes: [{ ...good, evil: 1 }] })).notes![0]).not.toHaveProperty('evil')
  })

  it('refuses a size that is not a finite number', () => {
    for (const bad of [{ width: NaN }, { height: Infinity }, { width: -Infinity }, { height: '160' }, { width: null }])
      expect(() => parseWorkflowInput(input({ notes: [{ ...good, ...bad }] })), JSON.stringify(bad)).toThrow(/^Invalid workflow$/)
  })

  it('keeps nothing of a __proto__ key, as JSON.parse makes it an own key', () => {
    const raw = JSON.parse('{"id":"n1","x":0,"y":0,"width":240,"height":160,"color":1,"text":"## Hi","__proto__":{"evil":1}}')
    const note = parseWorkflowInput(input({ notes: [raw] })).notes![0]
    expect(note).toEqual(good)
    expect(Object.getPrototypeOf(note)).toBe(Object.prototype)
    expect(Object.keys(note)).not.toContain('__proto__')
    expect((note as unknown as Record<string, unknown>).evil).toBeUndefined()
    expect(({} as Record<string, unknown>).evil).toBeUndefined()
  })

  it('refuses a custom color with anything around the six digits', () => {
    for (const color of ['#aabbcc ', ' #aabbcc', '#aabbcc\n', '#aabbccdd', '#aabbcc;', '#abc', 'aabbcc'])
      expect(() => parseWorkflowInput(input({ notes: [{ ...good, color }] })), JSON.stringify(color)).toThrow(/^Invalid workflow$/)
  })

  it('accepts exactly as many notes as the cap', () => {
    expect(parseWorkflowInput(input({ notes: Array.from({ length: 100 }, (_, i) => ({ ...good, id: `n${i}` })) })).notes).toHaveLength(100)
  })
})

describe('groups in parseWorkflowInput', () => {
  const steps = [
    { id: 't', handle: 'trigger', name: 'Trigger', x: 0, y: 0, kind: 'trigger' },
    { id: 'a', handle: 'a', name: 'A', x: 0, y: 0, kind: 'wait', minutes: 1 },
    { id: 'b', handle: 'b', name: 'B', x: 0, y: 0, kind: 'wait', minutes: 1 }
  ]
  const note = { id: 'n1', x: 0, y: 0, width: 240, height: 160, color: 1, text: '' }
  const good = { id: 'g1', name: 'Group', steps: ['a'], notes: ['n1'] }
  const make = (groups: unknown, o: Record<string, unknown> = {}): unknown => input({ steps, notes: [note], groups, ...o })

  it('reads absent groups as none', () => expect(parseWorkflowInput(input()).groups).toEqual([]))

  it('keeps a valid group, rebuilds its keys and leaves an absent description absent', () => {
    const w = parseWorkflowInput(
      make([
        { ...good, name: '  Group  ', evil: 1 },
        { id: 'g2', name: 'Two', description: 'Why', steps: ['b'], notes: [] }
      ])
    )
    expect(w.groups![0]).toEqual(good)
    expect(w.groups![0]).not.toHaveProperty('description')
    expect(w.groups![1]).toEqual({ id: 'g2', name: 'Two', description: 'Why', steps: ['b'], notes: [] })
  })

  it('refuses malformed groups', () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ id: `g${i}`, name: 'G', steps: [], notes: [] }))
    for (const groups of [
      [{ ...good, name: '   ' }],
      [{ ...good, name: 'x'.repeat(101) }],
      [{ ...good, description: 'x'.repeat(146) }],
      [{ ...good, steps: ['nope'] }],
      [{ ...good, notes: ['nope'] }],
      [{ ...good, steps: ['t'] }],
      [good, { ...good, id: 'g2' }],
      [{ ...good, steps: ['a', 'a'] }],
      [{ ...good, id: 'a' }],
      [{ ...good, id: 'n1' }],
      [good, good],
      [{ ...good, steps: 'a' }],
      [{ ...good, steps: [5] }],
      [{ ...good, id: 'constructor' }],
      'x',
      many
    ])
      expect(() => parseWorkflowInput(make(groups)), JSON.stringify(groups).slice(0, 80)).toThrow(/^Invalid workflow$/)
  })

  it('accepts the limits', () => {
    const w = parseWorkflowInput(make([{ ...good, name: 'x'.repeat(100), description: 'y'.repeat(145) }]))
    expect(w.groups![0]).toMatchObject({ description: 'y'.repeat(145) })
    expect(
      parseWorkflowInput(make(Array.from({ length: 50 }, (_, i) => ({ id: `g${i}`, name: 'G', steps: [], notes: [] })))).groups
    ).toHaveLength(50)
  })

  it('does not check the chain rules: those are dropped on save, not refused', () => {
    expect(parseWorkflowInput(make([{ id: 'g1', name: 'Solo', steps: ['a'], notes: [] }])).groups).toHaveLength(1)
  })
})

describe('group names and descriptions in parseWorkflowInput', () => {
  const steps = [
    { id: 't', handle: 'trigger', name: 'Trigger', x: 0, y: 0, kind: 'trigger' },
    { id: 'a', handle: 'a', name: 'A', x: 0, y: 0, kind: 'wait', minutes: 1 }
  ]
  const make = (g: Record<string, unknown>): unknown => input({ steps, groups: [{ id: 'g1', name: 'G', steps: ['a'], notes: [], ...g }] })

  it('leaves an empty or blank description absent', () => {
    for (const description of ['', '   ', '\n\t'])
      expect(parseWorkflowInput(make({ description })).groups![0], JSON.stringify(description)).not.toHaveProperty('description')
    expect(parseWorkflowInput(make({ description: ' Why ' })).groups![0].description).toBe(' Why ')
  })

  it('reads a blank description as absent even past the cap, and still refuses a long real one', () => {
    expect(parseWorkflowInput(make({ description: ' '.repeat(146) })).groups![0]).not.toHaveProperty('description')
    expect(() => parseWorkflowInput(make({ description: 'x'.repeat(146) }))).toThrow(/^Invalid workflow$/)
    expect(() => parseWorkflowInput(make({ description: 5 }))).toThrow(/^Invalid workflow$/)
  })

  it('caps the name after trimming it', () => {
    expect(parseWorkflowInput(make({ name: `${'x'.repeat(100)} ` })).groups![0].name).toBe('x'.repeat(100))
    expect(parseWorkflowInput(make({ name: `  ${'x'.repeat(100)}\n` })).groups![0].name).toBe('x'.repeat(100))
    expect(() => parseWorkflowInput(make({ name: `${'x'.repeat(101)} ` }))).toThrow(/^Invalid workflow$/)
    expect(() => parseWorkflowInput(make({ name: 5 }))).toThrow(/^Invalid workflow$/)
  })
})

describe('a run spend cap in parseWorkflowInput', () => {
  it('keeps an amount, rounded to cents, and leaves no key for none', () => {
    expect(parseWorkflowInput(input({ spendCap: 2.505 })).spendCap).toBe(2.51)
    expect(parseWorkflowInput(input({ spendCap: '7' })).spendCap).toBe(7)
    expect(parseWorkflowInput(input())).not.toHaveProperty('spendCap')
    expect(parseWorkflowInput(input({ spendCap: null }))).not.toHaveProperty('spendCap')
  })
  it('refuses an amount the editor could not have sent', () => {
    for (const bad of [0, -1, 'lots', 10_001, true]) expect(() => parseWorkflowInput(input({ spendCap: bad }))).toThrow()
  })
})

describe('event triggers in parseWorkflowInput', () => {
  const trig = (t: unknown) => parseWorkflowInput(input({ trigger: t })).trigger
  const f = { field: 'body.x', equals: 'y' }
  const file = { kind: 'file', path: '/tmp/in', pattern: '*.pdf', changes: ['added', 'changed'], filters: [] }
  const email = { kind: 'email', account: 'v1', host: 'imap.example.com', port: 993, folder: 'INBOX', filters: [] }

  it('round-trips each kind and drops stray keys', () => {
    for (const k of ['reply', 'todo', 'inbox']) expect(trig({ kind: k, filters: [f], evil: 1 })).toEqual({ kind: k, filters: [f] })
    expect(trig({ kind: 'reply' })).toEqual({ kind: 'reply', filters: [] })
    expect(trig({ ...file, evil: 1 })).toEqual(file)
    expect(trig({ ...email, evil: 1 })).toEqual(email)
  })
  it('keeps op contains on a filter and refuses any other op', () => {
    expect(trig({ kind: 'reply', filters: [{ ...f, op: 'contains' }] })).toEqual({ kind: 'reply', filters: [{ ...f, op: 'contains' }] })
    expect(trig({ kind: 'webhook', filters: [{ ...f, op: 'contains' }] })).toMatchObject({ filters: [{ ...f, op: 'contains' }] })
    expect(trig({ kind: 'reply', filters: [{ ...f, op: 'equals' }] })).toEqual({ kind: 'reply', filters: [f] })
    expect(() => trig({ kind: 'reply', filters: [{ ...f, op: 'regex' }] })).toThrow(/^Invalid workflow$/)
  })
  it('dedupes file changes and refuses an empty or foreign set', () => {
    expect((trig({ ...file, changes: ['added', 'added', 'removed'] }) as { changes: string[] }).changes).toEqual(['added', 'removed'])
    for (const bad of [[], ['renamed'], 'added', ['added', 3]]) expect(() => trig({ ...file, changes: bad })).toThrow(/^Invalid workflow$/)
  })
  it('caps the file path and pattern', () => {
    expect(() => trig({ ...file, path: '/'.repeat(1_001) })).toThrow()
    expect(() => trig({ ...file, pattern: 'a'.repeat(201) })).toThrow()
    expect(trig({ ...file, path: '/'.repeat(1_000), pattern: 'a'.repeat(200) })).toBeTruthy()
  })
  it('checks the email port and the text caps', () => {
    for (const bad of [0, 65_536, 993.5, '993', null]) expect(() => trig({ ...email, port: bad })).toThrow(/^Invalid workflow$/)
    expect(trig({ ...email, port: 65_535 })).toMatchObject({ port: 65_535 })
    expect(() => trig({ ...email, host: 'h'.repeat(254) })).toThrow()
    expect(() => trig({ ...email, folder: 'f'.repeat(201) })).toThrow()
    expect(() => trig({ ...email, account: 'a'.repeat(65) })).toThrow()
    expect(trig({ ...email, host: 'h'.repeat(253), folder: 'f'.repeat(200), account: 'a'.repeat(64) })).toBeTruthy()
  })
  it('refuses an unknown kind', () => {
    expect(() => trig({ kind: 'sms', filters: [] })).toThrow(/^Invalid workflow$/)
  })
  it('parses a trigger on its own, as Check mailbox sends one', () => {
    expect(parseTrigger({ ...email, evil: 1 })).toEqual(email)
    for (const bad of [null, 'email', { kind: 'sms' }]) expect(() => parseTrigger(bad)).toThrow(/^Invalid workflow$/)
  })
})

describe('parity keys', () => {
  const base = (id: string) => ({ id, handle: id, name: id, x: 0, y: 0 })
  const agentStep = { ...base('a'), kind: 'agent', agent: 'x', prompt: 'go', cwd: '/w' }
  const foreachStep = { ...base('f'), kind: 'foreach', agent: 'x', prompt: 'go {{item}}', cwd: '/w' }
  const roomStep = { ...base('r'), kind: 'room', room: 'tpl', prompt: 'go' }

  it('parses a chat step and keeps only fresh as a session', () => {
    const s = parseStep({ ...base('c'), kind: 'chat', chat: 'chat-1', prompt: 'hi', session: 'fresh' })
    expect(s).toMatchObject({ kind: 'chat', chat: 'chat-1', prompt: 'hi', session: 'fresh' })
    expect('session' in parseStep({ ...base('c'), kind: 'chat', chat: 'chat-1', prompt: 'hi', session: 'continue' })).toBe(false)
  })
  it('gives a chat step the error port only with On failure', () => {
    expect(parseStep({ ...base('c'), kind: 'chat', chat: '', prompt: '', onFailure: 'branch' })).toMatchObject({ onFailure: 'branch' })
  })
  it('keeps keep and title on agent and room only, section only on a kept room', () => {
    expect(parseStep({ ...agentStep, keep: true, title: '  Daily  ' })).toMatchObject({ keep: true, title: 'Daily' })
    expect('keep' in parseStep({ ...foreachStep, keep: true })).toBe(false)
    expect('section' in parseStep({ ...roomStep, section: 'sec-1' })).toBe(false)
    expect(parseStep({ ...roomStep, keep: true, section: 'sec-1' })).toMatchObject({ section: 'sec-1' })
    expect('title' in parseStep({ ...agentStep, keep: true, title: '   ' })).toBe(false)
    expect('keep' in parseStep({ ...agentStep, keep: false })).toBe(false)
    expect(() => parseStep({ ...agentStep, keep: true, title: 'x'.repeat(101) })).toThrow('Invalid workflow')
  })
  it('takes a room from agents with an empty room id', () => {
    const s = parseStep({ ...base('r'), kind: 'room', room: '', prompt: 'go', members: ['a', 'b'], role: 'Plan', cwd: '/w' })
    expect(s).toMatchObject({ room: '', members: ['a', 'b'], role: 'Plan', cwd: '/w' })
    expect(() => parseStep({ ...base('r'), kind: 'room', room: 'tpl', prompt: 'go', members: ['a', 'b'], role: '', cwd: '/w' })).toThrow(
      'Invalid workflow'
    )
    expect(() => parseStep({ ...base('r'), kind: 'room', room: '', prompt: 'go', members: ['a', 'a'], role: '', cwd: '/w' })).toThrow(
      'Invalid workflow'
    )
  })
  it('allows fewer than two members: that is a problem for problemsOf, not a refusal', () => {
    expect(parseStep({ ...base('r'), kind: 'room', room: '', prompt: 'go', members: ['a'], role: '', cwd: '' })).toMatchObject({
      members: ['a']
    })
    expect(parseStep({ ...base('r'), kind: 'room', room: '', prompt: 'go', members: [], role: '', cwd: '' })).toMatchObject({ members: [] })
  })
  it('drops a command with a blank agent', () => {
    expect('command' in parseStep({ ...agentStep, prompt: '/check now', command: { agent: '', name: 'check' } })).toBe(false)
    expect('command' in parseStep({ ...agentStep, prompt: '/check now', command: { agent: '  ', name: 'check' } })).toBe(false)
  })

  it('drops a command the prompt no longer starts with', () => {
    expect(parseStep({ ...agentStep, prompt: '/check now', command: { agent: 'x', name: 'check' } })).toMatchObject({
      command: { agent: 'x', name: 'check' }
    })
    expect('command' in parseStep({ ...agentStep, prompt: 'check now', command: { agent: 'x', name: 'check' } })).toBe(false)
    expect(parseStep({ ...foreachStep, prompt: '/check {{item}}', command: { agent: 'x', name: 'check' } })).toMatchObject({
      command: { name: 'check' }
    })
    expect(parseStep({ ...base('c'), kind: 'chat', chat: 'c1', prompt: '/check', command: { agent: 'x', name: 'check' } })).toMatchObject({
      command: { name: 'check' }
    })
    expect(
      (parseStep({ ...roomStep, prompt: '/check', command: { agent: 'x', name: 'check', evil: 1 } }) as { command?: unknown }).command
    ).toEqual({ agent: 'x', name: 'check' })
  })
  it('reads run settings and the webhook condition', () => {
    const w = parseWorkflowInput(
      input({ limitPolicy: 'skip', missedPolicy: 'skip', trigger: { kind: 'webhook', filters: [], condition: ' a new PR ' } })
    )
    expect(w).toMatchObject({ limitPolicy: 'skip', missedPolicy: 'skip', trigger: { condition: 'a new PR' } })
    expect('limitPolicy' in parseWorkflowInput(input({ limitPolicy: 'wait' }))).toBe(false)
    expect('missedPolicy' in parseWorkflowInput(input({ missedPolicy: 'run-once' }))).toBe(false)
    expect('condition' in parseWorkflowInput(input({ trigger: { kind: 'webhook', filters: [], condition: '   ' } })).trigger).toBe(false)
    expect(() => parseWorkflowInput(input({ trigger: { kind: 'webhook', filters: [], condition: 'x'.repeat(501) } }))).toThrow(
      'Invalid workflow'
    )
  })
})
