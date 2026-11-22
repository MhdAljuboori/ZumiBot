// Probe of the real claude CLI for Pause (spec: docs/superpowers/specs/2026-11-06-pause-resume-design.md).
// A paused chat's run blocks every new main-thread tool call with the app's PreToolUse hook (`pauseSettings` over the built
// backend/dist/pauseHook.mjs), while the subagents already running finish. This checks the three CLI facts that rests on:
// the hook runs for main-thread calls and its block reaches the model as an is_error tool result carrying the hook's stderr;
// ZUMIBOT_PAUSE_FILE from the run's env reaches the hook (its flag test); a subagent's calls carry agent_id, so they run
// while the main thread is blocked, and the subagent hands its result back to the main thread (so the session holds it).
// One --agent session in auto mode dispatches a subagent that runs `echo sub-ok`, then runs `echo main-ok` itself; the flag
// file is made at the CLI's first task_started line, when the dispatch call has passed its own hook and the subagent's calls
// are still a model request away. A CLI update that breaks any of it fails here, never silently.
// Real claude: it uses real quota (one short Haiku run, two when the first is inconclusive; the cost was never measured).
// Needs `npm run build:server` first and a Node that strips TypeScript types (22.18 or later; else INCONCLUSIVE).
// Run directly: node zumi-bot-server/e2e/pauseProbe.mjs
// Exit 0 PASS, 1 FAILED (main-ok ran after the flag was set, or the hook blocked a subagent's call), 2 INCONCLUSIVE (anything
// else, after one retry: no build, no login, no task_started line, the model never called again...). `--soft` turns INCONCLUSIVE
// into exit 0 with a loud warning (npm run e2e passes it); ZUMIBOT_SKIP_PAUSE_PROBE=1 skips the probe.
// ZUMIBOT_PROBE_CLAUDE (or CLAUDE_BIN) names the claude binary and ZUMIBOT_PROBE_PAUSE_HOOK the hook entry; the unit tests point them at fakes.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** The app's PAUSE_MARKER (shared/src/pause.ts), byte for byte; a unit test pins the two together. */
export const PAUSE_MARKER = '(zumibot-pause)'

const BUILT_HOOK = fileURLToPath(new URL('../backend/dist/pauseHook.mjs', import.meta.url))
const SETTINGS_SRC = new URL('../backend/src/core/chat/pauseSettings.ts', import.meta.url).href
const AGENT = 'pause-probe'
// An --agent session, as every app run is: the CLI documents agent_id as absent for the main thread even then.
const AGENTS = JSON.stringify({
  [AGENT]: { description: 'Pause probe test agent.', prompt: "You are a test agent. Follow the user's instructions exactly." }
})
const RUN_MS = 180_000
const PROMPT =
  'This is a test of tool hooks; nothing real happens. Do exactly this, in order, one tool call per message: ' +
  '1) Use the Agent tool once, with subagent_type "general-purpose", description "Echo" and this prompt: ' +
  '"Run the Bash command `echo sub-ok`, then reply with its output." Wait for it to return. ' +
  '2) Then run the Bash command `echo main-ok` yourself. ' +
  'If a call is refused or blocked, do not try it again: reply in one line and stop.'

const DISPATCH_TOOLS = new Set(['Agent', 'Task'])
const contentOf = (m) => (Array.isArray(m?.message?.content) ? m.message.content : [])
const textOf = (c) =>
  typeof c === 'string'
    ? c
    : Array.isArray(c)
      ? c.map((b) => (typeof b === 'string' ? b : b?.type === 'text' ? String(b.text ?? '') : '')).join('\n')
      : ''
/**
 * Where the probe makes the pause flag: the CLI's task_started line, never the dispatch's own tool_use line. The CLI runs the
 * Agent call's PreToolUse hook while it writes that line, so a flag made then could block the dispatch itself; by
 * task_started the call has passed its hook, and the subagent's first call is at least one model request later.
 */
const flagLine = (m) => m?.type === 'system' && m.subtype === 'task_started'

