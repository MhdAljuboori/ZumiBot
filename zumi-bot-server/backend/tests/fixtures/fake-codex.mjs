// Fake `codex app-server --listen stdio://` for tests: JSON lines on stdin/stdout, no `jsonrpc` field, as the real one
// (wire shapes taken from the recordings in tests/fixtures/codex/). It never reads ~/.codex or any auth. Argv is ignored
// except the hook arguments `-c hooks.PreToolUse=<TOML inline>` and `-c hooks.state=<TOML inline>` (see Hooks below).
// It answers initialize, model/list, hooks/list, thread/start, thread/resume, thread/fork, thread/compact/start, turn/start and
// turn/interrupt; `initialized` and other notifications are ignored, any other request gets a -32601 error.
// FAKE_CODEX_SCRIPT: a JSONL file read at each turn/start, one step per line, run after the turn/start answer and the
//   `turn/started` notification, in order:
//     {"notify": {method, params}}     a notification to the client
//     {"request": {method, params}}    a server request (ids 0, 1, ...); waits for the client's answer, which is appended
//                                      as received ({id, result} or {id, error}) to FAKE_CODEX_ANSWERS. Once answered or
//                                      interrupted it sends `serverRequest/resolved` on the params' threadId (a child's
//                                      request names the child, as check 13 recorded), as the real one does after an answer
//     {"sleep": ms}
//     {"mcpCall": {server, tool, args}}  the PreToolUse hooks (tool `mcp__<server>__<tool>`, input `args`), then, unless one
//                                      blocked, item/started + item/completed (mcpToolCall) around a real call to the stdio
//                                      MCP server `mcp_servers.<server>` of the thread's `config`
//     {"exec": {command, output?, exitCode?, id?, agent?}}  a shell call: the PreToolUse hooks (tool `Bash`, input
//                                      `{command}`), then, unless one blocked, item/started + item/completed
//                                      (commandExecution, `/bin/bash -lc '<command>'`, `output` as aggregatedOutput, default
//                                      '', `exitCode` default 0, failed when not 0). The command is never run. `id` (default
//                                      `exec-<uuid>`) is the item id and the hooks' tool_use_id. `agent: {threadId, type?,
//                                      turnId?}` makes it a subagent's call: the hook input gains agent_id (= threadId) and
//                                      agent_type (default `default`), and its notices and item carry that thread and turnId
//                                      (default `<threadId>-turn`), as check 11 recorded for a child. `hold: ms` makes the
//                                      command a real `sleep` (its pid in FAKE_CODEX_PIDS) between item/started and
//                                      item/completed. turn/interrupt kills a main-thread one and sends no item/completed; a
//                                      subagent's runs on, as check 13 found a child's `sleep 60` did, until this process exits.
//     {"spawn": {name, threadId?, id?}}  a subagent as check 13 recorded it: the PreToolUse hooks on the main thread (tool
//                                      `collaborationspawn_agent`, input {task_name, fork_turns, message}, tool_use_id `id`),
//                                      then, unless one blocked, item/started subAgentActivity `started` (agentThreadId
//                                      `threadId`, default `<name>-thread`; agentPath `/root/<name>`), the child's status
//                                      idle, item/completed of the same item, the child's status active and its turn/started
//                                      (turn id `<threadId>-turn`, rootTurnId the main turn). The child's own work is then
//                                      `exec` steps with `agent: {threadId}` and `notify`/`request` steps naming its thread.
//     {"childEnd": {threadId, status?}}  the child ends (status `completed`, the default, or `interrupted`): item/started
//                                      subAgentActivity of that kind (id `subagent-<kind>-<child turn>`) on the main thread,
//                                      the child's status idle, its turn/completed, then item/completed of the same item.
//     {"collab": {tool, id?, status?, receivers?, prompt?, states?}}  a collabAgentToolCall on the main thread. Status
//                                      `inProgress` (the default) runs the hooks first (a wait is check 11's
//                                      `collaborationwait_agent` with {timeout_ms: 10000}, a list `collaborationlist_agents`,
//                                      any other tool `collaboration<tool lower-cased>`, unrecorded) and sends item/started
//                                      unless one blocked; `completed` or `failed` sends item/completed, skipped when the
//                                      start was blocked. `states` is its agentsStates.
//     {"until": {file, ms?}}           waits until the file exists (at most `ms`, default 10000), or the turn is interrupted.
//   `$THREAD` and `$TURN` inside any string are replaced by the thread and turn id. When the steps end without a
//   `turn/completed` notify of their own, the turn completes with status `completed`. A turn/interrupt never stops a child.
// turn/interrupt stops the script and completes the turn as `interrupted`. FAKE_CODEX_UNAUTHORIZED=1 makes turn/start emit
//   an `unauthorized` error and complete the turn as `failed`, without running the script.
// FAKE_CODEX_LOG: appends {method, params} for every request received (a fork's lastTurnId, ephemeral and excludeTurns
//   included). FAKE_CODEX_HOME: thread markers live in <home>/threads/<id> (thread/resume and thread/fork need one, or the thread
//   open in this process; thread/start and a kept fork make one). A resume or fork without one gets real codex's resume error,
//   -32600 `no rollout found for thread id <id>` (a fork's own wording was not probed).
// thread/fork: a new thread id, as real codex 0.164.0 answers (probe check 7); lastTurnId is only logged, the fake keeps no
//   turns. `ephemeral` needs `excludeTurns`, as the real one does (check 8), and writes no marker, so a later process cannot
//   resume it. FAKE_CODEX_FORK_SAME=1 answers with the source id instead, as a CLI that ignored the fork would.
//   FAKE_CODEX_FORK_ERROR=<message> refuses every fork of a known thread with -32603 and that message (no real one recorded).
// thread/compact/start: answers {} at once, then plays what probe check 9 recorded as a turn: status active, turn/started,
//   item/started contextCompaction, a token update, item/completed contextCompaction, status idle, turn/completed. There is no
//   thread/compacted (deprecated, never sent). FAKE_CODEX_COMPACT_MS: the wait between the item's start and end (default 5);
//   turn/interrupt ends it `interrupted` with no item/completed.
// Hooks (probe check 11): `-c hooks.PreToolUse=[{matcher?, hooks=[{type="command", command, timeout}]}, …]` makes one
//   `sessionFlags` hook per handler, keyed `/<session-flags>/config.toml:pre_tool_use:<group>:<handler>`. hooks/list
//   {cwds} lists them per cwd in the recorded shape, with `currentHash` (`sha256:` of the event, matcher, command and
//   timeout and FAKE_CODEX_HOOK_SALT, never of the position; a new salt stands for a codex that hashes differently) and
//   `trustStatus` `trusted` only when `-c hooks.state={"<key>"={trusted_hash="<that hash>"}}` names it, else `untrusted`
//   (the dotted `hooks.state."<key>".trusted_hash=` form is ignored, as the real one ignores it). Only trusted hooks run,
//   an untrusted one silently. Before an `exec` or `mcpCall`, each trusted hook whose matcher takes the tool (none or `*`:
//   every tool; plain names joined by `|`: exactly those; else a regex) runs in order through `sh -c` with this process's
//   env and the thread's cwd, its stdin one JSON line shaped as check 11 recorded (session_id, turn_id, [agent_id,
//   agent_type], transcript_path, cwd, hook_event_name, model, permission_mode, tool_name, tool_input, tool_use_id), each
//   between hook/started and hook/completed (run.id `pre-tool-use:<n>:<sourcePath>:<tool_use_id>`). Exit 0 completes;
//   exit 2 blocks (status `blocked`, its trimmed stderr as a `feedback` entry) and the call then has no item at all; any
//   other exit (`hook exited with code N`) or the timeout (`hook timed out after Ns`, the hook's process group killed) is
//   `failed` and the call runs, as the real one fails open. FAKE_CODEX_HOOKS_LIST=off answers hooks/list with -32601 (an
//   older codex), `empty` lists no hooks, `hang` never answers it. FAKE_CODEX_HOOKS_OUT appends {id, tool, agentId, blocked} per
//   exec, mcpCall, spawn or collab start.
// FAKE_CODEX_PIDS: appends {pid, role: 'app-server'} for this process at start, and {pid, role: 'exec', id, threadId} for each
//   held exec's process, so a test can see what is left running.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'

