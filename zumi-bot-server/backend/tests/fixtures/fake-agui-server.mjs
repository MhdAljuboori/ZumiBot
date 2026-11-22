// Fake AG-UI 1.0 server for tests: plain HTTP on 127.0.0.1 only (a run reaches it under the dev hook), one SSE response per
// POST. It prints `FAKE_AGUI_PORT=<n>` first, and exits when its stdin closes (its parent is gone) or on SIGTERM, so no test
// leaves it running.
//
// FAKE_AGUI_SCRIPT: inline JSON (starting with `{`) or a path to a JSON file, read again for each request:
//   {requests: Step[][]}. Request i (counted from 0 since start) plays entry i; past the end the last entry repeats.
//   The strings "$threadId" and "$runId" anywhere in a step become the request's own.
//   Our RUN_STARTED {threadId, runId} goes out right before the first step that writes an event of our run, unless the
//   request has a `raw` RUN_STARTED of its own (then the script writes it where it wants, or never).
// Steps, in order:
//   events
//     {raw: event}                       the event as given
//     {text: string, id?}                TEXT_MESSAGE_START / _CONTENT / _END (id default `msg-<n>`)
//     {reasoning: string, id?}           REASONING_START, REASONING_MESSAGE_START / _CONTENT / _END, REASONING_END
//     {tool: {id, name, args, result?, parent?}}  TOOL_CALL_START / _ARGS / _END, then TOOL_CALL_RESULT when `result` is set
//                                        (`args` an object is sent as its JSON, a string as is)
//     {state: {snapshot} | {delta}}      STATE_SNAPSHOT or STATE_DELTA
//     an event step with `open: true`    its last line goes out with no blank line after it, so that event never completes
//   A step's events go out in one write.
//   endings
//     {finish: {outcome?, usage?}}       our RUN_FINISHED
//     {error: {message, code?}}          RUN_ERROR
//     {lateError: {message, code?}, ms?} RUN_ERROR after `ms` (default 0), meant to follow `finish`
//     {cut: true | 'reset'}              ends the response at once with no terminal event; 'reset' destroys the socket instead
//     {replay: {text?}}                  a whole run under another run id (`replay-<i>`): RUN_STARTED, a text, RUN_FINISHED
//   faults
//     {malformed: true | 'json'}         a known event with a field of the wrong type, or a data line that is not JSON
//     {oversize: bytes}                  one TEXT_MESSAGE_CONTENT whose delta is that many bytes
//     {comment: text?}                   a comment line (`: keep-alive` by default)
//     {sleep: ms}
//     {hold: true}                       writes nothing more and never ends, until the client goes
//   HTTP (before any event)
//     {status: {code, body?, hold?}}     answers with that status and body, and ends (with `hold`, never ends)
//     {redirect: {status, location}}     answers with that status and Location, and ends
//     {contentType: string}              the 200's Content-Type (default text/event-stream)
// After the last step the response ends.
// FAKE_AGUI_LOG: appends {path, query, headers, body} per request (body parsed when it is JSON), and {abort: i} when request
//   i's client goes before its response ended.
import { appendFileSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'

const LOG = process.env.FAKE_AGUI_LOG
const log = (entry) => { if (LOG) appendFileSync(LOG, JSON.stringify(entry) + '\n') }

function readScript() {
  const raw = process.env.FAKE_AGUI_SCRIPT ?? ''
  const text = raw.trimStart().startsWith('{') ? raw : raw ? readFileSync(raw, 'utf8') : '{}'
  const s = JSON.parse(text)
  return Array.isArray(s.requests) && s.requests.length > 0 ? s.requests : [[]]
}

// Whole strings only: "$threadId" and "$runId" become the request's own.
function fill(v, ids) {
  if (v === '$threadId') return ids.threadId
  if (v === '$runId') return ids.runId
  if (Array.isArray(v)) return v.map((x) => fill(x, ids))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, ids)]))
  return v
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// Steps that write an event of our run, so our RUN_STARTED goes out before them.
const OURS = ['raw', 'text', 'reasoning', 'tool', 'state', 'finish', 'error', 'lateError', 'malformed', 'oversize']

let count = 0
let messages = 0

