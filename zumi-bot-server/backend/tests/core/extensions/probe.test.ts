import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EXT_TEXT } from '@zumibot/shared/extensions'
import { probeClaude, probeCodex } from '../../../src/core/extensions/probe'
import { writeFakeBin } from '../../support/fakeBin'
import { isWindows, removeDir } from '../../support/platform'

const FAKE = fileURLToPath(new URL('../../fixtures/fake-extensions-claude.mjs', import.meta.url))

let dir: string
let folder: string
let fakeClaude: string
// Windows starts a fake through a launcher and a slower node start (seconds when test files run side by side), so a deadline
// meant to fall after the start, or after the first answer, is longer there. macOS too: an Intel Mac misses 200 ms with the
// suite running beside it.
const START_MS = isWindows ? 2500 : process.platform === 'darwin' ? 2000 : undefined
const at = (name: string) => join(dir, name)

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'cb-probe-')))
  folder = join(dir, 'work')
  mkdirSync(folder)
  fakeClaude = writeFakeBin(dir, 'claude', FAKE)
})
afterEach(() => removeDir(dir))

const state = (over: Record<string, unknown> = {}) => {
  writeFileSync(
    at('state.json'),
    JSON.stringify({
      version: '2.1.322',
      mcpServers: [
        {
          name: 'plugin:playwright:playwright',
          status: 'connected',
          config: { type: 'stdio', command: 'npx', env: { K: 'v' } },
          transport: 'stdio',
          scope: 'dynamic',
          source: 'plugin',
          tools: [{ name: 'browser_close' }]
        },
        { name: 'claude.ai Gmail', status: 'connected', config: {}, scope: 'claudeai', source: 'claudeai' }
      ],
      skills: [{ name: 'mine', description: 'My own', source: 'user', tokens: 10, state: 'on' }],
      hooks: [{ event: 'PreToolUse', matcher: 'Bash', source: 'userSettings', type: 'command', commandText: 'sh a.sh' }],
      plugins: [],
      ...over
    })
  )
}
// Nothing from the test process but PATH, which the fake's shebang needs to find node.
const envOf = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  FAKE_EXT_STATE: at('state.json'),
  ...extra
})
const probe = (extra: Record<string, string> = {}, over: Partial<Parameters<typeof probeClaude>[0]> = {}) =>
  probeClaude({ bin: fakeClaude, folder, agent: null, args: [], env: envOf(extra), pollMs: 20, killGraceMs: 300, ...over })
