// The real-CLI pause probe (e2e/pauseProbe.mjs): its verdicts over the CLI's stream lines, its exit codes, and one whole run
// against the fake claude, so the probe's own plumbing is checked without the real CLI or any quota. Each run gets its own
// TMPDIR and CLAUDE_CONFIG_DIR, so whatever the probe keeps is removed here.
import { afterEach, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFakeBin } from './support/fakeBin'
import { isWindows, removeDir } from './support/platform'
import { PAUSE_BLOCK_TEXT, PAUSE_MARKER } from '@zumibot/shared/pause'
import { pauseSettings } from '../src/core/chat/pauseSettings'

// A whole run starts the fake CLI more than once, each through a launcher and a slower node start on Windows: seconds there.
if (process.platform === 'win32') vi.setConfig({ testTimeout: 30_000 })

// @ts-expect-error plain .mjs without types
const probe = (await import('../../e2e/pauseProbe.mjs')) as {
  PAUSE_MARKER: string
  verdict(lines: string[]): 'PASS' | 'FAILED' | 'INCONCLUSIVE'
  classify(lines: string[]): { outcome: 'PASS' | 'FAILED' | 'INCONCLUSIVE'; reason: string | null }
  main(args?: string[], run?: () => Promise<{ outcome: string; version: string; reason: string | null }>): Promise<number>
}

const PROBE = fileURLToPath(new URL('../../e2e/pauseProbe.mjs', import.meta.url))
const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url))
const HOOK = fileURLToPath(new URL('./fixtures/pause-hook-src.mjs', import.meta.url))

// ---------- stream lines shaped like the real CLI's (stream-json, --verbose) ----------
const j = (o: unknown) => JSON.stringify(o)
const init = j({ type: 'system', subtype: 'init', session_id: 's1', claude_code_version: '9.9.9-fake', model: 'claude-haiku-5-5' })
const use = (id: string, name: string, input: unknown, parent: string | null = null, message = `msg_${id}`) =>
  j({
    type: 'assistant',
    parent_tool_use_id: parent,
    ...(parent ? { agent_id: 'a1' } : {}),
    session_id: 's1',
    message: { id: message, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }
  })
const res = (id: string, content: unknown, o: { parent?: string | null; error?: boolean } = {}) =>
  j({
    type: 'user',
    parent_tool_use_id: o.parent ?? null,
    ...(o.parent ? { agent_id: 'a1' } : {}),
    session_id: 's1',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(o.error ? { is_error: true } : {}) }] }
  })
const dispatch = use('toolu_A', 'Agent', { subagent_type: 'general-purpose', description: 'Echo', prompt: 'Run `echo sub-ok`.' })
const started = j({ type: 'system', subtype: 'task_started', task_id: 'a1', tool_use_id: 'toolu_A', description: 'Echo', session_id: 's1' })
const subUse = use('toolu_S', 'Bash', { command: 'echo sub-ok' }, 'toolu_A')
const subOk = res('toolu_S', 'sub-ok', { parent: 'toolu_A' })
const handBack = res('toolu_A', [{ type: 'text', text: 'The command printed sub-ok.' }])
const mainUse = use('toolu_M', 'Bash', { command: 'echo main-ok' })
const mainBlocked = res('toolu_M', `PreToolUse:Bash hook error: ${PAUSE_BLOCK_TEXT}`, { error: true })
const mainRan = res('toolu_M', 'main-ok')
const done = j({ type: 'result', subtype: 'success', is_error: false, result: 'Paused.', session_id: 's1' })

const PASS = [init, dispatch, started, subUse, subOk, handBack, mainUse, mainBlocked, done]
const FAILED = [init, dispatch, started, subUse, subOk, handBack, mainUse, mainRan, done]
const NEVER_DISPATCHED = [init, mainUse, mainRan, done]

it('pins its block marker to the app one', () => {
  expect(probe.PAUSE_MARKER).toBe(PAUSE_MARKER)
})

it('passes when the subagent ran echo sub-ok and handed back while the main thread call was blocked with the marker', () => {
  expect(probe.verdict(PASS)).toBe('PASS')
  expect(probe.classify(PASS)).toEqual({ outcome: 'PASS', reason: null })
})

it('fails when the main thread ran echo main-ok after the flag was set', () => {
  expect(probe.verdict(FAILED)).toBe('FAILED')
  expect(probe.classify(FAILED).reason).toMatch(/main thread ran echo main-ok/)
})

