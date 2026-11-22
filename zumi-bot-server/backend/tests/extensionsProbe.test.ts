// The real-CLI extensions probe (e2e/extensionsProbe.mjs): its verdict judge over what the runs saw, its exit codes, and whole runs
// against the fake claude (which follows the run's own flags and settings), so the plumbing is checked without quota.
// Each run gets its own TMPDIR, HOME and CLAUDE_CONFIG_DIR, so whatever the probe keeps is removed here.
import { afterEach, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFakeBin } from './support/fakeBin'
import { isWindows, removeDir } from './support/platform'
import { parseHooks, toolPrefix, type HooksConfig } from '@zumibot/shared/extensions'
import { SIDE_GUARD_SETTINGS } from '../src/core/btw/sideRun'
import { buildArgs } from '../src/core/chat/claudeRunner'
import { buildAgentRunConfig } from '../src/core/extensions/agentRunConfig'
import * as probe from '../../e2e/extensionsProbe.mjs'

const PROBE = fileURLToPath(new URL('../../e2e/extensionsProbe.mjs', import.meta.url))
const FAKE = fileURLToPath(new URL('./fixtures/fake-probe-claude.mjs', import.meta.url))
const dirs: string[] = []
// The probe reports local keys with the native separator; on Windows they read as POSIX paths for these patterns.
const slashed = (s: string) => (isWindows ? s.replace(/\\/g, '/') : s)
// Each whole run starts the fake CLI a dozen times, through a launcher and a slower node start on Windows.
const RUN_MS = isWindows ? 30_000 : undefined
afterEach(async () => {
  for (const d of dirs.splice(0)) removeDir(d)
})

it('pins its copies of the app constants to the app ones', () => {
  expect(probe.SIDE_GUARD_SETTINGS).toBe(SIDE_GUARD_SETTINGS)
  for (const name of ['my db: v2.1', 'plugin:chrome-devtools-mcp:chrome-devtools', 'claude.ai Claude Docs', 'a_b-c'])
    expect(probe.toolPrefix(name)).toBe(toolPrefix(name))
})

// Check g's settings are what a real run sends: every hook is one the app applies from an agent file, the agent part is what
// buildAgentRunConfig emits for such a file, and the merge is the runner's own.
it('pins check g to the app: editable hooks, the agent settings a run gets, and the runner merge', () => {
  const s = probe.AGENT_SETTINGS
  expect(parseHooks(s.hooks)?.editable).toBe(true)
  for (const groups of Object.values(s.hooks))
    for (const g of groups) for (const h of g.hooks) expect(parseHooks({ Stop: [{ hooks: [h] }] })?.editable).toBe(true)
  const own = buildAgentRunConfig(
    {
      serversOff: s.deniedMcpServers.map((d) => d.serverName),
      skillsOff: Object.keys(s.skillOverrides),
      plugins: s.enabledPlugins,
      servers: [],
      serversEditable: true,
      hooks: s.hooks as HooksConfig,
      hooksEditable: true
    },
    []
  )
  expect(JSON.parse(own.extraArgs[own.extraArgs.indexOf('--settings') + 1])).toEqual(s)
  const args = buildArgs({
    agentName: 'a',
    resumeSessionId: null,
    permissionMode: 'auto',
    extraArgs: ['--settings', JSON.stringify(probe.GUARD_SETTINGS), ...own.extraArgs]
  })
  expect(JSON.parse(args[args.indexOf('--settings') + 1])).toEqual(probe.mergeSettings(probe.GUARD_SETTINGS, s))
})

const answers = (errors: Record<string, string> = {}) => ({
  version: '9.9.9',
  mcp: { mcpServers: [{ name: 'probe-srv', status: 'connected', scope: 'project', tools: [{ name: 'ping' }] }] },
  skills: { skills: [{ name: 'probe-skill', state: 'on', source: 'project' }] },
  hooks: {
    events: [],
    hooks: [
      { event: 'PostToolUse', source: 'flagSettings' },
      { event: 'Stop', source: 'pluginHook', pluginName: 'demo@mk' }
    ]
  },
  errors
})
const good = () => ({
  answers: answers(),
  denied: { name: 'probe-srv', present: false },
  overrides: { skillOff: true, pluginOff: true },
  flagHook: true,
  merged: { guard: true, rules: true }
})
const goodModel = () => ({ toolsHidden: true, prefixOk: true, agentKeysIgnored: true, guardWins: true })

