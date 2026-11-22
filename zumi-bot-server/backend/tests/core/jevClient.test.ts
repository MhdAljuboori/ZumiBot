import { describe, expect, it, vi } from 'vitest'
import { createJevClient, JEV_MODEL, JEV_URL, type JevQuestion } from '../../src/core/jev/jevClient'

const KEY = 'sk-or-v1-test-key-0123456789'
const questions: Record<string, JevQuestion> = {
  bug: { type: 'noul', instructions: 'Is it a bug?' },
  team: { type: 'choice', instructions: 'Which team?', criteria: { payments: 'Billing', frontend: 'UI' } },
  urgency: { type: 'score', instructions: 'How urgent?', criteria: ['Later', 'Now'] }
}
const goodAnswers = {
  bug: { type: 'noul', noul: 0.96 },
  team: { type: 'choice', choice: 'payments', confidence: 0.67, probabilities: { payments: 0.78, frontend: 0.22 } },
  urgency: { type: 'score', score: 0.99, confidence: 0.99, probabilities: { '0': 0.01, '1': 0.99 } }
}

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function setup(o: { key?: string | null; fetch?: typeof fetch; timeoutMs?: number } = {}) {
  const log = vi.fn()
  const fetchFn = vi.fn(o.fetch ?? (async () => reply(200, { id: 'gen-1', model: 'typesafe/jev-1.14-x', answers: goodAnswers, usage: {} })))
  const client = createJevClient({
    key: async () => (o.key === undefined ? KEY : o.key),
    fetch: fetchFn as typeof fetch,
    timeoutMs: o.timeoutMs,
    log
  })
  return { client, fetchFn, log }
}

describe('jev client', () => {
  it('posts the questions with the key and returns the answers', async () => {
    const { client, fetchFn } = setup()
    const answers = await client.decide({ ticket: 'Pay button is blank' }, questions)
    expect(answers).toEqual({
      bug: { type: 'noul', noul: 0.96 },
      team: { type: 'choice', choice: 'payments', probabilities: { payments: 0.78, frontend: 0.22 } },
      urgency: { type: 'score', probabilities: { '0': 0.01, '1': 0.99 } }
    })
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(JEV_URL)
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${KEY}`)
    expect(JSON.parse(init.body as string)).toEqual({ model: JEV_MODEL, state: { ticket: 'Pay button is blank' }, questions })
  })

  it('makes no call without a key', async () => {
    const { client, fetchFn } = setup({ key: null })
    expect(await client.decide('x', questions)).toBeNull()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('answers null on an HTTP error and logs the status without the key', async () => {
    const { client, log } = setup({ fetch: async () => reply(402, { error: { code: 402, message: 'Insufficient credits' } }) })
    expect(await client.decide('x', questions)).toBeNull()
    const lines = log.mock.calls.map((c) => String(c[0])).join('\n')
    expect(lines).toContain('402')
    expect(lines).not.toContain(KEY)
  })

  it('answers null when the network fails', async () => {
    const { client } = setup({
      fetch: async () => {
        throw new TypeError('fetch failed')
      }
    })
    expect(await client.decide('x', questions)).toBeNull()
  })

  it('answers null when the body is not JSON', async () => {
    const { client } = setup({ fetch: async () => new Response('<html>', { status: 200 }) })
    expect(await client.decide('x', questions)).toBeNull()
  })

  it('answers null when an asked question has no answer', async () => {
    const { client } = setup({ fetch: async () => reply(200, { answers: { bug: goodAnswers.bug } }) })
    expect(await client.decide('x', questions)).toBeNull()
  })

  it('answers null when a choice is not one of the options', async () => {
    const { client } = setup({
      fetch: async () => reply(200, { answers: { ...goodAnswers, team: { type: 'choice', choice: 'legal', probabilities: { legal: 1 } } } })
    })
    expect(await client.decide('x', questions)).toBeNull()
  })

  it('answers null when a choice or score has no probabilities', async () => {
    const { client } = setup({
      fetch: async () => reply(200, { answers: { ...goodAnswers, team: { type: 'choice', choice: 'payments' } } })
    })
    expect(await client.decide('x', questions)).toBeNull()
  })

  it('answers null when a noul is out of range or of the wrong type', async () => {
    const { client } = setup({ fetch: async () => reply(200, { answers: { ...goodAnswers, bug: { type: 'noul', noul: 1.5 } } }) })
    expect(await client.decide('x', questions)).toBeNull()
    const { client: c2 } = setup({ fetch: async () => reply(200, { answers: { ...goodAnswers, bug: { type: 'score', score: 1 } } }) })
    expect(await c2.decide('x', questions)).toBeNull()
  })

  it('gives up after the timeout', async () => {
    const { client } = setup({
      timeoutMs: 20,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
    })
    expect(await client.decide('x', questions)).toBeNull()
  })

  it('stops when the caller aborts', async () => {
    const { client } = setup({
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
    })
    const ctrl = new AbortController()
    const pending = client.decide('x', questions, ctrl.signal)
    ctrl.abort()
    expect(await pending).toBeNull()
  })

  describe('check', () => {
    it('is ok when Jev answers', async () => {
      const { client } = setup({ fetch: async () => reply(200, { answers: { ok: { type: 'noul', noul: 0.9 } } }) })
      expect(await client.check()).toEqual({ ok: true })
    })

    it('says no key is set', async () => {
      const { client } = setup({ key: null })
      expect(await client.check()).toEqual({ ok: false, error: 'No OpenRouter key is set.' })
    })

    it('names a rejected key and missing credits', async () => {
      const { client } = setup({ fetch: async () => reply(401, { error: { code: 401, message: 'No auth' } }) })
      expect(await client.check()).toEqual({ ok: false, error: 'OpenRouter did not accept the key.' })
      const { client: c2 } = setup({ fetch: async () => reply(402, { error: { code: 402, message: 'Insufficient credits' } }) })
      expect(await c2.check()).toEqual({ ok: false, error: 'The OpenRouter account has no credits left.' })
    })

    it('reports other failures by status', async () => {
      const { client } = setup({ fetch: async () => reply(503, {}) })
      expect(await client.check()).toEqual({ ok: false, error: 'Jev did not answer (HTTP 503).' })
      const { client: c2 } = setup({
        fetch: async () => {
          throw new TypeError('fetch failed')
        }
      })
      expect(await c2.check()).toEqual({ ok: false, error: 'Could not reach OpenRouter.' })
    })
  })
})
