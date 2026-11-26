// Fake claude CLI for tests. Ignores argv (except --mcp-config, for #MCP_CALL, --settings, for #PRE_TOOL, and --agent with
// FAKE_STDOUT_DIR); behaviour is driven by env vars.
// Speaks the stream-json input channel: the first stdin line is the user message and starts the
// script; later stdin lines are control_response messages, or user messages (mid-turn steers) that #STEER_REPLAY echoes.
// With FAKE_STDOUT_DIR, a side run (argv has --no-session-persistence) reads <dir>/<agent>.side.jsonl when that file exists.
// FAKE_MCP_RESULTS_OUT: each #MCP_CALL appends {id, tool, text, isError} (a side run's tool results reach no chat item).
// FAKE_HOOKS_OUT: each #PRE_TOOL appends {id, tool, agentId, blocked}.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { createInterface } from 'node:readline'

const sleep = ms => new Promise(r => setTimeout(r, ms))
// The app's --thinking-display check (thinkingDisplay.ts): given no prompt it stops as claude does, before any FAKE_* output
// below, so the check is never counted or recorded as a run.
if (process.argv.slice(2).join(' ') === '-p --thinking-display summarized') {
  process.stderr.write('Error: Input must be provided either through stdin or as a prompt argument when using --print\n')
  process.exit(1)
}
if (process.env.FAKE_IGNORE_SIGINT === '1') process.on('SIGINT', () => {})
if (process.env.FAKE_IGNORE_SIGTERM === '1') process.on('SIGTERM', () => {})
if (process.env.FAKE_LEAK_STDOUT === '1') {
  const gc = spawn('sleep', ['30'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] })
  gc.unref()
  if (process.env.FAKE_PID_FILE) writeFileSync(process.env.FAKE_PID_FILE, String(gc.pid))
}
if (process.env.FAKE_READY_FILE) writeFileSync(process.env.FAKE_READY_FILE, 'ready')
// The slash menu's commands probe (`commandsProbeArgs`, the only call whose --settings turns every hook off): it asks
// `initialize` and the skills dialog, never sends a message, and ends by closing stdin. Answered as a CLI with no commands or
// skills, and kept out of every FAKE_*_OUT file: it is not a run, and a script taking its first request for the message
// would log `engine commands probe failed` and show in the call log as a run of its agent.
function isCommandsProbe(argv) {
  const at = argv.indexOf('--settings')
  try { return at >= 0 && argv.includes('--strict-mcp-config') && JSON.parse(argv[at + 1]).disableAllHooks === true } catch { return false }
}
if (isCommandsProbe(process.argv.slice(2))) {
  const lines = createInterface({ input: process.stdin })
  lines.on('line', (l) => {
    let m
    try { m = JSON.parse(l) } catch { return }
    if (m?.type !== 'control_request') return
    const subtype = m.request?.subtype
    const response =
      subtype === 'initialize' ? { commands: [], agents: [], claude_code_version: '0.0.0-fake', models: [], pid: process.pid }
      : subtype === 'get_skills_dialog' ? { skills: [] }
      : null
    const answer = response
      ? { subtype: 'success', request_id: m.request_id, response }
      : { subtype: 'error', request_id: m.request_id, error: 'Unsupported control request' }
    process.stdout.write(JSON.stringify({ type: 'control_response', response: answer }) + '\n')
  })
  lines.on('close', () => process.exit(0))
  await new Promise(() => {}) // ended by the close above
}
// A run's env and argv only (it speaks stream-json): a one-shot call (the ack line, a moderator, the side picker, a summary)
// starts beside a run, and whichever wrote last would win. FAKE_INVOCATIONS_OUT logs every call.
const streams = process.argv.slice(2).join(' ').includes('--input-format stream-json')
if (process.env.FAKE_ENV_OUT && streams) writeFileSync(process.env.FAKE_ENV_OUT, JSON.stringify(process.env))
if (process.env.FAKE_ARGS_OUT && streams) writeFileSync(process.env.FAKE_ARGS_OUT, JSON.stringify(process.argv.slice(2)))
if (process.env.FAKE_INVOCATIONS_OUT) appendFileSync(process.env.FAKE_INVOCATIONS_OUT, JSON.stringify({ args: process.argv.slice(2), browser: Boolean(process.env.ZUMIBOT_BROWSER_CAPABILITY), desktop: Boolean(process.env.ZUMIBOT_DESKTOP_CAPABILITY), appSecret: Boolean(process.env.ZUMIBOT_LOCAL_SECRET), path: Boolean(process.env.PATH), tmpdir: process.env.CLAUDE_CODE_TMPDIR ?? null }) + '\n')
// `plugin list --json`, which Agent Studio's loadout card asks for every Claude agent: a CLI with no plugins. Its stdin is
// closed, so waiting for a first line below would end in exit 13, which the server logs as an error.
if (process.argv[2] === 'plugin' && process.argv[3] === 'list') {
  process.stdout.write('[]\n')
  process.exit(0)
}
// The ack line's one-shot call (acknowledge.ts, known by its system prompt) starts beside every turn. It is not the agent: it
// never runs the script, whose #PRE_TOOL, #WRITE_FILE and #MCP_CALL lines would act a second time, and it answers nothing, so
// no ack line shows. A room's moderator call still runs the script: group.e2e counts on that.
const ackAt = process.argv.indexOf('--system-prompt')
if (ackAt >= 0 && process.argv[ackAt + 1]?.startsWith("You write the one short line an assistant says right after the user's message")) {
  process.stdin.resume()
  process.stdin.on('end', () => process.exit(0))
  await new Promise(() => {}) // ended with stdin
}

