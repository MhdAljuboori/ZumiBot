import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_CLEAN,
  VOICE_CLEAN_HEADER,
  VOICE_LANG_HEADER,
  VOICE_MAX_BYTES,
  VOICE_ROUTE,
  type VoiceClean,
  type VoiceFormat,
  type VoiceLang
} from '@zumibot/shared/voice'
import { createTranscriber, type TranscribeResult } from '../../src/core/voice/transcriber'
import { createVoiceLimiter, type VoiceRoute } from '../../src/http/voice'
import { allowGate, startRig, type Rig } from './helpers'

interface Call {
  audio: Buffer
  format: VoiceFormat
  lang: VoiceLang
  signal?: AbortSignal
}

// The fake records each call; `gate` makes it wait, and an abort ends the wait like the real fetch would.
function fake(result: TranscribeResult = { ok: true, text: 'hello' }, gate?: Promise<void>) {
  const calls: Call[] = []
  const transcriber: VoiceRoute['transcriber'] = {
    transcribe: async (audio, format, lang, signal) => {
      calls.push({ audio, format, lang, signal })
      if (gate) {
        await new Promise<void>((resolve) => {
          void gate.then(resolve)
          signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        if (signal?.aborted) return { ok: false, error: 'upstream' }
      }
      return result
    }
  }
  return { calls, transcriber }
}

let rig: Rig | undefined
afterEach(async () => {
  await rig?.close()
  rig = undefined
})

const start = async (v: Partial<VoiceRoute> & Pick<VoiceRoute, 'transcriber'>, gate = allowGate()): Promise<Rig> => {
  rig = await startRig({
    gate,
    voice: {
      on: async () => true,
      limiter: createVoiceLimiter(),
      clean: async () => DEFAULT_CLEAN,
      cleaner: { rewrite: async () => null },
      ...v
    }
  })
  return rig
}
const post = (r: Rig, body: Buffer | null, type = 'audio/webm', lang: string | null = 'auto'): Promise<Response> =>
  fetch(`${r.base}${VOICE_ROUTE}`, {
    method: 'POST',
    headers: { ...(type ? { 'Content-Type': type } : {}), ...(lang === null ? {} : { [VOICE_LANG_HEADER]: lang }) },
    body: body && new Uint8Array(body)
  })
const bytes = (n = 10): Buffer => Buffer.alloc(n, 7)

// A rewrite fake that records what it was given and answers a fixed tidy line.
function rewriter(out: string | null = 'I want to meet Obada at four.') {
  const calls: { text: string; signal?: AbortSignal }[] = []
  const cleaner: VoiceRoute['cleaner'] = {
    rewrite: async (text, signal) => {
      calls.push({ text, signal })
      return out
    }
  }
  return { calls, cleaner }
}
const postClean = (r: Rig, mode: string | null): Promise<Response> =>
  fetch(`${r.base}${VOICE_ROUTE}`, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/webm', [VOICE_LANG_HEADER]: 'auto', ...(mode === null ? {} : { [VOICE_CLEAN_HEADER]: mode }) },
    body: new Uint8Array(bytes())
  })
const SAID = 'Um, I want to meet Obada at three, no, at four.'
const switches =
  (fillers: boolean, rewrite: boolean): (() => Promise<VoiceClean>) =>
  async () => ({ fillers, rewrite })

describe('POST /api/voice/transcribe cleaning', () => {
  it('both switches off: the transcript as said, no rewrite', async () => {
    const w = rewriter()
    const r = await start({ transcriber: fake({ ok: true, text: SAID }).transcriber, cleaner: w.cleaner })
    expect(await (await postClean(r, null)).json()).toEqual({ text: SAID })
    expect(w.calls).toHaveLength(0)
  })

  it('filler words on: hums cut, no rewrite', async () => {
    const w = rewriter()
    const r = await start({ transcriber: fake({ ok: true, text: SAID }).transcriber, cleaner: w.cleaner, clean: switches(true, false) })
    expect(await (await postClean(r, 'full')).json()).toEqual({ text: 'I want to meet Obada at three, no, at four.' })
    expect(w.calls).toHaveLength(0)
  })

  it('rewrite on: the rewrite gets the filtered text and the request signal', async () => {
    const w = rewriter()
    const r = await start({ transcriber: fake({ ok: true, text: SAID }).transcriber, cleaner: w.cleaner, clean: switches(false, true) })
    expect(await (await postClean(r, 'full')).json()).toEqual({ text: 'I want to meet Obada at four.' })
    expect(w.calls).toEqual([{ text: 'I want to meet Obada at three, no, at four.', signal: expect.any(AbortSignal) }])
  })

  it('no clean header is full, so an older page still gets the rewrite', async () => {
    const w = rewriter()
    const r = await start({ transcriber: fake({ ok: true, text: SAID }).transcriber, cleaner: w.cleaner, clean: switches(false, true) })
    expect(await (await postClean(r, null)).json()).toEqual({ text: 'I want to meet Obada at four.' })
    expect(w.calls).toHaveLength(1)
  })

  it('light never rewrites, but still cuts hums when rewrite is on', async () => {
    const w = rewriter()
    const r = await start({ transcriber: fake({ ok: true, text: SAID }).transcriber, cleaner: w.cleaner, clean: switches(false, true) })
    expect(await (await postClean(r, 'light')).json()).toEqual({ text: 'I want to meet Obada at three, no, at four.' })
    expect(w.calls).toHaveLength(0)
  })

  it('an unknown clean mode is 400 with no transcription', async () => {
    const f = fake()
    const r = await start({ transcriber: f.transcriber })
    const res = await postClean(r, 'loud')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'bad-request' })
    expect(f.calls).toHaveLength(0)
  })

  it('a failed transcription never reaches the cleaner', async () => {
    const w = rewriter()
    const r = await start({
      transcriber: fake({ ok: false, error: 'upstream' }).transcriber,
      cleaner: w.cleaner,
      clean: switches(true, true)
    })
    expect((await postClean(r, 'full')).status).toBe(502)
    expect(w.calls).toHaveLength(0)
  })
})

