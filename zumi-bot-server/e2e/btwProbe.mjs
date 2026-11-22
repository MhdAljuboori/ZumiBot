// Probe of the real claude CLI for /btw side questions (spec: docs/superpowers/specs/2026-11-03-btw-side-questions-design.md).
// A main run sleeps four times; after its second tool result a side run forks it at the clean entry with the guard and tries
// every tool. Checks: 1 the fork writes nothing and leaves the main run alone, 2 the clean entry was already on disk,
// 3 no tool runs (even allowed ones) in auto or manual mode, 4 the side run's first request reads the main run's cache.
// Real claude, Haiku, a few cents of quota. Run directly: node zumi-bot-server/e2e/btwProbe.mjs
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const MCP = fileURLToPath(new URL('./fixtures/probe-mcp.mjs', import.meta.url))

/** The tool guard a side run gets with --settings. Task 5's SIDE_GUARD_SETTINGS must be this exact string. */
export const SIDE_GUARD =
  '{"hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"echo \'No tools in a side answer\' >&2; exit 2"}]}]}}'
const GUARD_TEXT = 'No tools in a side answer'

const RUN_MS = 180_000
const SIDE_MS = 120_000

// Cache-check filler: the forked history must be long enough to be worth caching on its own.
const FILLER = Array.from(
  { length: 80 },
  (_, i) => `Note ${i + 1}: this line is filler for a prompt cache test; it carries no task and needs no answer or action.`
).join('\n')

const MAIN_PROMPT = `Use the Bash tool to run \`sleep 2\` four times. Make exactly one Bash call per message and wait for its result before the next; never call tools in parallel and run nothing else. After the fourth result, reply with just the word DONE.

The notes below are filler; ignore them.
${FILLER}`

// The same clean-entry rule Task 4's CleanPoint implements: a clean entry has no tool call of the turn left open after it.
class CleanPoint {
  open = new Set()
  tip = null
  clean = null
  entry(uuid) {
    if (this.open.size === 0 && this.tip) this.clean = this.tip
    this.tip = uuid
  }
  toolUse(id) {
    this.open.add(id)
  }
  toolResult(id) {
    this.open.delete(id)
  }
  get() {
    return this.open.size === 0 ? this.tip : this.clean
  }
}

// Same session-folder naming as the CLI: every non-alphanumeric character becomes '-'.
const projectDirOf = (projects, cwd) => join(projects, cwd.replace(/[^a-zA-Z0-9]/g, '-'))

async function jsonlFiles(dir) {
  const out = new Set()
  const walk = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (e.isDirectory()) await walk(join(d, e.name))
      else if (e.name.endsWith('.jsonl')) out.add(join(d, e.name))
    }
  }
  await walk(dir)
  return out
}

const blocksOf = (m) => (Array.isArray(m?.message?.content) ? m.message.content : [])

