// Probe of the real claude CLI for the extensions feature (spec: docs/superpowers/specs/2026-11-12-claude-code-extensions-design.md,
// "What the CLI tells us" and "Checks made"). Settings > Extensions and the per-agent loadout rest on CLI behaviour nobody documents:
//  a) the control requests `mcp_status`, `get_skills_dialog` and `get_hooks_listing` (after `initialize`) answer with known shapes;
//  b) `deniedMcpServers` in a run's --settings keeps the server out of `mcp_status`;
//  c) `skillOverrides: {"<skill>": "off"}` shows the skill as state "off";
//  d) `enabledPlugins: {"<id>": false}` drops that plugin's skills and hooks;
//  e) a hook in a run's --settings is listed with source `flagSettings`;
//  f) the key `claude mcp add -s local` writes under `projects` of .claude.json: the REAL path of the nearest ancestor (the folder's
//     real path first) holding a `.git` entry (file or directory), else the real path of the folder; the service keys on this rule;
//  g) one --settings merging a guard hook, an ask and a deny rule with every hook shape the app applies from an agent file (and the
//     agent's other keys) keeps the guard and the rules: claude 2.1.322 silently drops a whole --settings over one PreToolUse hook with
//     a timeout of 0 or below, so a stricter schema in a later CLI could drop ZumiBot's guards with it (Ruling 23).
// Those need no model: they run the CLI in a temp project (a stub MCP server in `.mcp.json`, a project skill) and speak the
// control protocol directly (this script does not need the build). `--model-check` adds a few Haiku runs (a few cents) that check
//  1) a server named in --disallowedTools has no tools in the init event while it is connected;
//  2) the tool prefix rule (`toolPrefix`: every character outside [A-Za-z0-9_-] becomes `_`) for an odd server name;
//  3) an agent file's `mcpServers` and `hooks` are ignored under --agent (the CLI applies them to subagents only);
//  4) the side guard's block holds when another PreToolUse hook allows the same call (both orders).
// Run directly: node zumi-bot-server/e2e/extensionsProbe.mjs [--model-check] [--soft]
// Exit 0 PASS, 1 FAILED (the CLI changed something the feature relies on), 2 INCONCLUSIVE (a check could not be made, after one
// retry: no login, no plugin to compare, the model never made the call...). `--soft` turns INCONCLUSIVE into exit 0 with a loud
// warning (npm run e2e passes it); ZUMIBOT_SKIP_EXTENSIONS_PROBE=1 skips the probe.
// ZUMIBOT_PROBE_CLAUDE (or CLAUDE_BIN) names the claude binary; the unit tests point it at a fake.
// The model-free runs use a throwaway HOME and CLAUDE_CONFIG_DIR, so the user's own servers, skills and files are never read or
// written; only the plugin check (d) and the model runs use the real ones (the CLI itself may touch ~/.claude.json, as in any run).
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The app's SIDE_GUARD_SETTINGS (backend core/btw/sideRun.ts), byte for byte; a unit test pins the two together. */
export const SIDE_GUARD_SETTINGS =
  '{"hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"echo \'No tools in a side answer\' >&2; exit 2"}]}]}}'
const SIDE_GUARD_TEXT = 'No tools in a side answer'

/** The app's toolPrefix (shared/src/extensions.ts); a unit test pins the two together. */
export const toolPrefix = (serverName) => 'mcp__' + serverName.replace(/[^A-Za-z0-9_-]/g, '_')

const STUB_NAME = 'probe-srv'
const SKILL_NAME = 'probe-skill'
const ODD_NAME = 'my db: v2.1'
// A tiny MCP stdio server: answers initialize and tools/list with one tool, `ping`.
const STUB_SOURCE = `import { createInterface } from 'node:readline'
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
createInterface({ input: process.stdin }).on('line', (l) => {
  let m
  try { m = JSON.parse(l) } catch { return }
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'probe-stub', version: '1' } } })
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'ping', description: 'Ping', inputSchema: { type: 'object', properties: {} } }] } })
  else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'not supported' } })
})
`

const LIST_MS = 30_000
const PENDING_MS = 15_000
const POLL_MS = 500
const MODEL_RUN_MS = 120_000

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const binary = () => process.env.ZUMIBOT_PROBE_CLAUDE || process.env.CLAUDE_BIN || 'claude'
const killGroup = (child, sig = 'SIGKILL') => {
  try {
    // Windows has no process groups: the CLI's tree (its MCP servers included) ends with taskkill, as procKill.ts does.
    // An exited leader has no tree left for taskkill to find, so it is skipped (each call costs a process start).
    if (process.platform !== 'win32') process.kill(-child.pid, sig)
    else if (child.exitCode === null && child.signalCode === null)
      execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true })
  } catch {
    /* gone */
  }
}
// The CLIs running now, so a signal to the probe takes their whole process groups (and their MCP servers) down with it.
const running = new Set()
/** Ends every CLI still running (and its MCP servers): for a probe built on `listings` that is stopped by a signal. */
export const killRunning = () => {
  for (const c of running) killGroup(c)
  running.clear()
}

// ---------- the judge ----------

const SECTIONS = ['mcp', 'skills', 'hooks']
const SECTION_LABEL = { mcp: 'mcp_status', skills: 'get_skills_dialog', hooks: 'get_hooks_listing' }
const arr = Array.isArray
// A path inside an sh command: Claude Code runs hooks and Bash in Git Bash on Windows, which would eat a backslash.
const shPath = (p) => p.replace(/\\/g, '/')
const isStr = (v) => typeof v === 'string' && v !== ''

const toolNamed = (t) => isStr(t) || isStr(obj(t)?.name)

/**
 * Why one section's answer is not the shape the feature reads, or null when it is: every field `sanitize.ts` builds a row from, so a
 * renamed key fails loudly here instead of turning into a quiet `other` or an empty list on the page.
 */