/** PASS, FAILED or INCONCLUSIVE (with why) for one run's stdout lines; pure. */
export function classify(lines) {
  const msgs = []
  for (const l of lines) {
    try {
      const m = JSON.parse(l)
      if (m && typeof m === 'object') msgs.push(m)
    } catch {
      /* not a stream line */
    }
  }
  const flagAt = msgs.findIndex(flagLine)
  const dispatched = new Set()
  for (const m of msgs) {
    if (m.type === 'system' && m.subtype === 'task_started' && typeof m.tool_use_id === 'string') dispatched.add(m.tool_use_id)
    if (m.type === 'assistant' && !m.parent_tool_use_id)
      for (const b of contentOf(m)) if (b?.type === 'tool_use' && DISPATCH_TOOLS.has(b.name)) dispatched.add(b.id)
  }
  const results = msgs.flatMap((m, i) =>
    m.type !== 'user'
      ? []
      : contentOf(m)
          .filter((b) => b?.type === 'tool_result')
          .map((b) => ({ i, main: !m.parent_tool_use_id, id: b.tool_use_id, error: b.is_error === true, text: textOf(b.content) }))
  )
  const afterFlag = (r) => flagAt >= 0 && r.i > flagAt
  // Failures first: each is proof whatever else the run did.
  if (results.some((r) => r.main && !r.error && afterFlag(r) && !dispatched.has(r.id) && r.text.includes('main-ok'))) {
    return { outcome: 'FAILED', reason: 'the main thread ran echo main-ok after the pause flag was set: the hook did not block it' }
  }
  if (results.some((r) => !r.main && r.text.includes(PAUSE_MARKER))) {
    return {
      outcome: 'FAILED',
      reason:
        "the hook blocked a subagent's call: the CLI no longer marks subagent calls with agent_id, so a pause would stop running subagents"
    }
  }
  const no = (reason) => ({ outcome: 'INCONCLUSIVE', reason })
  if (!msgs.some((m) => m.type === 'system' && m.subtype === 'init'))
    return no('the CLI reported no init (not installed, or not signed in?)')
  if (flagAt < 0)
    return no(
      'no task_started line: the model never dispatched a subagent (or the CLI no longer reports it), so the pause flag was never set'
    )
  if (!results.some((r) => !r.main && !r.error && afterFlag(r) && r.text.includes('sub-ok'))) {
    return no("no subagent tool result with sub-ok after the flag was set: the subagent's call did not run")
  }
  if (!results.some((r) => r.main && !r.error && dispatched.has(r.id)))
    return no('the subagent never handed back to the main thread, so the session would not hold its result')
  const marked = results.filter((r) => r.main && afterFlag(r) && !dispatched.has(r.id) && r.text.includes(PAUSE_MARKER))
  if (marked.length === 0)
    return no(
      'no main thread call was blocked with the pause marker after the flag was set (the model made no further call, or the hook did not run)'
    )
  if (!marked.some((r) => r.error))
    return no('the pause block reached the model without is_error, so the server would not count blocked rounds')
  return { outcome: 'PASS', reason: null }
}

/** The verdict alone: 'PASS' | 'FAILED' | 'INCONCLUSIVE'. */
export const verdict = (lines) => classify(lines).outcome

// Same session-folder naming as the CLI: every non-alphanumeric character becomes '-'.
const projectDirOf = (cwd) =>
  join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
const binary = () => process.env.ZUMIBOT_PROBE_CLAUDE || process.env.CLAUDE_BIN || 'claude'
const killGroup = (child) => {
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    /* gone */
  }
}
// The CLI running now, so a signal to the probe takes its whole process group (and its hooks) down with it.
let current = null