const lines = (file: string) => readFileSync(file, 'utf8').split('\n').filter(Boolean)
const gone = (pid: number) => {
  try {
    process.kill(pid, 0)
    return false
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

describe('probeClaude', () => {
  it('returns the version and the three answers, and leaves no process', async () => {
    state()
    const r = await probe({ FAKE_EXT_PID_FILE: at('pid') })
    expect(r.errors).toEqual({})
    expect(r.version).toBe('2.1.322')
    expect((r.mcp as any).mcpServers.map((s: any) => s.name)).toEqual(['plugin:playwright:playwright', 'claude.ai Gmail'])
    expect((r.skills as any).skills[0].name).toBe('mine')
    expect((r.hooks as any).hooks[0].commandText).toBe('sh a.sh')
    expect(gone(Number(readFileSync(at('pid'), 'utf8')))).toBe(true)
  })

  it('starts the CLI in the folder with the stream-json flags, the agent, its own no-persistence flag and the extra args', async () => {
    state()
    await probe(
      { FAKE_EXT_START_OUT: at('start.jsonl'), MARK: '1' },
      { agent: 'helper', args: ['--settings', '{"a":1}', '--mcp-config', '{}'] }
    )
    const [start] = lines(at('start.jsonl')).map((l) => JSON.parse(l))
    expect(start.args).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-prompt-tool',
      'stdio',
      '--agent',
      'helper',
      '--no-session-persistence',
      '--settings',
      '{"a":1}',
      '--mcp-config',
      '{}'
    ])
    expect(start.cwd).toBe(folder)
    // The caller's env exactly: nothing of the test process leaks in.
    expect(start.envNames).toContain('MARK')
    expect(start.envNames).not.toContain('HOME')
  })

  it('adds no --agent for no agent', async () => {
    state()
    await probe({ FAKE_EXT_START_OUT: at('start.jsonl') })
    expect(JSON.parse(lines(at('start.jsonl'))[0]).args).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-prompt-tool',
      'stdio',
      '--no-session-persistence'
    ])
  })

  it('asks initialize first, then each section, and never writes a user message', async () => {
    state()
    const r = await probe({ FAKE_EXT_REQ_OUT: at('req') })
    expect(r.errors).toEqual({})
    const asked = lines(at('req'))
    expect(asked[0]).toBe('initialize')
    expect([...asked].sort()).toEqual(['get_hooks_listing', 'get_skills_dialog', 'initialize', 'mcp_status'])
    // The fake exits 3 on a user line and would have answered nothing; it also logs one, so check the log too.
    expect(asked).not.toContain('USER')
  })

  it('asks mcp_status again while a server is pending, and keeps the last answer', async () => {
    state()
    const r = await probe({ FAKE_EXT_PENDING_POLLS: '2', FAKE_EXT_REQ_OUT: at('req') })
    expect(r.errors).toEqual({})
    expect((r.mcp as any).mcpServers[0].status).toBe('connected')
    expect(lines(at('req')).filter((s) => s === 'mcp_status')).toHaveLength(3)
  })

  it('waits 500 ms between polls by default', async () => {
    state()
    const t = Date.now()
    await probe({ FAKE_EXT_PENDING_POLLS: '1' }, { pollMs: undefined })
    expect(Date.now() - t).toBeGreaterThanOrEqual(480)
  })

  it('stops polling after pendingMs and keeps the pending answer', async () => {
    state()
    const r = await probe({ FAKE_EXT_PENDING_POLLS: '9999' }, { pendingMs: 150 })
    expect(r.errors).toEqual({})
    expect((r.mcp as any).mcpServers[0].status).toBe('pending')
  })

  it("reports a request the CLI refuses as that section's unsupported error, and keeps the others", async () => {
    state()
    const r = await probe({ FAKE_EXT_ERROR_SUBTYPES: 'get_hooks_listing,get_skills_dialog' })
    expect(r.errors).toEqual({ skills: EXT_TEXT.unsupported('skills'), hooks: EXT_TEXT.unsupported('hooks') })
    expect(r.mcp).not.toBeNull()
    expect(r.hooks).toBeNull()
  })

  it('reports every section when the CLI ends without answering', async () => {
    state()
    const r = await probe({ FAKE_EXT_EXIT: '1' })
    expect(r.errors).toEqual({
      mcp: EXT_TEXT.unsupported('servers'),
      skills: EXT_TEXT.unsupported('skills'),
      hooks: EXT_TEXT.unsupported('hooks')
    })
    expect(r.version).toBeNull()
  })

  it('ends a hung CLI at the deadline, with errors and the whole process group gone', async () => {
    state()
    const t = Date.now()
    const r = await probe({ FAKE_EXT_HANG: '1', FAKE_EXT_GRANDCHILD: '1', FAKE_EXT_PID_FILE: at('pid') }, { deadlineMs: START_MS ?? 500 })
    expect(Date.now() - t).toBeLessThan(5000)
    expect(r.errors).toEqual({ mcp: EXT_TEXT.timeout, skills: EXT_TEXT.timeout, hooks: EXT_TEXT.timeout })
    expect(r.version).toBeNull()
    const pid = Number(readFileSync(at('pid'), 'utf8'))
    const child = Number(readFileSync(at('pid.child'), 'utf8'))
    expect(pid).toBeGreaterThan(0)
    // Resolved only after the process is gone, the grandchild in its group included.
    expect(gone(pid)).toBe(true)
    expect(gone(child)).toBe(true)
    // Windows has no process groups; the tree kill above is its whole check.
    if (!isWindows) expect(() => process.kill(-pid, 0)).toThrow(/ESRCH/)
  })

  // Windows has no catchable SIGTERM: the first kill is already a hard one.
  it.skipIf(isWindows)('kills with SIGKILL after the grace when SIGTERM is ignored', async () => {
    state()
    const t = Date.now()
    // The deadline must fall after the fake has set its SIGTERM trap, or SIGTERM alone ends it.
    const deadlineMs = START_MS ?? 300
    await probe(
      { FAKE_EXT_HANG: '1', FAKE_EXT_IGNORE_TERM: '1', FAKE_EXT_GRANDCHILD: '1', FAKE_EXT_PID_FILE: at('pid') },
      { deadlineMs, killGraceMs: 200 }
    )
    expect(Date.now() - t).toBeGreaterThanOrEqual(deadlineMs + 180)
    expect(gone(Number(readFileSync(at('pid'), 'utf8')))).toBe(true)
    expect(gone(Number(readFileSync(at('pid.child'), 'utf8')))).toBe(true)
  })

  it('keeps what arrived when the deadline passes in the middle', async () => {
    state()
    // Servers stay pending for ever, but the deadline is shorter than pendingMs.
    const r = await probe({ FAKE_EXT_PENDING_POLLS: '9999' }, { deadlineMs: START_MS ?? 200, pendingMs: 60_000 })
    expect((r.mcp as any).mcpServers[0].status).toBe('pending')
    expect(r.skills).not.toBeNull()
    expect(r.errors).toEqual({})
  })

  it('reports a missing CLI for every section instead of rejecting', async () => {
    const r = await probe({}, { bin: join(dir, 'no-such-claude') })
    expect(r.errors).toEqual({ mcp: EXT_TEXT.cliMissing, skills: EXT_TEXT.cliMissing, hooks: EXT_TEXT.cliMissing })
    expect(r.version).toBeNull()
  })
})