function shapeProblem(section, answer) {
  const a = obj(answer)
  if (section === 'mcp') {
    if (!a || !arr(a.mcpServers)) return 'no `mcpServers` list'
    if (a.mcpServers.some((s) => !isStr(obj(s)?.name) || !isStr(obj(s)?.status))) return 'a server has no `name` or `status`'
    if (a.mcpServers.some((s) => !isStr(s.scope))) return 'a server has no `scope`'
    // A connected server lists its tools, by name.
    if (a.mcpServers.some((s) => s.status === 'connected' && (!arr(s.tools) || !s.tools.every(toolNamed))))
      return 'a connected server has no `tools` list of named tools'
    return null
  }
  if (section === 'skills') {
    if (!a || !arr(a.skills)) return 'no `skills` list'
    if (a.skills.some((s) => !isStr(obj(s)?.name) || !['on', 'off'].includes(obj(s)?.state)))
      return 'a skill has no `name` or a `state` other than on/off'
    return a.skills.some((s) => !isStr(s.source)) ? 'a skill has no `source`' : null
  }
  if (!a || !arr(a.hooks)) return 'no `hooks` list'
  if (a.hooks.some((h) => !isStr(obj(h)?.event) || !isStr(obj(h)?.source))) return 'a hook has no `event` or `source`'
  return a.hooks.some((h) => h.source === 'pluginHook' && !isStr(h.pluginName)) ? 'a plugin hook has no `pluginName`' : null
}

/**
 * The probe's verdict from what its runs saw; pure. `answers` is the base run's raw answers (`errors.<section>` is 'error' when the
 * CLI answered with an error, any other string when it did not answer at all). Every other part is true (held), false (the CLI
 * changed) or null (could not be checked); `undefined` for `model`/`localKey` means not asked for.
 * FAILED when anything the feature relies on changed, else INCONCLUSIVE when anything could not be checked, else PASS.
 */
export function judgeExtensions(o) {
  const failed = [],
    unknown = []
  // true held, false the CLI changed (`bad`), null/undefined could not be checked (`none`).
  const check = (ok, bad, none) => {
    if (ok === false) failed.push(bad)
    else if (ok === null || ok === undefined) unknown.push(none)
  }

  const answers = o.answers
  if (!answers) unknown.push('the CLI could not be started or asked: no answers to check')
  else {
    for (const s of SECTIONS) {
      const err = answers.errors?.[s]
      if (err === 'error') failed.push(`${SECTION_LABEL[s]} was answered with an error`)
      else if (err) unknown.push(`${SECTION_LABEL[s]} got no answer (${err})`)
      else {
        const why = shapeProblem(s, answers[s])
        if (why) failed.push(`${SECTION_LABEL[s]} changed its shape: ${why}`)
      }
    }
  }
  // The plugin check's own listing (the user's real plugins) is the only one holding plugin rows: its shape is checked too.
  if (o.pluginShape) failed.push(`the listing with the user's plugins changed its shape: ${o.pluginShape}`)
  if (!o.denied) unknown.push('deniedMcpServers: no server to deny (the control run did not list the stub server)')
  else if (o.denied.present) failed.push(`deniedMcpServers did not keep "${o.denied.name}" out of mcp_status`)
  if (!o.overrides) unknown.push('skillOverrides and enabledPlugins could not be compared')
  else {
    check(o.overrides.skillOff, 'skillOverrides "off" did not show the skill as state off', 'skillOverrides: nothing to compare')
    check(
      o.overrides.pluginOff,
      "enabledPlugins false did not drop the plugin's skills and hooks",
      'enabledPlugins: no enabled plugin with skills or hooks to compare'
    )
  }
  if (o.flagHook !== undefined)
    check(o.flagHook, "a hook in the run's --settings was not listed with source flagSettings", 'flagSettings hook: could not be checked')
  if (o.merged !== undefined) {
    if (o.merged === null) unknown.push('merged settings: the CLI could not be started or asked')
    else {
      check(
        o.merged.guard,
        "a run's merged --settings lost its guard hook beside the hook shapes ZumiBot applies from an agent file (the CLI dropped the whole --settings)",
        'merged settings: get_hooks_listing could not be read'
      )
      check(
        o.merged.rules,
        "a run's merged --settings lost its ask and deny rules beside the hook shapes ZumiBot applies from an agent file (the CLI dropped the whole --settings)",
        'merged settings: get_settings could not be read'
      )
    }
  }
  if (o.model !== undefined) {
    if (o.model === null) unknown.push('--model-check: the model runs could not be made')
    else {
      const m = o.model
      const seen = m.prefixObserved ? ` (observed ${m.prefixObserved}, expected ${m.prefixExpected})` : ''
      check(
        m.toolsHidden,
        "--disallowedTools mcp__<server> did not remove the server's tools from the model's tool list",
        'tools hidden: no connected server to compare'
      )
      check(
        m.prefixOk,
        `the tool prefix is not mcp__ plus the name with every character outside [A-Za-z0-9_-] as _${seen}`,
        "tool prefix: the odd-named server's tools were not listed"
      )
      check(
        m.agentKeysIgnored,
        "an agent file's mcpServers or hooks ran under --agent (ZumiBot would double them)",
        'agent keys: could not be compared (the agent was not shown to be active, or the control hook did not run)'
      )
      check(
        m.guardWins,
        'the side guard did not block a call that another PreToolUse hook allowed',
        'side guard: no precedence proof (the control, the allow hook alone, did not let Bash run, or Bash ran with no hook at all, or the model never made the call, or something else refused it)'
      )
    }
  }
  if (o.localKey !== undefined) {
    if (o.localKey === null) unknown.push('local key: the CLI could not add a local server')
    else {
      const seen = o.localKey.observed?.length ? ` (observed: ${o.localKey.observed.join('; ')})` : ''
      check(
        o.localKey.rule,
        `claude mcp add -s local no longer keys by the real path of the nearest ancestor with a .git entry, else of the folder${seen}`,
        `local key: a sub-check could not be made${seen}`
      )
    }
  }
  if (failed.length) return { verdict: 'FAILED', reasons: failed }
  if (unknown.length) return { verdict: 'INCONCLUSIVE', reasons: unknown }
  return { verdict: 'PASS', reasons: [] }
}