it('is inconclusive when the model never dispatched a subagent, so the flag was never set', () => {
  expect(probe.verdict(NEVER_DISPATCHED)).toBe('INCONCLUSIVE')
  expect(probe.classify(NEVER_DISPATCHED).reason).toMatch(/never dispatched/)
  expect(probe.verdict([])).toBe('INCONCLUSIVE')
  expect(probe.classify([]).reason).toMatch(/no init/)
})

it('fails when a subagent call was blocked: the CLI no longer tells subagent calls apart (agent_id)', () => {
  const lines = [
    init,
    dispatch,
    started,
    subUse,
    res('toolu_S', PAUSE_BLOCK_TEXT, { parent: 'toolu_A', error: true }),
    handBack,
    mainUse,
    mainBlocked,
    done
  ]
  expect(probe.verdict(lines)).toBe('FAILED')
  expect(probe.classify(lines).reason).toMatch(/subagent's call/)
})

it('is inconclusive when echo main-ok ran before the flag, or the block came back without is_error', () => {
  expect(probe.verdict([init, mainUse, mainRan, dispatch, started, subUse, subOk, handBack, done])).toBe('INCONCLUSIVE')
  const plain = [init, dispatch, started, subUse, subOk, handBack, mainUse, res('toolu_M', PAUSE_BLOCK_TEXT), done]
  expect(probe.verdict(plain)).toBe('INCONCLUSIVE')
  expect(probe.classify(plain).reason).toMatch(/without is_error/)
})

it('is inconclusive while a piece is missing: the subagent result, its hand-back, or the main thread block', () => {
  expect(probe.classify([init, dispatch, started, subUse, handBack, mainUse, mainBlocked, done]).reason).toMatch(/sub-ok/)
  expect(probe.classify([init, dispatch, started, subUse, subOk, mainUse, mainBlocked, done]).reason).toMatch(/hand-back|handed back/)
  expect(probe.classify([init, dispatch, started, subUse, subOk, handBack, done]).reason).toMatch(/main thread/)
  for (const lines of [
    [init, dispatch, started, subUse, handBack, mainUse, mainBlocked, done],
    [init, dispatch, started, subUse, subOk, handBack, done]
  ]) {
    expect(probe.verdict(lines)).toBe('INCONCLUSIVE')
  }
})

it('takes the flag only from task_started, never from the dispatch tool_use (whose own hook runs as that line is written)', () => {
  const task = [init, 'not json', use('toolu_A', 'Task', {}), started, subUse, subOk, handBack, mainUse, mainBlocked, done]
  expect(probe.verdict(task)).toBe('PASS')
  const startedOnly = [init, started, subUse, subOk, handBack, mainUse, mainBlocked, done]
  expect(probe.verdict(startedOnly)).toBe('PASS')
  const noStarted = [init, dispatch, subUse, subOk, handBack, mainUse, mainBlocked, done]
  expect(probe.verdict(noStarted)).toBe('INCONCLUSIVE')
  expect(probe.classify(noStarted).reason).toMatch(/no task_started line/)
  // main-ok between the dispatch line and task_started ran before the flag: no failure, and nothing proven.
  const early = [init, dispatch, mainUse, mainRan, started, subUse, subOk, handBack, done]
  expect(probe.verdict(early)).toBe('INCONCLUSIVE')
})

afterEach(() => vi.restoreAllMocks())

it('maps a verdict to the exit code: 0 pass, 1 failed, 2 inconclusive, 0 inconclusive with --soft', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const err = vi.spyOn(console, 'error').mockImplementation(() => {})
  const verdict = (outcome: string) => async () => ({ outcome, version: '9.9.9', reason: 'why' })
  expect(await probe.main([], verdict('PASS'))).toBe(0)
  expect(await probe.main([], verdict('FAILED'))).toBe(1)
  expect(await probe.main(['--soft'], verdict('FAILED'))).toBe(1)
  expect(await probe.main([], verdict('INCONCLUSIVE'))).toBe(2)
  expect(await probe.main(['--soft'], verdict('INCONCLUSIVE'))).toBe(0)
  expect(err.mock.calls.flat().join('\n')).toMatch(/WARNING: the pause probe was SKIPPED as inconclusive/)
  expect(
    await probe.main([], async () => {
      throw new Error('boom')
    })
  ).toBe(2)
})

it('ZUMIBOT_SKIP_PAUSE_PROBE=1 skips without running the probe', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.stubEnv('ZUMIBOT_SKIP_PAUSE_PROBE', '1')
  const run = vi.fn(async () => ({ outcome: 'FAILED', version: '9.9.9', reason: 'why' }))
  try {
    expect(await probe.main([], run)).toBe(0)
    expect(run).not.toHaveBeenCalled()
  } finally {
    vi.unstubAllEnvs()
  }
})

