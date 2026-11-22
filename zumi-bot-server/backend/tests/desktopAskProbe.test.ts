// The real-CLI desktop ask probe (e2e/desktopAskProbe.mjs), run against a fake claude so its verdicts and exit codes are
// tested without quota. Each run gets its own TMPDIR and CLAUDE_CONFIG_DIR, so whatever the probe keeps is removed here.
import { afterEach, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFakeBin } from './support/fakeBin'
import { isWindows } from './support/platform'
import { DESKTOP_ASK_SETTINGS } from '../src/core/desktop/desktopIpc'

// A whole run starts the fake CLI more than once, each through a launcher and a slower node start on Windows: seconds there.
if (process.platform === 'win32') vi.setConfig({ testTimeout: 30_000 })

const PROBE = fileURLToPath(new URL('../../e2e/desktopAskProbe.mjs', import.meta.url))
const FAKE = fileURLToPath(new URL('./fixtures/fake-probe-claude.mjs', import.meta.url))
const FAILED = 'FAILED: Claude Code 9.9.9-fake: ask rules did not force a card in auto mode: desktop actions would run unasked'
const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const until = async (fn: () => Promise<boolean> | boolean, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) if (await fn()) return
  throw new Error('timed out')
}

async function probe(
  modes: string,
  o: { args?: string[]; env?: Record<string, string>; onStart?: (p: ReturnType<typeof spawn>, dir: string) => Promise<void> } = {}
) {
  const dir = await mkdtemp(join(tmpdir(), 'cb-probe-test-'))
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
    FAKE_PROBE_MODES: modes,
    FAKE_PROBE_STATE: join(dir, 'state'),
    FAKE_PROBE_ARGS: join(dir, 'args.jsonl'),
    FAKE_PROBE_PID: join(dir, 'pid'),
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
  const exit = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)))
  await o.onStart?.(child, dir)
  const code = await exit
  const calls = (await readFile(join(dir, 'args.jsonl'), 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as string[])
  const kept = (await readdir(dir)).filter((n) => n.startsWith('desktop-ask-probe-'))
  return { code, out, err, calls, kept, dir }
}

it('passes when desktop_click reaches can_use_tool, with the app ask settings in auto mode, and cleans up', async () => {
  const r = await probe('ask')
  expect(r.code).toBe(0)
  expect(r.out).toMatch(/desktop ask probe: PASS \(Claude Code 9\.9\.9-fake\)/)
  expect(r.calls).toHaveLength(1)
  const argv = r.calls[0]
  const after = (flag: string) => argv[argv.indexOf(flag) + 1]
  expect(after('--permission-mode')).toBe('auto')
  expect(after('--permission-prompt-tool')).toBe('stdio')
  expect(after('--settings')).toBe(DESKTOP_ASK_SETTINGS)
  expect(after('--max-turns')).toBe('6')
  expect(argv).toContain('--strict-mcp-config')
  // --mcp-config is variadic: the next option must end it.
  expect(argv[argv.indexOf('--mcp-config') + 2]).toBe('--settings')
  expect(Object.keys(JSON.parse(after('--mcp-config')).mcpServers)).toEqual(['zumibot_desktop'])
  expect(r.kept).toEqual([])
})

it('fails with exit 1 and the fixed text when desktop_click runs without can_use_tool, without retrying', async () => {
  const r = await probe('unasked,ask')
  expect(r.code).toBe(1)
  expect(r.err).toContain(FAILED)
  expect(r.err.split('\n').find((l) => l.startsWith('FAILED:'))).toBeDefined()
  expect(r.calls).toHaveLength(1)
})

it.each([
  ['never', /INCONCLUSIVE: Claude Code 9\.9\.9-fake: the model never called mcp__zumibot_desktop__desktop_click/],
  ['unconnected', /INCONCLUSIVE: Claude Code 9\.9\.9-fake: the stub MCP server zumibot_desktop did not connect \(status: failed\)/],
  ['auth', /INCONCLUSIVE: Claude Code 9\.9\.9-fake: the run ended with an error \(not signed in\?\): Invalid API key/],
  ['selfdeny', /INCONCLUSIVE: Claude Code 9\.9\.9-fake: mcp__zumibot_desktop__desktop_click was refused by the CLI itself/],
  ['noinit', /INCONCLUSIVE: Claude Code 9\.9\.9-fake \(Claude Code\): the CLI reported no init .*Not logged in/]
])('is inconclusive (exit 2) after one retry when %s', async (mode, text) => {
  const r = await probe(`${mode},${mode}`)
  expect(r.code).toBe(2)
  expect(r.err).toMatch(text)
  expect(r.err).not.toContain('FAILED')
  expect(r.calls).toHaveLength(2)
})