/** The exit code: 0 pass (or inconclusive with --soft), 1 failed, 2 inconclusive. */
export function exitCodeFor(verdict, { soft = false } = {}) {
  if (verdict === 'PASS') return 0
  if (verdict === 'FAILED') return 1
  return soft ? 0 : 2
}

// ---------- the CLI, model-free ----------

const cleanEnv = (extra = {}) => {
  const env = { ...process.env, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1', ...extra }
  delete env.CLAUDECODE // the probe may be started from inside a Claude Code session
  return env
}

/** Starts the CLI with the app's control-protocol flags; `ask(subtype)` resolves {ok, response} | {ok:false, why: 'error'|'timeout'|'exit'}. */
function startSession(bin, cwd, env, extraArgs, deadlineMs) {
  const child = spawn(
    bin,
    [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-prompt-tool',
      'stdio',
      '--no-session-persistence',
      ...extraArgs
    ],
    { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'ignore'] }
  )
  running.add(child)
  const open = new Map()
  let next = 1,
    over = null,
    buf = ''
  const end = (why) => {
    over ??= why
    const all = [...open.values()]
    open.clear()
    for (const settle of all) settle({ ok: false, why })
  }
  child.stdin.on('error', () => {})
  child.stdout.setEncoding('utf8').on('data', (c) => {
    buf += c
    for (let nl; (nl = buf.indexOf('\n')) >= 0;) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      let m
      try {
        m = JSON.parse(line)
      } catch {
        continue
      }
      // Everything else the CLI prints (hook lines, many `system` events) is not ours.
      if (m?.type !== 'control_response') continue
      const r = obj(m.response),
        settle = typeof r?.request_id === 'string' ? open.get(r.request_id) : undefined
      if (!r || !settle) continue
      open.delete(r.request_id)
      settle(r.subtype === 'success' ? { ok: true, response: r.response ?? null } : { ok: false, why: 'error' })
    }
  })
  child.on('error', () => end('exit'))
  child.on('exit', () => end('exit'))
  const deadline = setTimeout(() => {
    end('timeout')
    killGroup(child)
  }, deadlineMs)
  const ask = (subtype) => {
    if (over) return Promise.resolve({ ok: false, why: over })
    const id = `r${next++}`
    return new Promise((resolve) => {
      open.set(id, resolve)
      try {
        child.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request: { subtype } }) + '\n')
      } catch {
        open.delete(id)
        resolve({ ok: false, why: 'exit' })
      }
    })
  }
  const stop = async () => {
    clearTimeout(deadline)
    try {
      child.stdin.end()
    } catch {
      /* closed */
    }
    killGroup(child, 'SIGTERM')
    await sleep(150)
    killGroup(child) // a CLI that ignores SIGTERM (and its MCP servers) must not outlive the probe
    running.delete(child)
  }
  return { ask, stop }
}

/**
 * One CLI run: initialize, mcp_status (asked again while a server is `pending`), the skills and the hooks; raw answers, like ProbeAnswers.
 * With `effective`, also get_settings (the merged settings the run applies) into `out.effective`; `errors.settings` says why not.
 */
export async function listings({ bin, cwd, env, settings, agent = null, effective = false }) {
  const out = { version: null, mcp: null, skills: null, hooks: null, errors: {} }
  const s = startSession(bin, cwd, env, [...(agent ? ['--agent', agent] : []), '--settings', JSON.stringify(settings)], LIST_MS)
  try {
    const hello = await s.ask('initialize')
    if (!hello.ok) {
      for (const k of SECTIONS) out.errors[k] = hello.why
      return out
    }
    out.version = typeof obj(hello.response)?.claude_code_version === 'string' ? hello.response.claude_code_version : null
    const until = Date.now() + PENDING_MS
    for (const k of ['mcp', 'skills', 'hooks']) {
      for (;;) {
        const r = await s.ask(SECTION_LABEL[k])
        if (!r.ok) {
          out.errors[k] = r.why
          break
        }
        out[k] = r.response
        const pending = k === 'mcp' && arr(obj(r.response)?.mcpServers) && r.response.mcpServers.some((x) => obj(x)?.status === 'pending')
        if (!pending || Date.now() >= until) break
        await sleep(POLL_MS)
      }
    }
    if (effective) {
      const r = await s.ask('get_settings')
      if (r.ok) out.effective = r.response
      else out.errors.settings = r.why
    }
  } finally {
    await s.stop()
  }
  return out
}

const serversOf = (a) => (arr(obj(a?.mcp)?.mcpServers) ? a.mcp.mcpServers : [])
const skillsOf = (a) => (arr(obj(a?.skills)?.skills) ? a.skills.skills : [])
const hooksOf = (a) => (arr(obj(a?.hooks)?.hooks) ? a.hooks.hooks : [])
const transient = (a) => SECTIONS.some((k) => a.errors[k] && a.errors[k] !== 'error')

/** A project folder holding the stub server (`.mcp.json`) and a project skill, under a temp base that holds nothing else of the user's. */
async function makeWork(base) {
  const work = await realpath(await mkdtemp(join(base, 'extensions-probe-')))
  const proj = join(work, 'proj'),
    home = join(work, 'home')
  const stub = join(work, 'stub.mjs')
  await mkdir(join(proj, '.claude', 'skills', SKILL_NAME), { recursive: true })
  await mkdir(join(home, 'cfg'), { recursive: true })
  await writeFile(stub, STUB_SOURCE)
  await writeFile(join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { [STUB_NAME]: { command: process.execPath, args: [stub] } } }))
  await writeFile(
    join(proj, '.claude', 'skills', SKILL_NAME, 'SKILL.md'),
    `---\nname: ${SKILL_NAME}\ndescription: A skill for the extensions probe.\n---\nNothing to do.\n`
  )
  return { work, proj, stub, home, hermetic: { HOME: home, CLAUDE_CONFIG_DIR: join(home, 'cfg') } }
}

