// Probe of the real claude CLI for computer use's "actions always ask" (spec: docs/superpowers/specs/2026-11-04-computer-use-design.md).
// Production runs the CLI in auto mode, where many tool calls never reach ZumiBot. The app passes `--settings` with ask rules
// for every desktop action tool; this checks that the CLI still sends `can_use_tool` for one (desktop_click) in auto mode, so a
// card shows. A looking tool (desktop_screenshot) may or may not ask. A CLI update that breaks this fails here, never silently.
// Real claude, Haiku, a few cents of quota. Run directly: node zumi-bot-server/e2e/desktopAskProbe.mjs
// Exit 0 PASS (desktop_click reached can_use_tool), 1 FAILED (desktop_click ran without one), 2 INCONCLUSIVE (anything else,
// after one retry: no login, the stub server did not connect, the model never called it, the CLI refused it on its own...).
// `--soft` turns INCONCLUSIVE into exit 0 with a loud warning (npm run e2e passes it); ZUMIBOT_SKIP_ASK_PROBE=1 skips the probe.
// `--with-allow-rule` also puts an allow rule for desktop_click in the same settings, to check that ask beats allow (a user's
// own allow rule must not skip the card); the verdicts and exit codes are the same.
// ZUMIBOT_PROBE_CLAUDE (or CLAUDE_BIN) names the claude binary; the unit tests point it at a fake.
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const MCP = fileURLToPath(new URL('./fixtures/probe-desktop-mcp.mjs', import.meta.url))

/** The app's DESKTOP_ASK_SETTINGS (backend core/desktop/desktopIpc.ts), byte for byte; a unit test pins the two together. */
export const DESKTOP_ASK_SETTINGS =
  '{"permissions":{"ask":["mcp__zumibot_desktop__desktop_click","mcp__zumibot_desktop__desktop_drag","mcp__zumibot_desktop__desktop_scroll","mcp__zumibot_desktop__desktop_move","mcp__zumibot_desktop__desktop_type","mcp__zumibot_desktop__desktop_key","mcp__zumibot_desktop__desktop_launch","mcp__zumibot_desktop__desktop_focus"]}}'
export const ASK_FAILED = 'ask rules did not force a card in auto mode: desktop actions would run unasked'

const SERVER = 'zumibot_desktop'
const CLICK = `mcp__${SERVER}__desktop_click`
/** The settings a run passes: the app's ask rules, plus (withAllow) an allow rule for the very tool they ask for. */
export const askSettings = (withAllow = false) =>
  withAllow ? JSON.stringify({ permissions: { ...JSON.parse(DESKTOP_ASK_SETTINGS).permissions, allow: [CLICK] } }) : DESKTOP_ASK_SETTINGS
const SCREENSHOT = `mcp__${SERVER}__desktop_screenshot`
const RUN_MS = 180_000
const PROMPT =
  'This is a test of tool permissions on a test desktop; nothing real is clicked. Make exactly these two tool calls, ' +
  `one per message, in order: 1) ${SCREENSHOT} with empty input; 2) ${CLICK} with {"x": 10, "y": 20}. ` +
  'If a call is refused, still make the next one. Then reply with just the word DONE.'

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
// The CLI running now, so a signal to the probe takes its whole process group (and the stub server) down with it.
let current = null

