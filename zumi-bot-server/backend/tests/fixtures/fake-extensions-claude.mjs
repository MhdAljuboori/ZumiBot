#!/usr/bin/env node
// Fake claude for the extensions probe and the `claude mcp` / `claude plugin` subcommands; no quota. State is the JSON file named
// by FAKE_EXT_STATE: {version, mcpServers, skills, hooks, plugins}, each list in the shape the real CLI answers (mcp_status entries,
// get_skills_dialog entries, get_hooks_listing entries, `claude plugin list --json` entries).
//
// Session mode (argv without `mcp` / `plugin` first): stream-json over stdin, `type: control_request` lines answered as the real CLI
// does (initialize, mcp_status, get_skills_dialog, get_hooks_listing; any other subtype, or one named in
// FAKE_EXT_ERROR_SUBTYPES (comma list), gets an error answer), after a few `type: system` hook lines that a probe must ignore.
// get_hooks_listing reads the settings files as the real CLI does (see `fileHooks`), then adds the state's `hooks` (plugin rows, or a
// row no file holds).
//  - FAKE_EXT_PENDING_POLLS=n: the first n mcp_status answers report one server `pending` (the first one, or a made-up one).
//  - FAKE_EXT_HANG=1: never answers and ignores stdin ending; only a signal ends it. FAKE_EXT_IGNORE_TERM=1 ignores SIGTERM too, and
//    FAKE_EXT_GRANDCHILD=1 starts a `sleep` in the same process group (its pid goes to `<FAKE_EXT_PID_FILE>.child`).
//  - FAKE_EXT_EXIT=1: exits 1 at once, as a CLI that does not know the flags would.
//  - A `type: user` line is a turn, which a probe must never send: exit 3, unless FAKE_EXT_ALLOW_TURN is set, which runs
//    fake-claude.mjs (same argv, env and stdin from that line on) as a child to answer it.
//  - The session ends when stdin ends, or on SIGTERM.
// Subcommands: `mcp add-json <name> <json> [-s scope]` (scope defaults to local; an existing name in that scope is refused as the real
// CLI does), `mcp remove <name> [-s scope]` (refused when none), `plugin enable|disable <id> [-s scope] [--json]` and
// `plugin list --json` change or print the state file. Each appends its argv as one JSON line to FAKE_EXT_CLI_OUT, with every env
// and header value of the JSON argument replaced by `<value>`. FAKE_EXT_FAIL_ADD=1 makes `mcp add-json` exit 1 after logging;
// FAKE_EXT_FAIL_ADD_ONCE=<path> does that only while the file is missing, and makes it, so the add after it (a restore) works.
// FAKE_EXT_SLOW_ADD_ONCE=<path>: while the file is missing, `mcp add-json` writes its pid there and hangs until a signal ends it.
// Logs for tests: FAKE_EXT_PID_FILE (this pid), FAKE_EXT_START_OUT (a session's {args, cwd, envNames}), FAKE_EXT_REQ_OUT (one line
// per control request subtype, `USER` for a user line).
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const env = process.env

const readState = () => {
  const blank = { version: '0.0.0-fake', mcpServers: [], skills: [], hooks: [], plugins: [] }
  if (!env.FAKE_EXT_STATE || !existsSync(env.FAKE_EXT_STATE)) return blank
  return { ...blank, ...JSON.parse(readFileSync(env.FAKE_EXT_STATE, 'utf8')) }
}
const writeState = (s) => env.FAKE_EXT_STATE && writeFileSync(env.FAKE_EXT_STATE, JSON.stringify(s, null, 2))
const logCli = (args) => env.FAKE_EXT_CLI_OUT && appendFileSync(env.FAKE_EXT_CLI_OUT, JSON.stringify(args) + '\n')

