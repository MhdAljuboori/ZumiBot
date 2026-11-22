// Fake ACP agent (Agent Client Protocol v1) for tests: newline-delimited JSON-RPC 2.0 on stdin/stdout, every line it writes
// carries `jsonrpc`. It never reads any real login. Argv is ignored (FAKE_ACP_START records it).
// It answers initialize, session/new, session/resume, session/load, session/set_mode, session/set_config_option and
// session/prompt; any other request gets -32601. set_mode sends a current_mode_update for the new mode before its answer, as
// the Claude adapter does; set_config_option answers with the option at its new value.
// Notifications: session/cancel ends the running prompt with `stopReason: cancelled` (unless `ignoreCancel`); others are
// only logged. When stdin ends it exits 0 at once (unless `stayOpen`), leaving any `hold` child running, so a test can see
// the runner end the process group itself.
//
// FAKE_ACP_SCRIPT: inline JSON (starting with `{`) or a path to a JSON file, read at start:
//   initialize       fields shallow-merged over the default initialize result; `agentCapabilities` is merged one level
//                    deeper. Default: protocolVersion 1, loadSession false, no prompt images, sessionCapabilities {},
//                    authMethods [], agentInfo {name: 'fake-acp', version: '0.0.1'}
//   sessionId        the id session/new answers (default `fake-session-1`)
//   newResult        fields merged over session/new's {sessionId} (e.g. modes, configOptions, a bad sessionId)
//   failNew          an error code session/new answers with (e.g. -32000 auth required)
//   sessions         ids session/resume and session/load know; any other id gets -32002 resource not found
//   failResume       an error code session/resume and session/load answer with
//   resumeResult     the result of session/resume and session/load (default {})
//   replay           `update` objects session/load sends as session/update before its answer
//   beforeStart      `update` objects sent as session/update right before the answer of session/new, resume or load,
//   afterStart       or right after it: answer and updates go in one write, so the client reads them in one chunk
//   failPrompt       {code, message}: session/prompt answers with this error, running no steps
//   failSetMode      an error code session/set_mode and session/set_config_option answer with
//   setModeEcho      the mode set_mode's current_mode_update reports and set_config_option's answer holds (default: the one asked)
//   stallSetMode     true: set_mode and set_config_option are never answered; 'crash': the agent exits 4 on either
//   ignoreCancel     session/cancel is logged and nothing else
//   ignoreSigterm    SIGTERM is ignored
//   stayOpen         stdin ending does not end the process
//   holdAtInit       initialize first runs that hold (true is 'session'; 'graceful', 'stubborn'), for the Test's teardown
//   steps            what each session/prompt does, in order, then it answers {stopReason: 'end_turn'}:
//     {text}             agent_message_chunk (text)
//     {thought}          agent_thought_chunk (text)
//     {toolCall}         tool_call with these fields
//     {toolUpdate}       tool_call_update with these fields
//     {update}           a raw session/update `update` object
//     {permission: {toolCall, options?}}  session/request_permission; waits for its answer. Default options: allow_once,
//                        allow_always, reject_once, reject_always (ids `allow-once`, `allow-always`, `reject-once`, `reject-always`)
//     {elicitation: {message?, requestedSchema, mode?}}  elicitation/create (mode default `form`); waits for its answer
//     {request: {method, params}}  any request to the client; waits for its answer
//     {usage: {used, size, cost?}}  usage_update
//     {mode: id}         current_mode_update
//     {sleep: ms}
//     {hold: true}       spawns `sleep 60` in this process's group (its pid goes to FAKE_ACP_PIDS)
//     {hold: 'session'}  spawns `sleep 60` in a session and group of its own (setsid), as a real agent's Bash shell is:
//                        a group kill misses it (role `session`)
//     {hold: 'nested'}   spawns a child in this group (role `middle`, as the Claude CLI under claude-agent-acp) whose own
//                        `sleep 60` runs in a session of its own (role `nested`); the step waits until that grandchild runs
//     {hold: 'graceful', ms?}  a child in a session of its own that, on SIGTERM, takes `ms` (default 300) to clean up, then
//                        records role `cleaned` with its pid and exits (role `graceful`); the step waits until its handler is set
//     {hold: 'stubborn'} the same, but it ignores SIGTERM (role `stubborn`): only SIGKILL ends it
//     {stderr: text}     written to stderr
//     {crash: code?}     exits with that code (default 1) at once
//     {malformed: n?}    n lines (default 1) that are not JSON
//     {stopReason: r}    answers the prompt with r and stops the steps
// FAKE_ACP_LOG: appends every message received, as received (requests, notifications and answers).
// FAKE_ACP_PIDS: appends {pid, role: 'agent'} at start and {pid, role: 'hold'} for each held child.
// FAKE_ACP_START: appends {argv, cwd, envKeys} at start.
import { appendFileSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

const raw = process.env.FAKE_ACP_SCRIPT ?? ''
const S = raw.trim().startsWith('{') ? JSON.parse(raw) : raw ? JSON.parse(readFileSync(raw, 'utf8')) : {}

const append = (file, obj) => { if (file) appendFileSync(file, JSON.stringify(obj) + '\n') }
append(process.env.FAKE_ACP_PIDS, { pid: process.pid, role: 'agent' })
append(process.env.FAKE_ACP_START, { argv: process.argv.slice(2), cwd: process.cwd(), envKeys: Object.keys(process.env) })
if (S.ignoreSigterm) process.on('SIGTERM', () => {})

const out = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
const respond = (id, result) => out({ id, result })
const fail = (id, code, message) => out({ id, error: { code, message } })
const update = (sessionId, u) => out({ method: 'session/update', params: { sessionId, update: u } })
// A session start's answer with the scripted updates around it, in a single write.
const answerStart = (id, sid, result) => {
  const line = (msg) => JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n'
  const u = (x) => line({ method: 'session/update', params: { sessionId: sid, update: x } })
  process.stdout.write((S.beforeStart ?? []).map(u).join('') + line({ id, result }) + (S.afterStart ?? []).map(u).join(''))
}

let nextId = 0
const waiting = new Map() // our request id -> resolve(answer message)
let turn = null // {aborted, wake}
let sessionId = null

const ask = (method, params) => {
  const id = nextId++
  return new Promise((resolve) => {
    waiting.set(id, resolve)
    out({ id, method, params })
  })
}

const sleep = (ms) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms)
  if (turn) turn.wake = () => { clearTimeout(t); resolve() }
})

