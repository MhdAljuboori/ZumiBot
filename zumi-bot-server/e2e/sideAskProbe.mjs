// Probe of the real claude CLI for side ask's guard exception (spec: docs/superpowers/specs/2026-11-05-side-ask-design.md).
// A's side run blocks every tool with a PreToolUse hook, except `mcp__zumibot_agents__side_question`. This checks, in auto
// and in default mode, that the guard string under test lets that one tool run while `ask` (same server) and Bash (whose
// command even names the side tool in a comment) are blocked. Every can_use_tool is answered allow, so only the hook can block.
// Real claude, Haiku, a few cents of quota. Run directly: node zumi-bot-server/e2e/sideAskProbe.mjs
// Exit 0 PASS (both modes: the side marker exists, the model tried ask and Bash too, and neither ran), 1 FAILED (an ask or Bash
// marker exists: a blocked tool ran), 2 INCONCLUSIVE (anything else, after one retry per mode: the model did not try all three
// calls, or the side tool did not run either, which proves nothing about the guard). `--soft` turns INCONCLUSIVE into exit 0 with a loud warning (npm run e2e passes it);
// ZUMIBOT_SKIP_SIDE_ASK_PROBE=1 skips it. ZUMIBOT_PROBE_CLAUDE (or CLAUDE_BIN) names the claude binary.
import { execFileSync, spawn } from 'node:child_process'
import { access, mkdtemp, realpath, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const MCP = fileURLToPath(new URL('./fixtures/probe-agents-mcp.mjs', import.meta.url))

/** The app's SIDE_GUARD_ASKING (backend core/btw/sideRun.ts), byte for byte; a unit test pins the two together. */
export const SIDE_GUARD_ASKING =
  '{"hooks":{"PreToolUse":[{"matcher":"^(?!mcp__zumibot_agents__side_question$).*","hooks":[{"type":"command","command":"echo \'No tools in a side answer\' >&2; exit 2"}]}]}}'

const SERVER = 'zumibot_agents'
const SIDE = `mcp__${SERVER}__side_question`
const ASK = `mcp__${SERVER}__ask`
const RUN_MS = 180_000
const PROMPT =
  'This is a test of tool permissions in a sandbox; nothing real happens. Make exactly these three tool calls, one per message, in order: ' +
  `1) ${SIDE} with {"agent": "bob", "message": "hi"}; 2) ${ASK} with {"agent": "bob", "message": "hi"}; ` +
  '3) Bash with the command `touch marker-bash.txt # mcp__zumibot_agents__side_question`. ' +
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
// The CLI running now, so a signal to the probe takes its whole process group (and the stub server) down with it.
let current = null
const exists = (p) =>
  access(p).then(
    () => true,
    () => false
  )

/** One CLI run in one permission mode: what it reported, what the model tried and which markers really appeared. */
async function attempt(bin, mode, guard) {
  const work = await realpath(await mkdtemp(join(tmpdir(), 'side-ask-probe-')))
  // The stub writes its markers in its cwd, which is the CLI's: the temp dir.
  const mcpConfig = JSON.stringify({
    mcpServers: { [SERVER]: { type: 'stdio', command: process.execPath, args: [MCP], timeout: 86400000 } }
  })
  const env = { ...process.env, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' }
  delete env.CLAUDECODE // the probe may be started from inside a Claude Code session
  // The side run's flags that matter here; --settings ends --mcp-config's variadic list, as in the app.
  const argv = [
    '-p',
    '--model',
    'haiku',
    '--max-turns',
    '8',
    '--permission-mode',
    mode,
    '--permission-prompt-tool',
    'stdio',
    '--strict-mcp-config',
    '--mcp-config',
    mcpConfig,
    '--no-session-persistence',
    '--settings',
    guard,
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose'
  ]
  const r = { work, mode, version: null, server: null, asked: [], attempted: [], result: null, stderr: '', error: null, markers: {} }
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
          // Everything is allowed here, so a tool that does not run was stopped by the hook.
          r.asked.push(m.request.tool_name)
          send({
            type: 'control_response',
            response: { subtype: 'success', request_id: m.request_id, response: { behavior: 'allow', updatedInput: m.request.input } }
          })
        }
        const blocks = Array.isArray(m.message?.content) ? m.message.content : []
        if (m.type === 'assistant' && !m.parent_tool_use_id) for (const b of blocks) if (b.type === 'tool_use') r.attempted.push(b.name)
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
  for (const [k, f] of [
    ['side', 'marker-side.txt'],
    ['ask', 'marker-ask.txt'],
    ['bash', 'marker-bash.txt']
  ])
    r.markers[k] = await exists(join(work, f))
  return r
}

/** pass, fail or inconclusive (with why) for one run. Only a blocked tool that RAN is a failure; a pass needs the model to have tried the blocked tools too. */
export function classify(r) {
  const ran = Object.entries(r.markers)
    .filter(([, v]) => v)
    .map(([k]) => k)
  const leaked = ran.filter((k) => k !== 'side')
  if (leaked.length) return { outcome: 'fail', reason: `${leaked.join(' and ')} ran although the guard must block it` }
  const tail = r.stderr.trim() ? `; stderr: ${r.stderr.trim().slice(-500)}` : ''
  const no = (reason) => ({ outcome: 'inconclusive', reason })
  if (r.markers.side) {
    // A blocked tool that was never tried is not a blocked tool: without both attempts the guard was not exercised.
    const untried = [ASK, 'Bash'].filter((t) => !r.attempted.includes(t))
    if (untried.length === 0) return { outcome: 'pass', reason: null }
    return no(`the side tool ran, but the model never tried ${untried.join(' or ')}, so the guard was not exercised`)
  }
  if (r.error) return no(r.error + tail)
  if (r.version === null && !r.result) return no(`the CLI reported no init (not installed, or not signed in?)${tail}`)
  if (!r.attempted.includes(SIDE) && r.result?.is_error)
    return no(`the run ended with an error (not signed in?): ${String(r.result.result ?? r.result.subtype ?? '').slice(0, 300)}`)
  if (!r.attempted.includes(SIDE) && r.server !== 'connected')
    return no(`the stub MCP server ${SERVER} did not connect (status: ${r.server})`)
  if (!r.attempted.includes(SIDE)) return no(`the model never called ${SIDE}`)
  // The model tried the side tool and nothing ran: the guard blocked the tool it must let through (or the CLI refused it).
  return no(`${SIDE} was called but did not run (blocked by the guard, or refused by the CLI)`)
}

const cliVersion = (bin) => {
  try {
    return execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim()
  } catch {
    return 'unknown'
  }
}

/** One mode, one retry when inconclusive. */
async function probeMode(bin, mode, guard, log) {
  const runs = []
  for (let i = 0; i < 2; i++) {
    const r = await attempt(bin, mode, guard)
    const verdict = classify(r)
    runs.push({ r, verdict })
    log(
      `side ask probe: ${mode} mode, run ${i + 1}: Claude Code ${r.version ?? '?'}; server ${r.server ?? '?'}; tool calls ${JSON.stringify(r.attempted)}, ` +
        `asked ${JSON.stringify(r.asked)}, markers ${JSON.stringify(r.markers)}: ${verdict.outcome}${verdict.reason ? ` (${verdict.reason})` : ''}`
    )
    if (verdict.outcome !== 'inconclusive') break
  }
  return { runs, verdict: runs[runs.length - 1].verdict }
}

/** Runs the probe in auto and default mode; returns {outcome, version, reason}. Throws only on local setup errors. */
export async function probeSideAsk({ bin = binary(), log = console.log, guard = SIDE_GUARD_ASKING } = {}) {
  const all = []
  for (const mode of ['auto', 'default']) all.push(await probeMode(bin, mode, guard, log))
  const verdicts = all.map((a) => a.verdict)
  const bad = verdicts.find((v) => v.outcome === 'fail') ?? verdicts.find((v) => v.outcome === 'inconclusive')
  const outcome = bad ? bad.outcome : 'pass'
  const version =
    all
      .flatMap((a) => a.runs)
      .map((x) => x.r.version)
      .find(Boolean) ?? cliVersion(bin)
  for (const { runs } of all)
    for (const { r } of runs) {
      if (outcome === 'pass') {
        await rm(r.work, { recursive: true, force: true })
        // Only the probe's own session lives here: the folder is named after the fresh temp dir.
        await rm(projectDirOf(r.work), { recursive: true, force: true })
      } else log(`side ask probe: kept ${r.work} and ${projectDirOf(r.work)} for inspection`)
    }
  return { outcome, version, reason: bad?.reason ?? null }
}

/** The exit code: 0 pass (or skipped, or inconclusive with --soft), 1 failed, 2 inconclusive. */
export async function main(args = [], probe = probeSideAsk) {
  if (process.env.ZUMIBOT_SKIP_SIDE_ASK_PROBE === '1') {
    console.log('side ask probe: skipped (ZUMIBOT_SKIP_SIDE_ASK_PROBE=1)')
    return 0
  }
  let outcome,
    version = 'unknown',
    reason
  try {
    ;({ outcome, version, reason } = await probe())
  } catch (e) {
    outcome = 'inconclusive'
    reason = `the probe could not run: ${e.message}`
  }
  if (outcome === 'pass') {
    console.log(`side ask probe: PASS (Claude Code ${version}): side_question ran, ask and Bash were blocked, in auto and default mode`)
    return 0
  }
  if (outcome === 'fail') {
    console.error(`FAILED: Claude Code ${version}: the side guard did not hold (${reason})`)
    return 1
  }
  console.error(`INCONCLUSIVE: Claude Code ${version}: ${reason}`)
  if (!args.includes('--soft')) return 2
  console.error(
    '!!! WARNING: the side ask probe was SKIPPED as inconclusive: the side guard exception is NOT verified for this Claude Code version.'
  )
  console.error(
    '!!! Run `node zumi-bot-server/e2e/sideAskProbe.mjs` again (signed in, with quota) before relying on side questions to agents.'
  )
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // A Ctrl-C or kill must not leave the CLI and its stub server running.
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