/** Runs every check against the real CLI; throws with a clear message on the first failure. */
export async function probeSideRun({ bin = process.env.CLAUDE_BIN || 'claude', log = console.log } = {}) {
  const work = await realpath(await mkdtemp(join(tmpdir(), 'btw-probe-')))
  const projects = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')
  const projectDir = projectDirOf(projects, work)
  const mcpConfig = join(work, 'probe-mcp.json')
  await writeFile(mcpConfig, JSON.stringify({ mcpServers: { probe: { command: process.execPath, args: [MCP] } } }))
  const env = { ...process.env, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' }
  delete env.CLAUDECODE // the probe may be started from inside a Claude Code session
  const children = new Set()
  let ok = false
  let mainExited = false

  // The main run's own args; a side run adds only its session part and the guard, so the request start stays the same.
  const args = (mode) => [
    '-p',
    '--model',
    'haiku',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode',
    mode,
    '--permission-prompt-tool',
    'stdio',
    '--mcp-config',
    mcpConfig,
    // Variadic, so last. Both tools are allowed: only the guard may stop them in a side run.
    '--allowedTools',
    'Bash(sleep:*)',
    'mcp__probe__touch_marker'
  ]

  /** Spawns claude; onLine gets each parsed stdout line. stdin stays open until the result, for control responses. */
  function run(name, argv, prompt, onLine, timeoutMs) {
    // Own process group, so the cleanup also kills the MCP server and any shell the CLI started.
    const child = spawn(bin, argv, { cwd: work, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    children.add(child)
    let stderr = '',
      buf = '',
      resulted = false
    const send = (m) => {
      if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.write(JSON.stringify(m) + '\n')
    }
    child.stdin.on('error', () => {})
    child.stderr.setEncoding('utf8').on('data', (c) => {
      stderr += c
    })
    child.stdout.setEncoding('utf8').on('data', (c) => {
      buf += c
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        let m
        try {
          m = JSON.parse(line)
        } catch {
          continue
        }
        if (m.type === 'control_request' && m.request?.subtype === 'can_use_tool') {
          // ZumiBot's second line: deny, never a card. Counted, since the guard should leave nothing to ask.
          send({
            type: 'control_response',
            response: { subtype: 'success', request_id: m.request_id, response: { behavior: 'deny', message: GUARD_TEXT } }
          })
        }
        onLine(m, line)
        if (m.type === 'result' && !resulted) {
          resulted = true
          child.stdin.end()
        }
      }
    })
    send({ type: 'user', message: { role: 'user', content: prompt } })
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${name} run took longer than ${timeoutMs / 1000} s; stderr: ${stderr.slice(-2000)}`))
      }, timeoutMs)
      child.on('error', (e) => {
        clearTimeout(timer)
        reject(new Error(`${name} run could not start (${bin}): ${e.message}`))
      })
      child.on('exit', (code, signal) => {
        clearTimeout(timer)
        resolve({ code, signal, stderr: () => stderr })
      })
    })
    return { child, done }
  }

  /** A side run forked at (session, at) with the guard; collects what the checks need. */
  async function side(mode, session, at, token) {
    const r = { init: null, usage: null, toolUses: [], results: [], asks: 0, result: null, lines: [], text: '' }
    // Check 3 needs every tool really tried, so the prompt insists on each call even after a refusal.
    const prompt =
      `${token}: this is a test of a tool guard. Before you answer, make these three tool calls in order, one per message: ` +
      '1) call mcp__probe__touch_marker with empty input (call it by that name even if loading its schema is refused); ' +
      '2) call Bash with the command `sleep 1`; 3) call Bash with the command `echo hacked > hacked.txt`. ' +
      'A refusal of one call never excuses skipping the next: you must attempt all three calls yourself, even if every one is refused. ' +
      'Then say how many `sleep 2` commands have finished in this conversation so far.'
    const argv = [
      ...args(mode).slice(0, -3),
      '--resume',
      session,
      '--resume-session-at',
      at,
      '--fork-session',
      '--no-session-persistence',
      '--settings',
      SIDE_GUARD,
      ...args(mode).slice(-3)
    ]
    const h = run(
      `side (${mode})`,
      argv,
      prompt,
      (m, line) => {
        r.lines.push(line)
        if (m.type === 'system' && m.subtype === 'init') {
          r.init = m
          r.mainRunning = !mainExited
        }
        if (m.type === 'control_request' && m.request?.subtype === 'can_use_tool') r.asks++
        if (m.type === 'assistant' && !m.parent_tool_use_id) {
          if (!r.usage && m.message?.usage) r.usage = m.message.usage
          for (const b of blocksOf(m)) {
            if (b.type === 'tool_use')
              r.toolUses.push({ name: b.name, command: typeof b.input?.command === 'string' ? b.input.command : null })
            if (b.type === 'text') r.text += b.text
          }
        }
        if (m.type === 'user' && !m.parent_tool_use_id) {
          for (const b of blocksOf(m))
            if (b.type === 'tool_result') {
              const content = typeof b.content === 'string' ? b.content : JSON.stringify(b.content)
              r.results.push({ isError: b.is_error === true, content })
            }
        }
        if (m.type === 'result') r.result = m
      },
      SIDE_MS
    )
    const exit = await h.done
    r.stderr = exit.stderr()
    return r
  }

  try {
    log(`btw probe: working folder ${work}`)
    let S = null,
      version = null,
      mainUsage = null,
      results = 0,
      mainResult = null
    const clean = new CleanPoint()
    const token = `BTW-PROBE-${randomBytes(4).toString('hex')}`
    let sideStart = null // resolves to { before, at } once the side run is launched

    let launch
    const launched = new Promise((resolve) => {
      launch = resolve
    })
    const main = run(
      'main',
      args('auto'),
      MAIN_PROMPT,
      (m) => {
        if (m.type === 'system' && m.subtype === 'init') {
          S = m.session_id
          version = m.claude_code_version ?? null
        }
        if (m.parent_tool_use_id) return
        if (m.type === 'assistant' || m.type === 'user') {
          if (typeof m.uuid === 'string' && m.uuid) clean.entry(m.uuid)
          if (m.type === 'assistant' && !mainUsage && m.message?.usage) mainUsage = m.message.usage
          for (const b of blocksOf(m)) {
            if (b.type === 'tool_use') clean.toolUse(b.id)
            if (b.type === 'tool_result') {
              clean.toolResult(b.tool_use_id)
              results++
            }
          }
          // Fork right after the 2nd result, while the main run is still writing: the hardest moment for check 2.
          if (results === 2 && !sideStart) {
            const at = clean.get()
            sideStart = jsonlFiles(projectDir).then((before) => {
              // Wrapped: resolving with a bare promise would wait for the whole side run.
              launch({ side: side('auto', S, at, token) })
              return { before, at }
            })
          }
        }
        if (m.type === 'result') mainResult = m
      },
      RUN_MS
    )
    main.done.then(
      () => {
        mainExited = true
      },
      () => {
        mainExited = true
      }
    )

    const started = await Promise.race([
      launched,
      main.done.then((e) => {
        if (!sideStart) throw new Error(`main run ended before its 2nd tool result (exit ${e.code}); stderr: ${e.stderr().slice(-2000)}`)
        return launched
      })
    ])
    const { before, at } = await sideStart
    const a = await started.side
    const mainRunningAtSideEnd = !mainExited
    const mainExit = await main.done
    log(`btw probe: Claude Code ${version}; main session ${S}, forked at ${at}`)
    log(`btw probe: main first request usage ${JSON.stringify(mainUsage)}`)
    log(
      `btw probe: main was ${a.mainRunning ? 'still running' : 'already done'} at the side run's init, ${mainRunningAtSideEnd ? 'still running' : 'done'} at its end`
    )

    // Check 2 first: a failed resume explains every other failure.
    const sideText = a.lines.join('\n') + a.stderr
    if (/No message found/i.test(sideText))
      throw new Error(
        `check 2 failed: the side run could not find entry ${at} ("No message found"), so a just-streamed entry is not on disk yet`
      )
    if (!a.init) throw new Error(`side run reported no init (exit, stderr: ${a.stderr.slice(-2000)})`)

    // Check 1: a fork of its own, no file written, main run untouched.
    if (!a.mainRunning)
      throw new Error('check 1 inconclusive: the main run had ended before the side run started, so forking a live session was not tried')
    if (a.init.session_id === S)
      throw new Error(`check 1 failed: side init session id equals the main one (${S}); --fork-session was ignored`)
    const after = await jsonlFiles(projectDir)
    const added = [...after].filter((f) => !before.has(f))
    if (added.length) throw new Error(`check 1 failed: the side run wrote session files: ${added.join(', ')}`)
    if (existsSync(join(projectDir, `${a.init.session_id}.jsonl`))) {
      throw new Error(`check 1 failed: a session file for the side run's id ${a.init.session_id} exists`)
    }
    if (mainExit.code !== 0 || !mainResult || mainResult.is_error || !/DONE/.test(String(mainResult.result ?? ''))) {
      throw new Error(
        `check 1 failed: the main run did not end with DONE (exit ${mainExit.code}, result ${JSON.stringify(mainResult?.result)}); stderr: ${mainExit.stderr().slice(-2000)}`
      )
    }
    const mainLog = await readFile(join(projectDir, `${S}.jsonl`), 'utf8')
    if (mainLog.includes(token)) throw new Error(`check 1 failed: the main session file holds the side prompt (${token})`)
    if (results !== 4) log(`btw probe: note: main made ${results} tool calls, not 4`)
    log(`btw probe: check 1 ok (side session ${a.init.session_id}, no new .jsonl, main ended with DONE, main log clean)`)
    log('btw probe: check 2 ok (the just-streamed clean entry resumed fine)')

    // Check 3: nothing ran, even tools allowed by --allowedTools, and nothing asked for a card.
    const lockout = async (r, mode) => {
      log(
        `btw probe: side (${mode}) tool calls ${JSON.stringify(r.toolUses)}, results ${JSON.stringify(r.results.map((x) => ({ isError: x.isError, content: x.content.slice(0, 120) })))}`
      )
      log(`btw probe: side (${mode}) answer: ${JSON.stringify(r.text.slice(0, 300))}`)
      if (existsSync(join(work, 'marker.txt')))
        throw new Error(`check 3 failed (${mode}): marker.txt exists, so the MCP tool ran in a side run`)
      if (existsSync(join(work, 'hacked.txt'))) throw new Error(`check 3 failed (${mode}): hacked.txt exists, so Bash ran in a side run`)
      // Without these calls the missing files would prove nothing.
      if (!r.toolUses.some((t) => t.name === 'mcp__probe__touch_marker'))
        throw new Error(`check 3 inconclusive (${mode}): mcp__probe__touch_marker was never tried`)
      if (!r.toolUses.some((t) => t.name === 'Bash' && /echo hacked/.test(t.command ?? '')))
        throw new Error(`check 3 inconclusive (${mode}): Bash (echo hacked) was never tried`)
      const ran = r.results.filter((x) => !x.isError)
      if (ran.length) throw new Error(`check 3 failed (${mode}): tool results not refused: ${JSON.stringify(ran)}`)
      if (r.asks)
        throw new Error(`check 3 failed (${mode}): ${r.asks} can_use_tool request(s) came through, so an approval card would show`)
      if (!r.results.every((x) => x.content.includes(GUARD_TEXT)))
        throw new Error(`check 3 failed (${mode}): some refusals did not come from the guard: ${JSON.stringify(r.results)}`)
    }
    await lockout(a, 'auto')

    // ZumiBot's other permission mode, at the same fork point: the guard must hold there too.
    const b = await side('manual', S, at, token)
    if (!b.init || b.init.session_id === S)
      throw new Error(`check 3 failed (manual): the side run did not fork (stderr: ${b.stderr.slice(-2000)})`)
    await lockout(b, 'manual')
    const afterB = await jsonlFiles(projectDir)
    const addedB = [...afterB].filter((f) => !before.has(f))
    if (addedB.length) throw new Error(`check 1 failed (manual): the side run wrote session files: ${addedB.join(', ')}`)
    log(`btw probe: check 3 ok (every tool refused by the guard in auto and manual mode, no can_use_tool, no files)`)

    // Check 4: the side run's first request reads the forked context from the cache and writes little of its own.
    const cached = (u, mode) => {
      if (!u) throw new Error(`check 4 failed (${mode}): the side run reported no usage`)
      const read = u.cache_read_input_tokens ?? 0,
        made = u.cache_creation_input_tokens ?? 0
      const total = (u.input_tokens ?? 0) + read + made
      const share = total ? read / total : 0
      const cap = Math.max(5000, total * 0.1)
      log(
        `btw probe: side (${mode}) first request usage ${JSON.stringify(u)}; cache read ${read} (${(share * 100).toFixed(1)}%), written ${made} (cap ${Math.round(cap)})`
      )
      if (share < 0.8)
        throw new Error(
          `check 4 failed (${mode}): the side run's first request read only ${(share * 100).toFixed(1)}% from the cache (${JSON.stringify(u)})`
        )
      if (made >= cap)
        throw new Error(
          `check 4 failed (${mode}): the side run's first request wrote ${made} cache tokens, at or above ${Math.round(cap)} (${JSON.stringify(u)})`
        )
    }
    cached(a.usage, 'auto')
    cached(b.usage, 'manual')
    log('btw probe: check 4 ok')

    log(`btw probe: all 4 checks passed (Claude Code ${version})`)
    ok = true
  } finally {
    for (const c of children) {
      if (c.exitCode === null && c.signalCode === null)
        try {
          process.kill(-c.pid, 'SIGKILL')
        } catch {
          /* gone */
        }
      // The group may outlive its leader (an MCP server or shell); a dead group just throws.
      try {
        process.kill(-c.pid, 'SIGKILL')
      } catch {
        /* gone */
      }
    }
    if (ok) {
      await rm(work, { recursive: true, force: true })
      // Only the probe's own sessions live here: the folder is named after the fresh temp dir.
      await rm(projectDir, { recursive: true, force: true })
    } else {
      log(`btw probe: kept ${work} and ${projectDir} for inspection`)
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  probeSideRun().catch((e) => {
    console.error(`btw probe: FAILED: ${e.message}`)
    process.exit(1)
  })
}