const HOME = process.env.FAKE_CODEX_HOME
const marker = (id) => (HOME ? join(HOME, 'threads', String(id).replace(/[^A-Za-z0-9_.-]/g, '_')) : null)

const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
const notify = (method, params) => out({ method, params, emittedAtMs: Date.now() })

const threads = new Map() // id -> {cwd, config}
let activeTurn = null // {id, threadId, aborted, wake, done}
let turnCount = 0
let serverRequestId = 0
const answers = new Map() // server request id -> resolve(message)
const mcpChildren = []
const hookChildren = new Set() // hooks running now, each its own process group
const heldExecs = new Set() // `hold` commands still running: a subagent's outlive an interrupt, never this process
const children = new Map() // a spawned child's thread id -> {path, turnId, rootTurnId, startedAt}
const blockedCollab = new Set() // collab call ids a hook blocked, whose end is then never sent

if (process.env.FAKE_CODEX_PIDS) appendFileSync(process.env.FAKE_CODEX_PIDS, JSON.stringify({ pid: process.pid, role: 'app-server' }) + '\n')

function shutdown(code) {
  // The real app-server stops its MCP servers when it ends; none may outlive it, no hook, and no subagent's command (check 13).
  for (const c of mcpChildren) c.kill()
  for (const c of hookChildren) killGroup(c)
  for (const c of heldExecs) { try { c.kill('SIGKILL') } catch { /* gone */ } }
  process.exit(code)
}
function killGroup(c) {
  try { process.kill(-c.pid, 'SIGKILL') } catch { try { c.kill('SIGKILL') } catch { /* gone */ } }
}

// ---------- hooks from argv ----------