// ---------- one whole run against the fake claude: argv, env, the flag, the hook from --settings ----------
const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) removeDir(d)
})

async function run(script: string[], o: { args?: string[]; hook?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cb-pause-probe-test-'))
  dirs.push(dir)
  const bin = writeFakeBin(dir, 'claude', FAKE)
  await writeFile(join(dir, 'script.jsonl'), script.join('\n') + '\n')
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: dir,
    TMPDIR: dir,
    // os.tmpdir() reads TEMP and TMP on Windows, not TMPDIR.
    ...(isWindows ? { TEMP: dir, TMP: dir } : {}),
    CLAUDE_CONFIG_DIR: join(dir, 'config'),
    ZUMIBOT_PROBE_CLAUDE: bin,
    ZUMIBOT_PROBE_PAUSE_HOOK: o.hook ?? HOOK,
    FAKE_STDOUT_FILE: join(dir, 'script.jsonl'),
    FAKE_INVOCATIONS_OUT: join(dir, 'calls.jsonl'),
    FAKE_HOOKS_OUT: join(dir, 'hooks.jsonl')
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
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
  const jsonl = async (name: string) =>
    (await readFile(join(dir, name), 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  const kept = (await readdir(dir)).filter((n) => n.startsWith('pause-probe-'))
  return { code, out, err, calls: (await jsonl('calls.jsonl')) as { args: string[] }[], hooks: await jsonl('hooks.jsonl'), kept }
}

// The fake's script, in the CLI's order: the dispatch line, then that call's own hook (must pass: no flag yet), then
// task_started, which makes the probe set the flag, then the subagent's model request (the #SLEEP) and its call's hook.
const fakeRun = [
  init,
  dispatch,
  '#PRE_TOOL {"id":"toolu_A","tool":"Agent","agentId":null}',
  started,
  '#SLEEP 300',
  subUse,
  '#PRE_TOOL {"id":"toolu_S","tool":"Bash","agentId":"a1","parent":"toolu_A"}',
  subOk,
  handBack,
  mainUse,
  '#PRE_TOOL {"id":"toolu_M","tool":"Bash","agentId":null}',
  j({
    type: 'assistant',
    parent_tool_use_id: null,
    session_id: 's1',
    message: { id: 'msg_3', role: 'assistant', content: [{ type: 'text', text: 'Paused.' }] }
  }),
  done
]

it('a whole run: auto mode, an --agent session, the app pause settings, the flag in the hook env; it passes and cleans up', async () => {
  const r = await run(fakeRun)
  expect(r.err).toBe('')
  expect(r.code).toBe(0)
  expect(r.out).toMatch(/pause probe: PASS \(Claude Code 9\.9\.9-fake\)/)
  expect(r.calls).toHaveLength(1)
  const argv = r.calls[0].args
  const after = (flag: string) => argv[argv.indexOf(flag) + 1]
  expect(after('--permission-mode')).toBe('auto')
  expect(after('--permission-prompt-tool')).toBe('stdio')
  expect(argv).toContain('--strict-mcp-config')
  expect(after('--agent')).toBe('pause-probe')
  expect(Object.keys(JSON.parse(after('--agents')))).toEqual(['pause-probe'])
  expect(after('--settings')).toBe(pauseSettings({ node: process.execPath, entry: HOOK, electronNode: false }))
  // The dispatch passed its hook before the flag; the subagent's call ran with the flag set and was let through; the main
  // thread's next call was blocked.
  expect(r.hooks).toEqual([
    { id: 'toolu_A', tool: 'Agent', agentId: null, blocked: false },
    { id: 'toolu_S', tool: 'Bash', agentId: 'a1', blocked: false },
    { id: 'toolu_M', tool: 'Bash', agentId: null, blocked: true }
  ])
  expect(r.kept).toEqual([])
})

it('a missing built hook is inconclusive and names the build, without starting claude; --soft makes it exit 0', async () => {
  const missing = join(tmpdir(), 'no-such-dir-for-the-pause-probe', 'pauseHook.mjs')
  const r = await run(fakeRun, { hook: missing })
  expect(r.code).toBe(2)
  expect(r.err).toMatch(/^INCONCLUSIVE: .*npm run build:server/m)
  expect(r.calls).toEqual([])
  const soft = await run(fakeRun, { hook: missing, args: ['--soft'] })
  expect(soft.code).toBe(0)
  expect(soft.err).toMatch(/WARNING: the pause probe was SKIPPED as inconclusive/)
})
