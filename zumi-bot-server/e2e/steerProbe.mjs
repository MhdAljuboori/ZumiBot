// Probe of the real claude CLI for mid-turn messages (docs/architecture/mid-turn-messages.md). Enter while a reply runs writes a
// second stream-json user message into the running CLI; the feature rests on two behaviours of the CLI, checked here: it takes
// that message in at the agent's next tool step, inside the same turn (one result), and with --replay-user-messages it echoes
// the message back under the uuid it was sent with, which is when the chat draws its bubble. A CLI update that only answers it
// as a turn of its own, or stops echoing it, fails here, never silently (the bubble would never land, or land after the reply).
// Real claude: one short Haiku run that sleeps in Bash, so the message arrives while a tool runs (two when the model ran no tool).
// Run directly: node zumi-bot-server/e2e/steerProbe.mjs
// Exit 0 PASS, 1 FAILED, 2 INCONCLUSIVE (no login, no tool run twice, ...). `--soft` turns INCONCLUSIVE into exit 0 with a loud
// warning (npm run e2e passes it); ZUMIBOT_SKIP_STEER_PROBE=1 skips the probe.
// ZUMIBOT_PROBE_CLAUDE (or CLAUDE_BIN) names the claude binary.
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const RUN_MS = 120_000
// After a result while the steer is still unread: how long the CLI gets to start the turn it owes it.
const LATE_MS = 20_000
export const STEER_UUID = '5bee7e00-0000-4000-8000-00000000c0de'
const PROMPT_UUID = '5bee7e00-0000-4000-8000-00000000a000'
const PROMPT = 'Run the bash command `sleep 5`, then reply with one short sentence.'
const STEER = 'Extra detail: end your reply with the word BANANA.'

const userLine = (text, uuid) => JSON.stringify({ type: 'user', uuid, message: { role: 'user', content: text } }) + '\n'
const main_ = (m) => (m.parent_tool_use_id ?? null) === null
const contentOf = (m) => (Array.isArray(m?.message?.content) ? m.message.content : [])

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
  const no = (reason) => ({ outcome: 'INCONCLUSIVE', reason })
  if (!msgs.some((m) => m.type === 'system' && m.subtype === 'init'))
    return no('the CLI reported no init (not installed, or not signed in?)')
  const tool = msgs.findIndex((m) => m.type === 'assistant' && main_(m) && contentOf(m).some((b) => b?.type === 'tool_use'))
  if (tool < 0) return no('the model ran no tool, so there was no step to take the message in at')
  const replay = msgs.findIndex((m) => m.type === 'user' && m.isReplay === true && m.uuid === STEER_UUID)
  if (replay < 0)
    return {
      outcome: 'FAILED',
      reason: 'the CLI never echoed the mid-turn message back (--replay-user-messages): the chat would never show its bubble'
    }
  const firstResult = msgs.findIndex((m) => m.type === 'result')
  if (firstResult >= 0 && firstResult < replay)
    return {
      outcome: 'FAILED',
      reason: 'the CLI took the message only after the turn ended, as a turn of its own: Enter would no longer steer the running reply'
    }
  return { outcome: 'PASS', reason: null }
}

const binary = () => process.env.ZUMIBOT_PROBE_CLAUDE || process.env.CLAUDE_BIN || 'claude'
const killGroup = (child) => {
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    /* gone */
  }
}
let current = null