/** A TOML inline value, the subset hookConfig writes: JSON-escaped basic strings, integers, booleans, inline arrays and tables. */
function parseToml(src) {
  let i = 0
  const ws = () => { while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++ }
  const fail = () => { throw new Error(`fake-codex: bad TOML at ${i}: ${src}`) }
  const string = () => {
    let j = i + 1
    while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1
    if (j >= src.length) fail()
    const v = JSON.parse(src.slice(i, j + 1))
    i = j + 1
    return v
  }
  const key = () => {
    if (src[i] === '"') return string()
    const m = /^[A-Za-z0-9_-]+/.exec(src.slice(i))
    if (!m) fail()
    i += m[0].length
    return m[0]
  }
  const value = () => {
    ws()
    if (src[i] === '"') return string()
    if (src[i] === '[') {
      i++
      const out = []
      for (ws(); src[i] !== ']'; ws()) {
        out.push(value())
        ws()
        if (src[i] === ',') i++
        else if (src[i] !== ']') fail()
      }
      i++
      return out
    }
    if (src[i] === '{') {
      i++
      const out = {}
      for (ws(); src[i] !== '}'; ws()) {
        const k = key()
        ws()
        if (src[i++] !== '=') fail()
        out[k] = value()
        ws()
        if (src[i] === ',') i++
        else if (src[i] !== '}') fail()
      }
      i++
      return out
    }
    const m = /^(true|false|-?\d+)/.exec(src.slice(i))
    if (!m) fail()
    i += m[0].length
    return m[0] === 'true' ? true : m[0] === 'false' ? false : Number(m[0])
  }
  const v = value()
  ws()
  if (i !== src.length) fail()
  return v
}

/** The `-c key=value` pairs of argv; only the two exact keys check 11 used count. */
function configArgs() {
  const argv = process.argv.slice(2)
  const out = {}
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] !== '-c') continue
    const pair = argv[++i]
    const eq = pair.indexOf('=')
    if (eq > 0) out[pair.slice(0, eq)] = pair.slice(eq + 1)
  }
  return out
}

const HOOK_SOURCE = '/<session-flags>/config.toml'
const hookHash = (matcher, command, timeout) =>
  `sha256:${createHash('sha256').update(JSON.stringify([process.env.FAKE_CODEX_HOOK_SALT ?? '', 'pre_tool_use', matcher, command, timeout])).digest('hex')}`

const HOOKS = (() => {
  const cfg = configArgs()
  const groups = cfg['hooks.PreToolUse'] !== undefined ? parseToml(cfg['hooks.PreToolUse']) : []
  const state = cfg['hooks.state'] !== undefined ? parseToml(cfg['hooks.state']) : {}
  const hooks = []
  groups.forEach((g, gi) => (g.hooks ?? []).forEach((h, hi) => {
    if (h?.type !== 'command' || typeof h.command !== 'string') return
    const matcher = typeof g.matcher === 'string' ? g.matcher : null
    const timeout = Number.isInteger(h.timeout) ? h.timeout : 600 // codex's default
    const key = `${HOOK_SOURCE}:pre_tool_use:${gi}:${hi}`
    const currentHash = hookHash(matcher, h.command, timeout)
    hooks.push({ key, matcher, command: h.command, timeout, currentHash, order: hooks.length, trusted: state?.[key]?.trusted_hash === currentHash })
  }))
  return hooks
})()

const hookEntry = (h) => ({ key: h.key, eventName: 'preToolUse', handlerType: 'command', command: h.command, async: false, matcher: h.matcher, timeoutSec: h.timeout,
  statusMessage: null, additionalContextLimit: null, sourcePath: HOOK_SOURCE, source: 'sessionFlags', pluginId: null, displayOrder: h.order, enabled: true,
  isManaged: false, currentHash: h.currentHash, trustStatus: h.trusted ? 'trusted' : 'untrusted' })

/** fake-claude's matcher rule: none or '*' takes every tool, plain names (joined by |) exactly those, anything else is a regex. */
const hookMatches = (matcher, tool) =>
  !matcher || matcher === '*' ? true : /^[A-Za-z0-9_|]+$/.test(matcher) ? matcher.split('|').includes(tool) : new RegExp(matcher).test(tool)

/** One hook through `sh -c` with the input on stdin: {status, entries} as hook/completed carries them. */
function runHook(h, input, cwd) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('sh', ['-c', h.command], { env: process.env, cwd: cwd && existsSync(cwd) ? cwd : undefined, detached: true, stdio: ['pipe', 'ignore', 'pipe'] })
    } catch (e) {
      return resolve({ status: 'failed', entries: [{ kind: 'error', text: `hook failed to start: ${e.message}` }] })
    }
    hookChildren.add(child)
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; killGroup(child) }, h.timeout * 1000)
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d })
    child.stdin.on('error', () => {}) // a hook that exits without reading its input
    child.on('error', (e) => { stderr += e.message })
    child.on('close', (code) => {
      clearTimeout(timer)
      hookChildren.delete(child)
      if (timedOut) return resolve({ status: 'failed', entries: [{ kind: 'error', text: `hook timed out after ${h.timeout}s` }] })
      if (code === 0) return resolve({ status: 'completed', entries: [] })
      if (code === 2) return resolve({ status: 'blocked', entries: [{ kind: 'feedback', text: stderr.trim() }] })
      resolve({ status: 'failed', entries: [{ kind: 'error', text: `hook exited with code ${code}` }] })
    })
    child.stdin.end(JSON.stringify(input) + '\n')
  })
}