const server = createServer(async (req, res) => {
  const i = count++
  const chunks = []
  for await (const c of req) chunks.push(c)
  const text = Buffer.concat(chunks).toString('utf8')
  let body
  try { body = JSON.parse(text) } catch { body = text }
  const u = new URL(req.url ?? '/', 'http://fake')
  log({ path: u.pathname, query: u.search, headers: req.headers, body })

  let selfCut = false
  res.on('error', () => {})
  res.on('close', () => { if (!res.writableFinished && !selfCut) log({ abort: i }) })
  const gone = () => res.destroyed || res.writableEnded

  const requests = readScript()
  const ids = { threadId: body?.threadId, runId: body?.runId }
  const steps = fill(requests[Math.min(i, requests.length - 1)] ?? [], ids)
  const autoStart = !steps.some((s) => s.raw?.type === 'RUN_STARTED')
  let started = false
  let contentType = 'text/event-stream'

  const head = () => { if (!res.headersSent) res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-cache' }) }
  const write = (s) => { head(); res.write(s) }
  const frame = (e, open = false) => `data: ${JSON.stringify(e)}\n${open ? '' : '\n'}`
  const send = (e, open = false) => write(frame(e, open))
  // A step's events in one write, so a client reads several in one chunk; the last is left open when the step says so.
  const sendAll = (events, open) => write(events.map((e, n) => frame(e, open && n === events.length - 1)).join(''))
  const ours = () => {
    if (!autoStart || started) return
    started = true
    send({ type: 'RUN_STARTED', threadId: ids.threadId, runId: ids.runId })
  }

  for (const s of steps) {
    if (gone()) return
    if (OURS.some((k) => k in s)) ours()
    const open = s.open === true
    if ('status' in s) {
      res.writeHead(s.status.code, { 'content-type': 'text/plain' })
      if (!s.status.hold) return res.end(s.status.body ?? '')
      res.write(s.status.body ?? '')
      return
    }
    if ('redirect' in s) {
      res.writeHead(s.redirect.status, { location: s.redirect.location })
      return res.end()
    }
    if ('contentType' in s) contentType = s.contentType
    else if ('raw' in s) sendAll([s.raw], open)
    else if ('text' in s) {
      const messageId = s.id ?? `msg-${messages++}`
      sendAll([
        { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: s.text },
        { type: 'TEXT_MESSAGE_END', messageId }
      ], open)
    } else if ('reasoning' in s) {
      const messageId = s.id ?? `msg-${messages++}`
      sendAll([
        { type: 'REASONING_START', messageId },
        { type: 'REASONING_MESSAGE_START', messageId, role: 'reasoning' },
        { type: 'REASONING_MESSAGE_CONTENT', messageId, delta: s.reasoning },
        { type: 'REASONING_MESSAGE_END', messageId },
        { type: 'REASONING_END', messageId }
      ], open)
    } else if ('tool' in s) {
      const t = s.tool
      const events = [
        { type: 'TOOL_CALL_START', toolCallId: t.id, toolCallName: t.name, ...(t.parent ? { parentMessageId: t.parent } : {}) },
        { type: 'TOOL_CALL_ARGS', toolCallId: t.id, delta: typeof t.args === 'string' ? t.args : JSON.stringify(t.args ?? {}) },
        { type: 'TOOL_CALL_END', toolCallId: t.id }
      ]
      if (t.result !== undefined) events.push({ type: 'TOOL_CALL_RESULT', messageId: `result-${t.id}`, toolCallId: t.id, content: t.result, role: 'tool' })
      sendAll(events, open)
    } else if ('state' in s) {
      sendAll([s.state.snapshot !== undefined ? { type: 'STATE_SNAPSHOT', snapshot: s.state.snapshot } : { type: 'STATE_DELTA', delta: s.state.delta }], open)
    } else if ('finish' in s) {
      const f = s.finish ?? {}
      sendAll([{ type: 'RUN_FINISHED', threadId: ids.threadId, runId: ids.runId, ...(f.outcome ? { outcome: f.outcome } : {}), ...(f.usage ? { usage: f.usage } : {}) }], open)
    } else if ('error' in s) {
      sendAll([{ type: 'RUN_ERROR', message: s.error.message, ...(s.error.code !== undefined ? { code: s.error.code } : {}) }], open)
    } else if ('lateError' in s) {
      if (s.ms) await sleep(s.ms)
      if (gone()) return
      sendAll([{ type: 'RUN_ERROR', message: s.lateError.message, ...(s.lateError.code !== undefined ? { code: s.lateError.code } : {}) }], open)
    } else if ('cut' in s) {
      if (s.cut === 'reset') {
        selfCut = true
        return res.socket?.destroy()
      }
      head()
      return res.end()
    } else if ('replay' in s) {
      const runId = `replay-${i}`
      const messageId = `replayed-${i}`
      sendAll([
        { type: 'RUN_STARTED', threadId: ids.threadId, runId },
        { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: s.replay?.text ?? 'An earlier reply.' },
        { type: 'TEXT_MESSAGE_END', messageId },
        { type: 'RUN_FINISHED', threadId: ids.threadId, runId }
      ], false)
    } else if ('malformed' in s) {
      if (s.malformed === 'json') write('data: {not json\n\n')
      else send({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'msg-bad', delta: 42 })
    } else if ('oversize' in s) {
      send({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'msg-big', delta: 'x'.repeat(s.oversize) })
    } else if ('comment' in s) {
      write(`: ${s.comment ?? 'keep-alive'}\n\n`)
    } else if ('sleep' in s) {
      await sleep(s.sleep)
    } else if ('hold' in s) {
      return
    }
  }
  if (gone()) return
  head()
  res.end()
})

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`FAKE_AGUI_PORT=${server.address().port}\n`)
})

process.on('SIGTERM', () => process.exit(0))
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))
process.stdin.resume()