const DEFAULT_OPTIONS = [
  { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
  { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
  { optionId: 'reject-always', name: 'Always reject', kind: 'reject_always' }
]

function initializeResult() {
  const i = S.initialize ?? {}
  return {
    protocolVersion: 1,
    authMethods: [],
    agentInfo: { name: 'fake-acp', title: 'Fake ACP', version: '0.0.1' },
    ...i,
    agentCapabilities: {
      loadSession: false,
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
      mcpCapabilities: { http: false, sse: false },
      sessionCapabilities: {},
      ...(i.agentCapabilities ?? {})
    }
  }
}

const known = (id) => Array.isArray(S.sessions) && S.sessions.includes(id)

// A child in a session and group of its own: only a walk of the process tree finds it once this process is gone.
const sessionChild = () => {
  const c = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' })
  c.unref()
  append(process.env.FAKE_ACP_PIDS, { pid: c.pid, role: 'session' })
}
// The middle child prints its own child's pid, then idles until signalled.
const NESTED = "const c = require('node:child_process').spawn('sleep', ['60'], { detached: true, stdio: 'ignore' }); process.stdout.write(c.pid + '\\n'); setInterval(() => {}, 1e6)"
// A child in a session of its own with a SIGTERM handler: `ms` to clean up, or 'never'. It prints once the handler is set.
const TRAP = "const [ms, f] = process.argv.slice(1); const { appendFileSync } = require('node:fs'); process.on('SIGTERM', () => { if (ms === 'never') return; setTimeout(() => { if (f) appendFileSync(f, JSON.stringify({ pid: process.pid, role: 'cleaned' }) + '\\n'); process.exit(0) }, Number(ms)) }); process.stdout.write('ready\\n'); setInterval(() => {}, 1e6)"
const trapChild = (ms, role) => new Promise((resolve) => {
  const c = spawn(process.execPath, ['-e', TRAP, String(ms), process.env.FAKE_ACP_PIDS ?? ''], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
  append(process.env.FAKE_ACP_PIDS, { pid: c.pid, role })
  c.stdout.once('data', () => resolve())
})
const hold = async (kind, ms) => {
  if (kind === 'session') sessionChild()
  else if (kind === 'nested') await nestedChild()
  else if (kind === 'graceful') await trapChild(ms ?? 300, 'graceful')
  else if (kind === 'stubborn') await trapChild('never', 'stubborn')
  else {
    // Same process group as this agent; stdout and stderr inherited, as an agent's own tool child would have them.
    const c = spawn('sleep', ['60'], { stdio: ['ignore', 'inherit', 'inherit'] })
    append(process.env.FAKE_ACP_PIDS, { pid: c.pid, role: 'hold' })
  }
}
const nestedChild = () => new Promise((resolve) => {
  const mid = spawn(process.execPath, ['-e', NESTED], { stdio: ['ignore', 'pipe', 'ignore'] })
  append(process.env.FAKE_ACP_PIDS, { pid: mid.pid, role: 'middle' })
  let got = ''
  mid.stdout.setEncoding('utf8')
  mid.stdout.on('data', (c) => {
    got += c
    if (!got.includes('\n')) return
    append(process.env.FAKE_ACP_PIDS, { pid: Number(got.trim()), role: 'nested' })
    resolve()
  })
})

async function prompt(id, params) {
  const sid = params?.sessionId
  turn = { aborted: false, wake: null }
  const t = turn
  let reason = 'end_turn'
  for (const step of S.steps ?? []) {
    if (t.aborted) break
    if (step.text !== undefined) update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: step.text } })
    else if (step.thought !== undefined) update(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: step.thought } })
    else if (step.toolCall) update(sid, { sessionUpdate: 'tool_call', ...step.toolCall })
    else if (step.toolUpdate) update(sid, { sessionUpdate: 'tool_call_update', ...step.toolUpdate })
    else if (step.update) update(sid, step.update)
    else if (step.permission) await ask('session/request_permission', { sessionId: sid, toolCall: step.permission.toolCall, options: step.permission.options ?? DEFAULT_OPTIONS })
    else if (step.elicitation) await ask('elicitation/create', { sessionId: sid, mode: 'form', ...step.elicitation })
    else if (step.request) await ask(step.request.method, step.request.params)
    else if (step.usage) update(sid, { sessionUpdate: 'usage_update', ...step.usage })
    else if (step.mode !== undefined) update(sid, { sessionUpdate: 'current_mode_update', currentModeId: step.mode })
    else if (step.sleep !== undefined) await sleep(step.sleep)
    else if (step.hold) await hold(step.hold, step.ms)
    else if (step.stderr !== undefined) process.stderr.write(step.stderr)
    else if (step.crash !== undefined) process.exit(typeof step.crash === 'number' ? step.crash : 1)
    else if (step.malformed !== undefined) for (let i = 0; i < (step.malformed === true ? 1 : step.malformed); i++) process.stdout.write('this is not json {\n')
    else if (step.stopReason !== undefined) { reason = step.stopReason; break }
  }
  if (turn === t) turn = null
  respond(id, { stopReason: t.aborted ? 'cancelled' : reason })
}