const chunks = []
const answered = new Map() // request id -> its control_response's `response`
const waiters = new Map()
const steers = [] // mid-turn user messages not echoed yet, oldest first
let steerWaiter = null
const decoder = new StringDecoder('utf8')
let pending = ''
let started = false
let resolveFirst
const firstLine = new Promise(r => { resolveFirst = r })
const mcpChildren = []

process.on('exit', () => {
  // A run's stdin only, as for env and argv above: the ack line's one-shot call would overwrite it.
  if (process.env.FAKE_STDIN_OUT && streams) writeFileSync(process.env.FAKE_STDIN_OUT, Buffer.concat(chunks))
  // The real CLI stops its MCP servers when it ends; none may outlive the run.
  for (const c of mcpChildren) c.kill()
})

function onLine(l) {
  if (!started) { started = true; resolveFirst(); return }
  let m
  try { m = JSON.parse(l) } catch { return }
  // Stop through the Agent SDK adapter is this control_request, which the real CLI honours by abandoning its turn; the CLI
  // runner's Stop is SIGINT instead, which never reaches here as a line. Answer it, then emit nothing more.
  if (m?.type === 'control_request' && m.request?.subtype === 'interrupt') {
    try { writeSync(1, JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } }) + '\n') } catch { /* stdout gone */ }
    process.exit(Number(process.env.FAKE_EXIT ?? 0))
  }
  if (m?.type === 'user') {
    steers.push(m)
    steerWaiter?.()
    return
  }
  if (m?.type !== 'control_response') return
  if (process.env.FAKE_RESPONSES_FILE) appendFileSync(process.env.FAKE_RESPONSES_FILE, l + '\n')
  const id = m.response?.request_id
  answered.set(id, m.response)
  waiters.get(id)?.()
}
process.stdin.on('data', c => {
  chunks.push(c)
  pending += decoder.write(c)
  let i
  while ((i = pending.indexOf('\n')) >= 0) {
    const l = pending.slice(0, i)
    pending = pending.slice(i + 1)
    if (l) onLine(l)
  }
})
process.stdin.on('end', () => {
  if (process.env.FAKE_EXIT_ON_STDIN_END === '1') process.exit(Number(process.env.FAKE_EXIT ?? 0))
})
await firstLine