/**
 * The trusted PreToolUse hooks for one call, in order, each between hook/started and hook/completed on the call's thread.
 * True when one blocked: the call then gets no item.
 */
async function preToolUse(t, { id, tool, toolInput, agent }) {
  const threadId = agent ? agent.threadId : t.threadId
  const turnId = agent ? (agent.turnId ?? `${agent.threadId}-turn`) : t.id
  const cwd = threads.get(t.threadId)?.cwd ?? process.cwd()
  const input = {
    session_id: t.threadId,
    turn_id: turnId,
    ...(agent ? { agent_id: agent.threadId, agent_type: agent.type ?? 'default' } : {}),
    transcript_path: join(HOME ?? '/tmp/fake-codex-home', 'sessions', `rollout-${threadId}.jsonl`),
    cwd,
    hook_event_name: 'PreToolUse',
    model: 'fake-model',
    permission_mode: 'default',
    tool_name: tool,
    tool_input: toolInput,
    tool_use_id: id
  }
  let blocked = false
  for (const h of HOOKS) {
    if (!h.trusted || !hookMatches(h.matcher, tool)) continue
    const run = { id: `pre-tool-use:${h.order}:${HOOK_SOURCE}:${id}`, eventName: 'preToolUse', handlerType: 'command', executionMode: 'sync', scope: 'turn',
      sourcePath: HOOK_SOURCE, source: 'sessionFlags', displayOrder: h.order }
    const startedAt = Date.now()
    notify('hook/started', { threadId, turnId, run: { ...run, status: 'running', statusMessage: null, startedAt: Math.floor(startedAt / 1000), completedAt: null, durationMs: null, entries: [] } })
    const r = await runHook(h, input, cwd)
    if (r.status === 'blocked') blocked = true
    notify('hook/completed', { threadId, turnId, run: { ...run, status: r.status, statusMessage: null, startedAt: Math.floor(startedAt / 1000), completedAt: Math.floor(Date.now() / 1000), durationMs: Date.now() - startedAt, entries: r.entries } })
  }
  if (process.env.FAKE_CODEX_HOOKS_OUT) appendFileSync(process.env.FAKE_CODEX_HOOKS_OUT, JSON.stringify({ id, tool, agentId: agent?.threadId ?? null, blocked }) + '\n')
  return blocked
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

// ---------- requests ----------

const threadResult = (id, params, cwd, extra = {}) => ({
  thread: { id, sessionId: id, cwd, ephemeral: false, modelProvider: 'openai', model: 'fake-model', preview: '', turns: [], ...extra },
  model: 'fake-model',
  modelProvider: 'openai',
  cwd,
  approvalPolicy: params?.approvalPolicy ?? 'on-request',
  approvalsReviewer: params?.approvalsReviewer ?? 'user',
  sandbox: params?.sandbox ?? 'workspace-write',
  reasoningEffort: 'high'
})

function openThread(id, params, extra) {
  const cwd = typeof params?.cwd === 'string' ? params.cwd : process.cwd()
  const t = { cwd, config: params?.config && typeof params.config === 'object' ? params.config : {} }
  threads.set(id, t)
  return threadResult(id, params, cwd, extra)
}
const known = (tid) => {
  if (typeof tid !== 'string') return false
  const m = marker(tid)
  return threads.has(tid) || (m !== null && existsSync(m))
}
const saveMarker = (tid) => {
  const m = marker(tid)
  if (m) { mkdirSync(join(HOME, 'threads'), { recursive: true }); writeFileSync(m, '') }
}

async function handle(msg) {
  const { id, method, params } = msg
  const reply = (result) => out({ id, result })
  const fail = (code, message) => out({ id, error: { code, message } })
  switch (method) {
    case 'initialize': {
      const name = params?.clientInfo?.name ?? 'client'
      const ver = params?.clientInfo?.version ?? '0.0.0'
      return reply({ userAgent: `fake-codex/0.0.0 (Fake OS; x86_64) unknown (${name}; ${ver})`, codexHome: HOME ?? '/tmp/fake-codex-home', platformFamily: 'unix', platformOs: 'linux' })
    }
    case 'thread/start': {
      const tid = randomUUID()
      saveMarker(tid)
      const result = openThread(tid, params)
      reply(result)
      return notify('thread/started', { thread: result.thread })
    }
    case 'thread/resume': {
      const tid = params?.threadId
      if (!known(tid)) return fail(-32600, `no rollout found for thread id ${tid}`) // real codex 0.164.0's wording
      // A resume carries its own config, as the real one does; without one the thread keeps what it had.
      const old = threads.get(tid)
      const result = openThread(tid, { ...params, cwd: params?.cwd ?? old?.cwd, config: params?.config ?? old?.config })
      return reply(result)
    }
    case 'thread/fork': {
      const src = params?.threadId
      if (!known(src)) return fail(-32600, `no rollout found for thread id ${src}`)
      if (process.env.FAKE_CODEX_FORK_ERROR) return fail(-32603, process.env.FAKE_CODEX_FORK_ERROR)
      const ephemeral = params?.ephemeral === true
      // Real codex 0.164.0's refusal (probe check 8); its error code was not recorded.
      if (ephemeral && params?.excludeTurns !== true) return fail(-32600, 'ephemeral paginated thread/fork requires `excludeTurns: true`')
      const tid = process.env.FAKE_CODEX_FORK_SAME === '1' ? src : randomUUID()
      if (!ephemeral) saveMarker(tid)
      // The fork keeps the source's folder and config unless it names its own, as a resume does.
      const old = threads.get(src)
      const result = openThread(tid, { ...params, cwd: params?.cwd ?? old?.cwd, config: params?.config ?? old?.config },
        { forkedFromId: src, ephemeral, ...(ephemeral ? { path: null } : {}) })
      reply(result)
      return notify('thread/started', { thread: result.thread })
    }
    case 'thread/compact/start': {
      const threadId = params?.threadId
      if (!threads.has(threadId)) return fail(-32600, `thread not found: ${threadId}`)
      reply({})
      return compactTurn(threadId)
    }
    case 'hooks/list': {
      if (process.env.FAKE_CODEX_HOOKS_LIST === 'off') return fail(-32601, `Method not found: ${method}`)
      if (process.env.FAKE_CODEX_HOOKS_LIST === 'hang') return
      const listed = process.env.FAKE_CODEX_HOOKS_LIST === 'empty' ? [] : HOOKS.map(hookEntry)
      const cwds = Array.isArray(params?.cwds) ? params.cwds : [process.cwd()]
      return reply({ data: cwds.map((cwd) => ({ cwd, hooks: listed, warnings: [], errors: [] })) })
    }
    case 'model/list': {
      // FAKE_CODEX_MODELS_HANG: never answers. FAKE_CODEX_MODELS_PAGED: two pages. Real shape: data[].model/hidden, nextCursor.
      if (process.env.FAKE_CODEX_MODELS_HANG === '1') return
      const m = (model, hidden) => ({ id: model, model, hidden, displayName: model })
      if (process.env.FAKE_CODEX_MODELS_PAGED === '1') {
        return params?.cursor === 'p2' ? reply({ data: [m('gpt-fake-c', false)], nextCursor: null })
          : reply({ data: [m('gpt-fake-a', false), m('gpt-fake-hidden', true)], nextCursor: 'p2' })
      }
      return reply({ data: [m('gpt-fake-a', false), m('gpt-fake-hidden', true), m('gpt-fake-b', false)], nextCursor: null })
    }
    case 'turn/start':
      return startTurn(id, params)
    case 'turn/interrupt': {
      reply({})
      const t = activeTurn
      if (t && (!params?.turnId || params.turnId === t.id)) { t.aborted = true; t.wake() }
      return
    }
    default:
      return fail(-32601, `Method not found: ${method}`)
  }
}

// ---------- turns ----------

const turnObject = (t, status, error = null) => ({ id: t.id, rootTurnId: t.id, items: [], itemsView: status === 'inProgress' ? 'notLoaded' : 'summary', status, error, startedAt: t.startedAt, completedAt: status === 'inProgress' ? null : Math.floor(Date.now() / 1000), durationMs: status === 'inProgress' ? null : Date.now() - t.startedAt * 1000 })

function startTurn(id, params) {
  const threadId = params?.threadId
  if (!threads.has(threadId)) return out({ id, error: { code: -32600, message: `thread not found: ${threadId}` } })
  const t = { id: randomUUID(), threadId, aborted: false, wake: () => {}, startedAt: Math.floor(Date.now() / 1000), completed: false }
  activeTurn = t
  turnCount++
  out({ id, result: { turn: turnObject(t, 'inProgress') } })
  notify('turn/started', { threadId, turn: turnObject(t, 'inProgress') })
  void runTurn(t).catch((e) => {
    process.stderr.write(`fake-codex script error: ${e?.stack ?? e}\n`)
    complete(t, 'failed', { message: String(e?.message ?? e), codexErrorInfo: 'other' })
  })
}

function complete(t, status, error = null) {
  if (t.completed) return
  t.completed = true
  if (activeTurn === t) activeTurn = null
  notify('turn/completed', { threadId: t.threadId, turn: turnObject(t, status, error) })
}

// Resolves after `ms`, or at once when the turn is interrupted.
const nap = (t, ms) => new Promise((resolve) => {
  const timer = setTimeout(done, ms)
  function done() { clearTimeout(timer); t.wake = () => {}; resolve() }
  t.wake = done
})

const fill = (v, t) => {
  if (typeof v === 'string') return v.replaceAll('$THREAD', t.threadId).replaceAll('$TURN', t.id)
  if (Array.isArray(v)) return v.map((x) => fill(x, t))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, t)]))
  return v
}

