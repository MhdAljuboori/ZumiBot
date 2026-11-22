#!/usr/bin/env node
// A stand-in for the real claude CLI, for the desktop ask probe's unit tests (desktopAskProbe.test.ts); no quota.
// It speaks stream-json like the CLI and really starts the stub MCP server from `--mcp-config`, so "ran" means the stub
// ran. FAKE_PROBE_MODES is a comma list, one mode per invocation (counted in FAKE_PROBE_STATE):
//   ask         screenshot runs unasked, then desktop_click sends can_use_tool and runs on allow (what the ask rule does)
//   unasked     desktop_click runs without can_use_tool
//   allowwins   like ask, unless the --settings also allow desktop_click: then it runs unasked (allow beating ask)
//   never       only the screenshot; the model never calls desktop_click
//   unconnected init reports the stub server as failed; no tool calls
//   auth        init, then an error result, as when not signed in
//   selfdeny    desktop_click is refused by the CLI itself: an error tool_result, no can_use_tool, nothing runs
//   noinit      prints to stderr and exits 1 before any output
//   hang        init, then waits forever, even past stdin's end (for the signal test)
// The vault guard probe (vaultGuardProbe.test.ts) uses the v- modes, which apply the run's own --settings the way the CLI does
// (deny rules for Read, the Bash PreToolUse hooks run with sh -c on the call's JSON; exit 2 blocks with the hook's stderr) to
// the Read and Bash calls the prompt asks for (`file_path "<p>"`, `command "<c>"`):
//   v-guard       both calls are held by the settings: PASS
//   v-leak-read   the Read ignores the deny rules and returns the file
//   v-leak-bash   the Bash hook is ignored and cat prints the file
//   v-other-bash  Bash is refused by something else (an error result without the hook's text)
//   v-never       no tool call at all
//   v-auth        init, then an error result, as when not signed in (noinit works too)
// The extensions probe (extensionsProbe.test.ts) uses the e- modes, one mode for every invocation (the probe starts the CLI many
// times): the control requests of a model-free session, `plugin list --json`, `mcp add-json` and the Haiku-style model runs
// all follow the run's own flags, as the CLI does:
//   e-ok            everything as the real CLI 2.1.322 does it
//   e-denyignored   deniedMcpServers is ignored (the server stays listed)
//   e-error         mcp_status answers with an error
//   e-noserver      the project's .mcp.json server is never listed (nothing to deny)
//   e-noplugin      `plugin list --json` lists no plugin
//   e-prefix        the tool prefix collapses runs of `_` (not the rule the app assumes)
//   e-guardleak     another hook's allow beats the guard's block
//   e-agentkeys     an agent file's hooks and mcpServers are loaded under --agent
//   e-allowdead     the allow hook is ignored (it never allows a call by itself)
//   e-agentmissing  the --agent file is not found (not in init.agents, its prompt not in force)
//   e-localcwd      `mcp add-json -s local` keys by the folder's real path, ignoring .git (not the rule the app relies on)
//   e-strict        a stricter settings schema: a hook timeout that is not a whole number drops the whole --settings (as 0 does)
//   e-allowsall     something outside the run's settings (a managed policy) lets Bash run with no hook and every request denied
// FAKE_PROBE_ARGS gets one JSON line of argv per invocation; FAKE_PROBE_PID gets this process's pid.
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const argv = process.argv.slice(2)
if (argv[0] === '--version') { console.log('9.9.9-fake (Claude Code)'); process.exit(0) }
if (process.env.FAKE_PROBE_ARGS) appendFileSync(process.env.FAKE_PROBE_ARGS, JSON.stringify(argv) + '\n')
if (process.env.FAKE_PROBE_PID) writeFileSync(process.env.FAKE_PROBE_PID, String(process.pid))
const state = process.env.FAKE_PROBE_STATE
const run = state ? Number((() => { try { return readFileSync(state, 'utf8') } catch { return '0' } })()) : 0
if (state) writeFileSync(state, String(run + 1))
const modes = (process.env.FAKE_PROBE_MODES ?? 'ask').split(',')
const mode = modes[0].startsWith('e-') ? modes[0] : modes[Math.min(run, modes.length - 1)]
const SERVER = 'zumibot_desktop', CLICK = `mcp__${SERVER}__desktop_click`, SCREENSHOT = `mcp__${SERVER}__desktop_screenshot`