async function responseTo(id) {
  if (!answered.has(id)) await new Promise(r => waiters.set(id, r))
  return answered.get(id)
}

// ---------- #MCP_CALL: a real stdio MCP server from --mcp-config, called the way the CLI calls it ----------

let session = null // the script's session id, copied onto the lines #MCP_CALL writes
const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')

// ${VAR} and ${VAR:-default}, from this process's env: the CLI expands these in a server's command, args and env.
const expand = (s) => String(s).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, k, d) => process.env[k] ?? d ?? '')

/** Every server of every --mcp-config value: inline JSON or a file path, several values after one flag or several flags. */
function mcpServers() {
  const argv = process.argv.slice(2)
  const values = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--mcp-config=')) values.push(argv[i].slice('--mcp-config='.length))
    else if (argv[i] === '--mcp-config') while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) values.push(argv[++i])
  }
  const all = {}
  for (const v of values) Object.assign(all, JSON.parse(v.trimStart().startsWith('{') ? v : readFileSync(v, 'utf8')).mcpServers ?? {})
  return all
}

const servers = new Map() // name -> Promise of a JSON-RPC client, one server per name for the run

async function startServer(name) {
  const cfg = mcpServers()[name]
  if (!cfg) throw new Error(`No MCP server named ${name} in --mcp-config`)
  const env = { ...process.env, ...Object.fromEntries(Object.entries(cfg.env ?? {}).map(([k, v]) => [k, expand(v)])) }
  const child = spawn(expand(cfg.command), (cfg.args ?? []).map(expand), { env, stdio: ['pipe', 'pipe', 'pipe'] })
  mcpChildren.push(child)
  const calls = new Map()
  let next = 0
  let buf = ''
  let err = ''
  const failAll = (e) => { for (const c of calls.values()) c.reject(e); calls.clear() }
  child.stdin.on('error', () => {}) // a server that died is reported by its exit
  child.stderr.setEncoding('utf8').on('data', d => { err += d })
  child.stdout.setEncoding('utf8').on('data', d => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
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
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '0.0.0' } })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  return { request }
}

async function callTool(server, tool, args) {
  if (!servers.has(server)) servers.set(server, startServer(server))
  let timer
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`MCP call ${server}/${tool} timed out`)), 15_000) })
  try {
    const result = await Promise.race([servers.get(server).then(s => s.request('tools/call', { name: tool, arguments: args })), timeout])
    const text = (result?.content ?? []).filter(b => b?.type === 'text').map(b => b.text).join('\n')
    return { text, isError: result?.isError === true }
  } catch (e) {
    return { text: e instanceof Error ? e.message : String(e), isError: true }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * {"server", "tool", "args", "id", "permission"?}: the assistant's tool_use line, then (when `permission` names a request
 * id, as in manual mode) a can_use_tool request that waits for its answer, then the call itself and the user's
 * tool_result line, shaped like the real CLI's for an MCP tool (content blocks; is_error only when set).
 */
async function mcpCall(spec) {
  const { server, tool, args = {}, id, permission } = spec
  const name = `mcp__${server}__${tool}`
  out({ type: 'assistant', message: { model: 'claude-haiku-5-5', id: `msg_${id}`, type: 'message', role: 'assistant', content: [{ type: 'tool_use', id, name, input: args }], stop_reason: null, usage: { input_tokens: 2, output_tokens: 2 } }, parent_tool_use_id: null, session_id: session, uuid: randomUUID() })
  let input = args
  let result
  if (permission) {
    out({ type: 'control_request', request_id: permission, request: { subtype: 'can_use_tool', tool_name: name, input: args, tool_use_id: id } })
    const r = await responseTo(permission)
    if (r?.subtype === 'success' && r.response?.behavior === 'allow') input = r.response.updatedInput ?? args
    else result = { text: r?.response?.message ?? r?.error ?? 'Permission denied', isError: true }
  }
  result ??= await callTool(server, tool, input)
  if (process.env.FAKE_MCP_RESULTS_OUT) appendFileSync(process.env.FAKE_MCP_RESULTS_OUT, JSON.stringify({ id, tool: name, text: result.text, isError: result.isError }) + '\n')
  out({ type: 'user', message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: [{ type: 'text', text: result.text }], ...(result.isError ? { is_error: true } : {}) }] }, parent_tool_use_id: null, session_id: session, uuid: randomUUID(), timestamp: new Date().toISOString() })
}

