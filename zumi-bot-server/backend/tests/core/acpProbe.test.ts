import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeEach, describe, expect, test } from 'vitest'
import { ACP_TEXT } from '@zumibot/shared/acp'
import { probeAcp, type AcpProbeOptions } from '../../src/core/acp/acpProbe'

const FAKE = fileURLToPath(new URL('../fixtures/fake-acp-agent.mjs', import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'cb-acp-probe-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

let dir: string
let n = 0
beforeEach(() => {
  dir = join(root, `case-${n++}`)
  mkdirSync(dir, { recursive: true })
})

const file = (name: string) => join(dir, name)
const lines = (p: string): any[] =>
  existsSync(p)
    ? readFileSync(p, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function goneWithin(pid: number, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (!alive(pid)) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return !alive(pid)
}

// Running, not a zombie waiting for its new parent to reap it.
const running = (pid: number) => {
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.[0] !== 'Z'
  } catch {
    return false
  }
}
async function endedWithin(pid: number, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (!running(pid)) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return !running(pid)
}

const CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  auth: { terminal: false },
  elicitation: { form: {} },
  session: {}
}

function probe(script: object, o: Partial<AcpProbeOptions> = {}) {
  return probeAcp({
    command: 'fake-acp',
    bin: process.execPath,
    args: [FAKE],
    env: {
      ...process.env,
      FAKE_ACP_SCRIPT: JSON.stringify(script),
      FAKE_ACP_LOG: file('log.jsonl'),
      FAKE_ACP_PIDS: file('pids.jsonl'),
      FAKE_ACP_START: file('start.jsonl')
    },
    ...o
  })
}

// A node agent written inline: `body` runs with `send(obj)` to answer and `onLine(fn)` to read the client's lines.
function inline(body: string): { bin: string; args: string[] } {
  const script = file('inline.mjs')
  writeFileSync(
    script,
    `
    import { appendFileSync } from 'node:fs'
    import { spawn } from 'node:child_process'
    const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\\n')
    const handlers = []
    const onLine = (fn) => handlers.push(fn)
    let buf = ''
    process.stdin.on('data', (c) => { buf += c; const ls = buf.split('\\n'); buf = ls.pop(); for (const l of ls) if (l.trim()) for (const h of handlers) h(JSON.parse(l)) })
    ${body}
  `
  )
  return { bin: process.execPath, args: [script] }
}

describe('probeAcp', () => {
  test("reads the agent's initialize answer, sends only initialize with the run's capabilities, and ends the agent", async () => {
    const r = await probe({
      initialize: {
        agentInfo: { name: 'fake-acp', title: 'Fake ACP', version: '0.0.1' },
        authMethods: [
          { id: 'login', name: 'Log in with Fake' },
          { id: 'cli', name: 'Terminal login', type: 'terminal', args: ['auth', 'login'] },
          { id: 'nameless' }
        ],
        agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, sessionCapabilities: { resume: {}, systemPrompt: {} } }
      }
    })
    expect(r).toEqual({
      agentInfo: { name: 'fake-acp', title: 'Fake ACP', version: '0.0.1' },
      protocolVersion: 1,
      loadSession: true,
      resume: true,
      systemPrompt: true,
      image: true,
      authMethods: [
        { name: 'Log in with Fake', terminal: null },
        // A terminal method's hint is the agent's own command with the method's arguments, never the launch's.
        { name: 'Terminal login', terminal: 'fake-acp auth login' },
        { name: 'nameless', terminal: null }
      ]
    })
    const sent = lines(file('log.jsonl')).filter((m) => typeof m.method === 'string')
    expect(sent.map((m) => m.method)).toEqual(['initialize'])
    expect(sent[0].params).toEqual({
      protocolVersion: 1,
      clientCapabilities: CLIENT_CAPABILITIES,
      clientInfo: { name: 'zumibot', title: 'ZumiBot', version: '1.0.0' }
    })
    const agent = lines(file('pids.jsonl')).find((p) => p.role === 'agent')
    expect(await goneWithin(agent.pid, 3000)).toBe(true)
  })

  test('a minimal agent: nothing advertised reads as false, no auth methods', async () => {
    const r = await probe({})
    expect(r).toMatchObject({ loadSession: false, resume: false, systemPrompt: false, image: false, authMethods: [] })
  })

  test('runs in an empty temporary folder it removes afterwards, with every ZUMIBOT_* name stripped', async () => {
    const r = await probe(
      {},
      {
        env: {
          ...process.env,
          FAKE_ACP_SCRIPT: '{}',
          FAKE_ACP_START: file('start.jsonl'),
          ZUMIBOT_TODOS_IPC: 'x',
          ZUMIBOT_DATA_DIR: '/x',
          GEMINI_API_KEY: 'k'
        }
      }
    )
    expect('error' in r).toBe(false)
    const start = lines(file('start.jsonl'))[0]
    expect(start.cwd).not.toBe(process.cwd())
    expect(existsSync(start.cwd)).toBe(false)
    expect(start.envKeys.filter((k: string) => k.startsWith('ZUMIBOT_'))).toEqual([])
    expect(start.envKeys).toContain('GEMINI_API_KEY')
  })

  test('a protocol version other than 1 is the fixed sentence', async () => {
    expect(await probe({ initialize: { protocolVersion: 2 } })).toEqual({ error: ACP_TEXT.protocol })
  })

  test('an auth error on initialize is the sign-in sentence; any other error a fixed one, never the agent text', async () => {
    const auth = inline(
      `onLine((m) => { if (m.method === 'initialize') send({ id: m.id, error: { code: -32000, message: 'secret detail' } }) })`
    )
    expect(await probeAcp({ command: 'x', env: process.env, ...auth })).toEqual({ error: ACP_TEXT.notSignedIn([]) })
    const other = inline(
      `onLine((m) => { if (m.method === 'initialize') send({ id: m.id, error: { code: -32603, message: 'secret detail' } }) })`
    )
    expect(await probeAcp({ command: 'x', env: process.env, ...other })).toEqual({ error: ACP_TEXT.testRefused })
  })

  test('a reply that is not an initialize result is unreadable', async () => {
    const bad = inline(`onLine((m) => { if (m.method === 'initialize') send({ id: m.id, result: 'nope' }) })`)
    expect(await probeAcp({ command: 'x', env: process.env, ...bad })).toEqual({ error: ACP_TEXT.unreadable })
  })

  test('an agent that exits before answering is the stopped sentence with its code', async () => {
    const quits = inline(`process.exit(3)`)
    expect(await probeAcp({ command: 'x', env: process.env, ...quits })).toEqual({ error: ACP_TEXT.stopped(3) })
  })

  test('a command that cannot start names the command only', async () => {
    expect(await probeAcp({ command: 'nope', bin: join(dir, 'missing-bin'), args: ['--secret-arg'], env: process.env })).toEqual({
      error: ACP_TEXT.notStarted('nope')
    })
  })

  test('the deadline ends a silent agent and its group, a grandchild too', async () => {
    const silent = inline(`
      const c = spawn('sleep', ['60'], { stdio: 'ignore' })
      appendFileSync(${JSON.stringify(file('pids.jsonl'))}, JSON.stringify({ pid: process.pid, role: 'agent' }) + '\\n' + JSON.stringify({ pid: c.pid, role: 'hold' }) + '\\n')
      process.on('SIGTERM', () => {})
      setInterval(() => {}, 1000)
    `)
    const started = Date.now()
    expect(await probeAcp({ command: 'x', env: process.env, timeoutMs: 400, killForceMs: 200, ...silent })).toEqual({
      error: ACP_TEXT.testTimeout
    })
    expect(Date.now() - started).toBeLessThan(5000)
    for (const p of lines(file('pids.jsonl'))) expect(await goneWithin(p.pid, 3000), p.role).toBe(true)
  })

  test('a grandchild left in the group ends with a probe that got its answer', async () => {
    const answers = inline(`
      const c = spawn('sleep', ['60'], { stdio: 'ignore' })
      appendFileSync(${JSON.stringify(file('pids.jsonl'))}, JSON.stringify({ pid: c.pid, role: 'hold' }) + '\\n')
      process.stdin.on('end', () => {}) // stays up past stdin's end
      onLine((m) => { if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } }) })
      setInterval(() => {}, 1000)
    `)
    expect(await probeAcp({ command: 'x', env: process.env, killForceMs: 200, ...answers })).toMatchObject({ protocolVersion: 1 })
    const hold = lines(file('pids.jsonl')).find((p) => p.role === 'hold')
    expect(await goneWithin(hold.pid, 3000)).toBe(true)
  })

  // Linux: the walk past the group reads /proc (procTree.ts), which macOS has not.
  test.skipIf(process.platform !== 'linux')('a child the agent put in a session of its own (out of its group) ends with the Test too', async () => {
    const r = await probe({ holdAtInit: true })
    const all = lines(file('pids.jsonl'))
    try {
      expect(r).toMatchObject({ protocolVersion: 1 })
      expect(all.map((p) => p.role).sort()).toEqual(['agent', 'session'])
      for (const p of all) expect(await endedWithin(p.pid, 3000), p.role).toBe(true)
    } finally {
      // A failing run must not leave its sleep behind.
      for (const p of all) {
        let cmd = ''
        try {
          cmd = readFileSync(`/proc/${p.pid}/cmdline`, 'utf8')
        } catch {
          continue
        }
        if (/sleep|fake-acp-agent/.test(cmd))
          try {
            process.kill(p.pid, 'SIGKILL')
          } catch {
            /* gone */
          }
      }
    }
  })

  // Linux: a SIGTERM grace before SIGKILL (Windows ends the tree with taskkill at once), found through /proc, which macOS
  // has not.
  test.skipIf(process.platform !== 'linux')(
    'a child the Test leaves gets SIGTERM and the force grace to clean up before SIGKILL',
    async () => {
      const r = await probe({ holdAtInit: 'graceful' }, { killForceMs: 1500 })
      const all = lines(file('pids.jsonl'))
      try {
        expect(r).toMatchObject({ protocolVersion: 1 })
        const graceful = all.find((p) => p.role === 'graceful')
        expect(graceful).toBeDefined()
        expect(await endedWithin(graceful.pid, 3000)).toBe(true)
        expect(lines(file('pids.jsonl')).some((p) => p.role === 'cleaned' && p.pid === graceful.pid)).toBe(true)
      } finally {
        for (const p of all) {
          let cmd = ''
          try {
            cmd = readFileSync(`/proc/${p.pid}/cmdline`, 'utf8')
          } catch {
            continue
          }
          if (/SIGTERM|fake-acp-agent/.test(cmd))
            try {
              process.kill(p.pid, 'SIGKILL')
            } catch {
              /* gone */
            }
        }
      }
    }
  )
})