it('passes when every shape is right and every override held', () => {
  expect(probe.judgeExtensions(good())).toEqual({ verdict: 'PASS', reasons: [] })
  expect(probe.judgeExtensions({ ...good(), model: goodModel(), localKey: { rule: true, observed: [] } }).verdict).toBe('PASS')
})

it('fails when a request answers with an error or its shape changed', () => {
  const err = probe.judgeExtensions({ ...good(), answers: answers({ mcp: 'error' }) })
  expect(err.verdict).toBe('FAILED')
  expect(err.reasons[0]).toMatch(/mcp_status was answered with an error/)
  const shape = probe.judgeExtensions({ ...good(), answers: { ...answers(), skills: { skills: [{ name: 'x', state: 'maybe' }] } } })
  expect(shape.verdict).toBe('FAILED')
  expect(shape.reasons[0]).toMatch(/get_skills_dialog changed its shape/)
  expect(probe.judgeExtensions({ ...good(), answers: { ...answers(), hooks: { hooks: 'none' } } }).reasons[0]).toMatch(
    /get_hooks_listing changed its shape/
  )
  expect(probe.judgeExtensions({ ...good(), answers: { ...answers(), mcp: null } }).verdict).toBe('FAILED')
})

it.each([
  ['mcp', { mcpServers: [{ name: 's', status: 'connected', tools: [] }] }, /a server has no `scope`/],
  ['mcp', { mcpServers: [{ name: 's', status: 'connected', scope: 'user' }] }, /a connected server has no `tools` list/],
  [
    'mcp',
    { mcpServers: [{ name: 's', status: 'connected', scope: 'user', tools: [{ title: 'x' }] }] },
    /a connected server has no `tools` list of named tools/
  ],
  ['skills', { skills: [{ name: 'k', state: 'on' }] }, /a skill has no `source`/],
  ['hooks', { hooks: [{ event: 'Stop', source: 'pluginHook' }] }, /a plugin hook has no `pluginName`/]
])('fails when a %s answer lost a field the page reads (%#)', (section, answer, text) => {
  const r = probe.judgeExtensions({ ...good(), answers: { ...answers(), [section]: answer } })
  expect(r.verdict).toBe('FAILED')
  expect(r.reasons[0]).toMatch(text)
})