if (argv[0] === 'mcp' || argv[0] === 'plugin') {
  // Both spellings the CLI takes: `--name value` from the CLI runner, `--name=value` from the Agent SDK adapter.
  const flag = (name) => {
    const eq = argv.find((a) => a.startsWith(`${name}=`))
    if (eq !== undefined) return eq.slice(name.length + 1)
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const state = readState()
  const fail = (msg) => { process.stderr.write(msg + '\n'); process.exit(1) }
  if (argv[0] === 'mcp' && argv[1] === 'add-json') {
    const name = argv[2]
    let def
    try { def = JSON.parse(argv[3]) } catch { logCli(argv); fail('Invalid JSON') }
    const redacted = { ...def }
    for (const k of ['env', 'headers']) if (redacted[k]) redacted[k] = Object.fromEntries(Object.keys(redacted[k]).map((n) => [n, '<value>']))
    logCli(argv.map((a, i) => (i === 3 ? JSON.stringify(redacted) : a)))
    // A slow first add (until a signal ends it), as a stop between an edit's remove and add would find it; later adds are quick.
    if (env.FAKE_EXT_SLOW_ADD_ONCE && !existsSync(env.FAKE_EXT_SLOW_ADD_ONCE)) {
      writeFileSync(env.FAKE_EXT_SLOW_ADD_ONCE, String(process.pid))
      setInterval(() => {}, 1000)
      await new Promise(() => {})
    }
    if (env.FAKE_EXT_FAIL_ADD === '1') fail('Failed to add')
    if (env.FAKE_EXT_FAIL_ADD_ONCE && !existsSync(env.FAKE_EXT_FAIL_ADD_ONCE)) {
      writeFileSync(env.FAKE_EXT_FAIL_ADD_ONCE, '')
      fail('Failed to add')
    }
    const scope = flag('-s') ?? flag('--scope') ?? 'local'
    if (state.mcpServers.some((s) => s.name === name && s.scope === scope)) fail(`MCP server ${name} already exists in ${scope} config`)
    state.mcpServers.push({ name, status: 'connected', config: def, transport: def.type ?? 'stdio', scope, tools: [] })
    writeState(state)
    console.log(`Added MCP server ${name} to ${scope} config`)
  } else if (argv[0] === 'mcp' && argv[1] === 'remove') {
    logCli(argv)
    const name = argv[2]
    const scope = flag('-s') ?? flag('--scope')
    const keep = state.mcpServers.filter((s) => !(s.name === name && (!scope || s.scope === scope)))
    if (keep.length === state.mcpServers.length) fail(`No MCP server found with name: ${name}`)
    state.mcpServers = keep
    writeState(state)
    console.log(`Removed MCP server ${name}`)
  } else if (argv[0] === 'plugin' && (argv[1] === 'enable' || argv[1] === 'disable')) {
    logCli(argv)
    const p = state.plugins.find((x) => x.id === argv[2])
    if (!p) fail(`Plugin not found: ${argv[2]}`)
    p.enabled = argv[1] === 'enable'
    writeState(state)
    console.log(argv.includes('--json') ? JSON.stringify({ id: p.id, enabled: p.enabled }) : `${p.id} is now ${p.enabled ? 'enabled' : 'disabled'}`)
  } else if (argv[0] === 'plugin' && argv[1] === 'list') {
    logCli(argv)
    console.log(JSON.stringify(state.plugins))
  } else fail('Unknown command')
  process.exit(0)
}

// ---- a session ----
if (env.FAKE_EXT_PID_FILE) writeFileSync(env.FAKE_EXT_PID_FILE, String(process.pid))
if (env.FAKE_EXT_EXIT === '1') process.exit(1)
if (env.FAKE_EXT_START_OUT) appendFileSync(env.FAKE_EXT_START_OUT, JSON.stringify({ args: argv, cwd: process.cwd(), envNames: Object.keys(env).sort() }) + '\n')
if (env.FAKE_EXT_IGNORE_TERM === '1') process.on('SIGTERM', () => {})
if (env.FAKE_EXT_GRANDCHILD === '1') {
  // Same process group on purpose: the probe must end the whole group, not only this pid.
  // Windows has no `sleep` unless Git's usr/bin is on PATH: a node that waits stands in.
  const gc =
    process.platform === 'win32'
      ? spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
      : spawn('sleep', ['60'], { stdio: 'ignore' })
  if (env.FAKE_EXT_PID_FILE) writeFileSync(env.FAKE_EXT_PID_FILE + '.child', String(gc.pid))
}
if (env.FAKE_EXT_HANG === '1') {
  // stdin is never read and its end changes nothing: a stuck CLI, ended by a signal only
  setInterval(() => {}, 1000)
  process.stdin.resume()
} else {
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
  const state = readState()
  const errorSubtypes = (env.FAKE_EXT_ERROR_SUBTYPES ?? '').split(',').filter(Boolean)
  let pendingLeft = Number(env.FAKE_EXT_PENDING_POLLS ?? 0)
  let child = null
  let buf = Buffer.alloc(0)

  // What the real CLI prints while it starts: a probe has to skip all of it.
  out({ type: 'system', subtype: 'hook_started', hook_id: 'h1', hook_name: 'SessionStart:startup', hook_event: 'SessionStart' })
  out({ type: 'system', subtype: 'hook_response', hook_id: 'h1', output: 'noise', exit_code: 0, outcome: 'success' })
  out({ type: 'system', subtype: 'commands_changed', commands: [] })

  const answer = (id, response) => out({ type: 'control_response', response: { subtype: 'success', request_id: id, response } })
  const refuse = (id) => out({ type: 'control_response', response: { subtype: 'error', request_id: id, error: 'Unsupported control request' } })

  // The settings files' hooks, as claude 2.1.322 lists them: the user's file, the folder's settings.json, the folder's
  // settings.local.json and the repo root's (the nearest folder up holding .git), each file once; one that does not parse, or that
  // holds a PreToolUse hook timed 0 or below, is dropped whole and silently; then the run's --settings (flagSettings). No timeout.
  const fileHooks = () => {
    const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
    const drops = (s) => Array.isArray(s.hooks?.PreToolUse) && s.hooks.PreToolUse.some((g) => (g?.hooks ?? []).some((h) => typeof h?.timeout === 'number' && h.timeout <= 0))
    const rowsOf = (s, source) => !isPlain(s) || !isPlain(s.hooks) || drops(s) ? [] : Object.entries(s.hooks).flatMap(([event, groups]) => !Array.isArray(groups) ? [] : groups.flatMap((g) =>
      (Array.isArray(g?.hooks) ? g.hooks : []).map((h) => ({ event, matcher: typeof g.matcher === 'string' ? g.matcher : '', source, sourceLabel: source, type: typeof h?.type === 'string' ? h.type : 'command', commandText: typeof h?.command === 'string' ? h.command : undefined }))))
    const read = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }
    const cwd = process.cwd()
    let root = null
    for (let d = cwd; ; d = dirname(d)) { if (existsSync(join(d, '.git'))) { root = d; break } if (dirname(d) === d) break }
    const files = [
      ['userSettings', join(env.CLAUDE_CONFIG_DIR || join(env.HOME ?? '', '.claude'), 'settings.json')],
      ['projectSettings', join(cwd, '.claude', 'settings.json')],
      ['localSettings', join(cwd, '.claude', 'settings.local.json')],
      ...(root ? [['localSettings', join(root, '.claude', 'settings.local.json')]] : [])
    ]
    const seen = new Set()
    const rows = []
    for (const [source, path] of files) {
      if (seen.has(path)) continue
      seen.add(path)
      rows.push(...rowsOf(read(path), source))
    }
    const i = argv.indexOf('--settings')
    if (i >= 0) rows.push(...rowsOf((() => { try { return JSON.parse(argv[i + 1]) } catch { return null } })(), 'flagSettings'))
    return rows
  }

  const mcpStatus = () => {
    const servers = state.mcpServers.map((s) => ({ ...s }))
    if (pendingLeft > 0) {
      pendingLeft--
      if (servers.length) servers[0] = { ...servers[0], status: 'pending' }
      else servers.push({ name: 'slow-server', status: 'pending', config: {}, scope: 'dynamic' })
    }
    return { mcpServers: servers }
  }
  const respond = (id, subtype) => {
    if (errorSubtypes.includes(subtype)) return refuse(id)
    switch (subtype) {
      // Beside the version, what the real answer holds and a probe must not keep.
      case 'initialize': return answer(id, { commands: [], agents: [], claude_code_version: state.version, account: { email: 'someone@example.invalid' }, models: [], pid: process.pid })
      case 'mcp_status': return answer(id, mcpStatus())
      case 'get_skills_dialog': return answer(id, { skills: state.skills })
      case 'get_hooks_listing': {
        const hooks = [...fileHooks(), ...state.hooks]
        return answer(id, { events: [...new Set(hooks.map((h) => h.event))], hooks })
      }
      default: return refuse(id)
    }
  }

  const onLine = (line) => {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    if (msg?.type === 'control_request') {
      const subtype = msg.request?.subtype
      if (env.FAKE_EXT_REQ_OUT) appendFileSync(env.FAKE_EXT_REQ_OUT, String(subtype) + '\n')
      respond(msg.request_id, subtype)
    }
  }

  const startTurn = (rest) => {
    child = spawn(process.execPath, [fileURLToPath(new URL('./fake-claude.mjs', import.meta.url)), ...argv], { stdio: ['pipe', 'inherit', 'inherit'], env })
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { child.kill(sig); setTimeout(() => process.exit(1), 200) })
    child.on('exit', (code, sig) => process.exit(code ?? (sig ? 1 : 0)))
    child.stdin.on('error', () => {})
    child.stdin.write(rest)
  }

  process.stdin.on('data', (chunk) => {
    if (child) { child.stdin.write(chunk); return }
    buf = Buffer.concat([buf, chunk])
    for (let nl; (nl = buf.indexOf(10)) >= 0;) {
      const line = buf.subarray(0, nl).toString('utf8')
      let type
      try { type = JSON.parse(line)?.type } catch { type = null }
      if (type === 'user') {
        if (env.FAKE_EXT_REQ_OUT) appendFileSync(env.FAKE_EXT_REQ_OUT, 'USER\n')
        if (!env.FAKE_EXT_ALLOW_TURN) process.exit(3)
        // fake-claude.mjs takes the first stdin line as the user message: hand it this line and everything after
        const rest = buf
        buf = Buffer.alloc(0)
        startTurn(rest)
        return
      }
      buf = buf.subarray(nl + 1)
      onLine(line)
    }
  })
  process.stdin.on('end', () => {
    if (child) child.stdin.end()
    else process.exit(0)
  })
}