/** One CLI run: its stdout lines, what it reported, whether the flag was made, and what went wrong around it. */
async function attempt(bin, settings) {
  const work = await realpath(await mkdtemp(join(tmpdir(), 'pause-probe-')))
  const cwd = join(work, 'cwd')
  const cliTmp = join(work, 'tmp')
  const flag = join(work, 'paused')
  await mkdir(cwd)
  await mkdir(cliTmp, { mode: 0o700 })
  // The env a main run gets from the app: the flag path the hook tests, the chat's own temp root, no background tasks.
  const env = { ...process.env, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1', CLAUDE_CODE_TMPDIR: cliTmp, ZUMIBOT_PAUSE_FILE: flag }
  delete env.CLAUDECODE // the probe may be started from inside a Claude Code session
  // --strict-mcp-config keeps the user's own MCP servers and plugins out; --settings is the app's pause hook, as for a main run.
  const argv = [
    '-p',
    '--agents',
    AGENTS,
    '--agent',
    AGENT,
    '--model',
    'haiku',
    '--max-turns',
    '8',
    '--permission-mode',
    'auto',
    '--permission-prompt-tool',
    'stdio',
    '--strict-mcp-config',
    '--settings',
    settings,
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose'
  ]
  const r = { work, cwd, version: null, lines: [], flagged: false, main: [], sub: [], asked: [], result: null, stderr: '', error: null }
  let child
  try {
    child = spawn(bin, argv, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    current = child
    const send = (m) => {
      if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.write(JSON.stringify(m) + '\n')
    }
    child.stdin.on('error', () => {})
    child.stderr.setEncoding('utf8').on('data', (c) => {
      r.stderr = (r.stderr + c).slice(-4000)
    })
    let buf = ''
    child.stdout.setEncoding('utf8').on('data', (c) => {
      buf += c
      for (let nl; (nl = buf.indexOf('\n')) >= 0;) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        r.lines.push(line)
        let m
        try {
          m = JSON.parse(line)
        } catch {
          continue
        }
        // At task_started (see flagLine), synchronously: the subagent's first call is at least one model request away.
        if (!r.flagged && flagLine(m)) {
          writeFileSync(flag, '', { mode: 0o600 })
          r.flagged = true
        }
        if (m.type === 'system' && m.subtype === 'init') r.version = m.claude_code_version ?? null
        if (m.type === 'control_request' && m.request?.subtype === 'can_use_tool') {
          // A card the user allows: only the hook may block a call here.
          r.asked.push(m.request.tool_name)
          send({
            type: 'control_response',
            response: { subtype: 'success', request_id: m.request_id, response: { behavior: 'allow', updatedInput: m.request.input } }
          })
        }
        if (m.type === 'assistant')
          for (const b of contentOf(m)) if (b?.type === 'tool_use') (m.parent_tool_use_id ? r.sub : r.main).push(b.name)
        if (m.type === 'result' && !r.result) {
          r.result = m
          child.stdin.end()
        }
      }
    })
    send({ type: 'user', message: { role: 'user', content: PROMPT } })
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        r.error = `the run took longer than ${RUN_MS / 1000} s`
        resolve()
      }, RUN_MS)
      child.on('error', (e) => {
        clearTimeout(timer)
        r.error = `claude could not start (${bin}): ${e.message}`
        resolve()
      })
      // 'close' comes once stdout is drained (the result line may trail 'exit'); a stray holder of the pipe gets 1 s.
      child.on('close', () => {
        clearTimeout(timer)
        resolve()
      })
      child.on('exit', () => {
        setTimeout(() => {
          clearTimeout(timer)
          resolve()
        }, 1000).unref()
      })
    })
  } catch (e) {
    r.error = `claude could not start (${bin}): ${e.message}`
  } finally {
    if (child?.pid) killGroup(child)
    current = null
  }
  return r
}

/** The line verdict, with what went wrong around the run when that says more than the lines (a spawn error, a timeout, no login). */
function judge(r) {
  const v = classify(r.lines)
  if (v.outcome !== 'INCONCLUSIVE') return v
  const tail = r.stderr.trim() ? `; stderr: ${r.stderr.trim().slice(-500)}` : ''
  if (r.error) return { outcome: 'INCONCLUSIVE', reason: `${r.error}${tail}` }
  if (r.version === null && !r.result) return { outcome: 'INCONCLUSIVE', reason: `${v.reason}${tail}` }
  if (!r.flagged && r.result?.is_error)
    return {
      outcome: 'INCONCLUSIVE',
      reason: `the run ended with an error (not signed in?): ${String(r.result.result ?? r.result.subtype ?? '').slice(0, 300)}`
    }
  return v
}