const FLAG_HOOK = { PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'true' }] }] }
// enableAllProjectMcpServers approves the project's `.mcp.json` server for the run, with no prompt.
const BASE_SETTINGS = { enableAllProjectMcpServers: true, hooks: FLAG_HOOK }

async function once(fn) {
  const first = await fn()
  return first.retry ? (await fn()).value : first.value
}

/** Checks a, b, c and e in two hermetic runs: a plain one (the control) and one with deniedMcpServers and skillOverrides. */
async function checkSettings(bin, w) {
  const env = cleanEnv(w.hermetic)
  const base = await once(async () => {
    const a = await listings({ bin, cwd: w.proj, env, settings: BASE_SETTINGS })
    return { value: a, retry: transient(a) }
  })
  const withServer = serversOf(base).some((s) => obj(s)?.name === STUB_NAME)
  const skillBase = skillsOf(base).find((s) => obj(s)?.name === SKILL_NAME)
  const flagHook = hooksOf(base).some((h) => obj(h)?.source === 'flagSettings' && obj(h)?.event === 'PostToolUse')
  const changed = await once(async () => {
    const a = await listings({
      bin,
      cwd: w.proj,
      env,
      settings: { ...BASE_SETTINGS, deniedMcpServers: [{ serverName: STUB_NAME }], skillOverrides: { [SKILL_NAME]: 'off' } }
    })
    return { value: a, retry: transient(a) }
  })
  const denied =
    withServer && !changed.errors.mcp ? { name: STUB_NAME, present: serversOf(changed).some((s) => obj(s)?.name === STUB_NAME) } : null
  const offRow = skillsOf(changed).find((s) => obj(s)?.name === SKILL_NAME)
  const skillOff = skillBase?.state === 'on' && offRow ? offRow.state === 'off' : null
  return { base, denied, skillOff, flagHook: base.errors.hooks ? null : flagHook }
}

/**
 * Check d: an enabled user plugin that adds skills or hooks loses them under enabledPlugins false; `off` is null when there is none to
 * compare. `shape` names a field the plugin rows lost (`pluginName`, a skill's `source`), else null.
 */
async function checkPlugin(bin, w, log) {
  const shape = { value: null }
  const off = await pluginOff(bin, w, log, shape)
  return { off, shape: shape.value }
}

async function pluginOff(bin, w, log, shape) {
  let plugins
  try {
    plugins = JSON.parse(
      execFileSync(bin, ['plugin', 'list', '--json'], { encoding: 'utf8', timeout: 30_000, env: cleanEnv(), cwd: w.proj })
    )
  } catch (e) {
    log(`extensions probe: plugin check: claude plugin list --json failed (${String(e.message).split('\n')[0]})`)
    return null
  }
  const enabled = arr(plugins) ? plugins.filter((p) => obj(p) && p.enabled === true && isStr(p.id)) : []
  if (!enabled.length) return null
  const env = cleanEnv()
  const rows = (a, id) => ({
    skills: skillsOf(a).filter((s) => String(obj(s)?.name).startsWith(`${id.split('@')[0]}:`)).length,
    hooks: hooksOf(a).filter((h) => obj(h)?.pluginName === id).length
  })
  const run = (settings) =>
    once(async () => {
      const a = await listings({ bin, cwd: w.proj, env, settings })
      return { value: a, retry: transient(a) }
    })
  const before = await run({ enableAllProjectMcpServers: true })
  if (transient(before) || before.errors.skills || before.errors.hooks) return null
  shape.value = shapeProblem('hooks', before.hooks) ?? shapeProblem('skills', before.skills)
  if (shape.value) return null
  const pick = enabled.map((p) => ({ id: p.id, n: rows(before, p.id) })).find((x) => x.n.skills + x.n.hooks > 0)
  if (!pick) return null
  const after = await run({ enableAllProjectMcpServers: true, enabledPlugins: { [pick.id]: false } })
  if (after.errors.skills || after.errors.hooks) return null
  const left = rows(after, pick.id)
  log(
    `extensions probe: plugin ${pick.id}: ${pick.n.skills} skills and ${pick.n.hooks} hooks before, ${left.skills} and ${left.hooks} with enabledPlugins false`
  )
  return left.skills + left.hooks === 0
}

// ---------- check g: the merged --settings (model-free) ----------

const hookCmd = (cmd, timeout) => ({ type: 'command', command: cmd, ...(timeout !== undefined ? { timeout } : {}) })
/**
 * Every hook shape the app's parser (`parseHooks`, shared/src/extensions.ts) calls editable, so a run applies it from an agent file:
 * groups with and without a matcher (empty, a tool, a regex that does not compile), no hooks, an empty command, timeouts from tiny to
 * huge, an event with no groups and one the CLI does not know; beside the agent's other keys. A unit test pins every hook as editable
 * and the whole object as what `buildAgentRunConfig` emits for it.
 */