function request(msg) {
  const { id, method, params } = msg
  switch (method) {
    case 'initialize':
      if (!S.holdAtInit) return respond(id, initializeResult())
      return hold(S.holdAtInit === true ? 'session' : S.holdAtInit).then(() => respond(id, initializeResult()))
    case 'session/new':
      if (S.failNew !== undefined) return fail(id, S.failNew, S.failNew === -32000 ? 'Authentication required' : 'session/new failed')
      sessionId = S.sessionId ?? 'fake-session-1'
      return answerStart(id, sessionId, { sessionId, ...(S.newResult ?? {}) })
    case 'session/resume':
    case 'session/load': {
      if (S.failResume !== undefined) return fail(id, S.failResume, S.failResume === -32000 ? 'Authentication required' : `${method} failed`)
      if (!known(params?.sessionId)) return fail(id, -32002, 'Resource not found')
      sessionId = params.sessionId
      if (method === 'session/load') for (const u of S.replay ?? []) update(sessionId, u)
      return answerStart(id, sessionId, S.resumeResult ?? {})
    }
    case 'session/set_mode':
      if (S.stallSetMode === 'crash') process.exit(4)
      if (S.stallSetMode) return
      if (S.failSetMode !== undefined) return fail(id, S.failSetMode, S.failSetMode === -32000 ? 'Authentication required' : 'set_mode failed')
      update(params?.sessionId, { sessionUpdate: 'current_mode_update', currentModeId: S.setModeEcho ?? params?.modeId })
      return respond(id, {})
    case 'session/set_config_option':
      if (S.stallSetMode === 'crash') process.exit(4)
      if (S.stallSetMode) return
      if (S.failSetMode !== undefined) return fail(id, S.failSetMode, S.failSetMode === -32000 ? 'Authentication required' : 'set_config_option failed')
      return respond(id, { configOptions: [{ id: params?.configId, name: 'Mode', category: 'mode', type: 'select', currentValue: S.setModeEcho ?? params?.value, options: [] }] })
    case 'session/prompt':
      if (S.failPrompt) return fail(id, S.failPrompt.code, S.failPrompt.message)
      prompt(id, params).catch((e) => fail(id, -32603, String(e?.message ?? e)))
      return
    default:
      return fail(id, -32601, `Method not found: ${method}`)
  }
}

function receive(line) {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  append(process.env.FAKE_ACP_LOG, msg)
  if (typeof msg.method === 'string') {
    if (msg.id !== undefined) return request(msg)
    if (msg.method === 'session/cancel' && !S.ignoreCancel && turn) {
      turn.aborted = true
      turn.wake?.()
    }
    return
  }
  const resolve = waiting.get(msg.id)
  if (resolve) { waiting.delete(msg.id); resolve(msg) }
}

const decoder = new StringDecoder('utf8')
let buf = ''
process.stdin.on('data', (chunk) => {
  buf += decoder.write(chunk)
  const lines = buf.split('\n')
  buf = lines.pop() ?? ''
  for (const l of lines) receive(l)
})
// Stdin closed: the client is done with this process. Held children are left to the client's group kill.
process.stdin.on('end', () => { if (!S.stayOpen) process.exit(0) })
