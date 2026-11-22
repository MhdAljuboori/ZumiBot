import { describe, expect, it } from 'vitest'
import { FAILURE_PATH_TEXT, SELF_TEXT, problemsOf } from '../src/workflowGraph'
import {
  GET_BODY_TEXT,
  KEY_MISSING_TEXT,
  KEY_UNUSED_TEXT,
  ORIGIN_TEXT,
  fixedOrigin,
  headerProblem,
  jsonInside,
  jsonStringPlaceholders
} from '../src/workflowHttp'
import { INVALID_WORKFLOW, parseStep, parseWorkflowInput } from '../src/workflowInput'
import { NOT_JSON, nameFromPath, parsePath, readPath, runTransform } from '../src/workflowTransform'
import { deliver, newState, outcome } from '../src/workflowEngine'
import { fillTemplate, modelPrompt, type TemplateCtx } from '../src/workflowTemplate'
import { CONFIRM_ONLY_TOOLS } from '../src/automations'
import { OUTPUT_MAX, failureText, stepPorts, summaryOf } from '../src/workflows'
import type { Edge, Step, Visit, WorkflowRun } from '../src/workflows'

const pos = { x: 0, y: 0 }
const trig: Step = { id: 't', kind: 'trigger', handle: 't', name: 'Trigger', ...pos }
type Http = Extract<Step, { kind: 'http' }>
const http = (over: Partial<Http> = {}): Http => ({
  id: 'h',
  kind: 'http',
  handle: 'h',
  name: 'Fetch',
  method: 'GET',
  url: 'https://api.example.com/items',
  headers: [],
  bodyType: 'json',
  ...pos,
  ...over
})
const edge = (from: string, to: string, port: Edge['port'] = 'out'): Edge => ({ id: `${from}-${port}-${to}`, from, port, to })
const problems = (steps: Step[], edges: Edge[], id: string, wid?: string) =>
  problemsOf({ id: wid ?? null, trigger: { kind: 'manual' }, steps: [trig, ...steps], edges }, [], 'zumi-bot')
    .filter((p) => p.stepId === id)
    .map((p) => p.text)

describe('transform paths', () => {
  it('parses dots, brackets, wildcards and a leading $', () => {
    expect(parsePath('')).toEqual([])
    expect(parsePath('$')).toEqual([])
    expect(parsePath('a.b.0')).toEqual(['a', 'b', 0])
    expect(parsePath('$.items[2].title')).toEqual(['items', 2, 'title'])
    expect(parsePath('items[].id')).toEqual(['items', '*', 'id'])
    expect(parsePath('items[*].id')).toEqual(['items', '*', 'id'])
    expect(parsePath('a..b')).toBeNull()
    expect(parsePath('a[x]')).toBeNull()
  })

  it('reads one value, maps over lists, and finds nothing past a missing key', () => {
    const data = { items: [{ id: 1, tags: ['x'] }, { id: 2 }], meta: { total: 2 } }
    expect(readPath(data, parsePath('meta.total')!)).toEqual({ found: true, value: 2 })
    expect(readPath(data, parsePath('items.*.id')!)).toEqual({ found: true, value: [1, 2] })
    expect(readPath(data, parsePath('items.1.tags')!)).toEqual({ found: false })
    expect(readPath(data, parsePath('items.*.tags')!)).toEqual({ found: true, value: [['x']] })
    // Inherited members never read as values.
    expect(readPath({}, parsePath('constructor')!)).toEqual({ found: false })
  })

  it('makes a JSON object, null for a missing field', () => {
    const r = runTransform(
      '{"pr":{"title":"Fix","number":7}}',
      [
        { name: 'title', path: 'pr.title' },
        { name: 'who', path: 'pr.user.login' }
      ],
      'json'
    )
    expect(r).toEqual({ ok: true, output: JSON.stringify({ title: 'Fix', who: null }, null, 2), missing: ['pr.user.login'] })
  })

  it('makes one line per value, text as is and objects as JSON', () => {
    const input = JSON.stringify({ items: [{ t: 'a\nb' }, { t: 'c' }, { t: null }, { t: { n: 1 } }], n: 3 })
    expect(
      runTransform(
        input,
        [
          { name: 'titles', path: 'items[].t' },
          { name: 'n', path: 'n' }
        ],
        'lines'
      )
    ).toEqual({ ok: true, output: 'a b\nc\n{"n":1}\n3', missing: [] })
    // One field naming one value gives that value alone.
    expect(runTransform('{"title":"Hello"}', [{ name: 'title', path: 'title' }], 'lines')).toMatchObject({ output: 'Hello' })
  })

  it('fails on input that is not JSON, and on an output past the cap', () => {
    expect(runTransform('not json', [{ name: 'a', path: 'a' }], 'json')).toEqual({ ok: false, error: NOT_JSON, missing: [] })
    const big = JSON.stringify({ a: 'x'.repeat(OUTPUT_MAX + 10) })
    expect(runTransform(big, [{ name: 'a', path: 'a' }], 'lines')).toMatchObject({ ok: false })
  })

  it('names a field after its path', () => {
    expect(nameFromPath('pull_request.head.ref')).toBe('ref')
    expect(nameFromPath('items[].id')).toBe('id')
    expect(nameFromPath('')).toBe('value')
  })
})