export const AGENT_SETTINGS = {
  deniedMcpServers: [{ serverName: 'claude.ai Gmail' }, { serverName: 'plugin:x:y' }],
  enabledPlugins: { 'demo@mk': false },
  skillOverrides: { [SKILL_NAME]: 'off' },
  hooks: {
    PreToolUse: [
      { matcher: 'Bash', hooks: [hookCmd('true'), hookCmd('true', 1)] },
      { hooks: [hookCmd('', 1.5)] },
      { matcher: '(', hooks: [hookCmd('true', 1e20)] },
      { matcher: 'mcp__x__.*', hooks: [hookCmd('true', 0.001)] }
    ],
    PostToolUse: [{ matcher: '*', hooks: [hookCmd('true', 600)] }],
    NotAHookEvent: [{ hooks: [hookCmd('true')] }]
  }
}
export const ASK_RULE = 'mcp__zumibot_desktop__desktop_click'
export const DENY_RULE = 'Read(//probe-vault-key/**)'
const GUARD_COMMAND = 'echo GUARD'
/** What every main run adds beside them: a guard hook on every tool (the pause hook, the vault guard), an ask rule (the desktop's) and a deny rule (the vault's). */
export const GUARD_SETTINGS = {
  hooks: { PreToolUse: [{ matcher: '*', hooks: [hookCmd(GUARD_COMMAND)] }] },
  permissions: { ask: [ASK_RULE], deny: [DENY_RULE] }
}

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
/** The app's merge of several --settings into one (`mergeJson` in backend core/chat/claudeRunner.ts); a unit test pins the two together. */
export function mergeSettings(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b.filter((x) => !a.some((y) => JSON.stringify(y) === JSON.stringify(x)))]
  if (isPlain(a) && isPlain(b)) {
    const out = { ...a }
    for (const [k, v] of Object.entries(b)) out[k] = mergeSettings(out[k], v)
    return out
  }
  return b
}

/** Check g: the guard hook and both rules survive one merged --settings (the run's own first, the agent's after, as a main run has them). */
async function checkMerged(bin, w, log) {
  const ask = async (settings) => {
    // Like every model-free session here, in the project with its server approved; that key changes nothing the check reads.
    const s = startSession(
      bin,
      w.proj,
      cleanEnv(w.hermetic),
      ['--settings', JSON.stringify({ enableAllProjectMcpServers: true, ...settings })],
      LIST_MS
    )
    try {
      const hello = await s.ask('initialize')
      if (!hello.ok) return { value: null, retry: hello.why !== 'error' }
      const hooks = await s.ask('get_hooks_listing')
      const eff = await s.ask('get_settings')
      return { value: { hooks, eff }, retry: [hooks, eff].some((r) => !r.ok && r.why !== 'error') }
    } finally {
      await s.stop()
    }
  }
  const read = (r) => {
    const guard =
      r.hooks.ok && arr(obj(r.hooks.response)?.hooks)
        ? r.hooks.response.hooks.some(
            (h) => obj(h)?.source === 'flagSettings' && h.event === 'PreToolUse' && h.matcher === '*' && h.commandText === GUARD_COMMAND
          )
        : null
    const effective = r.eff.ok ? obj(obj(r.eff.response)?.effective) : null
    const perms = obj(effective?.permissions)
    const rules = effective ? arr(perms?.ask) && perms.ask.includes(ASK_RULE) && arr(perms?.deny) && perms.deny.includes(DENY_RULE) : null
    return { guard, rules }
  }
  const r = await once(() => ask(mergeSettings(GUARD_SETTINGS, AGENT_SETTINGS)))
  if (!r) return null
  const kept = read(r)
  // The control shows the check can see a drop: on claude 2.1.322 one PreToolUse hook with a timeout of 0 (which the app refuses) drops
  // the whole --settings; another event's drops only that hook.
  const zero = await once(() =>
    ask(mergeSettings(GUARD_SETTINGS, { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [hookCmd('true', 0)] }] } }))
  )
  const ctl = zero ? read(zero) : null
  const say = (v) => (v === true ? 'kept' : v === false ? 'LOST' : 'not read')
  log(
    `extensions probe: merged settings with every agent hook shape: guard hook ${say(kept.guard)}, ask and deny rules ${say(kept.rules)} (control, a timeout-0 hook: guard ${say(ctl?.guard)}, rules ${say(ctl?.rules)})`
  )
  return kept
}

const gitAbove = (dir) => {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return true
    if (dirname(d) === d) return false
  }
}

/**
 * Check f, the rule the service keys on: `claude mcp add-json -s local` stores the server under `projects[<key>]` of .claude.json, the key
 * being the real path of the nearest ancestor of the folder's real path that holds a `.git` entry (file or directory), else the real path
 * of the folder. Five scenarios in a throwaway HOME; `rule` is false when any key differs, null when one could not be made (the no-`.git`
 * case needs a folder with no `.git` in any ancestor, looked for under a few temp roots: a stray /tmp/.git is common).
 */
