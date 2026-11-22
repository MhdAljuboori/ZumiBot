import { createServer as createHttpsServer } from 'node:https'
import { createServer, type AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { AGUI_TEXT } from '@zumibot/shared/agui'
import { AGUI_LIMITS, postRun, type AguiLimits, type PostRunOptions } from '../../src/core/agui/aguiClient'
import { startFakeAgui, stopFakeAgui, type AguiStep } from '../support/fakeAgui'
import { selfSigned, withTlsCheckOff } from '../support/selfSigned'

afterEach(() => stopFakeAgui())

const BODY = JSON.stringify({ threadId: 't-1', runId: 'r-1', messages: [] })
const run = (o: Partial<PostRunOptions> & { url: string }, limits: Partial<AguiLimits> = {}) => {
  const data: string[] = []
  const controller = new AbortController()
  const result = postRun(
    {
      body: BODY,
      headers: { Authorization: 'Bearer sk-live-secret' },
      authKey: 'AGENT_KEY',
      allowLocal: true,
      limits: { ...AGUI_LIMITS, ...limits },
      signal: controller.signal,
      ...o
    },
    (d) => {
      data.push(d)
    }
  )
  return { result, data, controller }
}
const fake = (...requests: AguiStep[][]) => startFakeAgui(requests)
const types = (data: string[]) => data.map((d) => JSON.parse(d).type)
const refusedLookup = (address: string) => async () => [{ address, family: address.includes(':') ? 6 : 4 }]

describe('postRun', () => {
  it('POSTs the body with JSON in, an event stream out and the auth header, and hands over each data payload in order', async () => {
    const f = await fake([{ comment: 'keep-alive' }, { text: 'Hi' }, { finish: {} }])
    const { result, data } = run({ url: `${f.url}?q=1` })
    expect(await result).toEqual({ kind: 'ended' })
    expect(types(data)).toEqual(['RUN_STARTED', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END', 'RUN_FINISHED'])
    const [req] = f.requests()
    expect(req.path).toBe('/run')
    expect(req.query).toBe('?q=1')
    expect(req.body).toEqual(JSON.parse(BODY))
    expect(req.headers['content-type']).toBe('application/json')
    expect(req.headers.accept).toBe('text/event-stream')
    expect(req.headers.authorization).toBe('Bearer sk-live-secret')
    expect(req.headers['accept-encoding']).toBeUndefined()
  })

  it('keeps Accept and Content-Type its own whatever the headers say', async () => {
    const f = await fake([{ finish: {} }])
    await run({ url: f.url, headers: { 'X-Api-Key': 'v', accept: '*/*', 'content-type': 'text/plain' } }).result
    const [req] = f.requests()
    expect(req.headers.accept).toBe('text/event-stream')
    expect(req.headers['content-type']).toBe('application/json')
    expect(req.headers['x-api-key']).toBe('v')
  })

  it('connects to the checked address while Host keeps the name (pinning)', async () => {
    const f = await fake([{ finish: {} }])
    const asked: string[] = []
    const lookup = async (host: string) => {
      asked.push(host)
      return [{ address: '127.0.0.1', family: 4 }]
    }
    expect(await run({ url: `http://localhost:${f.port}/run`, lookup }).result).toEqual({ kind: 'ended' })
    expect(asked).toEqual(['localhost'])
    expect(f.requests()[0].headers.host).toBe(`localhost:${f.port}`)
  })

  it('never looks the name up again at connect: a checked address nothing listens on fails, though the name resolves', async () => {
    const f = await fake([{ finish: {} }])
    // The fake listens on 127.0.0.1 only; a fresh lookup of localhost would reach it. macOS routes no loopback address but
    // 127.0.0.1 (a connect to 127.0.0.2 hangs there), so it is ::1 on a Mac.
    const lookup = async () =>
      process.platform === 'darwin' ? [{ address: '::1', family: 6 }] : [{ address: '127.0.0.2', family: 4 }]
    const r = await run({ url: `http://localhost:${f.port}/run`, lookup }).result
    expect(r).toEqual({ kind: 'error', text: AGUI_TEXT.network(`localhost:${f.port}`, 'ECONNREFUSED'), unsent: true })
    expect(f.requests()).toEqual([])
  })

  describe('refused before anything is sent', () => {
    it('refuses an http endpoint without the dev hook', async () => {
      const f = await fake([{ finish: {} }])
      expect(await run({ url: f.url, allowLocal: false }).result).toEqual({ kind: 'error', text: AGUI_TEXT.endpointInvalid, unsent: true })
      expect(f.requests()).toEqual([])
    })

    it('refuses a name resolving to a private, loopback or mapped address, or a mixed answer', async () => {
      for (const address of ['10.0.0.1', '127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::7f00:1']) {
        expect(await run({ url: 'https://agent.example/run', allowLocal: false, lookup: refusedLookup(address) }).result).toEqual({
          kind: 'error',
          text: AGUI_TEXT.notPublic('agent.example'),
          unsent: true
        })
      }
      const mixed = async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '192.168.1.5', family: 4 }
      ]
      expect(await run({ url: 'https://agent.example/run', allowLocal: false, lookup: mixed }).result).toEqual({
        kind: 'error',
        text: AGUI_TEXT.notPublic('agent.example'),
        unsent: true
      })
    })

    it('names the host when the name does not resolve', async () => {
      const lookup = async () => {
        throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' })
      }
      expect(await run({ url: 'https://agent.example:8443/run?secret=1', allowLocal: false, lookup }).result).toEqual({
        kind: 'error',
        text: AGUI_TEXT.resolveFailed('agent.example:8443'),
        unsent: true
      })
    })

    it('bounds the name lookup by the connect time', async () => {
      const lookup = () => new Promise<never>(() => {})
      const started = Date.now()
      expect(await run({ url: 'https://agent.example/run', allowLocal: false, lookup }, { connectMs: 150 }).result).toEqual({
        kind: 'error',
        text: AGUI_TEXT.connectTimeout('agent.example'),
        unsent: true
      })
      expect(Date.now() - started).toBeLessThan(2000)
    })

    it('says a refused connection with the host and the code only', async () => {
      const port = await freePort()
      const r = await run({ url: `http://127.0.0.1:${port}/run?q=secret` }).result
      expect(r).toEqual({ kind: 'error', text: AGUI_TEXT.network(`127.0.0.1:${port}`, 'ECONNREFUSED'), unsent: true })
    })

    it('a header value Node refuses sends nothing, and the sentence never holds the value', async () => {
      const f = await fake([{ finish: {} }])
      const r = await run({ url: f.url, headers: { Authorization: 'Bearer sk-live\nsecret' } }).result
      expect(r).toEqual({ kind: 'error', text: AGUI_TEXT.network(`127.0.0.1:${f.port}`, 'ERR_INVALID_CHAR'), unsent: true })
      expect(JSON.stringify(r)).not.toContain('sk-live')
      expect(f.requests()).toEqual([])
    })

    it('ends at once on a signal already aborted', async () => {
      const f = await fake([{ finish: {} }])
      const controller = new AbortController()
      controller.abort()
      expect(await run({ url: f.url, signal: controller.signal }).result).toEqual({ kind: 'ended' })
      expect(f.requests()).toEqual([])
    })
  })

  describe('error statuses (never their body)', () => {
    it('a 401 or 403 names the auth key and never shows the body that echoes it', async () => {
      for (const code of [401, 403]) {
        const f = await fake([{ status: { code, body: 'bad token sk-live-secret' } }])
        const r = await run({ url: f.url }).result
        expect(r).toEqual({ kind: 'error', text: AGUI_TEXT.unauthorized(code, 'AGENT_KEY'), status: code })
        expect(JSON.stringify(r)).not.toContain('sk-live-secret')
      }
    })

    it('a 401 with no key configured asks for one', async () => {
      const f = await fake([{ status: { code: 401, body: 'who are you' } }])
      expect(await run({ url: f.url, headers: {}, authKey: null }).result).toEqual({
        kind: 'error',
        text: AGUI_TEXT.unauthorized(401, null),
        status: 401
      })
    })

    it('any other status shows the status only, however long its body', async () => {
      const f = await fake([{ status: { code: 500, body: 'x'.repeat(100_000) } }])
      expect(await run({ url: f.url }, { errorBodyBytes: 64 }).result).toEqual({ kind: 'error', text: AGUI_TEXT.status(500), status: 500 })
    })

    it('stops reading an error body at its cap, though the server keeps it open', async () => {
      const f = await fake([{ status: { code: 422, body: 'x'.repeat(5000), hold: true } }])
      const started = Date.now()
      expect(await run({ url: f.url }, { idleMs: 3000 }).result).toEqual({ kind: 'error', text: AGUI_TEXT.status(422), status: 422 })
      expect(Date.now() - started).toBeLessThan(2000)
      await waitFor(() => f.log().some((e) => e.abort === 0))
    })

    it('a 200 that is not an event stream is refused', async () => {
      const f = await fake([{ contentType: 'application/json' }, { finish: {} }])
      const { result, data } = run({ url: f.url })
      expect(await result).toEqual({ kind: 'error', text: AGUI_TEXT.notSse })
      expect(data).toEqual([])
    })

    it('reads an event stream content type with parameters', async () => {
      const f = await fake([{ contentType: 'Text/Event-Stream; charset=utf-8' }, { finish: {} }])
      expect(await run({ url: f.url }).result).toEqual({ kind: 'ended' })
    })
  })

  describe('redirects', () => {
    it('refuses a 303 (and a 301 or 302), even to the same origin', async () => {
      for (const status of [301, 302, 303]) {
        const f = await fake([{ redirect: { status, location: '/next' } }], [{ finish: {} }])
        expect(await run({ url: f.url }).result).toEqual({ kind: 'error', text: AGUI_TEXT.redirected })
        expect(f.requests()).toHaveLength(1)
      }
    })

    it('follows a same-origin 307 or 308 with the same body and headers', async () => {
      for (const status of [307, 308]) {
        const f = await fake([{ redirect: { status, location: '/next?x=2' } }], [{ text: 'moved' }, { finish: {} }])
        const { result, data } = run({ url: f.url })
        expect(await result).toEqual({ kind: 'ended' })
        expect(types(data)).toContain('RUN_FINISHED')
        const [first, second] = f.requests()
        expect([first.path, second.path, second.query]).toEqual(['/run', '/next', '?x=2'])
        expect(second.body).toEqual(first.body)
        expect(second.headers.authorization).toBe('Bearer sk-live-secret')
      }
    })

    it('never reaches another host on a cross-host 307', async () => {
      const other = await fake([{ finish: {} }])
      const f = await fake([{ redirect: { status: 307, location: `http://localhost:${other.port}/run` } }])
      expect(await run({ url: f.url }).result).toEqual({ kind: 'error', text: AGUI_TEXT.redirected })
      const elsewhere = await fake([{ redirect: { status: 307, location: `${other.url}` } }])
      expect(await run({ url: elsewhere.url }).result).toEqual({ kind: 'error', text: AGUI_TEXT.redirected })
      expect(other.requests()).toEqual([])
    })

    it('checks the address of a same-origin hop again before it connects', async () => {
      const f = await fake([{ redirect: { status: 307, location: '/next' } }], [{ finish: {} }])
      // The name answers the fake first, then a private address (not loopback, which plain http needs under the dev hook).
      const answers = ['127.0.0.1', '10.0.0.1']
      const lookup = async () => [{ address: answers.shift()!, family: 4 }]
      expect(await run({ url: `http://localhost:${f.port}/run`, lookup }).result).toEqual({
        kind: 'error',
        text: AGUI_TEXT.notPublic(`localhost:${f.port}`)
      })
      expect(answers).toEqual([])
      expect(f.requests()).toHaveLength(1)
    })

    it('follows at most the cap of redirects', async () => {
      const f = await fake([{ redirect: { status: 307, location: '/again' } }])
      expect(await run({ url: f.url }, { redirects: 2 }).result).toEqual({ kind: 'error', text: AGUI_TEXT.redirected })
      expect(f.requests()).toHaveLength(3)
    })
  })

  describe('timeouts and caps', () => {
    it('ends a response whose headers do not come in time', async () => {
      const f = await fake([{ sleep: 2000 }, { finish: {} }])
      expect(await run({ url: f.url }, { headersMs: 150 }).result).toEqual({ kind: 'error', text: AGUI_TEXT.headersTimeout })
      await waitFor(() => f.log().some((e) => e.abort === 0))
    })

    it('ends a stream that sends nothing for the idle time', async () => {
      const f = await fake([{ text: 'Hi' }, { hold: true }])
      const { result, data } = run({ url: f.url }, { idleMs: 150 })
      expect(await result).toEqual({ kind: 'error', text: AGUI_TEXT.idleTimeout })
      expect(types(data)).toEqual(['RUN_STARTED', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END'])
    })

    it('counts keep-alive comments as bytes', async () => {
      const drip = Array.from({ length: 6 }, () => [{ sleep: 60 }, { comment: 'keep-alive' }]).flat()
      const f = await fake([{ text: 'Hi' }, ...drip, { finish: {} }])
      expect(await run({ url: f.url }, { idleMs: 200 }).result).toEqual({ kind: 'ended' })
    })

    it('ends a run past its whole time, even one that keeps dripping', async () => {
      const drip = Array.from({ length: 40 }, () => [{ sleep: 25 }, { comment: 'keep-alive' }]).flat()
      const f = await fake([{ text: 'Hi' }, ...drip, { finish: {} }])
      expect(await run({ url: f.url }, { runMs: 300 }).result).toEqual({ kind: 'error', text: AGUI_TEXT.runTimeout })
    })

    it('ends a body over its cap', async () => {
      const f = await fake([...Array.from({ length: 50 }, () => ({ text: 'some reply text' })), { finish: {} }])
      expect(await run({ url: f.url }, { bodyBytes: 2048 }).result).toEqual({ kind: 'error', text: AGUI_TEXT.bodyTooBig })
    })

    it('ends on one event over its cap', async () => {
      const f = await fake([{ text: 'Hi' }, { oversize: 4096 }, { finish: {} }])
      const { result, data } = run({ url: f.url }, { eventBytes: 1024 })
      expect(await result).toEqual({ kind: 'error', text: AGUI_TEXT.eventTooBig })
      expect(types(data)).not.toContain('RUN_FINISHED')
    })
  })

  describe('the end of the body', () => {
    it('a body that ends is ended, whatever it held: the runner judges the events', async () => {
      const f = await fake([{ text: 'Hi' }, { cut: true }])
      expect(await run({ url: f.url }).result).toEqual({ kind: 'ended' })
    })

    it('drops a last event with no blank line after it, as the SSE rules say', async () => {
      const f = await fake([{ text: 'Hi' }, { finish: {}, open: true }])
      const { result, data } = run({ url: f.url })
      expect(await result).toEqual({ kind: 'ended' })
      expect(types(data)).not.toContain('RUN_FINISHED')
    })

    it('a connection reset in the middle of the body is a cut', async () => {
      const f = await fake([{ text: 'Hi' }, { sleep: 50 }, { cut: 'reset' }])
      expect(await run({ url: f.url }).result).toEqual({ kind: 'error', text: AGUI_TEXT.cut })
    })

    it('an abort ends the request at once, and the server sees the client go', async () => {
      const f = await fake([{ text: 'Hi' }, { hold: true }])
      const { result, controller, data } = run({ url: f.url })
      await waitFor(() => data.length >= 4)
      controller.abort()
      expect(await result).toEqual({ kind: 'ended' })
      await waitFor(() => f.log().some((e) => e.abort === 0))
    })

    it('stops handing over payloads once the callback aborts, even within one chunk', async () => {
      const f = await fake([{ text: 'Hi' }, { finish: {} }])
      const seen: string[] = []
      const controller = new AbortController()
      const r = await postRun(
        {
          url: f.url,
          body: BODY,
          headers: {},
          authKey: null,
          allowLocal: true,
          limits: AGUI_LIMITS,
          signal: controller.signal
        },
        (d) => {
          seen.push(d)
          if (seen.length === 2) controller.abort()
        }
      )
      expect(r).toEqual({ kind: 'ended' })
      expect(seen).toHaveLength(2)
    })
  })
})

describe('postRun over TLS', () => {
  // Node's default verification, asked for in the request itself, so an env var cannot turn it off for a run.
  it('refuses a self-signed certificate even with NODE_TLS_REJECT_UNAUTHORIZED=0, and the server sees no request', async () => {
    const cert = selfSigned()
    if (cert === null) return
    let requests = 0
    const server = createHttpsServer(cert, (_req, res) => {
      requests++
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end()
    })
    server.on('tlsClientError', () => {})
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const port = (server.address() as AddressInfo).port
      const lookup = async () => [{ address: '127.0.0.1', family: 4 }]
      const r = await withTlsCheckOff(() => run({ url: `https://agent.test:${port}/run`, lookup }).result)
      expect(r).toEqual({
        kind: 'error',
        unsent: true,
        text: expect.stringMatching(
          /^The connection to agent\.test:\d+ failed \((DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE)\)\.$/
        )
      })
      expect(requests).toBe(0)
    } finally {
      await new Promise((r) => server.close(r))
    }
    // openssl makes an RSA key first, which takes seconds on a busy Windows runner.
  }, 30_000)
})

async function freePort(): Promise<number> {
  const s = createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
  const port = (s.address() as { port: number }).port
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

async function waitFor(ok: () => boolean, ms = 3000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (ok()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  expect(ok()).toBe(true)
}
