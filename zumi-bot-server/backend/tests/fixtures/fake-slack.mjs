// A fake Slack on 127.0.0.1 for tests and e2e suites: the Web API methods the server uses, a Socket Mode WebSocket that
// sends envelopes (events and button presses) and records acks, file download and upload, and injected failures (429 with
// Retry-After, an error code). No test reaches the real Slack.
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'

export const FAKE_BOT_TOKEN = 'xoxb-1111111111-2222222222-fakeBotTokenForTests'
export const FAKE_APP_TOKEN = 'xapp-1-A0FAKE-3333333333-fakeAppTokenForTests'
export const TEAM = 'T0TEAM'
export const BOT_USER = 'U0BOT'

/**
 * @returns {Promise<import('./fake-slack.d.mts').FakeSlack>}
 */
export async function startFakeSlack() {
  const calls = []
  const acks = new Set()
  const sockets = new Set()
  const files = new Map()
  const failures = new Map()
  const waiters = new Set()
  let n = 0
  let ts = 1_700_000_000
  const names = new Map([['U0OWNER', 'Owner'], ['U0OTHER', 'Someone Else']])

  const record = (method, params, extra = {}) => {
    const c = { method, params, at: Date.now(), ...extra }
    calls.push(c)
    for (const w of [...waiters]) if (w.pred(c)) { waiters.delete(w); w.resolve(c) }
    return c
  }
  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  }
  const readBody = (req) => new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const raw = await readBody(req)
    const auth = String(req.headers.authorization ?? '')
    if (url.pathname.startsWith('/files/')) {
      if (auth !== `Bearer ${FAKE_BOT_TOKEN}`) return json(res, 403, { ok: false })
      const bytes = files.get(url.pathname.slice('/files/'.length))
      if (!bytes) return json(res, 404, { ok: false })
      res.writeHead(200, { 'content-length': String(bytes.length) })
      return res.end(Buffer.from(bytes))
    }
    if (url.pathname.startsWith('/upload/')) {
      record('upload', { id: url.pathname.slice('/upload/'.length), size: raw.length })
      res.writeHead(200)
      return res.end('OK')
    }
    const m = /^\/api\/([\w.]+)$/.exec(url.pathname)
    if (!m) return json(res, 404, { ok: false, error: 'unknown_method' })
    const method = m[1]
    const type = String(req.headers['content-type'] ?? '')
    const params = type.startsWith('application/json') ? (raw.length ? JSON.parse(String(raw)) : {}) : Object.fromEntries(new URLSearchParams(String(raw)))
    const fail = failures.get(method)
    if (fail && fail.times > 0) {
      fail.times--
      record(method, { ...params, failed: fail.err.status ?? fail.err.error })
      if (fail.err.status === 429) return json(res, 429, { ok: false, error: 'ratelimited' }, { 'retry-after': String(fail.err.retryAfter ?? 1) })
      return json(res, 200, { ok: false, error: fail.err.error ?? 'fatal_error' })
    }
    const app = method === 'apps.connections.open'
    if (auth !== `Bearer ${app ? FAKE_APP_TOKEN : FAKE_BOT_TOKEN}`) {
      record(method, { ...params, failed: 'invalid_auth' })
      return json(res, 200, { ok: false, error: auth.startsWith('Bearer xox') || auth.startsWith('Bearer xapp') ? 'invalid_auth' : 'not_authed' })
    }
    switch (method) {
      case 'auth.test':
        record(method, params)
        return json(res, 200, { ok: true, user_id: BOT_USER, team_id: TEAM, user: 'zumibot', team: 'Test Team' })
      case 'apps.connections.open':
        record(method, params)
        return json(res, 200, { ok: true, url: `ws://127.0.0.1:${server.address().port}/socket?ticket=${++n}` })
      case 'chat.postMessage': {
        const t = `${++ts}.000100`
        record(method, params, { ts: t })
        return json(res, 200, { ok: true, channel: params.channel, ts: t })
      }
      case 'users.info':
        record(method, params)
        return json(res, 200, { ok: true, user: { id: params.user, profile: { display_name: names.get(params.user) ?? params.user } } })
      case 'files.getUploadURLExternal': {
        const id = `F${++n}`
        record(method, params)
        return json(res, 200, { ok: true, upload_url: `http://127.0.0.1:${server.address().port}/upload/${id}`, file_id: id })
      }
      case 'chat.update':
      case 'chat.postEphemeral':
      case 'files.completeUploadExternal':
        record(method, params)
        return json(res, 200, { ok: true })
      default:
        record(method, params)
        return json(res, 200, { ok: false, error: 'unknown_method' })
    }
  })

  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/socket')) return socket.destroy()
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws)
      ws.on('close', () => sockets.delete(ws))
      ws.on('message', (d) => {
        try {
          const m = JSON.parse(String(d))
          if (m.envelope_id) {
            acks.add(m.envelope_id)
            record('ack', { envelope_id: m.envelope_id })
          }
        } catch { /* not json */ }
      })
      ws.send(JSON.stringify({ type: 'hello', num_connections: 1 }))
      record('socket', { connected: true })
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${server.address().port}`

  const send = (env) => {
    for (const ws of sockets) ws.send(JSON.stringify(env))
    return env.envelope_id
  }
  const nextTs = () => `${++ts}.000200`

  return {
    origin,
    calls,
    acks,
    posts: () => calls.filter((c) => c.method === 'chat.postMessage' && c.params.failed === undefined),
    connected: () => sockets.size > 0,
    /** An events_api envelope; `eventId` repeats an event (a redelivery). Returns the envelope id. */
    event: (event, o = {}) => send({ envelope_id: `env-${++n}`, type: 'events_api', accepts_response_payload: false, retry_attempt: o.retry ?? 0, payload: { team_id: TEAM, event_id: o.eventId ?? `Ev${++n}`, event } }),
    /** A message in the user's DM with the bot (channel `D<user>`). */
    dm: (user, text, extra = {}) => {
      const t = nextTs()
      return { ts: t, env: send({ envelope_id: `env-${++n}`, type: 'events_api', payload: { team_id: TEAM, event_id: `Ev${++n}`, event: { type: 'message', channel: `D${user}`, channel_type: 'im', user, text, ts: t, ...extra } } }) }
    },
    /** A message in a channel; `thread` puts it in that thread. */
    say: (user, channel, text, thread, extra = {}) => {
      const t = nextTs()
      return { ts: t, env: send({ envelope_id: `env-${++n}`, type: 'events_api', payload: { team_id: TEAM, event_id: `Ev${++n}`, event: { type: 'message', channel, channel_type: 'channel', user, text, ts: t, ...(thread ? { thread_ts: thread } : {}), ...extra } } }) }
    },
    /** A button press on a message the bot posted. */
    press: (user, channel, messageTs, value, thread) => send({
      envelope_id: `env-${++n}`, type: 'interactive',
      payload: { type: 'block_actions', user: { id: user, team_id: TEAM }, team: { id: TEAM }, channel: { id: channel }, message: { ts: messageTs, ...(thread ? { thread_ts: thread } : {}) }, actions: [{ action_id: 'b0_0', value }] }
    }),
    disconnect: () => { for (const ws of sockets) ws.send(JSON.stringify({ type: 'disconnect', reason: 'refresh_requested' })) },
    addFile: (id, bytes) => files.set(id, bytes),
    fileUrl: (id) => `${origin}/files/${id}`,
    failNext: (method, err, times = 1) => failures.set(method, { err, times }),
    waitFor: (pred, ms = 8000) => {
      const hit = calls.find(pred)
      if (hit) return Promise.resolve(hit)
      return new Promise((resolve, reject) => {
        const w = { pred, resolve }
        waiters.add(w)
        // The predicate's source names which wait timed out, since the stack of a timer callback does not.
        setTimeout(() => {
          if (!waiters.delete(w)) return
          // The last calls too: what did arrive tells a slow run from a missing one.
          const recent = calls.slice(-6).map((c) => `${c.method} ${String(c.params?.text ?? '').slice(0, 60)}`).join(' | ')
          reject(new Error(`fake slack: timed out waiting for a call: ${String(pred).replace(/\s+/g, ' ').slice(0, 200)}; last calls: ${recent}`))
        }, ms)
      })
    },
    close: () => new Promise((r) => {
      for (const ws of sockets) ws.terminate()
      wss.close()
      server.closeAllConnections?.()
      server.close(() => r())
    })
  }
}
