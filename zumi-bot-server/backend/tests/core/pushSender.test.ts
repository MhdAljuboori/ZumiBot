import { createHash, createECDH } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { b64url, generateVapidKeys } from '../../src/core/notify/webPush'
import { pushOptions, sendPush, topicOf } from '../../src/core/notify/pushSender'
import { buildPayload } from '@zumibot/shared/notify'
import type { NotifyPayloadKind } from '@zumibot/shared/notify'

const ENDPOINT = 'https://push.example.test/send/SECRET-endpoint-token-123'
const vapid = generateVapidKeys()
const ua = createECDH('prime256v1')
ua.generateKeys()
const target = {
  endpoint: ENDPOINT,
  p256dh: b64url.encode(ua.getPublicKey()),
  auth: b64url.encode(Buffer.alloc(16, 7))
}
const payloadOf = (kind: NotifyPayloadKind = 'waiting') => buildPayload({ kind, tag: 'chat:abc:waiting', chatId: 'abc', title: 'T', at: 1 })

interface Call {
  url: string
  init: RequestInit
}

function harness(replies: (Response | Error)[]) {
  const calls: Call[] = []
  const sleeps: number[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const r = replies[Math.min(calls.length - 1, replies.length - 1)]
    if (r instanceof Error) throw r
    return r
  }) as unknown as typeof globalThis.fetch
  return {
    calls,
    sleeps,
    opts: (kind: NotifyPayloadKind = 'waiting', timeoutMs?: number) => ({
      target,
      payload: payloadOf(kind),
      vapid,
      subject: 'mailto:a@b.test',
      fetch,
      now: () => 1_000_000,
      sleep: async (ms: number) => {
        sleeps.push(ms)
      },
      timeoutMs
    })
  }
}
const res = (status: number, headers?: Record<string, string>) => new Response(null, { status, headers })

describe('topicOf', () => {
  it('is the first 32 chars of base64url(sha256(tag))', () => {
    const t = topicOf('chat:abc:waiting')
    expect(t).toBe(createHash('sha256').update('chat:abc:waiting').digest('base64url').slice(0, 32))
    expect(t).toMatch(/^[A-Za-z0-9_-]{1,32}$/)
  })
})

describe('pushOptions', () => {
  it('maps kinds to ttl and urgency', () => {
    expect(pushOptions('waiting')).toEqual({ ttl: 43_200, urgency: 'high' })
    expect(pushOptions('replied')).toEqual({ ttl: 3_600, urgency: 'normal' })
    expect(pushOptions('error')).toEqual({ ttl: 3_600, urgency: 'normal' })
    expect(pushOptions('routine-failed')).toEqual({ ttl: 3_600, urgency: 'normal' })
    expect(pushOptions('test')).toEqual({ ttl: 60, urgency: 'normal' })
    expect(pushOptions('paused')).toEqual({ ttl: 60, urgency: 'normal' })
  })
})

describe('sendPush request', () => {
  it('posts an encrypted body with the Web Push headers', async () => {
    const h = harness([res(201)])
    await sendPush(h.opts('waiting'))
    expect(h.calls).toHaveLength(1)
    const { url, init } = h.calls[0]
    expect(url).toBe(ENDPOINT)
    expect(init.method).toBe('POST')
    const hd = init.headers as Record<string, string>
    expect(hd['Content-Encoding']).toBe('aes128gcm')
    expect(hd['Content-Type']).toBe('application/octet-stream')
    expect(hd.TTL).toBe('43200')
    expect(hd.Urgency).toBe('high')
    expect(hd.Topic).toBe(topicOf('chat:abc:waiting'))
    expect(hd.Topic).toMatch(/^[A-Za-z0-9_-]{1,32}$/)
    expect(hd.Authorization.startsWith('vapid t=')).toBe(true)
    expect((init.body as Uint8Array).length).toBeGreaterThan(86)
  })

  it('uses the replied and test options', async () => {
    const a = harness([res(201)])
    await sendPush(a.opts('replied'))
    const ha = a.calls[0].init.headers as Record<string, string>
    expect([ha.TTL, ha.Urgency]).toEqual(['3600', 'normal'])
    const b = harness([res(201)])
    await sendPush(b.opts('test'))
    expect((b.calls[0].init.headers as Record<string, string>).TTL).toBe('60')
  })
})

describe('sendPush outcomes', () => {
  it.each([
    [201, 'sent'],
    [200, 'sent'],
    [404, 'gone'],
    [410, 'gone'],
    [413, 'failed'],
    [400, 'failed'],
    [401, 'failed']
  ])('status %i -> %s without retry', async (status, outcome) => {
    const h = harness([res(status)])
    const r = await sendPush(h.opts())
    expect(r).toEqual({ outcome, status })
    expect(h.calls).toHaveLength(1)
    expect(h.sleeps).toEqual([])
  })
})

