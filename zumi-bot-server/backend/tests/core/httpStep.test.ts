import { describe, expect, it } from 'vitest'
import type { Step } from '@zumibot/shared/workflows'
import type { TemplateCtx } from '@zumibot/shared/workflowTemplate'
import { DOT_SEGMENT, buildHttpRequest } from '../../src/core/workflows/httpStep'

type HttpStep = Extract<Step, { kind: 'http' }>
const step = (over: Partial<HttpStep> = {}): HttpStep => ({
  id: 'h',
  handle: 'h',
  name: 'H',
  x: 0,
  y: 0,
  kind: 'http',
  method: 'GET',
  url: 'https://api.example.com/v1/users/{{input}}/delete',
  headers: [],
  bodyType: 'json',
  ...over
})
const ctx = (input: string): TemplateCtx =>
  ({
    inputs: [{ from: 't', text: input }],
    names: { t: 'Start' },
    outputs: {},
    trigger: { call: null, text: null, material: false }
  }) as unknown as TemplateCtx
const build = (s: HttpStep, input: string, key: { name: string; value: string } | null = null) => buildHttpRequest(s, ctx(input), key)

describe('buildHttpRequest path segments', () => {
  it('refuses a filled value that makes a . or .. segment, so the path never moves', () => {
    for (const v of ['..', '.']) expect(build(step(), v)).toMatchObject({ error: DOT_SEGMENT })
    // A literal %2e next to a filled dot is a dot segment to the URL parser too.
    expect(build(step({ url: 'https://api.example.com/v1/%2e{{input}}/x' }), '.')).toMatchObject({ error: DOT_SEGMENT })
    expect(build(step({ url: 'https://api.example.com/v1/{{input}}{{input}}/x' }), '.')).toMatchObject({ error: DOT_SEGMENT })
    expect(build(step({ url: 'https://api.example.com/v1/.{{input}}/x' }), '.')).toMatchObject({ error: DOT_SEGMENT })
    // The vault key is a value like any other.
    const keyed = step({ url: 'https://api.example.com/v1/{{key}}/x', key: 'k' })
    expect(build(keyed, 'a', { name: 'K', value: '..' })).toMatchObject({ error: DOT_SEGMENT })
  })

  it("keeps dots inside a segment, in the query, and the step's own literal path", () => {
    expect(build(step(), 'a.b')).toMatchObject({ req: { url: 'https://api.example.com/v1/users/a.b/delete' } })
    expect(build(step(), '...')).toMatchObject({ req: { url: 'https://api.example.com/v1/users/.../delete' } })
    // An encoded dot from a value stays encoded (its % is encoded too), so it is no dot segment.
    expect(build(step(), '%2e%2e')).toMatchObject({ req: { url: 'https://api.example.com/v1/users/%252e%252e/delete' } })
    expect(build(step({ url: 'https://api.example.com/v1/x?q={{input}}' }), '..')).toMatchObject({
      req: { url: 'https://api.example.com/v1/x?q=..' }
    })
    expect(build(step({ url: 'https://api.example.com/v1/../x/{{input}}' }), 'a')).toMatchObject({
      req: { url: 'https://api.example.com/x/a' }
    })
  })
})

describe('buildHttpRequest local network', () => {
  it('marks the request only when the step allows the local network', () => {
    expect(build(step(), 'a')).toMatchObject({ req: { url: 'https://api.example.com/v1/users/a/delete' } })
    expect((build(step(), 'a') as { req: object }).req).not.toHaveProperty('allowLocal')
    expect(build(step({ allowLocalNetwork: true }), 'a')).toMatchObject({ req: { allowLocal: true } })
  })
})