// A stand-in for `codex app-server`: the real answers' shapes, synthetic values, the servers on two pages.
function fakeCodex(opts: { hang?: boolean } = {}): string {
  // .mjs: an extensionless ESM script runs only on Node 22.7 and later.
  const file = at('fake-codex.mjs')
  writeFileSync(
    file,
    `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs'
if (process.env.FAKE_PID_OUT) writeFileSync(process.env.FAKE_PID_OUT, String(process.pid))
if (process.env.FAKE_ARGV_OUT) appendFileSync(process.env.FAKE_ARGV_OUT, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + '\\n')
const HANG = ${opts.hang ? 'true' : 'false'}
if (HANG) setInterval(() => {}, 1000)
let buf = ''
let skillCalls = 0
const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\\n')
process.stdin.setEncoding('utf8').on('data', (c) => {
  buf += c
  for (let i; (i = buf.indexOf('\\n')) >= 0;) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)
    if (process.env.FAKE_METHODS_OUT) appendFileSync(process.env.FAKE_METHODS_OUT, JSON.stringify({ method: m.method, params: m.params ?? null }) + '\\n')
    if (m.id === undefined || HANG) continue
    if (m.method === 'initialize') reply(m.id, { userAgent: 'zumibot/0.164.0 (Test; x86_64) fake', codexHome: '/h', platformFamily: 'unix', platformOs: 'linux' })
    else if (m.method === 'mcpServerStatus/list') {
      const first = !m.params?.cursor
      reply(m.id, first
        ? { data: [{ name: 'codex_apps', runtimeStatus: null, tools: { 'a.b': {} }, authStatus: 'bearerToken' }], nextCursor: 'c1' }
        : { data: [{ name: 'second', runtimeStatus: 'connected', tools: {}, authStatus: 'unsupported' }], nextCursor: null })
    }
    else if (m.method === 'skills/list') {
      // As codex 0.164.0 right after initialize: the built-in skills first, the plugins' skills from the second ask on.
      const all = [{ name: 'builtin', description: 'd', scope: 'system', enabled: true, pluginId: null, path: '/p' }, { name: 'plug:one', description: 'd', scope: 'user', enabled: true, pluginId: 'plug@m', path: '/q' }]
      reply(m.id, { data: [{ cwd: m.params.cwds[0], skills: ++skillCalls < 2 ? all.slice(0, 1) : all, errors: [] }] })
    }
    else if (m.method === 'hooks/list') reply(m.id, { data: [{ cwd: m.params.cwds[0], hooks: [], warnings: [], errors: [] }] })
    else process.stdout.write(JSON.stringify({ id: m.id, error: { code: -32601, message: 'no ' + m.method } }) + '\\n')
  }
})
process.stdin.on('end', () => process.exit(0))
`
  )
  chmodSync(file, 0o755)
  return writeFakeBin(dir, 'codex', file)
}

