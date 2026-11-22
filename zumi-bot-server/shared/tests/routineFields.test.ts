import { describe, expect, it } from 'vitest'
import { FIELDS_MAX, FIELD_DEPTH_MAX, fieldList, flattenCall, renderPrompt } from '@zumibot/shared/routineFields'
import type { WebhookCall } from '@zumibot/shared/routines'

const call = (method: string, query: Record<string, string>, body: unknown): WebhookCall => ({ method, query, body, receivedAt: 0 })

describe('flattenCall', () => {
  it('GET gives query fields only and ignores the body', () => {
    expect(flattenCall(call('GET', { repo: 'x' }, { a: 1 }))).toEqual({ 'query.repo': 'x' })
  })
  it('flattens JSON bodies into leaves and containers', () => {
    const c = call('POST', { p: 'high' }, { pr: { title: 'T', labels: ['bug'] } })
    const f = flattenCall(c)
    expect(f['query.p']).toBe('high')
    expect(f['body.pr.title']).toBe('T')
    expect(f['body.pr.labels.0']).toBe('bug')
    expect(f['body.pr.labels']).toBe('["bug"]')
    expect(f.body).toBe('{"pr":{"title":"T","labels":["bug"]}}')
    expect(fieldList(c).map((x) => x.path)).toEqual(['query.p', 'body.pr.title', 'body.pr.labels.0'])
    expect(fieldList(c)[1]).toEqual({ path: 'body.pr.title', sample: 'T' })
  })
  it('stringifies numbers, booleans and null', () => {
    const f = flattenCall(call('POST', {}, { n: 42, b: true, z: null }))
    expect([f['body.n'], f['body.b'], f['body.z']]).toEqual(['42', 'true', ''])
  })
  it('keeps a text body whole', () => {
    expect(flattenCall(call('POST', {}, 'hello'))).toEqual({ body: 'hello' })
  })
  it('has no body fields for null or undefined', () => {
    expect(flattenCall(call('POST', {}, null))).toEqual({})
    expect(flattenCall(call('POST', {}, undefined))).toEqual({})
  })
  it('indexes top-level arrays', () => {
    const f = flattenCall(call('POST', {}, [1, 2]))
    expect(f['body.0']).toBe('1')
    expect(f['body.1']).toBe('2')
  })
  it('caps leaves at FIELDS_MAX', () => {
    const body = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`k${i}`, i]))
    const c = call('POST', {}, body)
    expect(fieldList(c).length).toBe(FIELDS_MAX)
    expect(Object.keys(flattenCall(c)).length).toBeLessThanOrEqual(FIELDS_MAX + 1)
  })
  it('stops at depth 10 without throwing', () => {
    let body: unknown = 'deep'
    for (let i = 0; i < 15; i++) body = { n: body }
    const c = call('POST', {}, body)
    const depths = Object.keys(flattenCall(c)).map((p) => p.split('.').length - 1)
    expect(Math.max(...depths)).toBe(FIELD_DEPTH_MAX)
    expect(() => fieldList(c)).not.toThrow()
  })
})

describe('renderPrompt', () => {
  it('fills known fields and reports missing ones', () => {
    expect(renderPrompt('Review {{body.pr.title}} in {{ body.repo }}', { 'body.pr.title': 'T' })).toEqual({
      text: 'Review T in ',
      missing: ['body.repo']
    })
  })
  it('leaves text without placeholders unchanged', () => {
    expect(renderPrompt('no fields', {})).toEqual({ text: 'no fields', missing: [] })
  })
  it('lists a missing path once and does not re-expand substituted text', () => {
    const r = renderPrompt('{{a}}{{a}}{{b}}', { b: '{{a}}' })
    expect(r).toEqual({ text: '{{a}}', missing: ['a'] })
  })
})