/** One CLI run: the prompt, then the steer once the first tool starts; its stdout lines, stderr tail and what went wrong. */
async function attempt(bin) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'steer-probe-')))
  const env = { ...process.env }
  delete env.CLAUDECODE // the probe may be started from inside a Claude Code session
  // Only the one Bash call, no user settings or servers, nothing kept: only the steer matters here.
  const argv = [
    '-p',
    '--model',
    'haiku',
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--allowedTools',
    'Bash(sleep:*)',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--replay-user-messages'
  ]
  const r = { cwd, version: null, lines: [], stderr: '', error: null }
  let child
  try {
    child = spawn(bin, argv, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    current = child
    child.stdin.on('error', () => {})
    child.stderr.setEncoding('utf8').on('data', (c) => {
      r.stderr = (r.stderr + c).slice(-4000)
    })
    let steered = false
    let echoed = false
    let late = null
    const end = () => {
      if (late) clearTimeout(late)
      if (!child.stdin.writableEnded) child.stdin.end()
    }
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
        if (m.type === 'system' && m.subtype === 'init') r.version ??= m.claude_code_version ?? null
        // The steer goes in while the tool runs, as a user's Enter would.
        if (!steered && m.type === 'assistant' && main_(m) && contentOf(m).some((b) => b?.type === 'tool_use')) {
          steered = true
          child.stdin.write(userLine(STEER, STEER_UUID))
        }
        if (m.type === 'user' && m.isReplay === true && m.uuid === STEER_UUID) echoed = true
        // As the app does: stdin stays open past a result while the steer is unread, then closes at the next one.
        if (m.type === 'result') {
          if (!steered || echoed) end()
          else late ??= setTimeout(end, LATE_MS)
        }
      }
    })
    child.stdin.write(userLine(PROMPT, PROMPT_UUID))
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
        if (late) clearTimeout(late)
        resolve()
      })
    })
  } catch (e) {
    r.error = `claude could not start (${bin}): ${e.message}`
  } finally {
    if (child?.pid) killGroup(child)
    current = null
    await rm(cwd, { recursive: true, force: true })
  }
  return r
}

function judge(r) {
  if (r.stderr.includes('--replay-user-messages'))
    return { outcome: 'FAILED', reason: `the CLI refused --replay-user-messages: ${r.stderr.trim().slice(-300)}` }
  const v = classify(r.lines)
  if (v.outcome !== 'INCONCLUSIVE') return v
  const tail = r.stderr.trim() ? `; stderr: ${r.stderr.trim().slice(-500)}` : ''
  return { outcome: 'INCONCLUSIVE', reason: `${r.error ?? v.reason}${tail}` }
}

const cliVersion = (bin) => {
  try {
    return execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return 'unknown'
  }
}

/** Runs the probe (one retry when inconclusive); returns {outcome, version, reason}. */
export async function probeSteer({ bin = binary(), log = console.log } = {}) {
  let last = null
  let version = null
  for (let i = 0; i < 2; i++) {
    const r = await attempt(bin)
    version ??= r.version
    last = judge(r)
    log(`steer probe: run ${i + 1}: Claude Code ${r.version ?? '?'}: ${last.outcome}${last.reason ? ` (${last.reason})` : ''}`)
    if (last.outcome !== 'INCONCLUSIVE') break
  }
  return { outcome: last.outcome, version: version ?? cliVersion(bin), reason: last.reason }
}

/** The exit code: 0 pass (or skipped, or inconclusive with --soft), 1 failed, 2 inconclusive. */
export async function main(args = [], probe = probeSteer) {
  if (process.env.ZUMIBOT_SKIP_STEER_PROBE === '1') {
    console.log('steer probe: skipped (ZUMIBOT_SKIP_STEER_PROBE=1)')
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
    console.log(`steer probe: PASS (Claude Code ${version}): a mid-turn message is taken in at the next tool step and echoed back`)
    return 0
  }
  if (outcome === 'FAILED') {
    console.error(`FAILED: Claude Code ${version}: ${reason}`)
    return 1
  }
  console.error(`INCONCLUSIVE: Claude Code ${version}: ${reason}`)
  if (!args.includes('--soft')) return 2
  console.error(
    '!!! WARNING: the steer probe was SKIPPED as inconclusive: mid-turn messages are NOT verified for this Claude Code version.'
  )
  console.error('!!! Run `node zumi-bot-server/e2e/steerProbe.mjs` again (signed in, with quota) before relying on them.')
  return 0
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