describe('probeCodex', () => {
  const run = (bin: string, extra: Record<string, string> = {}, over: Partial<Parameters<typeof probeCodex>[0]> = {}) =>
    probeCodex({ bin, folder, env: { PATH: process.env.PATH, ...extra }, killGraceMs: 300, pollMs: 20, ...over })

  it('asks the servers first, then the skills until they settle, then the hooks, all in the folder, and returns the version', async () => {
    const bin = fakeCodex()
    const r = await run(bin, { FAKE_METHODS_OUT: at('methods'), FAKE_ARGV_OUT: at('argv') })
    expect(r.errors).toEqual({})
    expect(r.version).toBe('0.164.0')
    expect((r.mcp as any).data.map((s: any) => s.name)).toEqual(['codex_apps', 'second'])
    expect((r.skills as any).data[0].cwd).toBe(folder)
    expect((r.skills as any).data[0].skills.map((s: any) => s.name)).toEqual(['builtin', 'plug:one'])
    expect((r.hooks as any).data[0].cwd).toBe(folder)
    const asked = lines(at('methods')).map((l) => JSON.parse(l))
    // The first skills answer was partial, the second grew, the third confirmed it.
    expect(asked.map((a) => a.method)).toEqual([
      'initialize',
      'initialized',
      'mcpServerStatus/list',
      'mcpServerStatus/list',
      'skills/list',
      'skills/list',
      'skills/list',
      'hooks/list'
    ])
    expect(asked.filter((a) => a.method === 'mcpServerStatus/list')[1].params).toEqual({ cursor: 'c1' })
    expect(asked.find((a) => a.method === 'skills/list').params).toEqual({ cwds: [folder] })
    const [start] = lines(at('argv')).map((l) => JSON.parse(l))
    expect(start).toEqual({ args: ['app-server', '--listen', 'stdio://'], cwd: folder })
  })

  it("turns a refused listing into that section's unsupported error", async () => {
    const file = at('fake-codex-2.mjs')
    writeFileSync(
      file,
      `#!/usr/bin/env node
let buf = ''
process.stdin.setEncoding('utf8').on('data', (c) => { buf += c; for (let i; (i = buf.indexOf('\\n')) >= 0;) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (m.id === undefined) continue
  process.stdout.write(JSON.stringify(m.method === 'initialize' ? { id: m.id, result: { userAgent: 'x/1.2.3 y' } } : m.method === 'skills/list' ? { id: m.id, result: { data: [] } } : { id: m.id, error: { code: -32601, message: 'secret detail' } }) + '\\n') } })
process.stdin.on('end', () => process.exit(0))
`
    )
    chmodSync(file, 0o755)
    const r = await run(writeFakeBin(dir, 'codex-2', file))
    // Codex's own words: the Claude Code sentences would name the wrong program.
    expect(r.errors).toEqual({ mcp: EXT_TEXT.codexUnsupported('servers'), hooks: EXT_TEXT.codexUnsupported('hooks') })
    expect(JSON.stringify(r)).not.toContain('secret detail')
    expect(r.version).toBe('1.2.3')
  })

  it('ends a hung app-server at the deadline, process gone', async () => {
    const bin = fakeCodex({ hang: true })
    const r = await run(bin, { FAKE_PID_OUT: at('pid') }, { deadlineMs: START_MS ?? 400 })
    expect(r.errors).toEqual({ mcp: EXT_TEXT.codexTimeout, skills: EXT_TEXT.codexTimeout, hooks: EXT_TEXT.codexTimeout })
    expect(gone(Number(readFileSync(at('pid'), 'utf8')))).toBe(true)
  })

  it('reports a missing codex for every section, in Codex words', async () => {
    const r = await run(join(dir, 'no-such-codex'))
    expect(r.errors).toEqual({ mcp: EXT_TEXT.codexMissing, skills: EXT_TEXT.codexMissing, hooks: EXT_TEXT.codexMissing })
    expect(JSON.stringify(r.errors)).not.toContain('Claude Code')
  })
})