it('a retry that asks passes', async () => {
  const r = await probe('never,ask')
  expect(r.code).toBe(0)
  expect(r.calls).toHaveLength(2)
  expect(r.kept).toEqual([])
})

it('--soft turns inconclusive into exit 0 with a loud warning, but never a failure', async () => {
  const soft = await probe('never,never', { args: ['--soft'] })
  expect(soft.code).toBe(0)
  expect(soft.err).toMatch(/^INCONCLUSIVE:/m)
  expect(soft.err).toMatch(/WARNING: the desktop ask probe was SKIPPED as inconclusive/)
  const failed = await probe('unasked', { args: ['--soft'] })
  expect(failed.code).toBe(1)
  expect(failed.err).toContain(FAILED)
})

const CLICK = 'mcp__zumibot_desktop__desktop_click'
const settingsOf = (argv: string[]) =>
  JSON.parse(argv[argv.indexOf('--settings') + 1]) as { permissions: { ask: string[]; allow?: string[] } }

it('--with-allow-rule passes when desktop_click is still asked with an allow rule for it in the same settings', async () => {
  const r = await probe('ask', { args: ['--with-allow-rule'] })
  expect(r.code).toBe(0)
  expect(r.out).toMatch(
    /desktop ask probe: PASS \(Claude Code 9\.9\.9-fake\): desktop_click reached can_use_tool in auto mode, with an allow rule for it/
  )
  expect(r.calls).toHaveLength(1)
  const settings = settingsOf(r.calls[0])
  expect(settings.permissions.ask).toEqual(JSON.parse(DESKTOP_ASK_SETTINGS).permissions.ask)
  expect(settings.permissions.allow).toEqual([CLICK])
  expect(r.kept).toEqual([])
})

it('--with-allow-rule fails with exit 1 when the allow rule beats the ask rule', async () => {
  const r = await probe('allowwins', { args: ['--with-allow-rule'] })
  expect(r.code).toBe(1)
  expect(r.err).toContain(`${FAILED}, with an allow rule for it`)
  expect(r.calls).toHaveLength(1)
  // The same CLI asks when nothing allows the click, so the verdict comes from the allow rule alone.
  const plain = await probe('allowwins')
  expect(plain.code).toBe(0)
  expect(settingsOf(plain.calls[0]).permissions.allow).toBeUndefined()
})

it('--with-allow-rule keeps the soft and exit-code rules', async () => {
  const soft = await probe('never,never', { args: ['--with-allow-rule', '--soft'] })
  expect(soft.code).toBe(0)
  expect(soft.err).toMatch(/WARNING: the desktop ask probe was SKIPPED as inconclusive/)
  expect(soft.calls.every((argv) => settingsOf(argv).permissions.allow?.[0] === CLICK)).toBe(true)
  expect((await probe('never,never', { args: ['--with-allow-rule'] })).code).toBe(2)
  expect((await probe('allowwins', { args: ['--with-allow-rule', '--soft'] })).code).toBe(1)
})

it('ZUMIBOT_SKIP_ASK_PROBE=1 skips without starting claude', async () => {
  const r = await probe('ask', { env: { ZUMIBOT_SKIP_ASK_PROBE: '1' } })
  expect(r.code).toBe(0)
  expect(r.out).toContain('skipped')
  expect(r.calls).toEqual([])
})

// Linux by design: a catchable SIGTERM, exit 143 and /proc to find leftovers (macOS has no /proc).
it.skipIf(process.platform !== 'linux')('SIGTERM to the probe kills the CLI and the stub server with it', async () => {
  let pid = 0
  const r = await probe('hang', {
    onStart: async (child, dir) => {
      await until(
        async () =>
          (pid = Number(await readFile(join(dir, 'pid'), 'utf8').catch(() => '0'))) > 0 &&
          (await readFile(join(dir, 'args.jsonl'), 'utf8').catch(() => '')) !== ''
      )
      // The stub server records nothing until called; give the fake a moment to start it.
      await new Promise((resolve) => setTimeout(resolve, 300))
      child.kill('SIGTERM')
    }
  })
  expect(r.code).toBe(143)
  await until(() => !alive(pid))
  // Every process of that run is gone: none still has this run's TMPDIR in its environment.
  const leftovers: string[] = []
  for (const p of (await readdir('/proc')).filter((n) => /^\d+$/.test(n))) {
    const environ = await readFile(`/proc/${p}/environ`, 'utf8').catch(() => '')
    if (environ.includes(`TMPDIR=${r.dir}\0`)) leftovers.push(p)
  }
  expect(leftovers).toEqual([])
})
