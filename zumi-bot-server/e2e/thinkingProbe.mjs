// Probe of the real claude CLI for thinking rows (docs/architecture/thinking.md). A `-p` run streams every thinking block
// empty unless it gets the hidden `--thinking-display summarized` flag, which the app passes when the CLI takes it. This checks
// both facts that rests on: the app's own check (thinkingDisplay.ts) finds that this CLI takes the flag, and a run with it
// streams thinking_delta text and ends each thinking block with its summary. A CLI update that drops the flag, or that sends the
// summaries some other way, fails here, never silently (the app would just show no thinking).
// Real claude: one short Sonnet run with no tools at high effort (two when the model did not think the first time).
// Needs a Node that strips TypeScript types (22.18 or later; else INCONCLUSIVE). No build needed.
// Run directly: node zumi-bot-server/e2e/thinkingProbe.mjs
// Exit 0 PASS, 1 FAILED, 2 INCONCLUSIVE (no login, no thinking block twice, ...). `--soft` turns INCONCLUSIVE into exit 0 with a
// loud warning (npm run e2e passes it); ZUMIBOT_SKIP_THINKING_PROBE=1 skips the probe.
// ZUMIBOT_PROBE_CLAUDE (or CLAUDE_BIN) names the claude binary; the unit tests point it at fakes.
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PROBE_SRC = new URL('../backend/src/core/chat/thinkingDisplay.ts', import.meta.url).href
const RUN_MS = 180_000
// Something worth thinking about, so an adaptive model thinks at all.
const PROMPT =
  'Find the smallest positive integer n such that n^2 + n + 41 is composite, and prove it is the smallest. ' +
  'Reason step by step before answering; give the final answer in one line.'

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
  const main = (m) => (m.parent_tool_use_id ?? null) === null
  const blocks = msgs.filter((m) => m.type === 'assistant' && main(m)).flatMap((m) => contentOf(m).filter((b) => b?.type === 'thinking'))
  const deltas = msgs
    .filter((m) => m.type === 'stream_event' && main(m) && m.event?.delta?.type === 'thinking_delta')
    .map((m) => m.event.delta.thinking)
  const no = (reason) => ({ outcome: 'INCONCLUSIVE', reason })
  if (!msgs.some((m) => m.type === 'system' && m.subtype === 'init'))
    return no('the CLI reported no init (not installed, or not signed in?)')
  if (blocks.length === 0) return no('the model did not think in this run (no thinking block), so there was nothing to check')
  if (!blocks.some((b) => typeof b.thinking === 'string' && b.thinking.trim() !== '')) {
    return {
      outcome: 'FAILED',
      reason:
        'every thinking block came empty with --thinking-display summarized: the CLI no longer sends summaries this way, so chats show no thinking'
    }
  }
  if (!deltas.some((t) => typeof t === 'string' && t !== '')) {
    return {
      outcome: 'FAILED',
      reason: 'the thinking blocks kept their summary, but no thinking_delta carried text: the live thought line would stay empty'
    }
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

/** One CLI run with the flag: its stdout lines, its stderr tail, and what went wrong around it. */
async function attempt(bin) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'thinking-probe-')))
  const env = { ...process.env }
  delete env.CLAUDECODE // the probe may be started from inside a Claude Code session
  // No tools, no user settings or servers, nothing kept: only the thinking stream matters here.
  const argv = [
    '-p',
    '--model',
    'sonnet',
    '--effort',
    'high',
    '--tools',
    '',
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--thinking-display',
    'summarized',
    PROMPT
  ]
  const r = { cwd, version: null, lines: [], stderr: '', error: null }
  let child
  try {
    child = spawn(bin, argv, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    current = child
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
        try {
          const m = JSON.parse(line)
          if (m.type === 'system' && m.subtype === 'init') r.version = m.claude_code_version ?? null
        } catch {
          /* not a stream line */
        }
      }
    })
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
  // A CLI that does not take the flag refuses the run before any line.
  if (r.stderr.includes('--thinking-display'))
    return { outcome: 'FAILED', reason: `the CLI refused --thinking-display: ${r.stderr.trim().slice(-300)}` }
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
export async function probeThinking({ bin = binary(), log = console.log } = {}) {
  let createThinkingProbe
  try {
    ;({ createThinkingProbe } = await import(PROBE_SRC))
  } catch (e) {
    return {
      outcome: 'INCONCLUSIVE',
      version: 'unknown',
      reason: `the app's thinking check could not be loaded (this needs a Node that strips TypeScript types, 22.18 or later): ${e.message}`
    }
  }
  // The app's own check, as a chat's first attempt runs it.
  const takes = await createThinkingProbe({ env: () => process.env })(bin)
  log(`thinking probe: the app's check says this CLI ${takes ? 'takes' : 'does not take'} --thinking-display`)
  if (!takes)
    return {
      outcome: 'FAILED',
      version: cliVersion(bin),
      reason: "the app's check found no --thinking-display in this CLI, so chats would show no thinking"
    }
  let last = null
  let version = null
  for (let i = 0; i < 2; i++) {
    const r = await attempt(bin)
    version ??= r.version
    last = judge(r)
    log(`thinking probe: run ${i + 1}: Claude Code ${r.version ?? '?'}: ${last.outcome}${last.reason ? ` (${last.reason})` : ''}`)
    if (last.outcome !== 'INCONCLUSIVE') break
  }
  return { outcome: last.outcome, version: version ?? cliVersion(bin), reason: last.reason }
}

/** The exit code: 0 pass (or skipped, or inconclusive with --soft), 1 failed, 2 inconclusive. */
export async function main(args = [], probe = probeThinking) {
  if (process.env.ZUMIBOT_SKIP_THINKING_PROBE === '1') {
    console.log('thinking probe: skipped (ZUMIBOT_SKIP_THINKING_PROBE=1)')
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
      `thinking probe: PASS (Claude Code ${version}): --thinking-display summarized streams thinking text and keeps each block's summary`
    )
    return 0
  }
  if (outcome === 'FAILED') {
    console.error(`FAILED: Claude Code ${version}: ${reason}`)
    return 1
  }
  console.error(`INCONCLUSIVE: Claude Code ${version}: ${reason}`)
  if (!args.includes('--soft')) return 2
  console.error('!!! WARNING: the thinking probe was SKIPPED as inconclusive: thinking rows are NOT verified for this Claude Code version.')
  console.error('!!! Run `node zumi-bot-server/e2e/thinkingProbe.mjs` again (signed in, with quota) before relying on them.')
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