async function runTurn(t) {
  if (process.env.FAKE_CODEX_UNAUTHORIZED === '1') {
    const error = { message: 'Not signed in. Run codex login.', codexErrorInfo: 'unauthorized', additionalDetails: null }
    notify('error', { error, willRetry: false, threadId: t.threadId, turnId: t.id })
    return complete(t, 'failed', error)
  }
  const file = process.env.FAKE_CODEX_SCRIPT
  const steps = file ? readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) : []
  for (const raw of steps) {
    if (t.aborted) break
    const step = fill(raw, t)
    if (step.notify) {
      notify(step.notify.method, step.notify.params)
      if (step.notify.method === 'turn/completed') { t.completed = true; if (activeTurn === t) activeTurn = null }
    } else if (step.request) {
      await serverRequest(t, step.request)
    } else if (typeof step.sleep === 'number') {
      await nap(t, step.sleep)
    } else if (step.mcpCall) {
      await mcpCall(t, step.mcpCall)
    } else if (step.exec) {
      await execCall(t, step.exec)
    } else if (step.spawn) {
      await spawnAgent(t, step.spawn)
    } else if (step.childEnd) {
      childEnd(t, step.childEnd)
    } else if (step.collab) {
      await collabCall(t, step.collab)
    } else if (step.until) {
      const end = Date.now() + (step.until.ms ?? 10_000)
      while (!t.aborted && !existsSync(step.until.file) && Date.now() < end) await nap(t, 20)
    }
    if (!t.aborted) await nap(t, 5) // keep the lines apart, as a real stream is
  }
  complete(t, t.aborted ? 'interrupted' : 'completed')
}

