import { describe, expect, it } from 'vitest'
import { elicitationAnswer, elicitationQuestions } from '../../src/core/acp/acpElicitation'
import { allowResponse, denyResponse, errorResponse } from '../../src/core/chat/controlProtocol'
import { ACP_YES_NO } from '@zumibot/shared/acp'
import { parseQuestions } from '@zumibot/shared/questions'

const form = (properties: Record<string, unknown>, required?: string[], message = 'Tell me') => ({
  mode: 'form',
  message,
  sessionId: 's1',
  requestedSchema: { type: 'object', properties, ...(required ? { required } : {}) }
})

// What the card sends back: answers keyed by question text, on the input the server built.
const answered = (params: unknown, answers: Record<string, unknown>) =>
  allowResponse('r', { ...(elicitationQuestions(params) as object), answers })

describe('elicitationQuestions', () => {
  it('maps an enum string to a choice, with its labels', () => {
    const input = elicitationQuestions(form({ color: { type: 'string', title: 'Color', enum: ['red', 'blue'] } }))
    const p = parseQuestions(input)!
    expect(p.title).toBe('Tell me')
    expect(p.questions).toHaveLength(1)
    expect(p.questions[0]).toMatchObject({ text: 'Color', kind: 'choice', multiSelect: false })
    expect(p.questions[0].options.map((o) => o.label)).toEqual(['red', 'blue'])
  })

  it('maps a oneOf string to a choice labelled by title', () => {
    const p = parseQuestions(
      elicitationQuestions(
        form({
          size: {
            type: 'string',
            oneOf: [
              { const: 's', title: 'Small' },
              { const: 'l', title: 'Large' }
            ]
          }
        })
      )
    )!
    expect(p.questions[0].text).toBe('size')
    expect(p.questions[0].options.map((o) => o.label)).toEqual(['Small', 'Large'])
  })

  it('maps a boolean to Yes / No', () => {
    const p = parseQuestions(elicitationQuestions(form({ ok: { type: 'boolean', title: 'Sure?' } })))!
    expect(p.questions[0]).toMatchObject({ kind: 'choice', multiSelect: false })
    expect(p.questions[0].options.map((o) => o.label)).toEqual(['Yes', 'No'])
  })

  it('maps an array of an enum to a multi-select', () => {
    const p = parseQuestions(
      elicitationQuestions(form({ tags: { type: 'array', title: 'Tags', items: { type: 'string', enum: ['a', 'b', 'c'] } } }))
    )!
    expect(p.questions[0]).toMatchObject({ kind: 'choice', multiSelect: true })
    expect(p.questions[0].options.map((o) => o.label)).toEqual(['a', 'b', 'c'])
    const any = parseQuestions(elicitationQuestions(form({ t: { type: 'array', items: { anyOf: [{ const: 'x', title: 'X' }] } } })))!
    expect(any.questions[0].options.map((o) => o.label)).toEqual(['X'])
  })

  it('maps a plain string to text', () => {
    const p = parseQuestions(elicitationQuestions(form({ name: { type: 'string', title: 'Name', description: 'Your name' } })))!
    expect(p.questions[0]).toMatchObject({ kind: 'text', description: 'Your name' })
  })

  it('maps number and integer to number with min and max', () => {
    const p = parseQuestions(
      elicitationQuestions(
        form({
          n: { type: 'number', minimum: 0.5, maximum: 9.5, default: 2 },
          i: { type: 'integer', minimum: 1, maximum: 10 }
        })
      )
    )!
    expect(p.questions[0]).toMatchObject({ kind: 'number', min: 0.5, max: 9.5, defaultValue: 2, step: null })
    expect(p.questions[1]).toMatchObject({ kind: 'number', min: 1, max: 10, step: 1 })
  })

  it('one question per property, in order', () => {
    const p = parseQuestions(elicitationQuestions(form({ a: { type: 'string' }, b: { type: 'boolean' }, c: { type: 'integer' } })))!
    expect(p.questions.map((q) => q.text)).toEqual(['a', 'b', 'c'])
  })

  it('gives null for a nested, unknown or empty schema, or a non-form mode', () => {
    expect(elicitationQuestions(form({ o: { type: 'object', properties: {} } }))).toBeNull()
    expect(elicitationQuestions(form({ x: { type: 'null' } }))).toBeNull()
    expect(elicitationQuestions(form({ x: {} }))).toBeNull()
    expect(elicitationQuestions(form({ x: { type: 'array', items: { type: 'string' } } }))).toBeNull()
    expect(elicitationQuestions(form({ x: { type: 'array', items: { type: 'object' } } }))).toBeNull()
    expect(elicitationQuestions(form({ ok: { type: 'string' }, bad: { type: 'object' } }))).toBeNull()
    expect(elicitationQuestions(form({}))).toBeNull()
    expect(elicitationQuestions({ mode: 'url', message: 'open', url: 'https://x' })).toBeNull()
    expect(elicitationQuestions({ ...form({ a: { type: 'string' } }), mode: undefined })).toBeNull()
    for (const bad of [
      null,
      undefined,
      3,
      'x',
      [],
      {},
      { mode: 'form' },
      { mode: 'form', requestedSchema: [] },
      { mode: 'form', requestedSchema: { properties: [] } }
    ]) {
      expect(elicitationQuestions(bad)).toBeNull()
    }
  })

  it('an enum with no usable values gives null', () => {
    expect(elicitationQuestions(form({ x: { type: 'string', enum: [] } }))).toBeNull()
    expect(elicitationQuestions(form({ x: { type: 'string', enum: [1, 2] } }))).toBeNull()
  })

  it('keeps question texts unique when titles repeat', () => {
    const input = elicitationQuestions(form({ a: { type: 'string', title: 'Same' }, b: { type: 'string', title: 'Same' } }))
    const p = parseQuestions(input)!
    expect(new Set(p.questions.map((q) => q.text)).size).toBe(2)
  })

  it('carries no title when the message is blank', () => {
    expect(parseQuestions(elicitationQuestions(form({ a: { type: 'string' } }, undefined, '  ')))!.title).toBeNull()
  })
})

