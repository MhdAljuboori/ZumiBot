import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { LookupAddress } from 'node:dns'
import type { AddressInfo } from 'node:net'
import { HTTP_NOT_PUBLIC, HTTP_NOT_RESOLVED, HTTP_NOT_TEXT, HTTP_STOPPED, HTTP_TOO_BIG, httpCall } from '../../src/core/workflows/httpCalls'

let server: Server
let other: Server
let base: string
let otherBase: string
const seen: { url: string; method: string; auth?: string; body: string }[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => {
      body += c.toString()
    })
    req.on('end', () => {
      seen.push({
        url: req.url ?? '',
        method: req.method ?? '',
        ...(req.headers.authorization ? { auth: req.headers.authorization } : {}),
        body
      })
      const url = req.url ?? ''
      if (url === '/json') {
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end('{"a":[1,2]}')
      } else if (url === '/same') {
        res.statusCode = 302
        res.setHeader('location', '/json')
        res.end()
      } else if (url === '/see-other') {
        res.statusCode = 303
        res.setHeader('location', '/echo')
        res.end()
      } else if (url === '/again') {
        res.statusCode = 307
        res.setHeader('location', '/json')
        res.end()
      } else if (url === '/away') {
        res.statusCode = 302
        res.setHeader('location', `${otherBase}/steal`)
        res.end()
      } else if (url === '/missing') {
        res.statusCode = 404
        res.end('nope')
      } else if (url === '/big') {
        res.end('x'.repeat(60_000))
      } else if (url === '/huge') {
        res.end(Buffer.alloc(2 * 1024 * 1024, 120))
      } else if (url === '/binary') {
        res.end(Buffer.from([1, 0, 2]))
      } else if (url === '/slow') {
        setTimeout(() => res.end('late'), 500)
      } else res.end(`${req.method} ${body}`)
    })
  })
  other = createServer((req, res) => {
    seen.push({
      url: `other${req.url}`,
      method: req.method ?? '',
      ...(req.headers.authorization ? { auth: req.headers.authorization } : {}),
      body: ''
    })
    res.end('stolen')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  await new Promise<void>((r) => other.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  otherBase = `http://127.0.0.1:${(other.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise((r) => server.close(r))
  await new Promise((r) => other.close(r))
})

const call = (
  path: string,
  over: Partial<Parameters<typeof httpCall>[0]> = {},
  signal = new AbortController().signal,
  timeoutMs?: number
) => httpCall({ method: 'GET', url: `${base}${path}`, headers: [], allowLocal: true, ...over }, signal, timeoutMs ? { timeoutMs } : {})

describe('httpCall', () => {
  it('pretty-prints a JSON answer and sends the body', async () => {
    expect(await call('/json')).toEqual({ ok: true, status: 200, body: '{\n  "a": [\n    1,\n    2\n  ]\n}' })
    expect(await call('/echo', { method: 'POST', body: 'hi' })).toEqual({ ok: true, status: 200, body: 'POST hi' })
  })

  it('follows a same-origin redirect, and a 303 turns into a GET', async () => {
    expect(await call('/same')).toMatchObject({ ok: true, status: 200 })
    expect(await call('/see-other', { method: 'POST', body: 'x' })).toEqual({ ok: true, status: 200, body: 'GET ' })
  })

  it('never follows a redirect to another host with the headers', async () => {
    seen.length = 0
    const r = await call('/away', { headers: [['Authorization', 'Bearer k']] })
    expect(r).toMatchObject({ ok: true, status: 302 })
    expect(seen.some((s) => s.url.startsWith('other'))).toBe(false)
  })

  it('fails an error status with its body', async () => {
    expect(await call('/missing')).toEqual({ ok: false, error: 'HTTP 404', status: 404, body: 'nope' })
  })

  it('refuses an answer past the caps, or one that is not text', async () => {
    expect(await call('/big')).toMatchObject({ ok: false, error: HTTP_TOO_BIG })
    expect(await call('/huge')).toMatchObject({ ok: false, error: HTTP_TOO_BIG })
    expect(await call('/binary')).toMatchObject({ ok: false, error: HTTP_NOT_TEXT })
  })

  it('times out, stops, and names only an error code for a refused connection', async () => {
    expect(await call('/slow', {}, new AbortController().signal, 50)).toEqual({ ok: false, error: 'The request timed out after 60 s' })
    const ac = new AbortController()
    const p = call('/slow', {}, ac.signal)
    ac.abort()
    expect(await p).toEqual({ ok: false, error: HTTP_STOPPED })
    const r = await httpCall(
      { method: 'GET', url: 'http://127.0.0.1:1/x?token=secret', headers: [], allowLocal: true },
      new AbortController().signal
    )
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r)).not.toContain('secret')
  })
})

// A DNS answer without the network: the name is made up, so a connection that reaches the test server used the checked address.
const answer =
  (...addresses: string[]) =>
  async (): Promise<LookupAddress[]> =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))

describe('httpCall address guard', () => {
  const port = () => new URL(base).port
  const at = (host: string, path: string) => `http://${host}:${port()}${path}`

  it('refuses loopback, private, link-local and metadata by default, before any request', async () => {
    seen.length = 0
    for (const url of [
      `${base}/json`,
      'http://10.0.0.1/x',
      'http://192.168.1.1/x',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/x',
      'http://[::ffff:127.0.0.1]/x'
    ]) {
      expect(await httpCall({ method: 'GET', url, headers: [] }, new AbortController().signal)).toEqual({
        ok: false,
        error: HTTP_NOT_PUBLIC
      })
    }
    expect(
      await httpCall({ method: 'GET', url: at('rebind.test', '/json'), headers: [] }, new AbortController().signal, {
        lookup: answer('127.0.0.1')
      })
    ).toEqual({ ok: false, error: HTTP_NOT_PUBLIC })
    // A mixed answer is refused: the connection could pick either.
    expect(
      await httpCall({ method: 'GET', url: at('mixed.test', '/json'), headers: [] }, new AbortController().signal, {
        lookup: answer('8.8.8.8', '127.0.0.1')
      })
    ).toEqual({ ok: false, error: HTTP_NOT_PUBLIC })
    expect(seen).toEqual([])
  })

  it('never reaches link-local or reserved, even with the local network allowed', async () => {
    for (const url of ['http://169.254.169.254/latest/meta-data', 'http://0.0.0.0/x', 'http://[fe80::1]/x']) {
      expect(await httpCall({ method: 'GET', url, headers: [], allowLocal: true }, new AbortController().signal)).toEqual({
        ok: false,
        error: HTTP_NOT_PUBLIC
      })
    }
  })

  it('connects to the checked address, resolving once per hop', async () => {
    const asked: string[] = []
    const lookup = async (h: string): Promise<LookupAddress[]> => {
      asked.push(h)
      return [{ address: '127.0.0.1', family: 4 }]
    }
    const r = await httpCall({ method: 'GET', url: at('nas.test', '/same'), headers: [], allowLocal: true }, new AbortController().signal, {
      lookup
    })
    expect(r).toMatchObject({ ok: true, status: 200 })
    expect(asked).toEqual(['nas.test', 'nas.test'])
  })

  it('checks a same-origin redirect again, so a second answer cannot move it to a local address', async () => {
    let n = 0
    // The first hop is allowed here only to reach the test server; the guard is the same on every hop.
    const lookup = async (): Promise<LookupAddress[]> => [{ address: n++ === 0 ? '127.0.0.1' : '169.254.169.254', family: 4 }]
    expect(
      await httpCall({ method: 'GET', url: at('flip.test', '/again'), headers: [], allowLocal: true }, new AbortController().signal, {
        lookup
      })
    ).toEqual({ ok: false, error: HTTP_NOT_PUBLIC })
  })

  it('a name that does not resolve is a fixed sentence', async () => {
    const failing = async (): Promise<LookupAddress[]> => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND secret.test'), { code: 'ENOTFOUND' })
    }
    expect(
      await httpCall({ method: 'GET', url: 'https://secret.test/x', headers: [] }, new AbortController().signal, { lookup: failing })
    ).toEqual({ ok: false, error: HTTP_NOT_RESOLVED })
  })
})
