// Probe of the real claude CLI for background processes' "a start always asks" (docs/architecture/processes.md). A process
// outlives the turn, so the app passes `--settings` with an ask rule for mcp__zumibot_processes__start; this checks that the
// CLI sends `can_use_tool` for it in auto mode (where most calls never reach ZumiBot) and in Plan mode (where the server
// then refuses it before any card). Either mode fails if a start RAN without a can_use_tool first.
// Real claude, Haiku, a few cents of quota. Run directly: node zumi-bot-server/e2e/processAskProbe.mjs [--mode auto|plan]
// (both modes by default). Exit 0 PASS, 1 FAILED, 2 INCONCLUSIVE (after one retry per mode: no login, the stub server did not
// connect, the model never called start...). `--soft` turns INCONCLUSIVE into exit 0 with a loud warning (npm run e2e passes it);
// ZUMIBOT_SKIP_ASK_PROBE=1 skips it, as it does the desktop's. ZUMIBOT_PROBE_CLAUDE (or CLAUDE_BIN) names the binary.
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const MCP = fileURLToPath(new URL('./fixtures/probe-process-mcp.mjs', import.meta.url))

/** The app's PROCESS_ASK_SETTINGS (backend core/processes/processTools.ts), byte for byte; a unit test pins the two together. */
export const PROCESS_ASK_SETTINGS = '{"permissions":{"ask":["mcp__zumibot_processes__start"]}}'
export const ASK_FAILED = 'the ask rule did not force a card: a background process would start unasked'

const SERVER = 'zumibot_processes'
const START = `mcp__${SERVER}__start`
const LIST = `mcp__${SERVER}__list`
const RUN_MS = 180_000
const PROMPT =
  'This is a test of tool permissions; nothing real runs. Make exactly these two tool calls, one per message, in order: ' +
  `1) ${START} with {"command": "echo probe", "name": "probe"}; 2) ${LIST} with empty input. ` +
  'If a call is refused, still make the next one. Then reply with just the word DONE.'

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
let current = null