describe('POST /api/voice/transcribe', () => {
  it('needs a session and our origin', async () => {
    const f = fake()
    const denied = await start({ transcriber: f.transcriber }, allowGate(false))
    expect((await post(denied, bytes())).status).toBe(401)
    await rig!.close()
    const badOrigin = await start(
      { transcriber: f.transcriber },
      { authorize: async () => true, originOk: async () => false, handle: async () => false }
    )
    expect((await post(badOrigin, bytes())).status).toBe(403)
    expect(f.calls).toHaveLength(0)
  })

  it('POST only', async () => {
    const f = fake()
    const r = await start({ transcriber: f.transcriber })
    expect((await fetch(`${r.base}${VOICE_ROUTE}`)).status).toBe(405)
  })

  it('is 404 when the server has no voice route', async () => {
    rig = await startRig()
    expect((await post(rig, bytes())).status).toBe(404)
  })

  it('checks type and language', async () => {
    const f = fake()
    const r = await start({ transcriber: f.transcriber })
    const bad = await post(r, bytes(), 'text/plain')
    expect(bad.status).toBe(415)
    expect(await bad.json()).toEqual({ error: 'bad-type' })
    // A plain-object lookup would find "constructor" on the prototype.
    expect((await post(r, bytes(), 'constructor')).status).toBe(415)
    expect((await post(r, bytes(), '')).status).toBe(415)
    const fr = await post(r, bytes(), 'audio/webm;codecs=opus', 'fr')
    expect(fr.status).toBe(400)
    expect(await fr.json()).toEqual({ error: 'bad-request' })
    expect((await post(r, bytes(), 'audio/webm', null)).status).toBe(400)
    expect((await post(r, Buffer.alloc(0))).status).toBe(400)
    expect(f.calls).toHaveLength(0)
  })

  it('too large', async () => {
    const f = fake()
    const r = await start({ transcriber: f.transcriber })
    const { request } = await import('node:http')
    const declared = await new Promise<{ status: number; json: any }>((resolve, reject) => {
      const req = request(
        `${r.base}${VOICE_ROUTE}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'audio/webm', [VOICE_LANG_HEADER]: 'auto', 'Content-Length': String(VOICE_MAX_BYTES + 1) }
        },
        (res) => {
          let s = ''
          res.on('data', (d) => (s += d))
          res.on('end', () => resolve({ status: res.statusCode!, json: JSON.parse(s) }))
        }
      )
      req.on('error', reject)
      req.write('a few bytes only') // the answer must not wait for the rest
    })
    expect(declared.status).toBe(413)
    expect(declared.json).toEqual({ error: 'too-large' })

    const chunk = Buffer.alloc(1024 * 1024, 1)
    const chunked = await new Promise<{ status: number; json: any }>((resolve, reject) => {
      const req = request(
        `${r.base}${VOICE_ROUTE}`,
        { method: 'POST', headers: { 'Content-Type': 'audio/webm', [VOICE_LANG_HEADER]: 'auto' } },
        (res) => {
          let s = ''
          res.on('data', (d) => (s += d))
          res.on('end', () => resolve({ status: res.statusCode!, json: JSON.parse(s) }))
        }
      )
      req.on('error', () => {}) // a reset after the answer is fine; the response handler already ran
      for (let i = 0; i < 9; i++) req.write(chunk)
      req.end()
    })
    expect(chunked.status).toBe(413)
    expect(chunked.json).toEqual({ error: 'too-large' })
    expect(f.calls).toHaveLength(0)
  })

  it('off', async () => {
    const f = fake()
    const r = await start({ transcriber: f.transcriber, on: async () => false })
    const res = await post(r, bytes())
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'off' })
    expect(f.calls).toHaveLength(0)
  })

  it('passes format and language through', async () => {
    const f = fake({ ok: true, text: 'مرحبا' })
    const r = await start({ transcriber: f.transcriber })
    const body = Buffer.from([1, 2, 3, 4, 5])
    const res = await post(r, body, 'audio/mp4', 'ar')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ text: 'مرحبا' })
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]!.format).toBe('m4a')
    expect(f.calls[0]!.lang).toBe('ar')
    expect(f.calls[0]!.audio.equals(body)).toBe(true)
  })

  it('maps errors', async () => {
    for (const [error, status] of [
      ['upstream', 502],
      ['timeout', 504],
      ['off', 503]
    ] as const) {
      const r = await start({ transcriber: fake({ ok: false, error }).transcriber })
      const res = await post(r, bytes())
      expect(res.status).toBe(status)
      expect(await res.json()).toEqual({ error })
      await r.close()
      rig = undefined
    }
  })

  it('limits concurrent requests', async () => {
    let release!: () => void
    const f = fake({ ok: true, text: 'ok' }, new Promise<void>((r) => (release = r)))
    const r = await start({ transcriber: f.transcriber, limiter: createVoiceLimiter({ concurrent: 2 }) })
    const a = post(r, bytes())
    const b = post(r, bytes())
    await waitFor(() => f.calls.length === 2)
    const third = await post(r, bytes())
    expect(third.status).toBe(429)
    expect(await third.json()).toEqual({ error: 'busy' })
    release()
    expect((await a).status).toBe(200)
    expect((await b).status).toBe(200)
    expect((await post(r, bytes())).status).toBe(200) // slots are free again
  })

  it('limits requests per rolling minute', async () => {
    let t = 1_000_000
    const f = fake()
    const r = await start({ transcriber: f.transcriber, limiter: createVoiceLimiter({ perMinute: 2, now: () => t }) })
    expect((await post(r, bytes())).status).toBe(200)
    expect((await post(r, bytes())).status).toBe(200)
    expect((await post(r, bytes())).status).toBe(429)
    t += 60_000
    expect((await post(r, bytes())).status).toBe(200)
  })

  it('an aborted request frees its slot', async () => {
    let release!: () => void
    const f = fake({ ok: true, text: 'ok' }, new Promise<void>((r) => (release = r)))
    const r = await start({ transcriber: f.transcriber, limiter: createVoiceLimiter({ concurrent: 2 }) })
    const ac = new AbortController()
    const aborted = fetch(`${r.base}${VOICE_ROUTE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm', [VOICE_LANG_HEADER]: 'auto' },
      body: new Uint8Array(bytes()),
      signal: ac.signal
    })
    aborted.catch(() => {})
    const kept = post(r, bytes())
    await waitFor(() => f.calls.length === 2)
    ac.abort()
    await waitFor(() => f.calls[0]!.signal?.aborted === true)
    // The gate is still closed: this one starts only if the abort alone freed a slot (both were taken).
    const third = post(r, bytes())
    await waitFor(() => f.calls.length === 3)
    release()
    expect((await kept).status).toBe(200)
    expect((await third).status).toBe(200)
    expect(f.calls[0]!.signal?.aborted).toBe(true)
  })

  it('a body that stalls past the timeout is 504', async () => {
    // The real transcriber behind the route: headers arrive, the body never finishes.
    const stalled = ((_u: string, init: RequestInit) =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('{'))
              init.signal?.addEventListener('abort', () => c.error(init.signal?.reason))
            }
          }),
          { status: 200 }
        )
      )) as unknown as typeof fetch
    const lines: string[] = []
    const transcriber = createTranscriber({ key: async () => 'k', fetch: stalled, timeoutMs: 30, log: (l) => lines.push(l) })
    const r = await start({ transcriber })
    const res = await post(r, bytes())
    expect(res.status).toBe(504)
    expect(await res.json()).toEqual({ error: 'timeout' })
    expect(lines).toEqual(['voice: timed out (10 bytes)'])
  })

  it('writes nothing to disk', async () => {
    // Own temp dir, kept as TMPDIR through the POST: parallel test files cannot change what is compared,
    // and anything the route writes through tmpdir() lands where it is looked for.
    const mine = await mkdtemp(join(tmpdir(), 'cb-voice-tmp-'))
    const prev = process.env.TMPDIR
    process.env.TMPDIR = mine
    const list = async (dir: string): Promise<string[]> => (await readdir(dir, { recursive: true })).sort()
    try {
      const r = await start({ transcriber: fake().transcriber })
      const rootBefore = await list(r.root)
      const tmpBefore = await list(mine)
      expect((await post(r, bytes(1000))).status).toBe(200)
      expect(await list(r.root)).toEqual(rootBefore)
      expect(await list(mine)).toEqual(tmpBefore)
    } finally {
      if (prev === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = prev
      await rm(mine, { recursive: true, force: true })
    }
  })
})

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('condition not met')
}
