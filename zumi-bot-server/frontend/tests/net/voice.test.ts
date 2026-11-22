import { describe, expect, it, vi } from 'vitest'
import { transcribeClip } from '../../src/net/voice'

const resp = (status: number, body: string, json = false): Response =>
  new Response(body, { status, headers: { 'content-type': json ? 'application/json' : 'text/html' } })
const clip = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' })
const run = (f: typeof fetch, onSignedOut?: () => void, signal = new AbortController().signal) =>
  transcribeClip(f, clip, 'audio/webm', 'ar', 'full', signal, onSignedOut)

describe('transcribeClip', () => {
  it('asks for light cleaning when told', async () => {
    const f = vi.fn().mockResolvedValue(resp(200, JSON.stringify({ text: 'yes' }), true))
    await transcribeClip(f, clip, 'audio/webm', 'auto', 'light', new AbortController().signal)
    expect(f.mock.calls[0][1].headers['X-ZumiBot-Voice-Clean']).toBe('light')
  })

  it('posts the raw clip with its type and language', async () => {
    const f = vi.fn().mockResolvedValue(resp(200, JSON.stringify({ text: 'hello' }), true))
    const ctl = new AbortController()
    expect(await run(f, undefined, ctl.signal)).toEqual({ ok: true, text: 'hello' })
    const [url, init] = f.mock.calls[0]
    expect(url).toBe('/api/voice/transcribe')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'Content-Type': 'audio/webm', 'X-ZumiBot-Voice-Lang': 'ar', 'X-ZumiBot-Voice-Clean': 'full' })
    expect(init.body).toBe(clip)
    expect(init.signal).toBe(ctl.signal)
  })

  it('401 signs out and fails', async () => {
    const out = vi.fn()
    expect(await run(vi.fn().mockResolvedValue(resp(401, 'no')), out)).toEqual({ ok: false, error: 'failed' })
    expect(out).toHaveBeenCalledOnce()
  })

  it.each([
    [413, 'too-large'],
    [429, 'busy'],
    [503, 'off'],
    [502, 'upstream'],
    [504, 'timeout'],
    [400, 'failed'],
    [415, 'failed'],
    [500, 'failed']
  ])('%i maps to %s', async (status, error) => {
    const out = vi.fn()
    expect(await run(vi.fn().mockResolvedValue(resp(status, '<html>x</html>')), out)).toEqual({ ok: false, error })
    expect(out).not.toHaveBeenCalled()
  })

  it('a rejected fetch is a network error', async () => {
    expect(await run(vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))).toEqual({ ok: false, error: 'network' })
  })

  it('an abort is "failed", which the caller ignores as stale', async () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' })
    expect(await run(vi.fn().mockRejectedValue(err))).toEqual({ ok: false, error: 'failed' })
  })

  it('a 200 that is not JSON fails', async () => {
    expect(await run(vi.fn().mockResolvedValue(resp(200, '<html>proxy</html>')))).toEqual({ ok: false, error: 'failed' })
  })

  it('a 200 without a string text fails', async () => {
    expect(await run(vi.fn().mockResolvedValue(resp(200, '{}', true)))).toEqual({ ok: false, error: 'failed' })
    expect(await run(vi.fn().mockResolvedValue(resp(200, '{"text":5}', true)))).toEqual({ ok: false, error: 'failed' })
  })
})