async function checkLocalKey(bin, w, log) {
  const t = join(w.work, 'lk')
  const repo = join(t, 'repo'),
    app = join(repo, 'sub', 'app'),
    link = join(t, 'link')
  const wt = join(t, 'wt'),
    wtSub = join(wt, 'sub')
  await mkdir(join(repo, '.git'), { recursive: true })
  await mkdir(app, { recursive: true })
  await mkdir(wtSub, { recursive: true })
  await writeFile(join(wt, '.git'), 'gitdir: /nonexistent\n') // worktree style: a file
  // A junction on Windows, where a symlink needs admin rights or Developer Mode; the type is ignored elsewhere.
  await symlink(app, link, 'junction')
  const keys = async (cwd) => {
    await rm(join(w.home, 'cfg'), { recursive: true, force: true })
    await mkdir(join(w.home, 'cfg'), { recursive: true })
    execFileSync(bin, ['mcp', 'add-json', 'probe-srv', JSON.stringify({ command: 'node', args: ['x'] }), '-s', 'local'], {
      cwd,
      env: cleanEnv(w.hermetic),
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const j = JSON.parse(
      await readFile(join(w.home, 'cfg', '.claude.json'), 'utf8').catch(() => readFile(join(w.home, '.claude.json'), 'utf8'))
    )
    return Object.keys(obj(j.projects) ?? {})
  }
  const observed = [],
    results = []
  let extra = null
  const scenario = async (label, cwd, expected, root = w.work) => {
    try {
      const got = await keys(cwd)
      const ok = got.length === 1 && got[0] === expected
      const rel = (k) => (k.startsWith(root) ? k.slice(root.length) || '/' : k)
      observed.push(`${label}: ${got.map(rel).join(', ') || 'no key'}${ok ? '' : ` (expected ${rel(expected)})`}`)
      results.push(ok)
    } catch (e) {
      observed.push(`${label}: the CLI failed (${String(e.message).split('\n')[0].slice(0, 120)})`)
      results.push(null)
    }
  }
  try {
    await scenario('repo/sub/app in a repo', app, repo)
    await scenario('symlink to repo/sub/app', link, repo)
    await mkdir(join(app, '.git'))
    await scenario('nested repo wins', app, app)
    await scenario('.git as a file', wtSub, wt)
    // The no-`.git` case: a folder none of whose ancestors holds a .git entry.
    for (const base of [tmpdir(), '/var/tmp', '/dev/shm']) {
      if (!existsSync(base) || gitAbove(base)) continue
      try {
        extra = await realpath(await mkdtemp(join(base, 'extensions-probe-nogit-')))
      } catch {
        continue
      }
      break
    }
    if (extra) {
      await mkdir(join(extra, 'sub'))
      await symlink(join(extra, 'sub'), join(extra, 'link'), 'junction')
      await scenario('no .git above, via a symlink', join(extra, 'link'), join(extra, 'sub'), extra)
    } else {
      observed.push('no .git above: not checked (every temp root has a .git in an ancestor)')
      results.push(null)
    }
  } finally {
    if (extra) await rm(extra, { recursive: true, force: true })
  }
  log(`extensions probe: local key (relative to the temp folder): ${observed.join('; ')}`)
  return { rule: results.includes(false) ? false : results.includes(null) ? null : true, observed }
}

// ---------- the model runs (opt-in) ----------

const contentOf = (m) => (Array.isArray(m?.message?.content) ? m.message.content : [])
const textOf = (c) =>
  typeof c === 'string'
    ? c
    : Array.isArray(c)
      ? c.map((b) => (typeof b === 'string' ? b : b?.type === 'text' ? String(b.text ?? '') : '')).join('\n')
      : ''

/** One tiny Haiku turn (`-p`, stream-json); every can_use_tool gets `answer` (allow: only the settings can stop a call; deny: only a hook can let one run). */
async function modelRun(bin, cwd, extraArgs, prompt, { mode = 'auto', answer = 'allow' } = {}) {
  const argv = [
    '-p',
    '--model',
    'haiku',
    '--max-turns',
    '4',
    '--permission-mode',
    mode,
    '--permission-prompt-tool',
    'stdio',
    '--no-session-persistence',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    ...extraArgs
  ]
  const r = { init: null, results: [], calls: [], asked: [], result: null, error: null }
  let child
  try {
    child = spawn(bin, argv, { cwd, env: cleanEnv(), detached: true, stdio: ['pipe', 'pipe', 'ignore'] })
    running.add(child)
    const send = (m) => {
      if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.write(JSON.stringify(m) + '\n')
    }
    child.stdin.on('error', () => {})
    let buf = ''
    child.stdout.setEncoding('utf8').on('data', (c) => {
      buf += c
      for (let nl; (nl = buf.indexOf('\n')) >= 0;) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        let m
        try {
          m = JSON.parse(line)
        } catch {
          continue
        }
        if (m.type === 'system' && m.subtype === 'init') r.init = m
        if (m.type === 'control_request' && m.request?.subtype === 'can_use_tool') {
          r.asked.push(m.request.tool_name)
          send({
            type: 'control_response',
            response: {
              subtype: 'success',
              request_id: m.request_id,
              response:
                answer === 'allow'
                  ? { behavior: 'allow', updatedInput: m.request.input }
                  : { behavior: 'deny', message: 'The probe denies every permission request.' }
            }
          })
        }
        if (m.type === 'assistant' && !m.parent_tool_use_id)
          for (const b of contentOf(m)) if (b?.type === 'tool_use') r.calls.push({ id: b.id, name: b.name })
        if (m.type === 'user')
          for (const b of contentOf(m))
            if (b?.type === 'tool_result') r.results.push({ id: b.tool_use_id, error: b.is_error === true, text: textOf(b.content) })
        if (m.type === 'result' && !r.result) {
          r.result = m
          child.stdin.end()
        }
      }
    })
    send({ type: 'user', message: { role: 'user', content: prompt } })
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        r.error = `the run took longer than ${MODEL_RUN_MS / 1000} s`
        resolve()
      }, MODEL_RUN_MS)
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
    if (child?.pid) {
      killGroup(child)
      running.delete(child)
    }
  }
  return r
}

const stubConfig = (stub, names) =>
  JSON.stringify({ mcpServers: Object.fromEntries(names.map((n) => [n, { command: process.execPath, args: [stub] }])) })
const NO_TOOL = 'This is a test. Reply with just the word OK. Do not call any tool.'