// ---------- #PRE_TOOL: the PreToolUse hooks of --settings, run the way the CLI runs them before a tool call ----------

/** The CLI's matcher rule: none or '*' matches every tool, plain names (joined by |) match exactly, anything else is a regex. */
const hookMatches = (matcher, tool) =>
  !matcher || matcher === '*' ? true : /^[A-Za-z0-9_|]+$/.test(matcher) ? matcher.split('|').includes(tool) : new RegExp(matcher).test(tool)

/** The command of every PreToolUse hook whose matcher takes `tool`, from every --settings value (inline JSON or a file path). */
function preToolCommands(tool) {
  const argv = process.argv.slice(2)
  const values = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--settings=')) values.push(argv[i].slice('--settings='.length))
    else if (argv[i] === '--settings' && i + 1 < argv.length) values.push(argv[++i])
  }
  const commands = []
  for (const v of values) {
    const settings = JSON.parse(v.trimStart().startsWith('{') ? v : readFileSync(v, 'utf8'))
    for (const entry of settings?.hooks?.PreToolUse ?? []) {
      if (!hookMatches(entry?.matcher, tool)) continue
      for (const h of entry.hooks ?? []) if (h?.type === 'command' && typeof h.command === 'string') commands.push(h.command)
    }
  }
  return commands
}

/** One hook command through `sh -c` with this process's env (so ZUMIBOT_PAUSE_FILE reaches it) and the input on stdin. */
function runHook(command, input) {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], { env: process.env, stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', d => { stderr += d })
    child.stdin.on('error', () => {}) // a hook that exits without reading its input (no flag: `|| exit 0`)
    child.on('error', (e) => resolve({ code: null, stderr: e.message }))
    child.on('close', (code) => resolve({ code, stderr }))
    child.stdin.end(JSON.stringify(input))
  })
}

/**
 * {"id", "tool", "agentId": string | null, "parent"?, "input"?}: the PreToolUse hooks for a tool use the script already wrote. The
 * input carries agent_id and agent_type only for a subagent's call (agentId set), as the CLI's does. Exit 2 blocks the
 * call: the CLI then writes the tool's result itself, an error carrying the hook's stderr, and the model goes on.
 */
async function preTool(spec) {
  const { id, tool, agentId = null, agentType = 'general-purpose', parent, input: toolInput = {} } = spec
  const input = { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput, tool_use_id: id, ...(agentId ? { agent_id: agentId, agent_type: agentType } : {}) }
  const reasons = []
  for (const command of preToolCommands(tool)) {
    const r = await runHook(command, input)
    if (r.code === 2) reasons.push(r.stderr.trim())
  }
  const blocked = reasons.length > 0
  if (process.env.FAKE_HOOKS_OUT) appendFileSync(process.env.FAKE_HOOKS_OUT, JSON.stringify({ id, tool, agentId, blocked }) + '\n')
  if (blocked) out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: reasons.join('\n') }] }, parent_tool_use_id: parent ?? null, session_id: session, uuid: randomUUID(), timestamp: new Date().toISOString() })
}

/**
 * FAKE_STDOUT_DIR: one script per agent, <dir>/<agent>.jsonl, the agent taken from `--agent <name>` (an ask runs two
 * agents at once, each with its own script). A side run (`/btw`, a side ask) reads <dir>/<agent>.side.jsonl instead when
 * that file exists, so the agent's main run and its side answer can differ. Without it, FAKE_STDOUT_FILE as before.
 */