describe('sendPush redirects and bodies', () => {
  it('asks fetch not to follow redirects', async () => {
    const h = harness([res(201)])
    await sendPush(h.opts())
    expect(h.calls[0].init.redirect).toBe('manual')
  })

  it.each([307, 308, 302])('a %i is failed with that status, once, never retried', async (status) => {
    const h = harness([new Response(null, { status, headers: { Location: 'https://elsewhere.example.test/x' } }), res(201)])
    const r = await sendPush(h.opts())
    expect(r).toEqual({ outcome: 'failed', status })
    expect(h.calls).toHaveLength(1)
    expect(h.sleeps).toEqual([])
  })

  it.each([
    [201, 'sent'],
    [410, 'gone']
  ])('cancels the response body on a %i', async (status, outcome) => {
    let cancelled = 0
    const fake = {
      status,
      headers: new Headers(),
      body: {
        cancel: () => {
          cancelled++
          return Promise.resolve()
        }
      }
    }
    const h = harness([fake as unknown as Response])
    expect((await sendPush(h.opts())).outcome).toBe(outcome)
    expect(cancelled).toBe(1)
  })
})

describe('sendPush retry', () => {
  it('retries a 429 once after Retry-After seconds', async () => {
    const h = harness([res(429, { 'Retry-After': '5' }), res(201)])
    expect(await sendPush(h.opts())).toEqual({ outcome: 'sent', status: 201 })
    expect(h.sleeps).toEqual([5000])
    expect(h.calls).toHaveLength(2)
  })

  it('gives up after two 503s', async () => {
    const h = harness([res(503), res(503)])
    expect(await sendPush(h.opts())).toEqual({ outcome: 'failed', status: 503 })
    expect(h.calls).toHaveLength(2)
    expect(h.sleeps).toEqual([1000])
  })

  it('caps the wait at 60 000 ms', async () => {
    const h = harness([res(429, { 'Retry-After': '999' }), res(201)])
    await sendPush(h.opts())
    expect(h.sleeps).toEqual([60_000])
  })

  it('reads an HTTP-date Retry-After against now()', async () => {
    const h = harness([res(503, { 'Retry-After': new Date(1_000_000 + 7000).toUTCString() }), res(201)])
    await sendPush(h.opts())
    expect(h.sleeps[0]).toBeGreaterThanOrEqual(6000)
    expect(h.sleeps[0]).toBeLessThanOrEqual(7000)
  })

  it('falls back to 1000 ms for an unreadable Retry-After', async () => {
    const h = harness([res(500, { 'Retry-After': 'soon' }), res(201)])
    await sendPush(h.opts())
    expect(h.sleeps).toEqual([1000])
  })

  it('maps a gone answer on the retry to gone', async () => {
    const h = harness([res(503), res(410)])
    expect(await sendPush(h.opts())).toEqual({ outcome: 'gone', status: 410 })
  })
})

describe('sendPush failures', () => {
  it('turns a network error into failed', async () => {
    const h = harness([new Error(`connect ECONNREFUSED ${ENDPOINT}`)])
    const r = await sendPush(h.opts())
    expect(r).toEqual({ outcome: 'failed', status: null })
    expect(h.calls).toHaveLength(1)
  })

  it('times out through an AbortSignal', async () => {
    let aborted = false
    const fetch = ((_url: string, init: RequestInit) =>
      new Promise((_, reject) => {
        init.signal!.addEventListener('abort', () => {
          aborted = true
          reject(new Error('aborted'))
        })
      })) as unknown as typeof globalThis.fetch
    const h = harness([res(201)])
    const r = await sendPush({ ...h.opts('waiting', 50), fetch })
    expect(r).toEqual({ outcome: 'failed', status: null })
    expect(aborted).toBe(true)
  })

  it('does not throw when the payload cannot be encrypted', async () => {
    const h = harness([res(201)])
    const big = { ...payloadOf(), title: 'x'.repeat(5000) }
    const r = await sendPush({ ...h.opts(), payload: big })
    expect(r).toEqual({ outcome: 'failed', status: null })
    expect(h.calls).toHaveLength(0)
  })

  it('does not throw on a malformed subscription key', async () => {
    const h = harness([res(201)])
    const r = await sendPush({ ...h.opts(), target: { ...target, p256dh: 'AAAA' } })
    expect(r.outcome).toBe('failed')
  })

  it('never leaks the endpoint', async () => {
    const cases = [res(201), res(404), res(503), new Error(`boom ${ENDPOINT}`)]
    for (const c of cases) {
      const h = harness([c, c])
      const r = await sendPush(h.opts())
      expect(JSON.stringify(r)).not.toContain('SECRET')
      expect(JSON.stringify(r)).not.toContain('push.example')
    }
  })
})