/** Checks 1 and 2 in one run: a hidden server and an odd-named one, both connected. */
async function checkTools(bin, w, log) {
  const hidden = 'hidden-srv'
  const r = await once(async () => {
    const run = await modelRun(
      bin,
      w.proj,
      ['--strict-mcp-config', '--mcp-config', stubConfig(w.stub, [hidden, ODD_NAME]), '--disallowedTools', toolPrefix(hidden)],
      NO_TOOL
    )
    return { value: run, retry: !run.init }
  })
  if (!r.init) return { toolsHidden: null, prefixOk: null }
  const tools = arr(r.init.tools) ? r.init.tools.filter((t) => typeof t === 'string' && t.startsWith('mcp__')) : []
  const servers = arr(r.init.mcp_servers) ? r.init.mcp_servers : []
  const hiddenConnected = servers.some((s) => obj(s)?.name === hidden && obj(s)?.status === 'connected')
  const hiddenTools = tools.filter((t) => t.startsWith(toolPrefix(hidden) + '__'))
  // The odd server's tools are the control: they show that tools of a connected server do reach the list in this run.
  const odd = tools.filter((t) => !t.startsWith(toolPrefix(hidden) + '__'))
  const expected = toolPrefix(ODD_NAME)
  const observed = odd.length ? odd[0].replace(/__ping$/, '') : null
  const prefixOk = odd.length ? odd.every((t) => t === `${expected}__ping`) : null
  log(
    `extensions probe: tools of a connected, disallowed server: ${hiddenTools.length} (status ${hiddenConnected ? 'connected' : (servers.find((s) => obj(s)?.name === hidden)?.status ?? 'absent')}); odd name "${ODD_NAME}" lists ${JSON.stringify(odd)}`
  )
  return {
    toolsHidden: hiddenConnected && odd.length ? hiddenTools.length === 0 : null,
    prefixOk,
    prefixObserved: prefixOk === false ? observed : undefined,
    prefixExpected: expected
  }
}

const AGENT_WORD = 'PROBE-AGENT-OK'

/**
 * Check 3: an agent file's own `mcpServers` and `hooks` do not load under --agent. Two controls keep "ignored" from being vacuous: a hook
 * given in --settings must fire (hooks run in this setup), and the agent must really be the active one: its name is in the init event's
 * `agents` and the reply carries the word only its own prompt asks for. Either control missing gives null.
 */
async function checkAgentKeys(bin, w, log) {
  const proj = join(w.work, 'agentproj')
  const ignored = join(w.work, 'agent-hook-ran'),
    control = join(w.work, 'settings-hook-ran')
  await mkdir(join(proj, '.claude', 'agents'), { recursive: true })
  await writeFile(
    join(proj, '.claude', 'agents', 'probe-agent.md'),
    [
      '---',
      'name: probe-agent',
      'description: An agent for the extensions probe.',
      'mcpServers:',
      '  - agentsrv:',
      '      type: stdio',
      `      command: ${JSON.stringify(process.execPath)}`,
      `      args: [${JSON.stringify(w.stub)}]`,
      'hooks:',
      '  UserPromptSubmit:',
      '    - hooks:',
      '        - type: command',
      `          command: ${JSON.stringify(`touch ${shPath(ignored)}`)}`,
      '---',
      `Always reply with exactly the word ${AGENT_WORD} and nothing else. Never call a tool.`,
      ''
    ].join('\n')
  )
  const settings = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `touch ${shPath(control)}` }] }] } })
  const active = (r) => arr(r.init?.agents) && r.init.agents.includes('probe-agent') && String(r.result?.result ?? '').includes(AGENT_WORD)
  const r = await once(async () => {
    await rm(ignored, { force: true })
    await rm(control, { force: true })
    const run = await modelRun(bin, proj, ['--agent', 'probe-agent', '--settings', settings], 'Hello.')
    return { value: run, retry: !run.init || !existsSync(control) || !active(run) }
  })
  const serverListed = (arr(r.init?.mcp_servers) ? r.init.mcp_servers : []).some((s) => obj(s)?.name === 'agentsrv')
  const agentHook = existsSync(ignored),
    controlHook = existsSync(control),
    loaded = active(r)
  log(
    `extensions probe: agent file keys under --agent: the agent ${loaded ? 'is active (listed in init.agents, its reply carries its own word)' : 'was NOT shown to be active'}; its mcpServers entry ${serverListed ? 'WAS' : 'was not'} listed in init, its UserPromptSubmit hook ${agentHook ? 'RAN' : 'did not run'} (the --settings hook ${controlHook ? 'ran' : 'did not run'})`
  )
  if (!r.init || !controlHook || !loaded) return null
  return !serverListed && !agentHook
}

const ALLOW_HOOK = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } })

/**
 * Check 4: the side guard blocks a Bash call that another PreToolUse hook allows, whichever hook comes first. Control first: the allow
 * hook ALONE, in a permission mode that asks, with every request denied: Bash must still run (marker written), which only the hook's
 * allow can cause. Without that, the guard + allow runs would pass with a dead allow hook and prove nothing about precedence.
 * Every run here loads no user, project or local settings (`--setting-sources ''`: a user's Bash allow rule or hook stays out, the
 * login does not depend on them), and a negative arm (no hook, every request denied) must NOT run Bash: if it does, something the
 * probe cannot turn off (a managed policy) allows it, so the control proves nothing and the check is INCONCLUSIVE.
 */