describe('elicitationAnswer', () => {
  it('round trip: accept with each kind of answer, as the schema wants it', () => {
    const params = form({
      color: {
        type: 'string',
        title: 'Color',
        oneOf: [
          { const: 'r', title: 'Red' },
          { const: 'b', title: 'Blue' }
        ]
      },
      ok: { type: 'boolean', title: 'Sure?' },
      tags: { type: 'array', title: 'Tags', items: { type: 'string', enum: ['a', 'b'] } },
      name: { type: 'string', title: 'Name' },
      age: { type: 'integer', title: 'Age', minimum: 0 }
    })
    const res = elicitationAnswer(answered(params, { Color: 'Blue', 'Sure?': 'No', Tags: ['a', 'b'], Name: 'Mo', Age: '41' }), params)
    expect(res).toEqual({ action: 'accept', content: { color: 'b', ok: false, tags: ['a', 'b'], name: 'Mo', age: 41 } })
  })

  it('Yes is true; a single multi-select pick may arrive as a string', () => {
    const params = form({ ok: { type: 'boolean' }, t: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } } })
    expect(elicitationAnswer(answered(params, { ok: 'Yes', t: 'b' }), params)).toEqual({
      action: 'accept',
      content: { ok: true, t: ['b'] }
    })
  })

  it('an off-list choice, an off-list multi pick and an out-of-range number are omitted when optional', () => {
    const params = form({
      c: { type: 'string', enum: ['x', 'y'] },
      m: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
      n: { type: 'integer', minimum: 1, maximum: 5 },
      k: { type: 'string' }
    })
    const res = elicitationAnswer(answered(params, { c: 'something else', m: ['a', 'zzz'], n: '9', k: 'kept' }), params)
    expect(res).toEqual({ action: 'accept', content: { k: 'kept' } })
    expect(elicitationAnswer(answered(params, { c: 'y', m: ['a', 'b'], n: '5', k: 'kept' }), params)).toEqual({
      action: 'accept',
      content: { c: 'y', m: ['a', 'b'], n: 5, k: 'kept' }
    })
    expect(elicitationAnswer(answered(params, { n: '0', k: 'kept' }), params)).toEqual({ action: 'accept', content: { k: 'kept' } })
  })

  it('declines when a required choice, multi pick or number is off-schema', () => {
    for (const [prop, bad] of [
      [{ type: 'string', enum: ['x', 'y'] }, 'other'],
      [{ type: 'array', items: { type: 'string', enum: ['a', 'b'] } }, ['a', 'zzz']],
      [{ type: 'number', minimum: 0, maximum: 1 }, '2'],
      [{ type: 'number', minimum: 0, maximum: 1 }, '-0.5']
    ] as const) {
      const params = form({ f: prop }, ['f'])
      expect(elicitationAnswer(answered(params, { f: bad }), params)).toEqual({ action: 'decline' })
    }
  })

  it('uses the shared Yes / No labels on both sides', () => {
    const q = parseQuestions(elicitationQuestions(form({ ok: { type: 'boolean' } })))!
    expect(q.questions[0].options.map((o) => o.label)).toEqual([ACP_YES_NO.yes, ACP_YES_NO.no])
  })

  it('declines an accept that leaves a required field unanswered or unreadable', () => {
    const params = form({ n: { type: 'number' }, s: { type: 'string' } }, ['n'])
    expect(elicitationAnswer(answered(params, { s: 'x' }), params)).toEqual({ action: 'decline' })
    expect(elicitationAnswer(answered(params, { n: 'abc', s: 'x' }), params)).toEqual({ action: 'decline' })
    // an optional one may be left out
    expect(elicitationAnswer(answered(params, { n: '3' }), params)).toEqual({ action: 'accept', content: { n: 3 } })
  })

  it('Skip (deny) declines', () => {
    expect(elicitationAnswer(denyResponse('r', 'skip'), form({ a: { type: 'string' } }))).toEqual({ action: 'decline' })
  })

  it('Stop, an error or anything unrecognised cancels, never accepts', () => {
    const params = form({ a: { type: 'string' } })
    expect(elicitationAnswer(errorResponse('r', 'stopped'), params)).toEqual({ action: 'cancel' })
    expect(elicitationAnswer({}, params)).toEqual({ action: 'cancel' })
    expect(elicitationAnswer(null as never, params)).toEqual({ action: 'cancel' })
    expect(elicitationAnswer({ response: { subtype: 'success', response: { behavior: 'maybe' } } }, params)).toEqual({ action: 'cancel' })
  })

  it('an allow with params that do not map declines, since there was no card', () => {
    expect(elicitationAnswer(allowResponse('r', {}), { mode: 'form', requestedSchema: { properties: { o: { type: 'object' } } } })).toEqual(
      { action: 'decline' }
    )
  })

  it('answers for names the form did not ask are never sent', () => {
    const params = form({ a: { type: 'string', title: 'A' } })
    const res = elicitationAnswer(allowResponse('r', { answers: { A: 'x', Evil: 'y' } }), params)
    expect(res).toEqual({ action: 'accept', content: { a: 'x' } })
  })

  it('a property named __proto__ is an own key, not the prototype', () => {
    const params = JSON.parse(
      '{"mode":"form","message":"m","requestedSchema":{"type":"object","properties":{"__proto__":{"type":"string","title":"P"}}}}'
    )
    const res = elicitationAnswer(allowResponse('r', { answers: { P: 'hi' } }), params)
    expect(res.action).toBe('accept')
    const content = (res as { content: Record<string, unknown> }).content
    expect(Object.keys(content)).toEqual(['__proto__'])
    expect(Object.getPrototypeOf(content)).toBeNull()
    expect(JSON.stringify(content)).toBe('{"__proto__":"hi"}')
  })
})