/** One CLI run in one permission mode: what it reported, what asked, what the model tried, what the CLI refused and what ran. */
async function attempt(bin, mode) {
  const work = await realpath(await mkdtemp(join(tmpdir(), 'process-ask-probe-')))
  // The app's server name, shape and timeout; PROBE_DIR tells the stub where to note its calls.
  const mcpConfig = JSON.stringify({
    mcpServers: {
      [SERVER]: { type: 'stdio', command: process.execPath, args: [MCP], alwaysLoad: true, timeout: 150000, env: { PROBE_DIR: work } }
    }
  })
  const env = { ...process.env, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' }
  delete env.CLAUDECODE
  const argv = [
    '-p',
    '--model',
    'haiku',
    '--max-turns',
    '6',
    '--permission-mode',
    mode,
    '--permission-prompt-tool',
    'stdio',
    '--strict-mcp-config',
    '--mcp-config',
    mcpConfig,
    '--settings',
    PROCESS_ASK_SETTINGS,
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose'
  ]
  const r = {
    mode,
    work,
    version: null,
    server: null,
    asked: [],
    attempted: [],
    refused: [],
    ran: [],
    result: null,
    stderr: '',
    error: null
  }
  let child
  try {
    child = spawn(bin, argv, { cwd: work, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
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
        let m
        try {
          m = JSON.parse(line)
        } catch {
          continue
        }
        if (m.type === 'system' && m.subtype === 'init') {
          r.version = m.claude_code_version ?? null
          r.server = (Array.isArray(m.mcp_servers) ? m.mcp_servers : []).find((s) => s?.name === SERVER)?.status ?? 'missing'
        }
        if (m.type === 'control_request' && m.request?.subtype === 'can_use_tool') {
          // The card ZumiBot would show; the user allows it (in Plan mode the server would refuse a start here instead).
          r.asked.push(m.request.tool_name)
          send({
            type: 'control_response',
            response: { subtype: 'success', request_id: m.request_id, response: { behavior: 'allow', updatedInput: m.request.input } }
          })
        }
        const blocks = Array.isArray(m.message?.content) ? m.message.content : []
        if (m.type === 'assistant' && !m.parent_tool_use_id)
          for (const b of blocks) if (b.type === 'tool_use') r.attempted.push({ id: b.id, name: b.name })
        if (m.type === 'user' && !m.parent_tool_use_id)
          for (const b of blocks) if (b.type === 'tool_result' && b.is_error) r.refused.push(b.tool_use_id)
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
  r.ran = (await readFile(join(work, 'calls.jsonl'), 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l).tool)
  return r
}

/** pass, fail or inconclusive (with why) for one run. Only a start that RAN unasked is a failure. */
export function classify(r) {
  const asks = r.asked.filter((n) => n === START).length,
    runs = r.ran.filter((t) => t === 'start').length
  if (runs > asks) return { outcome: 'fail', reason: `start ran ${runs} time(s) with ${asks} can_use_tool for it` }
  if (asks > 0) return { outcome: 'pass', reason: null }
  const tail = r.stderr.trim() ? `; stderr: ${r.stderr.trim().slice(-500)}` : ''
  const no = (reason) => ({ outcome: 'inconclusive', reason })
  if (r.error) return no(r.error + tail)
  if (r.version === null && !r.result) return no(`the CLI reported no init (not installed, or not signed in?)${tail}`)
  const tried = r.attempted.filter((t) => t.name === START)
  if (!tried.length && r.result?.is_error)
    return no(`the run ended with an error (not signed in?): ${String(r.result.result ?? r.result.subtype ?? '').slice(0, 300)}`)
  if (!tried.length && r.server !== 'connected') return no(`the stub MCP server ${SERVER} did not connect (status: ${r.server})`)
  if (!tried.length) return no(`the model never called ${START}`)
  // Refused by the CLI itself (Plan mode may do that): nothing ran, which is safe, but the card path is not shown.
  if (tried.some((t) => r.refused.includes(t.id))) return no(`${START} was refused by the CLI itself: no can_use_tool, nothing ran`)
  return no(`${START} was called but neither asked nor ran`)
}

const cliVersion = (bin) => {
  try {
    return execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim()
  } catch {
    return 'unknown'
  }
}

/** Runs one mode (one retry when inconclusive); returns {outcome, version, reason}. */
export async function probeProcessAsk({ bin = binary(), log = console.log, mode = 'auto' } = {}) {
  const runs = []
  for (let i = 0; i < 2; i++) {
    const r = await attempt(bin, mode)
    const verdict = classify(r)
    runs.push({ r, verdict })
    log(
      `process ask probe (${mode}): run ${i + 1}: Claude Code ${r.version ?? '?'}; server ${r.server ?? '?'}; tool calls ${JSON.stringify(r.attempted.map((t) => t.name))}, ` +
        `asked ${JSON.stringify(r.asked)}, ran ${JSON.stringify(r.ran)}: ${verdict.outcome}${verdict.reason ? ` (${verdict.reason})` : ''}`
    )
    if (verdict.outcome !== 'inconclusive') break
  }
  const last = runs[runs.length - 1]
  const version = runs.map((x) => x.r.version).find(Boolean) ?? cliVersion(bin)
  if (last.verdict.outcome === 'pass') {
    for (const { r } of runs) {
      await rm(r.work, { recursive: true, force: true })
      await rm(projectDirOf(r.work), { recursive: true, force: true })
    }
  } else {
    for (const { r } of runs) log(`process ask probe (${mode}): kept ${r.work} and ${projectDirOf(r.work)} for inspection`)
  }
  return { outcome: last.verdict.outcome, version, reason: last.verdict.reason }
}

/** The exit code: 0 pass (or skipped, or inconclusive with --soft), 1 failed, 2 inconclusive. */
export async function main(args = []) {
  if (process.env.ZUMIBOT_SKIP_ASK_PROBE === '1') {
    console.log('process ask probe: skipped (ZUMIBOT_SKIP_ASK_PROBE=1)')
    return 0
  }
  const at = args.indexOf('--mode')
  const modes = at >= 0 ? [args[at + 1]] : ['auto', 'plan']
  if (!modes.every((m) => m === 'auto' || m === 'plan')) {
    console.error('--mode takes auto or plan')
    return 2
  }
  let code = 0
  for (const mode of modes) {
    let outcome,
      version = 'unknown',
      reason
    try {
      ;({ outcome, version, reason } = await probeProcessAsk({ mode }))
    } catch (e) {
      outcome = 'inconclusive'
      reason = `the probe could not run: ${e.message}`
    }
    if (outcome === 'pass') {
      console.log(`process ask probe: PASS (Claude Code ${version}): start reached can_use_tool in ${mode} mode`)
      continue
    }
    if (outcome === 'fail') {
      console.error(`FAILED: Claude Code ${version}: ${ASK_FAILED} in ${mode} mode (${reason})`)
      code = 1
      continue
    }
    console.error(`INCONCLUSIVE: Claude Code ${version} (${mode} mode): ${reason}`)
    if (!args.includes('--soft')) {
      code = Math.max(code, 2)
      continue
    }
    console.error(
      `!!! WARNING: the process ask probe was SKIPPED as inconclusive in ${mode} mode: "a start always asks" is NOT verified for this Claude Code version.`
    )
  }
  return code
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
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