async function checkGuard(bin, w, log) {
  const guard = JSON.parse(SIDE_GUARD_SETTINGS).hooks.PreToolUse[0]
  const allow = { matcher: '*', hooks: [{ type: 'command', command: `printf '%s' '${ALLOW_HOOK}'` }] }
  const attemptFor = async (label, order, opts) => {
    const marker = join(w.work, `guard-marker-${label.replace(/[ +]/g, '-')}`)
    const prompt = `This is a test of tool hooks; nothing real happens. Use the Bash tool to run exactly this command: echo guard-probe > ${shPath(marker)}\nIf the call is refused or blocked, do not try another way: reply with the word BLOCKED and stop.`
    const r = await once(async () => {
      await rm(marker, { force: true })
      const run = await modelRun(
        bin,
        w.proj,
        [
          '--strict-mcp-config',
          '--mcp-config',
          '{"mcpServers":{}}',
          '--setting-sources',
          '',
          '--settings',
          JSON.stringify({ hooks: { PreToolUse: order } })
        ],
        prompt,
        opts
      )
      return { value: run, retry: run.calls.length === 0 }
    })
    const bash = r.calls.find((c) => c.name === 'Bash')
    const res = bash ? r.results.find((x) => x.id === bash.id) : undefined
    return { bash, res, ran: existsSync(marker), asked: r.asked, blocked: !!res && res.error && res.text.includes(SIDE_GUARD_TEXT) }
  }
  const neg = await attemptFor('no hook', [], { mode: 'default', answer: 'deny' })
  log(
    `extensions probe: side guard negative arm (no hook, every permission request denied): Bash ${neg.bash ? 'called' : 'never called'}, asked ${JSON.stringify(neg.asked)}, marker file ${neg.ran ? 'WRITTEN (something else allows Bash here)' : 'absent'}`
  )
  if (neg.ran) return null
  const ctl = await attemptFor('allow alone', [allow], { mode: 'default', answer: 'deny' })
  log(
    `extensions probe: side guard control (the allow hook alone, every permission request denied): Bash ${ctl.bash ? 'called' : 'never called'}, asked ${JSON.stringify(ctl.asked)}, marker file ${ctl.ran ? 'WRITTEN (the allow hook allows)' : 'absent (the allow hook did not allow)'}`
  )
  if (!ctl.ran) return null
  const verdicts = []
  for (const [label, order] of [
    ['guard first', [guard, allow]],
    ['allow first', [allow, guard]]
  ]) {
    const g = await attemptFor(label, order, {})
    log(
      `extensions probe: side guard with another hook allowing (${label}): Bash ${g.bash ? 'called' : 'never called'}, ${g.blocked ? 'blocked with the guard text' : g.res ? `result: ${g.res.text.slice(0, 120)}` : 'no result'}, marker file ${g.ran ? 'WRITTEN' : 'absent'}`
    )
    verdicts.push(g.ran ? false : g.bash && g.blocked ? true : null)
  }
  if (verdicts.includes(false)) return false
  return verdicts.every((v) => v === true) ? true : null
}

async function checkModel(bin, w, log) {
  const t = await checkTools(bin, w, log)
  return { ...t, agentKeysIgnored: await checkAgentKeys(bin, w, log), guardWins: await checkGuard(bin, w, log) }
}

// ---------- the probe ----------

const cliVersion = (bin) => {
  try {
    return execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim()
  } catch {
    return 'unknown'
  }
}

/** Runs the probe; returns {verdict, reasons, version}. Throws only on local setup errors. */
export async function probeExtensions({ bin = binary(), modelCheck = false, log = console.log } = {}) {
  const w = await makeWork(tmpdir())
  let keep = false
  try {
    const s = await checkSettings(bin, w)
    log(
      `extensions probe: Claude Code ${s.base.version ?? '?'}: shapes ${SECTIONS.map((k) => `${SECTION_LABEL[k]} ${s.base.errors[k] ? `ERROR(${s.base.errors[k]})` : shapeProblem(k, s.base[k]) ? 'CHANGED' : 'ok'}`).join(', ')}; deniedMcpServers ${s.denied ? (s.denied.present ? 'ignored' : 'kept the server out') : 'not checked'}; skillOverrides ${s.skillOff === null ? 'not checked' : s.skillOff ? 'off shown' : 'ignored'}; flagSettings hook ${s.flagHook ? 'listed' : 'missing'}`
    )
    const plugin = await checkPlugin(bin, w, log)
    const o = {
      answers: s.base,
      denied: s.denied,
      overrides: { skillOff: s.skillOff, pluginOff: plugin.off },
      pluginShape: plugin.shape,
      flagHook: s.base.errors.hooks ? null : s.flagHook,
      localKey: undefined
    }
    o.merged = await checkMerged(bin, w, log)
    const lk = await checkLocalKey(bin, w, log)
    o.localKey = lk
    if (modelCheck)
      o.model = await checkModel(bin, w, log).catch((e) => {
        log(`extensions probe: model runs failed: ${e.message}`)
        return null
      })
    const j = judgeExtensions(o)
    keep = j.verdict !== 'PASS'
    return { ...j, version: s.base.version ?? cliVersion(bin) }
  } finally {
    for (const c of running) killGroup(c)
    running.clear()
    if (keep) log(`extensions probe: kept ${w.work} for inspection`)
    else await rm(w.work, { recursive: true, force: true })
  }
}

/** The exit code of the probe's own run. */
export async function main(args = [], probe = probeExtensions) {
  if (process.env.ZUMIBOT_SKIP_EXTENSIONS_PROBE === '1') {
    console.log('extensions probe: skipped (ZUMIBOT_SKIP_EXTENSIONS_PROBE=1)')
    return 0
  }
  const modelCheck = args.includes('--model-check')
  let r
  try {
    r = await probe({ modelCheck })
  } catch (e) {
    r = { verdict: 'INCONCLUSIVE', reasons: [`the probe could not run: ${e.message}`], version: 'unknown' }
  }
  const soft = args.includes('--soft')
  const code = exitCodeFor(r.verdict, { soft })
  if (r.verdict === 'PASS')
    console.log(
      `extensions probe: PASS (Claude Code ${r.version}): the control requests, deniedMcpServers, skillOverrides, enabledPlugins, flagSettings hooks and a merged --settings keeping its guards behave as the extensions feature expects${modelCheck ? '; the tool prefix, hidden tools, ignored agent keys and the side guard held in real runs' : ''}`
    )
  else if (r.verdict === 'FAILED')
    console.error(`FAILED: Claude Code ${r.version}: the CLI no longer behaves as the extensions feature expects (${r.reasons.join('; ')})`)
  else {
    console.error(`INCONCLUSIVE: Claude Code ${r.version}: ${r.reasons.join('; ')}`)
    if (soft) {
      console.error(
        '!!! WARNING: the extensions probe was SKIPPED as inconclusive: the extensions feature is NOT verified for this Claude Code version.'
      )
      console.error('!!! Run `node zumi-bot-server/e2e/extensionsProbe.mjs` again before relying on it.')
    }
  }
  return code
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // A Ctrl-C or kill must not leave the CLI and its MCP servers running.
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143]
  ])
    process.once(signal, () => {
      for (const c of running) killGroup(c)
      process.exit(code)
    })
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