const out = (m) => process.stdout.write(JSON.stringify(m) + '\n')
if (mode.startsWith('e-') && argv[0] === 'plugin') { console.log(JSON.stringify(mode === 'e-noplugin' ? [] : [{ id: 'demo@mk', scope: 'user', enabled: true }])); process.exit(0) }
if (mode.startsWith('e-') && argv[0] === 'mcp') {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? process.env.HOME, file = join(dir, '.claude.json')
  mkdirSync(dir, { recursive: true })
  // The CLI's key: the real path of the nearest ancestor with a .git entry (file or directory), else of the folder.
  let key = realpathSync(process.cwd())
  if (mode !== 'e-localcwd') for (let d = key; ; d = dirname(d)) { if (existsSync(join(d, '.git'))) { key = d; break } if (dirname(d) === d) break }
  writeFileSync(file, JSON.stringify({ projects: { [key]: { mcpServers: { [argv[2]]: JSON.parse(argv[3]) } } } }))
  console.log(`Added stdio MCP server ${argv[2]} to local config`); process.exit(0)
}
if (mode === 'noinit') { process.stderr.write('Not logged in · Please run /login\n'); process.exit(1) }

// The stub MCP server, started like the CLI does from the config, answering initialize and tools/call.
const config = mode.startsWith('v-') || mode.startsWith('e-') ? null : JSON.parse(argv[argv.indexOf('--mcp-config') + 1]).mcpServers[SERVER]
let mcp = null, id = 0, mcpBuf = ''
const waiting = new Map()
function startMcp() {
  mcp = spawn(config.command, config.args, { env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'ignore'] })
  mcp.stdout.setEncoding('utf8').on('data', (c) => {
    mcpBuf += c
    for (let i; (i = mcpBuf.indexOf('\n')) >= 0;) {
      const m = JSON.parse(mcpBuf.slice(0, i)); mcpBuf = mcpBuf.slice(i + 1)
      waiting.get(m.id)?.(m); waiting.delete(m.id)
    }
  })
}
const rpc = (method, params) => new Promise((resolve) => { const n = ++id; waiting.set(n, resolve); mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n') })
const toolUse = (useId, name, input) => out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: useId, name, input }] } })
const toolResult = (useId, text, isError) => out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: useId, content: text, is_error: isError }] } })
async function runTool(useId, name, input) {
  const r = await rpc('tools/call', { name: name.slice(`mcp__${SERVER}__`.length), arguments: input })
  toolResult(useId, r.result?.content?.[0]?.text ?? 'error', !!r.error)
}
const finish = (result = 'DONE', isError = false) => out({ type: 'result', subtype: isError ? 'error_during_execution' : 'success', is_error: isError, result, session_id: 's' })

let buf = '', started = false, answer = null
process.stdin.setEncoding('utf8').on('data', async (c) => {
  buf += c
  for (let i; (i = buf.indexOf('\n')) >= 0;) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)
    if (m.type === 'control_response') { answer?.(m.response); continue }
    if (mode.startsWith('e-') && m.type === 'control_request') { extControl(m); continue }
    if (started) continue
    started = true
    await play(typeof m.message?.content === 'string' ? m.message.content : '')
  }
})
// A hung CLI does not notice its stdin closing; only a kill of its group ends it (and the stub server).
process.stdin.on('end', () => { if (mode !== 'hang') { mcp?.kill(); process.exit(0) } })

// The vault probe's two calls, held (or not) by the settings the run was started with.
function playVault(prompt) {
  const settings = JSON.parse(argv[argv.indexOf('--settings') + 1])
  const path = /file_path "([^"]+)"/.exec(prompt)?.[1], cmd = /command "([^"]+)"/.exec(prompt)?.[1]
  out({ type: 'system', subtype: 'init', session_id: 's', claude_code_version: '9.9.9-fake', mcp_servers: [] })
  if (mode === 'v-auth') return finish('Invalid API key · Please run /login', true)
  if (mode === 'v-never') return finish('I will not read that.')
  // As Claude Code on Windows: a rule names `C:\x` as `//c/x`, so the path is matched in that form there.
  const rulePath = process.platform === 'win32' ? path.replace(/^([A-Za-z]):[\\/]/, (_m, d) => `/${d.toLowerCase()}/`).replace(/\\/g, '/') : path
  const denied = (settings.permissions?.deny ?? []).some((rule) => {
    const m = /^Read\((.*)\)$/.exec(rule)
    if (!m) return false
    const p = m[1].slice(1)
    return p.endsWith('/**') ? rulePath.startsWith(p.slice(0, -2)) : rulePath === p
  })
  toolUse('t1', 'Read', { file_path: path })
  if (denied && mode !== 'v-leak-read') toolResult('t1', "Permission to use Read has been denied.", true)
  else toolResult('t1', readFileSync(path, 'utf8'), false)
  toolUse('t2', 'Bash', { command: cmd })
  if (mode === 'v-other-bash') { toolResult('t2', 'Permission to use Bash has been denied.', true); return finish() }
  if (mode !== 'v-leak-bash') {
    for (const h of settings.hooks?.PreToolUse ?? []) {
      if (h.matcher !== 'Bash' && h.matcher !== '*') continue
      for (const hook of h.hooks) {
        const r = spawnSync('sh', ['-c', hook.command], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: cmd } }), encoding: 'utf8' })
        if (r.status === 2) { toolResult('t2', `PreToolUse:Bash hook error: [sh]: ${r.stderr.trim()}`, true); return finish() }
      }
    }
  }
  // sh would eat a Windows path's backslashes; a model would write the path so that cat finds it.
  const ran = process.platform === 'win32' ? cmd.replace(/\\/g, '/') : cmd
  toolResult('t2', spawnSync('sh', ['-c', ran], { encoding: 'utf8' }).stdout, false)
  finish()
}