// The turn a compaction runs, in the order probe check 9 recorded (goal and account notices left out: nothing reads them).
async function compactTurn(threadId) {
  const t = { id: randomUUID(), threadId, aborted: false, wake: () => {}, startedAt: Math.floor(Date.now() / 1000), completed: false }
  activeTurn = t
  turnCount++
  const item = { type: 'contextCompaction', id: randomUUID() }
  const ms = process.env.FAKE_CODEX_COMPACT_MS ? Number(process.env.FAKE_CODEX_COMPACT_MS) : 5
  notify('thread/status/changed', { threadId, status: { type: 'active', activeFlags: [] } })
  notify('turn/started', { threadId, turn: turnObject(t, 'inProgress') })
  await nap(t, 5)
  if (!t.aborted) {
    notify('item/started', { item, threadId, turnId: t.id, startedAtMs: Date.now() })
    // The update check 9 saw mid-compaction, whose `last` counts no tokens (the fake keeps no totals either).
    const zero = { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }
    notify('thread/tokenUsage/updated', { threadId, turnId: t.id, tokenUsage: { total: zero, last: zero, modelContextWindow: 258400 } })
    await nap(t, ms)
  }
  if (!t.aborted) notify('item/completed', { item, threadId, turnId: t.id, completedAtMs: Date.now() })
  notify('thread/status/changed', { threadId, status: { type: 'idle' } })
  complete(t, t.aborted ? 'interrupted' : 'completed')
}

/** Sends a server request and waits for the client's answer (or an interrupt), appending the answer to FAKE_CODEX_ANSWERS. */
async function serverRequest(t, { method, params }) {
  const id = serverRequestId++
  const answer = new Promise((resolve) => answers.set(id, resolve))
  out({ id, method, params })
  const msg = await Promise.race([answer, new Promise((resolve) => { t.wake = () => resolve(null) })])
  answers.delete(id)
  t.wake = () => {}
  if (msg && process.env.FAKE_CODEX_ANSWERS) appendFileSync(process.env.FAKE_CODEX_ANSWERS, JSON.stringify(msg) + '\n')
  notify('serverRequest/resolved', { threadId: typeof params?.threadId === 'string' ? params.threadId : t.threadId, requestId: id })
}

// ---------- mcpCall: a real stdio MCP server from the thread's config, called the way Codex calls it ----------

const mcpServers = new Map() // `${threadId}\0${name}` -> Promise of a JSON-RPC client

// Codex starts a server with a trimmed env: its own fixed `env` plus the `env_vars` names taken from Codex's env.
function mcpEnv(cfg) {
  const base = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG'].filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]))
  const passed = Object.fromEntries((Array.isArray(cfg.env_vars) ? cfg.env_vars : []).filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]))
  return { ...base, ...passed, ...(cfg.env && typeof cfg.env === 'object' ? cfg.env : {}) }
}

