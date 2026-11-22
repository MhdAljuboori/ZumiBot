// A fake Telegram Bot API on 127.0.0.1 for tests and e2e suites: getUpdates with real offset semantics (an offset confirms
// every lower update; a lower offset gets the unconfirmed ones again), the send and edit methods the server uses, files,
// and injected failures (429 with retry_after, 409, 401). No test reaches the real Telegram.
import { createServer } from 'node:http'

export const FAKE_TOKEN = '123456789:AAFakeTokenForTestsOnly_abcdefghijklmnop'
export const FAKE_BOT = { id: 123456789, is_bot: true, first_name: 'Test Bot', username: 'test_zumibot' }

/**
 * @returns {Promise<{
 *   origin: string,
 *   calls: { method: string, params: any, at: number }[],
 *   sent: () => any[],
 *   update: (u: object) => number,
 *   message: (from: number, text: string, extra?: object) => number,
 *   press: (from: number, msgId: number, data: string) => number,
 *   addFile: (id: string, bytes: Uint8Array) => void,
 *   failNext: (method: string, err: { code: number, retry_after?: number, description?: string }, times?: number) => void,
 *   waitFor: (pred: (c: { method: string, params: any }) => boolean, ms?: number) => Promise<{ method: string, params: any }>,
 *   close: () => Promise<void>
 * }>}
 */
export async function startFakeTelegram(o = {}) {
  const token = o.token ?? FAKE_TOKEN
  const calls = []
  const updates = []
  const files = new Map()
  const failures = new Map()
  const waiters = new Set()
  let nextUpdate = 1000
  let nextMsg = 1
  let confirmed = 0
  const pollers = new Set()

  const record = (method, params) => {
    const c = { method, params, at: Date.now() }
    calls.push(c)
    for (const w of [...waiters]) if (w.pred(c)) { waiters.delete(w); w.resolve(c) }
  }
  const pending = (offset) => updates.filter((u) => u.update_id >= offset)
  const wake = () => { for (const p of [...pollers]) p() }

  const answer = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const ok = (res, result) => answer(res, 200, { ok: true, result })

  const readBody = (req) => new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const file = /^\/file\/bot([^/]+)\/(.+)$/.exec(url.pathname)
    if (file) {
      if (file[1] !== token) return answer(res, 401, { ok: false, error_code: 401, description: 'Unauthorized' })
      const bytes = files.get(file[2])
      if (!bytes) return answer(res, 404, { ok: false, error_code: 404, description: 'Not Found' })
      res.writeHead(200, { 'content-length': String(bytes.length) })
      return res.end(Buffer.from(bytes))
    }
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(url.pathname)
    if (!m) return answer(res, 404, { ok: false, error_code: 404, description: 'Not Found' })
    if (m[1] !== token) return answer(res, 401, { ok: false, error_code: 401, description: 'Unauthorized' })
    const method = m[2]
    const raw = await readBody(req)
    let params = {}
    const type = String(req.headers['content-type'] ?? '')
    if (type.startsWith('application/json')) params = raw.length ? JSON.parse(String(raw)) : {}
    else if (type.startsWith('multipart/form-data')) {
      const form = await new Request('http://x', { method: 'POST', headers: { 'content-type': type }, body: raw }).formData()
      for (const [k, v] of form) params[k] = typeof v === 'string' ? v : { name: v.name, size: v.size, text: await v.text() }
    }
    const fail = failures.get(method)
    if (fail && fail.times > 0) {
      fail.times--
      record(method, { ...params, failed: fail.err.code })
      return answer(res, fail.err.code === 429 ? 429 : fail.err.code === 409 ? 409 : 400, {
        ok: false, error_code: fail.err.code, description: fail.err.description ?? `Error ${fail.err.code}`,
        ...(fail.err.retry_after ? { parameters: { retry_after: fail.err.retry_after } } : {})
      })
    }
    if (method !== 'getUpdates') record(method, params)
    switch (method) {
      case 'getMe':
        return ok(res, FAKE_BOT)
      case 'getUpdates': {
        const offset = Number(params.offset ?? 0)
        if (offset > confirmed) confirmed = offset
        const ready = pending(offset)
        if (ready.length > 0) return ok(res, ready.slice(0, 100))
        // Long poll: answer when an update arrives, or empty after a short wait (tests need no 25 s holds).
        const wait = Math.min(Number(params.timeout ?? 0), 2) * 1000
        let done = false
        const finish = () => {
          if (done) return
          done = true
          pollers.delete(finish)
          clearTimeout(timer)
          ok(res, pending(offset).slice(0, 100))
        }
        const timer = setTimeout(finish, wait)
        pollers.add(finish)
        req.on('close', () => { pollers.delete(finish); clearTimeout(timer) })
        return
      }
      case 'sendMessage':
      case 'sendDocument': {
        const message_id = nextMsg++
        // Synchronous after record(): this call is the last one recorded.
        calls[calls.length - 1].messageId = message_id
        return ok(res, { message_id, chat: { id: Number(params.chat_id), type: 'private' }, date: Math.floor(Date.now() / 1000), text: params.text })
      }
      case 'getFile':
        return files.has(`files/${params.file_id}`) ? ok(res, { file_id: params.file_id, file_size: files.get(`files/${params.file_id}`).length, file_path: `files/${params.file_id}` }) : answer(res, 400, { ok: false, error_code: 400, description: 'Bad Request: invalid file_id' })
      case 'sendMessageDraft':
      case 'sendChatAction':
      case 'setMyCommands':
      case 'answerCallbackQuery':
      case 'editMessageReplyMarkup':
      case 'editMessageText':
        return ok(res, true)
      default:
        return answer(res, 404, { ok: false, error_code: 404, description: 'Not Found: method not found' })
    }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${server.address().port}`

  const update = (u) => {
    const update_id = nextUpdate++
    updates.push({ update_id, ...u })
    wake()
    return update_id
  }
  const user = (id) => ({ id, is_bot: false, first_name: id === 1001 ? 'Owner' : 'Stranger' })

  return {
    origin,
    calls,
    sent: () => calls.filter((c) => c.method === 'sendMessage' && c.params.failed === undefined).map((c) => c.params),
    update,
    message: (from, text, extra = {}) => update({ message: { message_id: nextMsg++, from: user(from), chat: { id: from, type: 'private' }, date: 0, text, ...extra } }),
    press: (from, msgId, data) => update({ callback_query: { id: `cb${nextUpdate}`, from: user(from), message: { message_id: msgId, chat: { id: from, type: 'private' } }, data } }),
    addFile: (id, bytes) => files.set(`files/${id}`, bytes),
    failNext: (method, err, times = 1) => failures.set(method, { err, times }),
    waitFor: (pred, ms = 8000) => {
      const hit = calls.find(pred)
      if (hit) return Promise.resolve(hit)
      return new Promise((resolve, reject) => {
        const w = { pred, resolve }
        waiters.add(w)
        setTimeout(() => { if (waiters.delete(w)) reject(new Error('fake telegram: timed out waiting for a call')) }, ms)
      })
    },
    close: () => new Promise((r) => {
      for (const p of [...pollers]) p()
      server.closeAllConnections?.()
      server.close(() => r())
    })
  }
}