// ---- the e- modes: a model-free control session and Haiku-style model runs, driven by the run's own flags ----
// Both spellings the CLI takes: `--name value` from the CLI runner, `--name=value` from the Agent SDK adapter.
const flag = (name) => {
  const eq = argv.find((a) => a.startsWith(`${name}=`))
  if (eq !== undefined) return eq.slice(name.length + 1)
  return argv.includes(name) ? argv[argv.indexOf(name) + 1] : null
}
// As claude 2.1.322: one PreToolUse hook with a timeout of 0 or below drops the WHOLE --settings, silently. e-strict also drops it for
// any hook whose timeout is not a whole number (a stricter schema in a later CLI).
const dropsSettings = (s) => Object.entries(s.hooks ?? {}).some(([event, groups]) => Array.isArray(groups) && groups.some((g) => (g.hooks ?? []).some((h) =>
  typeof h.timeout === 'number' && ((event === 'PreToolUse' && h.timeout <= 0) || (mode === 'e-strict' && !Number.isInteger(h.timeout))))))
const runSettings = () => {
  const s = flag('--settings') ? JSON.parse(flag('--settings')) : {}
  return dropsSettings(s) ? {} : s
}
const KNOWN_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'Stop', 'SessionStart', 'UserPromptSubmit', 'Notification'])
function extControl(m) {
  const settings = runSettings()
  const reply = (response) => out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response } })
  const sub = m.request.subtype
  if (sub === 'initialize') return reply({ claude_code_version: '9.9.9-fake', commands: [], agents: [] })
  if (sub === 'get_settings') return reply({ effective: { ...(settings.permissions ? { permissions: settings.permissions } : {}), ...(settings.hooks ? { hooks: settings.hooks } : {}) }, sources: flag('--settings') && Object.keys(settings).length ? [{ source: 'flagSettings', settings }] : [] })
  if (sub === 'mcp_status') {
    if (mode === 'e-error') return out({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: 'unsupported' } })
    let project = {}
    try { project = JSON.parse(readFileSync(join(process.cwd(), '.mcp.json'), 'utf8')).mcpServers ?? {} } catch { /* none */ }
    const denied = mode === 'e-denyignored' ? [] : (settings.deniedMcpServers ?? []).map((d) => d.serverName)
    const names = Object.keys(project).filter((n) => settings.enableAllProjectMcpServers && mode !== 'e-noserver' && !denied.includes(n))
    return reply({ mcpServers: names.map((name) => ({ name, status: 'connected', config: { type: 'stdio', command: 'x' }, scope: 'project', tools: [{ name: 'ping' }] })) })
  }
  if (sub === 'get_skills_dialog') {
    let dirs = []
    try { dirs = readdirSync(join(process.cwd(), '.claude', 'skills')) } catch { /* none */ }
    const skills = dirs.map((name) => ({ name, source: 'project', state: settings.skillOverrides?.[name] === 'off' ? 'off' : 'on', advertised: true }))
    if (settings.enabledPlugins?.['demo@mk'] !== false) skills.push({ name: 'demo:greet', source: 'plugin', state: 'on', advertised: true })
    return reply({ skills })
  }
  // One row per hook of a known event, as the CLI lists them (an unknown event's hooks are kept but not listed).
  const hooks = Object.entries(settings.hooks ?? {}).filter(([event]) => KNOWN_EVENTS.has(event)).flatMap(([event, groups]) =>
    groups.flatMap((g) => (g.hooks ?? []).map((h) => ({ event, matcher: g.matcher ?? '', source: 'flagSettings', type: 'command', commandText: h.command }))))
  if (settings.enabledPlugins?.['demo@mk'] !== false) hooks.push({ event: 'SessionStart', matcher: '', source: 'pluginHook', pluginName: 'demo@mk', type: 'command' })
  reply({ events: [], hooks })
}
const hookOut = (command, input = {}) => spawnSync('sh', ['-c', command], { input: JSON.stringify(input), encoding: 'utf8' })
async function playExt(prompt) {
  const settings = runSettings()
  const prefix = (n) => 'mcp__' + n.replace(/[^A-Za-z0-9_-]/g, '_')
  const squash = (n) => (mode === 'e-prefix' ? 'mcp__' + prefix(n).slice(5).replace(/_+/g, '_') : prefix(n))
  const names = Object.keys(flag('--mcp-config') ? JSON.parse(flag('--mcp-config')).mcpServers : {})
  const off = []
  for (let i = argv.indexOf('--disallowedTools') + 1; i > 0 && i < argv.length && !argv[i].startsWith('--'); i++) off.push(argv[i])
  const agent = flag('--agent')
  let agentText = ''
  if (agent) try { agentText = readFileSync(join(process.cwd(), '.claude', 'agents', `${agent}.md`), 'utf8') } catch { /* none */ }
  if (mode === 'e-agentkeys' && agentText.includes('agentsrv')) names.push('agentsrv')
  const tools = names.filter((n) => !off.includes(prefix(n))).map((n) => `${squash(n)}__ping`)
  const agentLoaded = !!agentText && mode !== 'e-agentmissing'
  out({ type: 'system', subtype: 'init', session_id: 's', claude_code_version: '9.9.9-fake', tools: ['Bash', ...tools], agents: ['claude', ...(agentLoaded ? [agent] : [])], mcp_servers: names.map((name) => ({ name, status: 'connected' })) })
  for (const h of settings.hooks?.UserPromptSubmit ?? []) for (const x of h.hooks) hookOut(x.command)
  const own = /command: ("[^\n]*touch [^\n]*")/.exec(agentText)
  if (mode === 'e-agentkeys' && own) hookOut(JSON.parse(own[1]))
  const cmd = /run exactly this command: ([^\n]+)/.exec(prompt)?.[1]
  if (!cmd) return finish(agentLoaded ? 'PROBE-AGENT-OK' : 'OK')
  toolUse('t1', 'Bash', { command: cmd })
  const hooks = (settings.hooks?.PreToolUse ?? []).flatMap((h) => h.hooks)
  const runs = hooks.map((x) => hookOut(x.command, { tool_name: 'Bash', tool_input: { command: cmd } }))
  const allowed = mode !== 'e-allowdead' && runs.some((r) => r.stdout.includes('"permissionDecision":"allow"'))
  const blocked = runs.find((r) => r.status === 2)
  if (blocked && !(mode === 'e-guardleak' && allowed)) { toolResult('t1', `PreToolUse:Bash hook error: [sh]: ${blocked.stderr.trim()}`, true); return finish('BLOCKED') }
  // Without an allowing hook a permission mode other than auto asks the client first, as the CLI does.
  if (!allowed && flag('--permission-mode') !== 'auto' && mode !== 'e-allowsall') {
    const response = await new Promise((resolve) => {
      answer = resolve
      out({ type: 'control_request', request_id: 'p1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: cmd }, tool_use_id: 't1' } })
    })
    if (response?.response?.behavior !== 'allow') { toolResult('t1', 'Permission to use Bash has been denied.', true); return finish('DENIED') }
  }
  toolResult('t1', spawnSync('sh', ['-c', cmd], { encoding: 'utf8' }).stdout, false)
  finish('DONE')
}

async function play(prompt) {
  if (mode.startsWith('e-')) return playExt(prompt)
  if (mode.startsWith('v-')) return playVault(prompt)
  const connected = mode !== 'unconnected'
  if (connected) { startMcp(); await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-probe-claude', version: '1' } }) }
  out({ type: 'system', subtype: 'init', session_id: 's', claude_code_version: '9.9.9-fake', mcp_servers: [{ name: SERVER, status: connected ? 'connected' : 'failed' }] })
  if (mode === 'hang') return
  if (mode === 'auth') return finish('Invalid API key · Please run /login', true)
  if (mode === 'unconnected') return finish('I have no such tools.')
  toolUse('t1', SCREENSHOT, {})
  await runTool('t1', SCREENSHOT, {})
  if (mode === 'never') return finish()
  toolUse('t2', CLICK, { x: 10, y: 20 })
  if (mode === 'selfdeny') { toolResult('t2', 'Permission to use this tool was denied.', true); return finish() }
  // Reads the run's own settings, so the same mode passes without the allow rule and fails with it.
  const allowed = mode === 'allowwins' && (JSON.parse(argv[argv.indexOf('--settings') + 1]).permissions?.allow ?? []).includes(CLICK)
  if (mode === 'ask' || (mode === 'allowwins' && !allowed)) {
    const response = await new Promise((resolve) => {
      answer = resolve
      out({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: CLICK, input: { x: 10, y: 20 }, tool_use_id: 't2' } })
    })
    if (response?.response?.behavior !== 'allow') { toolResult('t2', 'Denied', true); return finish() }
  }
  await runTool('t2', CLICK, { x: 10, y: 20 })
  finish()
}
