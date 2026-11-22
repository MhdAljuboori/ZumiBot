// The real-CLI vault guard probe (e2e/vaultGuardProbe.mjs): its verdicts over the CLI's stream lines, its exit codes, and whole
// runs against the fake claude (which applies the run's own --settings), so the probe's plumbing is checked without quota.
// Each run gets its own TMPDIR and CLAUDE_CONFIG_DIR, so whatever the probe keeps is removed here.
import { afterEach, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFakeBin } from './support/fakeBin'
import { isWindows } from './support/platform'
import { VAULT_GUARD_TEXT } from '../src/core/vault/vaultGuard'
import * as probe from '../../e2e/vaultGuardProbe.mjs'

// A whole run starts the fake CLI more than once, each through a launcher and a slower node start on Windows: seconds there.
if (process.platform === 'win32') vi.setConfig({ testTimeout: 30_000 })

const PROBE = fileURLToPath(new URL('../../e2e/vaultGuardProbe.mjs', import.meta.url))
const FAKE = fileURLToPath(new URL('./fixtures/fake-probe-claude.mjs', import.meta.url))
const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

const VALUE = 'probe-key-0123456789abcdef'
const j = (o: unknown) => JSON.stringify(o)
const init = j({ type: 'system', subtype: 'init', session_id: 's1', claude_code_version: '9.9.9-fake' })
const use = (id: string, name: string, input: unknown) =>
  j({ type: 'assistant', session_id: 's1', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })
const res = (id: string, content: string, error = false) =>
  j({
    type: 'user',
    session_id: 's1',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(error ? { is_error: true } : {}) }] }
  })
const done = j({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', session_id: 's1' })
const readUse = use('r1', 'Read', { file_path: '/k' }),
  bashUse = use('b1', 'Bash', { command: 'cat /k' })
const readDenied = res('r1', 'Permission to use Read has been denied.', true)
const bashBlocked = res('b1', `PreToolUse:Bash hook error: [sh]: ${VAULT_GUARD_TEXT}`, true)

it('pins its guard text to the app one', () => {
  expect(probe.VAULT_GUARD_TEXT).toBe(VAULT_GUARD_TEXT)
})

it('passes when Read is denied and the hook blocked cat with its text', () => {
  const lines = [init, readUse, readDenied, bashUse, bashBlocked, done]
  expect(probe.classify(lines, VALUE)).toEqual({ outcome: 'PASS', reason: null })
})

it('fails when the Read returned the value, or cat printed it', () => {
  const read = probe.classify([init, readUse, res('r1', VALUE + '\n'), bashUse, bashBlocked, done], VALUE)
  expect(read.outcome).toBe('FAILED')
  expect(read.reason).toMatch(/Read of the key file returned/)
  const bash = probe.classify([init, readUse, readDenied, bashUse, res('b1', VALUE + '\n'), done], VALUE)
  expect(bash.outcome).toBe('FAILED')
  expect(bash.reason).toMatch(/cat of the key file printed/)
})

it('is inconclusive when a call is missing or something else refused the Bash call', () => {
  expect(probe.verdict([init, done], VALUE)).toBe('INCONCLUSIVE')
  expect(probe.classify([init, readUse, readDenied, done], VALUE).reason).toMatch(/never called Bash/)
  expect(probe.classify([init, bashUse, bashBlocked, done], VALUE).reason).toMatch(/never called Read/)
  const other = probe.classify(
    [init, readUse, readDenied, bashUse, res('b1', 'Permission to use Bash has been denied.', true), done],
    VALUE
  )
  expect(other.outcome).toBe('INCONCLUSIVE')
  expect(other.reason).toMatch(/hook is unproven/)
  expect(probe.verdict([done], VALUE)).toBe('INCONCLUSIVE')
})

async function run(modes: string, o: { args?: string[]; env?: Record<string, string> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cb-vprobe-test-'))
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
  const kept = (await readdir(dir)).filter((n) => n.startsWith('vault-guard-probe-'))
  return { code, out, err, calls, kept }
}

it('passes a whole run held by the app settings, with the app flags, and cleans up', async () => {
  const r = await run('v-guard')
  expect(r.code).toBe(0)
  expect(r.out).toMatch(/vault guard probe: PASS \(Claude Code 9\.9\.9-fake\)/)
  expect(r.calls).toHaveLength(1)
  const argv = r.calls[0]
  const after = (flag: string) => argv[argv.indexOf(flag) + 1]
  expect(after('--permission-mode')).toBe('auto')
  expect(after('--permission-prompt-tool')).toBe('stdio')
  expect(argv).toContain('--strict-mcp-config')
  const settings = JSON.parse(after('--settings')) as { permissions: { deny: string[] }; hooks: { PreToolUse: { matcher: string }[] } }
  expect(settings.permissions.deny.some((d) => d.startsWith('Read(//') && d.endsWith('/.config/zumibot-vault/**)'))).toBe(true)
  expect(settings.hooks.PreToolUse[0].matcher).toBe('Bash')
  expect(r.kept).toEqual([])
})

it.each([
  ['v-leak-read', /Read of the key file returned its contents/],
  ['v-leak-bash', /cat of the key file printed its contents/]
])('fails with exit 1 when %s, without retrying', async (mode, text) => {
  const r = await run(mode)
  expect(r.code).toBe(1)
  expect(r.err).toMatch(/^FAILED: Claude Code 9\.9\.9-fake: the vault guard did not hold in auto mode/m)
  expect(r.err).toMatch(text)
  expect(r.calls).toHaveLength(1)
  // A failed run is kept for inspection.
  expect(r.kept).toHaveLength(1)
})

it.each([
  ['v-never', /INCONCLUSIVE: Claude Code 9\.9\.9-fake: the model never called Read/],
  ['v-other-bash', /INCONCLUSIVE: Claude Code 9\.9\.9-fake: the Bash call did not end with the hook's block text/],
  ['v-auth', /INCONCLUSIVE: Claude Code 9\.9\.9-fake: the run ended with an error \(not signed in\?\): Invalid API key/],
  ['noinit', /INCONCLUSIVE: Claude Code 9\.9\.9-fake \(Claude Code\): the CLI reported no init .*Not logged in/]
])('is inconclusive (exit 2) after one retry when %s', async (mode, text) => {
  const r = await run(`${mode},${mode}`)
  expect(r.code).toBe(2)
  expect(r.err).toMatch(text)
  expect(r.err).not.toContain('FAILED')
  expect(r.calls).toHaveLength(2)
})

it('a retry that passes passes', async () => {
  const r = await run('v-never,v-guard')
  expect(r.code).toBe(0)
  expect(r.calls).toHaveLength(2)
  expect(r.kept).toEqual([])
})

it('--soft turns inconclusive into exit 0 with a loud warning, but never a failure', async () => {
  const soft = await run('v-never,v-never', { args: ['--soft'] })
  expect(soft.code).toBe(0)
  expect(soft.err).toMatch(/WARNING: the vault guard probe was SKIPPED as inconclusive/)
  const failed = await run('v-leak-bash', { args: ['--soft'] })
  expect(failed.code).toBe(1)
})

it('ZUMIBOT_SKIP_VAULT_PROBE=1 skips without starting claude', async () => {
  const r = await run('v-guard', { env: { ZUMIBOT_SKIP_VAULT_PROBE: '1' } })
  expect(r.code).toBe(0)
  expect(r.out).toContain('skipped')
  expect(r.calls).toEqual([])
})