const cliVersion = (bin) => {
  try {
    return execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim()
  } catch {
    return 'unknown'
  }
}

/** Runs the probe (one retry when inconclusive); returns {outcome, version, reason}. Throws only on local setup errors. */
export async function probePause({ bin = binary(), log = console.log, entry = process.env.ZUMIBOT_PROBE_PAUSE_HOOK || BUILT_HOOK } = {}) {
  if (!existsSync(entry))
    return { outcome: 'INCONCLUSIVE', version: 'unknown', reason: `the pause hook ${entry} is missing: run npm run build:server first` }
  let pauseSettings
  try {
    ;({ pauseSettings } = await import(SETTINGS_SRC))
  } catch (e) {
    return {
      outcome: 'INCONCLUSIVE',
      version: 'unknown',
      reason: `the app's pause settings could not be loaded (this needs a Node that strips TypeScript types, 22.18 or later): ${e.message}`
    }
  }
  // The same settings a main run gets (app.ts pauseHookOf), with this Node.
  const settings = pauseSettings({ node: process.execPath, entry, electronNode: false })
  const runs = []
  for (let i = 0; i < 2; i++) {
    const r = await attempt(bin, settings)
    const v = judge(r)
    runs.push({ r, v })
    log(
      `pause probe: run ${i + 1}: Claude Code ${r.version ?? '?'}; flag ${r.flagged ? 'set' : 'never set'}; main thread calls ${JSON.stringify(r.main)}, ` +
        `subagent calls ${JSON.stringify(r.sub)}, asked ${JSON.stringify(r.asked)}: ${v.outcome}${v.reason ? ` (${v.reason})` : ''}`
    )
    if (v.outcome !== 'INCONCLUSIVE') break
  }
  const last = runs[runs.length - 1]
  const version = runs.map((x) => x.r.version).find(Boolean) ?? cliVersion(bin)
  for (const { r } of runs) {
    if (last.v.outcome === 'PASS') {
      await rm(r.work, { recursive: true, force: true })
      // Only the probe's own session lives here: the folder is named after the fresh temp dir.
      await rm(projectDirOf(r.cwd), { recursive: true, force: true })
    } else log(`pause probe: kept ${r.work} and ${projectDirOf(r.cwd)} for inspection`)
  }
  return { outcome: last.v.outcome, version, reason: last.v.reason }
}

/** The exit code: 0 pass (or skipped, or inconclusive with --soft), 1 failed, 2 inconclusive. */
export async function main(args = [], probe = probePause) {
  if (process.env.ZUMIBOT_SKIP_PAUSE_PROBE === '1') {
    console.log('pause probe: skipped (ZUMIBOT_SKIP_PAUSE_PROBE=1)')
    return 0
  }
  let outcome,
    version = 'unknown',
    reason
  try {
    ;({ outcome, version, reason } = await probe())
  } catch (e) {
    outcome = 'INCONCLUSIVE'
    reason = `the probe could not run: ${e.message}`
  }
  if (outcome === 'PASS') {
    console.log(
      `pause probe: PASS (Claude Code ${version}): the hook blocked a main thread call with an is_error result, and a subagent's call ran and handed back`
    )
    return 0
  }
  if (outcome === 'FAILED') {
    console.error(`FAILED: Claude Code ${version}: ${reason}`)
    return 1
  }
  console.error(`INCONCLUSIVE: Claude Code ${version}: ${reason}`)
  if (!args.includes('--soft')) return 2
  console.error('!!! WARNING: the pause probe was SKIPPED as inconclusive: Pause is NOT verified for this Claude Code version.')
  console.error(
    '!!! Run `node zumi-bot-server/e2e/pauseProbe.mjs` again (signed in, with quota, after npm run build:server) before relying on Pause.'
  )
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // A Ctrl-C or kill must not leave the CLI and its hooks running.
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143]
  ])
    process.once(signal, () => {
      if (current) killGroup(current)
      process.exit(code)
    })
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
