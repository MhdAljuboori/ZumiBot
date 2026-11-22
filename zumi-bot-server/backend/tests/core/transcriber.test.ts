import { describe, expect, it, vi } from 'vitest'
import { createTranscriber, OPENROUTER_ORIGIN, testVoiceOrigin, VOICE_MODEL } from '../../src/core/voice/transcriber'

const KEY = 'sk-or-SECRET'
const URL_T = 'https://openrouter.ai/api/v1/audio/transcriptions'
const URL_K = 'https://openrouter.ai/api/v1/key'

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const text = (status: number, body: string): Response => new Response(body, { status })

function setup(o: { key?: string | null; fetch?: typeof fetch; timeoutMs?: number; origin?: string } = {}) {
  const log = vi.fn()
  const fetchFn = vi.fn(o.fetch ?? (async () => json(200, { text: ' hi ' })))
  const t = createTranscriber({
    key: async () => (o.key === undefined ? KEY : o.key),
    fetch: fetchFn as typeof fetch,
    timeoutMs: o.timeoutMs,
    origin: o.origin,
    log
  })
  return { t, fetchFn, log }
}

describe('transcriber', () => {
  it('posts base64 JSON with zdr and the model', async () => {
    const { t, fetchFn } = setup()
    const r = await t.transcribe(Buffer.from('abc'), 'webm', 'auto')
    expect(r).toEqual({ ok: true, text: 'hi' })
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(URL_T)
    expect(OPENROUTER_ORIGIN).toBe('https://openrouter.ai')
    expect(init.method).toBe('POST')
    const h = init.headers as Record<string, string>
    expect(h['Authorization']).toBe(`Bearer ${KEY}`)
    expect(h['Content-Type']).toBe('application/json')
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({ model: VOICE_MODEL, input_audio: { data: 'YWJj', format: 'webm' }, provider: { zdr: true } })
    expect(body).not.toHaveProperty('language')
  })

  it('sends language for en and ar', async () => {
    for (const lang of ['en', 'ar'] as const) {
      const { t, fetchFn } = setup()
      await t.transcribe(Buffer.from('abc'), 'ogg', lang)
      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit]
      expect(JSON.parse(init.body as string).language).toBe(lang)
    }
  })

  it('no key is off, with no request', async () => {
    const { t, fetchFn } = setup({ key: null })
    expect(await t.transcribe(Buffer.from('abc'), 'webm', 'auto')).toEqual({ ok: false, error: 'off' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('bad upstream answers are upstream errors', async () => {
    const answers = [text(500, '<html>bad gateway</html>'), text(200, '<html>'), json(200, {}), json(200, { text: 5 })]
    for (const a of answers) {
      const { t } = setup({ fetch: async () => a })
      expect(await t.transcribe(Buffer.from('abc'), 'webm', 'auto')).toEqual({ ok: false, error: 'upstream' })
    }
  })

  it('times out', async () => {
    const hang = ((_u: string, init: RequestInit) =>
      new Promise((_res, rej) => {
        init.signal?.addEventListener('abort', () => rej(init.signal?.reason))
      })) as unknown as typeof fetch
    const { t } = setup({ fetch: hang, timeoutMs: 20 })
    expect(await t.transcribe(Buffer.from('abc'), 'webm', 'auto')).toEqual({ ok: false, error: 'timeout' })
  })

  // Headers arrive, then the body stalls: the timer fires during res.text(), not during fetch().
  const stalledBody = ((_u: string, init: RequestInit) => {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(' '))
        init.signal?.addEventListener('abort', () => c.error(init.signal?.reason))
      }
    })
    return Promise.resolve(new Response(body, { status: 200 }))
  }) as unknown as typeof fetch

  it('times out while reading the body', async () => {
    const { t, log } = setup({ fetch: stalledBody, timeoutMs: 20 })
    expect(await t.transcribe(Buffer.from('abc'), 'webm', 'auto')).toEqual({ ok: false, error: 'timeout' })
    const lines = log.mock.calls.map((c) => String(c[0]))
    expect(lines).toEqual(['voice: timed out (3 bytes)'])
  })

  it('a caller abort while reading the body logs nothing', async () => {
    const { t, log } = setup({ fetch: stalledBody })
    const ac = new AbortController()
    const r = t.transcribe(Buffer.from('abc'), 'webm', 'auto', ac.signal)
    await new Promise((res) => setTimeout(res, 20))
    ac.abort()
    expect(await r).toEqual({ ok: false, error: 'upstream' })
    expect(log).not.toHaveBeenCalled()
  })

  it('passes a caller abort on to fetch', async () => {
    const hang = ((_u: string, init: RequestInit) =>
      new Promise((_res, rej) => {
        if (init.signal?.aborted) rej(init.signal.reason)
        init.signal?.addEventListener('abort', () => rej(init.signal?.reason))
      })) as unknown as typeof fetch
    const { t, fetchFn } = setup({ fetch: hang })
    const ac = new AbortController()
    ac.abort()
    const r = await t.transcribe(Buffer.from('abc'), 'webm', 'auto', ac.signal)
    expect(r).toEqual({ ok: false, error: 'upstream' })
    if (fetchFn.mock.calls.length) expect((fetchFn.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true)
  })

  it('logs status and size only', async () => {
    const audio = Buffer.from('some audio bytes')
    const { t, log } = setup({ fetch: async () => text(500, 'SECRETBODY') })
    await t.transcribe(audio, 'webm', 'auto')
    const lines = log.mock.calls.map((c) => String(c[0]))
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.join('\n')).toContain('500')
    for (const bad of [KEY, 'SECRETBODY', audio.toString('base64')]) expect(lines.join('\n')).not.toContain(bad)
  })

  it('checks the key', async () => {
    const ok = setup({ fetch: async () => json(200, { data: {} }) })
    expect(await ok.t.check()).toEqual({ ok: true })
    const [url, init] = ok.fetchFn.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(URL_K)
    expect(init.method ?? 'GET').toBe('GET')
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${KEY}`)

    const bad = setup({ fetch: async () => json(401, { error: 'no' }) })
    expect(await bad.t.check()).toEqual({ ok: false, reason: 'invalid' })

    const down = setup({
      fetch: async () => {
        throw new TypeError('fetch failed')
      }
    })
    expect(await down.t.check()).toEqual({ ok: false, reason: 'unreachable' })

    const none = setup({ key: null })
    expect(await none.t.check()).toEqual({ ok: false, reason: 'nokey' })
    expect(none.fetchFn).not.toHaveBeenCalled()
  })

  it('uses an origin override for both URLs', async () => {
    const { t, fetchFn } = setup({ origin: 'http://127.0.0.1:9' })
    await t.transcribe(Buffer.from('abc'), 'webm', 'auto')
    await t.check()
    expect((fetchFn.mock.calls[0][0] as string).startsWith('http://127.0.0.1:9/')).toBe(true)
    expect((fetchFn.mock.calls[1][0] as string).startsWith('http://127.0.0.1:9/')).toBe(true)
  })
})

describe('testVoiceOrigin', () => {
  it('accepts only a bare 127.0.0.1 http origin', () => {
    expect(testVoiceOrigin('http://127.0.0.1:4555')).toBe('http://127.0.0.1:4555')
    for (const bad of [
      'http://127.0.0.1:4555/x',
      'http://127.0.0.1:4555/?a=1',
      'https://127.0.0.1:1',
      'http://localhost:1',
      'http://10.0.0.1:1',
      undefined
    ]) {
      expect(testVoiceOrigin(bad)).toBeNull()
    }
  })
})