describe('http rules', () => {
  it('keeps the scheme and host out of reach of any placeholder', () => {
    expect(fixedOrigin('https://api.example.com/repos/{{trigger.body.repo}}')).toBe('https://api.example.com')
    expect(fixedOrigin('https://api.example.com?q={{input}}')).toBe('https://api.example.com')
    expect(fixedOrigin('http://localhost:5678/webhook')).toBe('http://localhost:5678')
    expect(fixedOrigin('https://api.example.com{{input}}')).toBeNull()
    expect(fixedOrigin('https://{{host}}/x')).toBeNull()
    expect(fixedOrigin('https://api.example.com:{{port}}/x')).toBeNull()
    expect(fixedOrigin('{{input}}')).toBeNull()
    expect(fixedOrigin('ftp://example.com/x')).toBeNull()
    expect(fixedOrigin('https://user:pw@example.com/x')).toBeNull()
  })

  it('finds which placeholders of a JSON body sit inside strings', () => {
    const body = '{"text": "Hi {{input}} \\" {{a}}", "items": {{list}}}'
    const at = [...body.matchAll(/\{\{/g)].map((m) => m.index)
    expect([...jsonStringPlaceholders(body)]).toEqual([at[0], at[1]])
    expect(jsonInside('a "b"\n')).toBe('a \\"b\\"\\n')
  })

  it('checks header names and values', () => {
    expect(headerProblem({ name: 'Authorization', value: 'Bearer {{key}}' })).toBeNull()
    expect(headerProblem({ name: 'Bad Name', value: 'x' })).toMatch(/not a header name/)
    expect(headerProblem({ name: 'Host', value: 'x' })).toMatch(/set by the request/)
    expect(headerProblem({ name: 'X-A', value: 'a\nb' })).toMatch(/line break/)
  })

  it('lists the step problems', () => {
    expect(problems([http()], [edge('t', 'h')], 'h')).toEqual([])
    expect(problems([http({ url: '' })], [edge('t', 'h')], 'h')).toEqual(['Write the address'])
    expect(problems([http({ url: 'https://{{x}}/' })], [edge('t', 'h')], 'h')).toEqual([ORIGIN_TEXT])
    expect(problems([http({ body: '{}' })], [edge('t', 'h')], 'h')).toEqual([GET_BODY_TEXT])
    expect(problems([http({ headers: [{ name: 'Authorization', value: 'Bearer {{key}}' }] })], [edge('t', 'h')], 'h')).toEqual([
      KEY_MISSING_TEXT
    ])
    expect(problems([http({ key: 'k1' })], [edge('t', 'h')], 'h')).toEqual([KEY_UNUSED_TEXT])
    expect(problems([http({ url: 'https://a.example/{{steps.nope.output}}' })], [edge('t', 'h')], 'h')).toEqual([
      'No step has the handle "nope"'
    ])
  })
})

describe('new kinds in the saved workflow', () => {
  const save = (steps: unknown[], edges: unknown[] = []) =>
    parseWorkflowInput({
      id: null,
      name: 'W',
      enabled: false,
      timeZone: 'UTC',
      trigger: { kind: 'manual' },
      steps: [trig, ...steps],
      edges
    })

  it('rebuilds http, transform and workflow steps key by key', () => {
    const w = save([
      { ...http({ method: 'POST', body: '{"a":1}', key: 'item-1', headers: [{ name: 'X-A', value: '1' }] }), extra: 1 },
      { id: 'x', kind: 'transform', handle: 'x', name: 'Pick', ...pos, fields: [{ name: 'a', path: 'a', more: 2 }], format: 'lines' },
      { id: 's', kind: 'workflow', handle: 's', name: 'Sub', ...pos, workflow: 'w-2', input: '{{input}}' }
    ])
    expect(w.steps[1]).toEqual(http({ method: 'POST', body: '{"a":1}', key: 'item-1', headers: [{ name: 'X-A', value: '1' }] }))
    expect(w.steps[2]).toEqual({
      id: 'x',
      kind: 'transform',
      handle: 'x',
      name: 'Pick',
      ...pos,
      fields: [{ name: 'a', path: 'a' }],
      format: 'lines'
    })
    expect(w.steps[3]).toEqual({ id: 's', kind: 'workflow', handle: 's', name: 'Sub', ...pos, workflow: 'w-2', input: '{{input}}' })
  })

  it('keeps Allow local network only as true, so an older step and anything else read as off', () => {
    expect(save([http({ allowLocalNetwork: true })]).steps[1]).toEqual(http({ allowLocalNetwork: true }))
    for (const v of [false, 'true', 1, null]) expect(save([{ ...http(), allowLocalNetwork: v }]).steps[1]).toEqual(http())
    expect(save([http()]).steps[1]).not.toHaveProperty('allowLocalNetwork')
  })

  it('takes an error edge only from a step whose failure path is on', () => {
    expect(() => save([http()], [edge('t', 'h'), { id: 'e1', from: 'h', port: 'error', to: 't2' }])).toThrow(INVALID_WORKFLOW)
    const on = http({ onFailure: 'branch' })
    const w = save(
      [on, { ...trig, id: 'n', kind: 'notify', handle: 'n', name: 'N', title: 'x' }],
      [edge('t', 'h'), edge('h', 'n', 'error')]
    )
    expect(w.steps[1]).toMatchObject({ onFailure: 'branch' })
    expect(w.edges).toContainEqual(edge('h', 'n', 'error'))
    // Where a step can't fail by itself the setting is dropped, and so its error port does not exist.
    expect(parseStep({ id: 'w', kind: 'wait', handle: 'w', name: 'W', ...pos, minutes: 1, onFailure: 'branch' })).not.toHaveProperty(
      'onFailure'
    )
    expect(() => parseStep({ ...http(), onFailure: 'sometimes' })).toThrow(INVALID_WORKFLOW)
  })

  it('stepPorts adds error only while the setting is on', () => {
    expect(stepPorts(http())).toEqual(['out'])
    expect(stepPorts(http({ onFailure: 'branch' }))).toEqual(['out', 'error'])
    expect(stepPorts({ kind: 'condition', onFailure: 'branch' })).toEqual(['yes', 'no', 'error'])
    expect(stepPorts({ kind: 'approval', onFailure: 'branch' })).toEqual(['approved', 'rejected'])
  })

  it('problems: a failure path with no connection, a transform with no field, a workflow naming itself', () => {
    expect(problems([http({ onFailure: 'branch' })], [edge('t', 'h')], 'h')).toEqual([FAILURE_PATH_TEXT])
    const tf: Step = { id: 'x', kind: 'transform', handle: 'x', name: 'X', ...pos, fields: [], format: 'json' }
    expect(problems([tf], [edge('t', 'x')], 'x')).toEqual(['Add a field to pick'])
    const dup: Step = {
      ...tf,
      fields: [
        { name: 'a', path: 'a' },
        { name: 'a', path: 'a..b' }
      ]
    }
    expect(problems([dup], [edge('t', 'x')], 'x')).toEqual(['Two fields have the same name', '"a..b" is not a path'])
    const sub: Step = { id: 's', kind: 'workflow', handle: 's', name: 'S', ...pos, workflow: 'w-1', input: '' }
    expect(problems([sub], [edge('t', 's')], 's', 'w-1')).toEqual([SELF_TEXT])
    expect(problems([{ ...sub, workflow: '' }], [edge('t', 's')], 's')).toEqual(['Pick a workflow'])
  })
})

describe('the failure path in the engine', () => {
  const steps: Step[] = [trig, http({ onFailure: 'branch' }), { id: 'n', kind: 'notify', handle: 'n', name: 'Alert', title: 'x', ...pos }]
  const edges = [edge('t', 'h'), edge('h', 'n', 'error')]
  const failed: Visit = {
    id: 'v1',
    stepId: 'h',
    n: 1,
    status: 'failed',
    port: 'error',
    error: 'HTTP 404',
    output: 'not here',
    input: '',
    inputs: [],
    startedAt: 0,
    endedAt: 1
  }

  it('hands on the error and the body, and the run still ends done', () => {
    expect(failureText(failed)).toBe('HTTP 404\n\nnot here')
    const s = deliver({ ...newState({ steps, edges }), visits: [failed] }, failed)
    expect(s.inbox.n).toEqual([{ edgeId: 'h-error-n', from: 'h', text: 'HTTP 404\n\nnot here' }])
    const n: Visit = { ...failed, id: 'v2', stepId: 'n', status: 'done', port: 'out', error: undefined }
    expect(outcome({ ...newState({ steps, edges }), visits: [failed, n] })).toBe('done')
    expect(outcome({ ...newState({ steps, edges }), visits: [{ ...failed, port: undefined }] })).toBe('failed')
  })

  it('summaryOf leaves a handled failure out of the failed steps', () => {
    const run = {
      id: 'r',
      workflowId: 'w',
      via: 'manual',
      late: false,
      status: 'done',
      snapshot: { steps, edges },
      visits: [failed],
      inbox: {},
      allowance: { perStep: {}, total: 200 },
      halted: false,
      startedAt: 0
    } as WorkflowRun
    expect(summaryOf(run).failed).toEqual([])
  })
})

describe('templates for the new steps', () => {
  const ctx: TemplateCtx = {
    inputs: [{ edgeId: 'e', from: 'p', text: 'a b/c' }],
    names: { p: 'Parent' },
    outputs: {},
    trigger: { text: 'typed', call: null }
  }

  it('encodes and adds vars only when asked', () => {
    expect(fillTemplate('x/{{input}}?k={{key}}', ctx, 'raw', { encode: encodeURIComponent, vars: { key: 's&1' } }).text).toBe(
      'x/a%20b%2Fc?k=s%261'
    )
    expect(fillTemplate('{{key}}', ctx, 'raw').missing).toEqual(['key'])
  })

  it("wraps a sub-workflow's trigger text as material in a model prompt", () => {
    expect(modelPrompt('Do {{trigger.text}}', ctx, {}, { appendInputs: false }).text).toBe('Do typed')
    const child = { ...ctx, trigger: { ...ctx.trigger, material: true } }
    expect(modelPrompt('Do {{trigger.text}}', child, {}, { appendInputs: false }).text).toBe('Do <input from="trigger">\ntyped\n</input>')
    expect(fillTemplate('{{trigger.text}}', child, 'raw').text).toBe('typed')
  })
})

describe('room step', () => {
  const room = (over: Record<string, unknown> = {}) => ({
    id: 'r',
    kind: 'room',
    handle: 'r',
    name: 'Room',
    ...pos,
    room: 'abc-123',
    prompt: '{{input}}',
    ...over
  })
  const rule = (r: unknown) => () => parseStep(room({ rules: [r] }))

  it('keeps the room, the prompt and valid rules', () => {
    const rules = [{ tool: 'Bash', command: 'ls', agent: 'a' }, { tool: 'Edit' }]
    expect(parseStep(room({ rules, extra: 1 }))).toEqual(room({ rules }))
  })

  it('refuses a malformed room id, takes a missing or empty one as none', () => {
    expect(() => parseStep(room({ room: 'bad id!' }))).toThrow(INVALID_WORKFLOW)
    expect(parseStep(room({ room: undefined }))).toMatchObject({ room: '' })
    expect(parseStep(room({ room: '' }))).toMatchObject({ room: '' })
  })

  it('refuses rules that could never apply or that must always ask', () => {
    for (const bad of [
      { tool: 'Bash' },
      { tool: 'Edit', command: 'x' },
      { tool: 'Edit', unsandboxed: true },
      { tool: 'Bash', command: 'ls', unsandboxed: false },
      { tool: 'AskUserQuestion' },
      { tool: 'ExitPlanMode' },
      { tool: CONFIRM_ONLY_TOOLS[0] },
      { tool: 'x'.repeat(201) },
      { tool: '' },
      { tool: 'Bash', command: 'x'.repeat(4_001) },
      { tool: 'Bash', command: '' }
    ])
      expect(rule(bad), JSON.stringify(bad).slice(0, 60)).toThrow(INVALID_WORKFLOW)
    expect(rule({ tool: 'Bash', command: 'ls', unsandboxed: true })()).toMatchObject({
      rules: [{ tool: 'Bash', command: 'ls', unsandboxed: true }]
    })
  })

  it('collapses duplicates, caps the count and leaves out an empty list', () => {
    expect(parseStep(room({ rules: [{ tool: 'Edit' }, { tool: 'Edit' }] }))).toMatchObject({ rules: [{ tool: 'Edit' }] })
    expect(() => parseStep(room({ rules: Array.from({ length: 101 }, (_, i) => ({ tool: `T${i}` })) }))).toThrow(INVALID_WORKFLOW)
    expect(parseStep(room({ rules: [] }))).not.toHaveProperty('rules')
  })

  it('has a failure path', () => {
    const s = parseStep(room({ onFailure: 'branch' }))
    expect(s).toMatchObject({ onFailure: 'branch' })
    expect(stepPorts(s)).toEqual(['out', 'error'])
  })

  it('problems: a room, a prompt, known handles, the cap', () => {
    const st = (over: Record<string, unknown> = {}) => parseStep(room(over))
    const p = (over: Record<string, unknown>) => problems([st(over)], [edge('t', 'r')], 'r')
    expect(p({})).toEqual([])
    expect(p({ room: '' })).toEqual(['Pick a room'])
    expect(p({ prompt: '  ' })).toEqual(['Write a prompt'])
    expect(p({ prompt: '{{steps.nope.output}}' })).toEqual(['No step has the handle "nope"'])
    expect(p({ prompt: 'x'.repeat(20_001) })).toEqual(['Prompt is over 20 000 characters'])
  })
})