async function startServer(thread, name) {
  const cfg = thread.config?.[`mcp_servers.${name}`]
  if (!cfg || typeof cfg.command !== 'string') throw new Error(`No MCP server named ${name} in the thread config`)
  const child = spawn(cfg.command, Array.isArray(cfg.args) ? cfg.args : [], { cwd: thread.cwd, env: mcpEnv(cfg), stdio: ['pipe', 'pipe', 'pipe'] })
  mcpChildren.push(child)
  const calls = new Map()
  let next = 0
  let buf = ''
  let err = ''
  const failAll = (e) => { for (const c of calls.values()) c.reject(e); calls.clear() }
  child.stdin.on('error', () => {}) // a server that died is reported by its exit
  child.stderr.setEncoding('utf8').on('data', (d) => { err += d })
  child.stdout.setEncoding('utf8').on('data', (d) => {
    buf += d
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      let m
      try { m = JSON.parse(line) } catch { continue }
      const c = calls.get(m?.id)
      if (!c) continue // a notification or a server request: the fake answers neither
      calls.delete(m.id)
      if (m.error) c.reject(new Error(`MCP error ${m.error.code}: ${m.error.message}`))
      else c.resolve(m.result)
    }
  })
  child.on('error', failAll)
  child.on('exit', (code, sig) => failAll(new Error(`MCP server ${name} exited (${code ?? sig})${err.trim() ? `: ${err.trim()}` : ''}`)))
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++next
    calls.set(id, { resolve, reject })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-codex', version: '0.0.0' } })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  return { request, timeoutMs: Number(cfg.tool_timeout_sec) > 0 ? Number(cfg.tool_timeout_sec) * 1000 : 15_000 }
}

// ---------- exec: a shell call as check 11 recorded it (never run) ----------

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

async function execCall(t, { command, output = '', exitCode = 0, id = `exec-${randomUUID()}`, agent = null, hold = 0 }) {
  if (await preToolUse(t, { id, tool: 'Bash', toolInput: { command }, agent }) || t.aborted) return
  const threadId = agent ? agent.threadId : t.threadId
  const turnId = agent ? (agent.turnId ?? `${agent.threadId}-turn`) : t.id
  const cwd = threads.get(t.threadId)?.cwd ?? process.cwd()
  const item = { type: 'commandExecution', id, pluginId: null, scriptPath: null, command: `/bin/bash -lc ${shq(command)}`, cwd, processId: String(process.pid),
    source: 'unifiedExecStartup', status: 'inProgress', commandActions: [{ type: 'unknown', command }], aggregatedOutput: null, exitCode: null, durationMs: null }
  // A held command's process exists (and is logged) by the time its item says it started.
  const proc = hold > 0 ? holdProcess({ id, threadId, ms: hold }) : null
  notify('item/started', { item, threadId, turnId, startedAtMs: Date.now() })
  if (proc && !(await held(t, proc, agent !== null))) return
  notify('item/completed', { item: { ...item, status: exitCode === 0 ? 'completed' : 'failed', aggregatedOutput: output, exitCode, durationMs: 0 }, threadId, turnId, completedAtMs: Date.now() })
}

function holdProcess({ id, threadId, ms }) {
  const proc = spawn('sleep', [String(ms / 1000)], { stdio: 'ignore' })
  heldExecs.add(proc)
  if (process.env.FAKE_CODEX_PIDS) appendFileSync(process.env.FAKE_CODEX_PIDS, JSON.stringify({ pid: proc.pid, role: 'exec', id, threadId }) + '\n')
  return proc
}

// Waits for a held command: true once it ended by itself, false when the turn was interrupted first. Codex stops its own
// turn's command then; a subagent's runs on (probe check 13) until this process exits.
async function held(t, proc, child) {
  const ended = new Promise((resolve) => { proc.on('exit', () => resolve(true)); proc.on('error', () => resolve(true)) })
  const done = await Promise.race([ended, new Promise((resolve) => { t.wake = () => resolve(false) })])
  t.wake = () => {}
  if (done && !t.aborted) { heldExecs.delete(proc); return true }
  if (!child) { try { proc.kill('SIGKILL') } catch { /* gone */ } heldExecs.delete(proc) }
  return false
}

// ---------- subagents: check 13's notices for a child thread ----------

// The spawn's message as check 11's hook saw it: sealed, so no client can read the child's prompt.
const SEALED_MESSAGE = 'gAAAAA-fake-sealed-message'
const childTurn = (c, status) => ({ id: c.turnId, rootTurnId: c.rootTurnId, items: [], itemsView: status === 'inProgress' ? 'notLoaded' : 'summary', status, error: null,
  startedAt: c.startedAt, completedAt: status === 'inProgress' ? null : Math.floor(Date.now() / 1000), durationMs: status === 'inProgress' ? null : Date.now() - c.startedAt * 1000 })

async function spawnAgent(t, { name, threadId = `${name}-thread`, id = `call_${randomUUID().replaceAll('-', '')}` }) {
  if (await preToolUse(t, { id, tool: 'collaborationspawn_agent', toolInput: { task_name: name, fork_turns: 'none', message: SEALED_MESSAGE }, agent: null }) || t.aborted) return
  const c = { path: `/root/${name}`, turnId: `${threadId}-turn`, rootTurnId: t.id, startedAt: Math.floor(Date.now() / 1000) }
  children.set(threadId, c)
  const item = { type: 'subAgentActivity', model: 'fake-model', reasoningEffort: 'high', id, kind: 'started', agentThreadId: threadId, agentPath: c.path }
  notify('item/started', { item, threadId: t.threadId, turnId: t.id, startedAtMs: Date.now() })
  notify('thread/status/changed', { threadId, status: { type: 'idle' } })
  notify('item/completed', { item, threadId: t.threadId, turnId: t.id, completedAtMs: Date.now() })
  notify('thread/status/changed', { threadId, status: { type: 'active', activeFlags: [] } })
  notify('turn/started', { threadId, turn: childTurn(c, 'inProgress') })
}