/** One CLI run: what it reported, what asked, what the model tried, what the CLI refused and what really ran. */
async function attempt(bin, settings) {
  const work = await realpath(await mkdtemp(join(tmpdir(), 'desktop-ask-probe-')))
  // The same server name and shape the app's per-turn bridge gets; PROBE_DIR tells the stub where to note its calls.
  const mcpConfig = JSON.stringify({
    mcpServers: { [SERVER]: { type: 'stdio', command: process.execPath, args: [MCP], timeout: 86400000, env: { PROBE_DIR: work } } }
  })
  const env = { ...process.env, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' }
  delete env.CLAUDECODE // the probe may be started from inside a Claude Code session
  // The app's flags for a main run that matter here. --strict-mcp-config keeps the user's own MCP servers and plugins out;
  // --settings ends --mcp-config's variadic list, as in the app.
  const argv = [
    '-p',
    '--model',
    'haiku',
    '--max-turns',
    '6',
    '--permission-mode',
    'auto',
    '--permission-prompt-tool',
    'stdio',
    '--strict-mcp-config',
    '--mcp-config',
    mcpConfig,
    '--settings',
    settings,
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose'
  ]
  const r = { work, version: null, server: null, asked: [], attempted: [], refused: [], ran: [], result: null, stderr: '', error: null }
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
          // A card ZumiBot would show; the user allows it.
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
  r.ran = (await readFile(join(work, 'calls.jsonl'), 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l).tool)
  return r
}

/** pass, fail or inconclusive (with why) for one run. Only a click that RAN unasked is a failure; the rest proves nothing. */
export function classify(r) {
  const asks = r.asked.filter((n) => n === CLICK).length,
    runs = r.ran.filter((t) => t === 'desktop_click').length
  if (runs > asks) return { outcome: 'fail', reason: `desktop_click ran ${runs} time(s) with ${asks} can_use_tool for it` }
  if (asks > 0) return { outcome: 'pass', reason: null }
  const tail = r.stderr.trim() ? `; stderr: ${r.stderr.trim().slice(-500)}` : ''
  const no = (reason) => ({ outcome: 'inconclusive', reason })
  if (r.error) return no(r.error + tail)
  if (r.version === null && !r.result) return no(`the CLI reported no init (not installed, or not signed in?)${tail}`)
  const tried = r.attempted.filter((t) => t.name === CLICK)
  if (!tried.length && r.result?.is_error)
    return no(`the run ended with an error (not signed in?): ${String(r.result.result ?? r.result.subtype ?? '').slice(0, 300)}`)
  if (!tried.length && r.server !== 'connected') return no(`the stub MCP server ${SERVER} did not connect (status: ${r.server})`)
  if (!tried.length) return no(`the model never called ${CLICK}`)
  if (tried.some((t) => r.refused.includes(t.id)))
    return no(`${CLICK} was refused by the CLI itself, not by this probe: no can_use_tool, nothing ran`)
  return no(`${CLICK} was called but neither asked nor ran`)
}

const cliVersion = (bin) => {
  try {
    return execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim()
  } catch {
    return 'unknown'
  }
}

/** Runs the probe (one retry when inconclusive); returns {outcome, version, reason, runs}. Throws only on local setup errors. */
export async function probeDesktopAsk({ bin = binary(), log = console.log, withAllowRule = false } = {}) {
  const runs = []
  for (let i = 0; i < 2; i++) {
    const r = await attempt(bin, askSettings(withAllowRule))
    const verdict = classify(r)
    runs.push({ r, verdict })
    log(
      `desktop ask probe: run ${i + 1}: Claude Code ${r.version ?? '?'}; server ${r.server ?? '?'}; tool calls ${JSON.stringify(r.attempted.map((t) => t.name))}, ` +
        `asked ${JSON.stringify(r.asked)}, ran ${JSON.stringify(r.ran)}: ${verdict.outcome}${verdict.reason ? ` (${verdict.reason})` : ''}`
    )
    if (verdict.outcome !== 'inconclusive') break
  }
  const last = runs[runs.length - 1]
  const version = runs.map((x) => x.r.version).find(Boolean) ?? cliVersion(bin)
  if (last.verdict.outcome === 'pass') {
    for (const { r } of runs) {
      await rm(r.work, { recursive: true, force: true })
      // Only the probe's own session lives here: the folder is named after the fresh temp dir.
      await rm(projectDirOf(r.work), { recursive: true, force: true })
    }
  } else {
    for (const { r } of runs) log(`desktop ask probe: kept ${r.work} and ${projectDirOf(r.work)} for inspection`)
  }
  return { outcome: last.verdict.outcome, version, reason: last.verdict.reason, runs: runs.length }
}

/** The exit code: 0 pass (or skipped, or inconclusive with --soft), 1 failed, 2 inconclusive. */
export async function main(args = []) {
  if (process.env.ZUMIBOT_SKIP_ASK_PROBE === '1') {
    console.log('desktop ask probe: skipped (ZUMIBOT_SKIP_ASK_PROBE=1)')
    return 0
  }
  const withAllowRule = args.includes('--with-allow-rule'),
    variant = withAllowRule ? ', with an allow rule for it' : ''
  let outcome,
    version = 'unknown',
    reason
  try {
    ;({ outcome, version, reason } = await probeDesktopAsk({ withAllowRule }))
  } catch (e) {
    outcome = 'inconclusive'
    reason = `the probe could not run: ${e.message}`
  }
  if (outcome === 'pass') {
    console.log(`desktop ask probe: PASS (Claude Code ${version}): desktop_click reached can_use_tool in auto mode${variant}`)
    return 0
  }
  if (outcome === 'fail') {
    console.error(`FAILED: Claude Code ${version}: ${ASK_FAILED}${variant} (${reason})`)
    return 1
  }
  console.error(`INCONCLUSIVE: Claude Code ${version}: ${reason}`)
  if (!args.includes('--soft')) return 2
  console.error(
    '!!! WARNING: the desktop ask probe was SKIPPED as inconclusive: "actions always ask" is NOT verified for this Claude Code version.'
  )
  console.error('!!! Run `node zumi-bot-server/e2e/desktopAskProbe.mjs` again (signed in, with quota) before relying on computer use.')
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