function scriptFile() {
  const dir = process.env.FAKE_STDOUT_DIR
  if (!dir) return process.env.FAKE_STDOUT_FILE
  const argv = process.argv.slice(2)
  // Both spellings the CLI takes: `--name value` from the CLI runner, `--name=value` from the Agent SDK adapter.
  const eq = argv.find((a) => a.startsWith('--agent='))
  const i = argv.indexOf('--agent')
  const agent = eq !== undefined ? eq.slice('--agent='.length) : i >= 0 ? argv[i + 1] : undefined
  if (!agent || !/^[A-Za-z0-9_.-]+$/.test(agent)) throw new Error('FAKE_STDOUT_DIR needs --agent <name>')
  const side = join(dir, `${agent}.side.jsonl`)
  if (argv.includes('--no-session-persistence') && existsSync(side)) return side
  return join(dir, `${agent}.jsonl`)
}

const scriptPath = scriptFile()
if (scriptPath) {
  const lines = readFileSync(scriptPath, 'utf8').split('\n').filter(Boolean)
  for (const l of lines) {
    if (l.startsWith('#WAIT_RESPONSE ')) {
      await responseTo(l.slice('#WAIT_RESPONSE '.length).trim())
      continue
    }
    if (l.startsWith('#SLEEP ')) { await sleep(Number(l.slice('#SLEEP '.length))); continue } // slow streams for the browser e2e
    // Holds the script until the file exists: an e2e lets the run go on once it has seen what it waits to check.
    if (l.startsWith('#WAIT_FILE ')) {
      const path = l.slice('#WAIT_FILE '.length).trim()
      while (!existsSync(path)) await sleep(50)
      continue
    }
    // Waits until a mid-turn user message is on stdin, echoing nothing yet (an e2e then sees it waiting).
    if (l === '#WAIT_STEER') {
      if (steers.length === 0) await new Promise(r => { steerWaiter = r })
      steerWaiter = null
      continue
    }
    // The CLI taking in a mid-turn user message: waits for the next one on stdin and echoes it as --replay-user-messages does.
    if (l === '#STEER_REPLAY') {
      if (steers.length === 0) await new Promise(r => { steerWaiter = r })
      steerWaiter = null
      const m = steers.shift()
      process.stdout.write(JSON.stringify({ type: 'user', isReplay: true, uuid: m.uuid, message: m.message, session_id: session }) + '\n')
      await sleep(5)
      continue
    }
    // A script tool call with a real effect: {"path": ..., "content": ...} is written (parents made) at this point.
    if (l.startsWith('#WRITE_FILE ')) {
      const { path, content } = JSON.parse(l.slice('#WRITE_FILE '.length))
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
      continue
    }
    if (l.startsWith('#MCP_CALL ')) {
      await mcpCall(JSON.parse(l.slice('#MCP_CALL '.length)))
      await sleep(5)
      continue
    }
    if (l.startsWith('#PRE_TOOL ')) {
      await preTool(JSON.parse(l.slice('#PRE_TOOL '.length)))
      await sleep(5)
      continue
    }
    if (session === null && l.includes('"session_id"')) {
      try { session = JSON.parse(l).session_id ?? null } catch { /* not JSON: written as is */ }
    }
    process.stdout.write(l + '\n')
    await sleep(5)
  }
}
if (process.env.FAKE_SPLIT_UTF8 === '1') {
  const buf = Buffer.from('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi 👋"}}}\n')
  const cut = buf.indexOf(Buffer.from('👋')) + 2
  process.stdout.write(buf.subarray(0, cut))
  await sleep(30)
  process.stdout.write(buf.subarray(cut))
}
if (process.env.FAKE_STDERR) process.stderr.write(process.env.FAKE_STDERR)
if (process.env.FAKE_HANG === '1') setInterval(() => {}, 1000)
else process.exit(Number(process.env.FAKE_EXIT ?? 0))