function childEnd(t, { threadId, status = 'completed' }) {
  const c = children.get(threadId)
  if (!c) throw new Error(`fake-codex: childEnd of a thread no spawn started: ${threadId}`)
  const kind = status === 'interrupted' ? 'interrupted' : 'completed'
  const item = { type: 'subAgentActivity', model: null, reasoningEffort: null, id: `subagent-${kind}-${c.turnId}`, kind, agentThreadId: threadId, agentPath: c.path }
  notify('item/started', { item, threadId: t.threadId, turnId: t.id, startedAtMs: Date.now() })
  notify('thread/status/changed', { threadId, status: { type: 'idle' } })
  notify('turn/completed', { threadId, turn: childTurn(c, kind) })
  notify('item/completed', { item, threadId: t.threadId, turnId: t.id, completedAtMs: Date.now() })
}

// Check 11 recorded the wait's hook input; the others' names are guesses in the same pattern.
const COLLAB_HOOKS = new Map([['wait', ['collaborationwait_agent', { timeout_ms: 10000 }]], ['list', ['collaborationlist_agents', {}]]])

async function collabCall(t, { tool, id = `call_${randomUUID().replaceAll('-', '')}`, status = 'inProgress', receivers = [], prompt = null, states = {} }) {
  const item = { type: 'collabAgentToolCall', id, tool, status, senderThreadId: t.threadId, receiverThreadIds: receivers, prompt, model: null, reasoningEffort: null, agentsStates: states }
  if (status !== 'inProgress') {
    if (!blockedCollab.has(id)) notify('item/completed', { item, threadId: t.threadId, turnId: t.id, completedAtMs: Date.now() })
    return
  }
  const [hookTool, input] = COLLAB_HOOKS.get(tool) ?? [`collaboration${String(tool).toLowerCase()}`, {}]
  if (await preToolUse(t, { id, tool: hookTool, toolInput: input, agent: null })) { blockedCollab.add(id); return }
  if (!t.aborted) notify('item/started', { item, threadId: t.threadId, turnId: t.id, startedAtMs: Date.now() })
}

async function mcpCall(t, { server, tool, args = {} }) {
  const itemId = `fake-mcp-${turnCount}-${randomUUID().slice(0, 8)}`
  if (await preToolUse(t, { id: itemId, tool: `mcp__${server}__${tool}`, toolInput: args, agent: null }) || t.aborted) return
  const base = { type: 'mcpToolCall', id: itemId, server, tool, arguments: args, appContext: null, mcpAppUi: null, pluginId: null, readOnlyHint: null }
  const startedAt = Date.now()
  notify('item/started', { item: { ...base, status: 'inProgress', result: null, error: null, durationMs: null }, threadId: t.threadId, turnId: t.id, startedAtMs: startedAt })
  let result = null
  let error = null
  let timer
  try {
    const thread = threads.get(t.threadId)
    const key = `${t.threadId}\0${server}`
    if (!mcpServers.has(key)) mcpServers.set(key, startServer(thread, server))
    const s = await mcpServers.get(key)
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`MCP call ${server}/${tool} timed out`)), s.timeoutMs) })
    const r = await Promise.race([s.request('tools/call', { name: tool, arguments: args }), timeout])
    if (r?.isError === true) error = { message: (r.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n') || 'tool error' }
    else result = { content: r?.content ?? [], structuredContent: r?.structuredContent ?? null, _meta: null }
  } catch (e) {
    error = { message: e instanceof Error ? e.message : String(e) }
  } finally {
    clearTimeout(timer)
  }
  notify('item/completed', { item: { ...base, status: error ? 'failed' : 'completed', result, error, durationMs: Date.now() - startedAt }, threadId: t.threadId, turnId: t.id, completedAtMs: Date.now() })
}

// ---------- stdin ----------

const decoder = new StringDecoder('utf8')
let pending = ''

function onLine(line) {
  let msg
  try { msg = JSON.parse(line) } catch { return } // stray text
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return
  if (typeof msg.method === 'string') {
    if (msg.id === undefined || msg.id === null) return // `initialized` and other notifications need no answer
    if (process.env.FAKE_CODEX_LOG) appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ method: msg.method, params: msg.params }) + '\n')
    void handle(msg).catch((e) => out({ id: msg.id, error: { code: -32603, message: String(e?.message ?? e) } }))
    return
  }
  // No method: the client's answer to one of this fixture's requests.
  answers.get(msg.id)?.(msg)
}

process.stdin.on('data', (c) => {
  pending += decoder.write(c)
  for (let i; (i = pending.indexOf('\n')) >= 0;) {
    const l = pending.slice(0, i)
    pending = pending.slice(i + 1)
    if (l.trim()) onLine(l)
  }
})
process.stdin.on('end', () => shutdown(0))