it("fails when the plugin check's own listing lost a field the page reads", () => {
  const r = probe.judgeExtensions({ ...good(), pluginShape: 'a plugin hook has no `pluginName`' })
  expect(r.verdict).toBe('FAILED')
  expect(r.reasons[0]).toMatch(/the listing with the user's plugins changed its shape: a plugin hook has no `pluginName`/)
  expect(probe.judgeExtensions({ ...good(), pluginShape: null }).verdict).toBe('PASS')
})

it('is inconclusive when a request got no answer at all, or there are no answers', () => {
  const r = probe.judgeExtensions({ ...good(), answers: answers({ hooks: 'timeout' }) })
  expect(r.verdict).toBe('INCONCLUSIVE')
  expect(r.reasons[0]).toMatch(/get_hooks_listing got no answer \(timeout\)/)
  expect(probe.judgeExtensions({ ...good(), answers: null }).verdict).toBe('INCONCLUSIVE')
})

it('fails when a denied server is still listed, is inconclusive with nothing to deny', () => {
  const still = probe.judgeExtensions({ ...good(), denied: { name: 'probe-srv', present: true } })
  expect(still.verdict).toBe('FAILED')
  expect(still.reasons[0]).toMatch(/deniedMcpServers did not keep "probe-srv" out/)
  const none = probe.judgeExtensions({ ...good(), denied: null })
  expect(none.verdict).toBe('INCONCLUSIVE')
  expect(none.reasons[0]).toMatch(/no server to deny/)
})

it('judges the skill and plugin overrides and the flagSettings hook', () => {
  expect(probe.judgeExtensions({ ...good(), overrides: { skillOff: false, pluginOff: true } }).reasons[0]).toMatch(/skillOverrides "off"/)
  expect(probe.judgeExtensions({ ...good(), overrides: { skillOff: true, pluginOff: false } }).reasons[0]).toMatch(/enabledPlugins false/)
  const none = probe.judgeExtensions({ ...good(), overrides: { skillOff: true, pluginOff: null } })
  expect(none.verdict).toBe('INCONCLUSIVE')
  expect(none.reasons[0]).toMatch(/no enabled plugin/)
  expect(probe.judgeExtensions({ ...good(), overrides: null }).verdict).toBe('INCONCLUSIVE')
  expect(probe.judgeExtensions({ ...good(), flagHook: false }).reasons[0]).toMatch(/flagSettings/)
})

it('fails when a merged --settings lost its guard hook or its rules, and is inconclusive when it could not be read', () => {
  const guard = probe.judgeExtensions({ ...good(), merged: { guard: false, rules: true } })
  expect(guard.verdict).toBe('FAILED')
  expect(guard.reasons[0]).toMatch(/merged --settings lost its guard hook/)
  expect(probe.judgeExtensions({ ...good(), merged: { guard: true, rules: false } }).reasons[0]).toMatch(
    /merged --settings lost its ask and deny rules/
  )
  expect(probe.judgeExtensions({ ...good(), merged: { guard: true, rules: null } }).verdict).toBe('INCONCLUSIVE')
  expect(probe.judgeExtensions({ ...good(), merged: null }).verdict).toBe('INCONCLUSIVE')
})

it.each([
  ['toolsHidden', /disallowedTools/],
  ['prefixOk', /tool prefix/],
  ['agentKeysIgnored', /agent file's mcpServers or hooks ran/],
  ['guardWins', /side guard did not block/]
])('fails when the model check finds %s false, and is inconclusive when null', (key, text) => {
  const bad = probe.judgeExtensions({ ...good(), model: { ...goodModel(), [key]: false } })
  expect(bad.verdict).toBe('FAILED')
  expect(bad.reasons[0]).toMatch(text)
  expect(probe.judgeExtensions({ ...good(), model: { ...goodModel(), [key]: null } }).verdict).toBe('INCONCLUSIVE')
})

it('names the observed prefix when the rule differs, and is inconclusive when the model runs could not be made', () => {
  const r = probe.judgeExtensions({
    ...good(),
    model: { ...goodModel(), prefixOk: false, prefixObserved: 'mcp__my_db_v2_1', prefixExpected: 'mcp__my_db__v2_1' }
  })
  expect(r.reasons[0]).toMatch(/observed mcp__my_db_v2_1, expected mcp__my_db__v2_1/)
  expect(probe.judgeExtensions({ ...good(), model: null }).verdict).toBe('INCONCLUSIVE')
})

it('judges the local key rule: false fails with the observed keys, null is inconclusive', () => {
  const observed = ['repo/sub/app in a repo: /sub/app (expected /repo)']
  const bad = probe.judgeExtensions({ ...good(), localKey: { rule: false, observed } })
  expect(bad.verdict).toBe('FAILED')
  expect(bad.reasons[0]).toMatch(/nearest ancestor with a \.git entry.*observed: repo\/sub\/app in a repo: \/sub\/app/)
  const unknown = probe.judgeExtensions({ ...good(), localKey: { rule: null, observed: ['no .git above: not checked'] } })
  expect(unknown.verdict).toBe('INCONCLUSIVE')
  expect(unknown.reasons[0]).toMatch(/a sub-check could not be made.*not checked/)
  expect(probe.judgeExtensions({ ...good(), localKey: null }).verdict).toBe('INCONCLUSIVE')
  expect(probe.judgeExtensions({ ...good(), localKey: { rule: true, observed: [] } }).verdict).toBe('PASS')
})

it('a failure wins over an inconclusive part', () => {
  const r = probe.judgeExtensions({ ...good(), denied: null, localKey: { rule: false, observed: [] } })
  expect(r.verdict).toBe('FAILED')
})

it('maps verdicts to exit codes, --soft turning only inconclusive into 0', () => {
  expect(probe.exitCodeFor('PASS')).toBe(0)
  expect(probe.exitCodeFor('FAILED')).toBe(1)
  expect(probe.exitCodeFor('INCONCLUSIVE')).toBe(2)
  expect(probe.exitCodeFor('INCONCLUSIVE', { soft: true })).toBe(0)
  expect(probe.exitCodeFor('FAILED', { soft: true })).toBe(1)
})

async function run(mode: string, o: { args?: string[]; env?: Record<string, string> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cb-eprobe-test-'))
  dirs.push(dir)
  const bin = writeFakeBin(dir, 'claude', FAKE)
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: dir,
    TMPDIR: dir,
    // os.tmpdir() reads TEMP and TMP on Windows, not TMPDIR.
    ...(isWindows ? { TEMP: dir, TMP: dir } : {}),
    CLAUDE_CONFIG_DIR: join(dir, 'config'),
    ZUMIBOT_PROBE_CLAUDE: bin,
    FAKE_PROBE_MODES: mode,
    FAKE_PROBE_STATE: join(dir, 'state'),
    FAKE_PROBE_ARGS: join(dir, 'args.jsonl'),
    ...o.env
  }
  const child = spawn(process.execPath, [PROBE, ...(o.args ?? [])], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '',
    err = ''
  child.stdout.setEncoding('utf8').on('data', (c) => {
    out += c
  })
  child.stderr.setEncoding('utf8').on('data', (c) => {
    err += c
  })
  const code = await new Promise<number | null>((resolve) => child.on('close', (c) => resolve(c)))
  const calls = (await readFile(join(dir, 'args.jsonl'), 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as string[])
  const kept = (await readdir(dir)).filter((n) => n.startsWith('extensions-probe-'))
  return { code, out, err, calls, kept }
}

it(
  'passes a whole model-free run against the fake CLI, with the app flags, and cleans up',
  async () => {
    const r = await run('e-ok')
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/extensions probe: PASS \(Claude Code 9\.9\.9-fake\)/)
    expect(r.out).toMatch(/plugin demo@mk: 1 skills and 1 hooks before, 0 and 0 with enabledPlugins false/)
    expect(slashed(r.out)).toMatch(
      /local key \(relative to the temp folder\): repo\/sub\/app in a repo: \/lk\/repo; symlink to repo\/sub\/app: \/lk\/repo; nested repo wins: \/lk\/repo\/sub\/app; \.git as a file: \/lk\/wt; no \.git above, via a symlink: \/sub/
    )
    // Check g: the merged settings kept their guards, and the timeout-0 control shows the check sees a drop.
    expect(r.out).toMatch(
      /merged settings with every agent hook shape: guard hook kept, ask and deny rules kept \(control, a timeout-0 hook: guard LOST, rules LOST\)/
    )
    const merged = r.calls
      .map((a) => (a.includes('--settings') ? JSON.parse(a[a.indexOf('--settings') + 1]) : null))
      .find((s) => s?.permissions?.ask)
    expect(merged.hooks.PreToolUse[0]).toEqual(probe.GUARD_SETTINGS.hooks.PreToolUse[0])
    expect(merged.hooks.NotAHookEvent).toEqual(probe.AGENT_SETTINGS.hooks.NotAHookEvent)
    // No model is ever called without --model-check.
    expect(r.calls.some((a) => a.includes('--model'))).toBe(false)
    const sessions = r.calls.filter((a) => a.includes('--input-format'))
    expect(sessions.length).toBeGreaterThanOrEqual(4)
    for (const argv of sessions) {
      expect(argv).toContain('--no-session-persistence')
      expect(JSON.parse(argv[argv.indexOf('--settings') + 1]).enableAllProjectMcpServers).toBe(true)
    }
    expect(r.kept).toEqual([])
  },
  RUN_MS
)

it(
  'passes the model checks against the fake CLI',
  async () => {
    const r = await run('e-ok', { args: ['--model-check'] })
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/odd name "my db: v2\.1" lists \["mcp__my_db__v2_1__ping"\]/)
    expect(r.out).toMatch(
      /side guard negative arm \(no hook, every permission request denied\): Bash called, asked \["Bash"\], marker file absent/
    )
    expect(r.out).toMatch(
      /side guard control \(the allow hook alone, every permission request denied\): Bash called, asked \[\], marker file WRITTEN/
    )
    expect(r.out).toMatch(/the agent is active \(listed in init\.agents, its reply carries its own word\)/)
    const model = r.calls.filter((a) => a.includes('--model'))
    // tools, agent keys, the guard's negative arm, its control and the guard in both hook orders.
    expect(model.length).toBe(6)
    for (const argv of model) expect(argv[argv.indexOf('--model') + 1]).toBe('haiku')
    // The negative arm and the control ask (default mode) and are answered with deny; the precedence runs are auto.
    const asking = model.filter((a) => a[a.indexOf('--permission-mode') + 1] === 'default')
    expect(asking).toHaveLength(2)
    const [negative, control] = asking
    expect(JSON.parse(negative[negative.indexOf('--settings') + 1]).hooks.PreToolUse).toEqual([])
    expect(JSON.parse(control[control.indexOf('--settings') + 1]).hooks.PreToolUse).toHaveLength(1)
    expect(control[control.indexOf('--settings') + 1]).not.toContain('No tools in a side answer')
    // Every guard run loads none of the user's, project's or local settings: a user's own allow rule cannot stand in for the hook.
    const guardRuns = model.filter(
      (a) => a.includes('--settings') && JSON.parse(a[a.indexOf('--settings') + 1]).hooks?.PreToolUse !== undefined
    )
    expect(guardRuns).toHaveLength(4)
    for (const argv of guardRuns) expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('')
    expect(r.kept).toEqual([])
  },
  RUN_MS
)

it.each([
  ['e-denyignored', [], /deniedMcpServers did not keep "probe-srv" out of mcp_status/],
  [
    'e-localcwd',
    [],
    /no longer keys by the real path of the nearest ancestor with a \.git entry.*repo\/sub\/app in a repo: \/lk\/repo\/sub\/app \(expected \/lk\/repo\)/
  ],
  ['e-error', [], /mcp_status was answered with an error/],
  [
    'e-strict',
    [],
    /merged --settings lost its guard hook.*the CLI dropped the whole --settings.*merged --settings lost its ask and deny rules/
  ],
  ['e-prefix', ['--model-check'], /tool prefix is not mcp__ plus the name.*observed mcp__my_db_v2_1, expected mcp__my_db__v2_1/],
  ['e-guardleak', ['--model-check'], /side guard did not block/],
  ['e-agentkeys', ['--model-check'], /agent file's mcpServers or hooks ran under --agent/]
])(
  'fails with exit 1 when %s, keeping the temp folder',
  async (mode, args, text) => {
    const r = await run(mode, { args })
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/^FAILED: Claude Code 9\.9\.9-fake: the CLI no longer behaves as the extensions feature expects/m)
    expect(slashed(r.err)).toMatch(text)
    expect(r.kept).toHaveLength(1)
  },
  RUN_MS
)

it.each([
  [
    'e-allowdead',
    /INCONCLUSIVE: .*side guard: no precedence proof/,
    /side guard control .*marker file absent \(the allow hook did not allow\)/
  ],
  [
    'e-allowsall',
    /INCONCLUSIVE: .*side guard: no precedence proof/,
    /side guard negative arm .*marker file WRITTEN \(something else allows Bash here\)/
  ],
  [
    'e-agentmissing',
    /INCONCLUSIVE: .*agent keys: could not be compared \(the agent was not shown to be active/,
    /the agent was NOT shown to be active/
  ]
])(
  'is inconclusive, never a pass, when the control of %s does not establish',
  async (mode, text, log) => {
    const r = await run(mode, { args: ['--model-check'] })
    expect(r.code).toBe(2)
    expect(r.err).toMatch(text)
    expect(r.err).not.toContain('FAILED')
    expect(r.out).toMatch(log)
    expect(r.kept).toHaveLength(1)
  },
  RUN_MS
)

it(
  'is inconclusive (exit 2) with no server to deny or no plugin, and --soft makes it 0 with a loud warning',
  async () => {
    const r = await run('e-noserver')
    expect(r.code).toBe(2)
    expect(r.err).toMatch(/INCONCLUSIVE: Claude Code 9\.9\.9-fake: deniedMcpServers: no server to deny/)
    const plugin = await run('e-noplugin')
    expect(plugin.code).toBe(2)
    expect(plugin.err).toMatch(/no enabled plugin with skills or hooks to compare/)
    const soft = await run('e-noserver', { args: ['--soft'] })
    expect(soft.code).toBe(0)
    expect(soft.err).toMatch(/WARNING: the extensions probe was SKIPPED as inconclusive/)
    const failed = await run('e-denyignored', { args: ['--soft'] })
    expect(failed.code).toBe(1)
    // Four whole probe runs, each starting the fake CLI a dozen times (about 19 s alone on an Intel Mac).
  },
  isWindows || process.platform === 'darwin' ? 90_000 : 30_000
)

it('ZUMIBOT_SKIP_EXTENSIONS_PROBE=1 skips without starting claude', async () => {
  const r = await run('e-ok', { env: { ZUMIBOT_SKIP_EXTENSIONS_PROBE: '1' } })
  expect(r.code).toBe(0)
  expect(r.out).toContain('skipped')
  expect(r.calls).toEqual([])
})
