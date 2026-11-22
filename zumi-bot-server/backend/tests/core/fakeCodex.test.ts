import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeDir } from '../support/platform'

const FAKE = join(__dirname, '..', 'fixtures', 'fake-codex.mjs')
const PROBE_MCP = join(__dirname, '..', '..', '..', 'e2e', 'fixtures', 'probe-codex-mcp.mjs')

type Msg = { id?: number; method?: string; params?: any; result?: any; error?: any }

// A hand-driven client: the same JSON lines (no jsonrpc field) the real app-server speaks.
class Client {
  readonly child: ChildProcessWithoutNullStreams
  readonly seen: Msg[] = []
  private nextId = 1
  private waiters = new Set<() => void>()
  exited: Promise<number | null>

  constructor(env: Record<string, string>, args: string[] = []) {
    this.child = spawn(process.execPath, [FAKE, 'app-server', '--listen', 'stdio://', ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let buf = ''
    this.child.stdout.setEncoding('utf8').on('data', (c: string) => {
      buf += c
      for (let i; (i = buf.indexOf('\n')) >= 0;) {
        const l = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (l) {
          this.seen.push(JSON.parse(l))
          for (const w of [...this.waiters]) w()
        }
      }
    })
    this.exited = new Promise((r) => this.child.on('exit', (code) => r(code)))
  }

  send(msg: Msg) {
    this.child.stdin.write(JSON.stringify(msg) + '\n')
  }

  request(method: string, params?: any): Promise<Msg> {
    const id = this.nextId++
    this.send({ id, method, params })
    return this.waitFor((m) => m.id === id && m.method === undefined)
  }

  waitFor(pred: (m: Msg) => boolean, ms = 8000): Promise<Msg> {
    return new Promise((resolve, reject) => {
      const look = () => {
        const m = this.seen.find(pred)
        if (m) {
          done()
          resolve(m)
          return true
        }
        return false
      }
      const timer = setTimeout(() => {
        done()
        reject(new Error(`timed out; seen: ${JSON.stringify(this.seen)}`))
      }, ms)
      const done = () => {
        clearTimeout(timer)
        this.waiters.delete(look)
      }
      if (!look()) this.waiters.add(look)
    })
  }

  async open(params: Record<string, unknown> = {}) {
    await this.request('initialize', { clientInfo: { name: 'test', title: null, version: '1.2.3' }, capabilities: {} })
    this.send({ method: 'initialized' })
    const start = await this.request('thread/start', { cwd: process.cwd(), ...params })
    return start.result.thread.id as string
  }

  methods() {
    return this.seen.filter((m) => m.method).map((m) => m.method)
  }
  close() {
    this.child.stdin.end()
  }
}

let dir: string
let clients: Client[]
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fake-codex-'))
  clients = []
})
afterEach(() => {
  for (const c of clients) c.child.kill('SIGKILL')
  // Retries: on Windows a killed fake's children can hold the folder for a moment.
  removeDir(dir)
})

function script(...steps: unknown[]) {
  const p = join(dir, 'script.jsonl')
  writeFileSync(p, steps.map((s) => JSON.stringify(s)).join('\n') + '\n')
  return p
}
function make(env: Record<string, string> = {}, args: string[] = []) {
  const c = new Client({ FAKE_CODEX_HOME: join(dir, 'home'), ...env }, args)
  clients.push(c)
  return c
}
const lines = (p: string) =>
  readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))

describe('fake-codex', () => {
  it('answers initialize with a userAgent whose version follows the first slash', async () => {
    const c = make()
    const r = await c.request('initialize', { clientInfo: { name: 'probe', title: null, version: '0.0.0' }, capabilities: {} })
    expect(r.result.userAgent).toMatch(/^fake-codex\/0\.0\.0 \(/)
    expect(r.result).toMatchObject({ platformFamily: 'unix', platformOs: 'linux' })
    expect(typeof r.result.codexHome).toBe('string')
  })

  it('starts a thread and a turn, then plays the script notifications in order', async () => {
    const c = make({
      FAKE_CODEX_SCRIPT: script(
        { notify: { method: 'item/agentMessage/delta', params: { threadId: '$THREAD', turnId: '$TURN', itemId: 'm1', delta: 'a' } } },
        { sleep: 5 },
        { notify: { method: 'item/agentMessage/delta', params: { threadId: '$THREAD', turnId: '$TURN', itemId: 'm1', delta: 'b' } } }
      )
    })
    const thread = await c.open()
    expect(thread).toBeTruthy()
    const start = c.seen.find((m) => m.id === 2)!
    expect(start.result).toMatchObject({ model: expect.any(String), approvalPolicy: expect.any(String), sandbox: expect.anything() })
    const turn = await c.request('turn/start', { threadId: thread, input: [{ type: 'text', text: 'hi', text_elements: [] }] })
    const turnId = turn.result.turn.id
    expect(turnId).toBeTruthy()
    const done = await c.waitFor((m) => m.method === 'turn/completed')
    expect(done.params).toMatchObject({ threadId: thread, turn: { id: turnId, status: 'completed' } })
    const deltas = c.seen.filter((m) => m.method === 'item/agentMessage/delta')
    expect(deltas.map((m) => m.params.delta)).toEqual(['a', 'b'])
    expect(deltas[0].params).toMatchObject({ threadId: thread, turnId })
    // turn/started comes before the script, turn/completed after it
    const order = c.methods()
    expect(order.indexOf('turn/started')).toBeLessThan(order.indexOf('item/agentMessage/delta'))
    expect(order.lastIndexOf('item/agentMessage/delta')).toBeLessThan(order.indexOf('turn/completed'))
    // no `jsonrpc` field on the wire
    expect(c.seen.every((m) => !('jsonrpc' in m))).toBe(true)
  })

  it('does not add a second turn/completed when the script ends the turn itself', async () => {
    const c = make({
      FAKE_CODEX_SCRIPT: script({
        notify: { method: 'turn/completed', params: { threadId: '$THREAD', turn: { id: '$TURN', status: 'failed' } } }
      })
    })
    const thread = await c.open()
    await c.request('turn/start', { threadId: thread, input: [] })
    await c.waitFor((m) => m.method === 'turn/completed')
    await new Promise((r) => setTimeout(r, 100))
    expect(c.seen.filter((m) => m.method === 'turn/completed')).toHaveLength(1)
  })

  it('waits at a request step until the client answers, and records the answer', async () => {
    const answers = join(dir, 'answers.jsonl')
    const c = make({
      FAKE_CODEX_ANSWERS: answers,
      FAKE_CODEX_SCRIPT: script(
        { request: { method: 'item/commandExecution/requestApproval', params: { threadId: '$THREAD', turnId: '$TURN', command: 'ls' } } },
        { notify: { method: 'item/agentMessage/delta', params: { delta: 'after' } } }
      )
    })
    const thread = await c.open()
    const turn = await c.request('turn/start', { threadId: thread, input: [] })
    const ask = await c.waitFor((m) => m.method === 'item/commandExecution/requestApproval')
    expect(typeof ask.id).toBe('number')
    expect(ask.params).toMatchObject({ threadId: thread, turnId: turn.result.turn.id, command: 'ls' })
    await new Promise((r) => setTimeout(r, 150))
    expect(c.methods()).not.toContain('item/agentMessage/delta')
    expect(c.methods()).not.toContain('turn/completed')
    c.send({ id: ask.id, result: { decision: 'accept' } })
    await c.waitFor((m) => m.method === 'turn/completed')
    expect(c.methods()).toContain('item/agentMessage/delta')
    expect(lines(answers)).toEqual([{ id: ask.id, result: { decision: 'accept' } }])
  })

  it('ends a waiting script with turn/completed interrupted on turn/interrupt', async () => {
    const c = make({
      FAKE_CODEX_SCRIPT: script(
        { notify: { method: 'item/agentMessage/delta', params: { delta: 'x' } } },
        { sleep: 60000 },
        { notify: { method: 'item/agentMessage/delta', params: { delta: 'never' } } }
      )
    })
    const thread = await c.open()
    const turn = await c.request('turn/start', { threadId: thread, input: [] })
    await c.waitFor((m) => m.method === 'item/agentMessage/delta')
    const r = await c.request('turn/interrupt', { threadId: thread, turnId: turn.result.turn.id })
    expect(r.error).toBeUndefined()
    const done = await c.waitFor((m) => m.method === 'turn/completed')
    expect(done.params.turn.status).toBe('interrupted')
    await new Promise((r2) => setTimeout(r2, 100))
    expect(c.seen.filter((m) => m.method === 'turn/completed')).toHaveLength(1)
    expect(c.seen.filter((m) => m.method === 'item/agentMessage/delta')).toHaveLength(1)
  })

  it('interrupts a script that waits on an unanswered request, resolving the request first', async () => {
    const c = make({ FAKE_CODEX_SCRIPT: script({ request: { method: 'item/tool/requestUserInput', params: {} } }) })
    const thread = await c.open()
    const turn = await c.request('turn/start', { threadId: thread, input: [] })
    const ask = await c.waitFor((m) => m.method === 'item/tool/requestUserInput')
    await c.request('turn/interrupt', { threadId: thread, turnId: turn.result.turn.id })
    const done = await c.waitFor((m) => m.method === 'turn/completed')
    expect(done.params.turn.status).toBe('interrupted')
    const resolved = c.seen.filter((m) => m.method === 'serverRequest/resolved')
    expect(resolved.map((m) => m.params)).toEqual([{ threadId: thread, requestId: ask.id }])
    expect(c.methods().indexOf('serverRequest/resolved')).toBeLessThan(c.methods().indexOf('turn/completed'))
  })

  it('sends serverRequest/resolved after an answer, as the real app-server does', async () => {
    const c = make({
      FAKE_CODEX_SCRIPT: script(
        { request: { method: 'item/commandExecution/requestApproval', params: { threadId: '$THREAD', turnId: '$TURN', command: 'ls' } } },
        { notify: { method: 'item/agentMessage/delta', params: { delta: 'after' } } }
      )
    })
    const thread = await c.open()
    await c.request('turn/start', { threadId: thread, input: [] })
    const ask = await c.waitFor((m) => m.method === 'item/commandExecution/requestApproval')
    c.send({ id: ask.id, result: { decision: 'accept' } })
    await c.waitFor((m) => m.method === 'turn/completed')
    const order = c.methods()
    expect(c.seen.find((m) => m.method === 'serverRequest/resolved')!.params).toEqual({ threadId: thread, requestId: ask.id })
    expect(order.indexOf('serverRequest/resolved')).toBeLessThan(order.indexOf('item/agentMessage/delta'))
  })

  it('resumes a thread whose marker exists and refuses an unknown one', async () => {
    const c = make()
    const thread = await c.open()
    const ok = await c.request('thread/resume', { threadId: thread })
    expect(ok.result.thread.id).toBe(thread)
    expect(ok.result).toMatchObject({ model: expect.any(String) })
    const marker = join(dir, 'home', 'threads', 'from-before')
    mkdirSync(join(dir, 'home', 'threads'), { recursive: true })
    writeFileSync(marker, '')
    const old = await c.request('thread/resume', { threadId: 'from-before' })
    expect(old.result.thread.id).toBe('from-before')
    const bad = await c.request('thread/resume', { threadId: 'nope' })
    expect(bad.error).toEqual({ code: -32600, message: 'no rollout found for thread id nope' }) // real codex 0.164.0's answer
  })

  it('forks a thread into a new one that keeps working, logging lastTurnId and the flags, and leaves the source as it was', async () => {
    const log = join(dir, 'log.jsonl')
    const c = make({ FAKE_CODEX_LOG: log })
    const src = await c.open()
    const r = await c.request('thread/fork', { threadId: src, lastTurnId: 'turn-1', cwd: process.cwd(), sandbox: 'workspace-write' })
    const fork = r.result.thread.id
    expect(fork).toBeTruthy()
    expect(fork).not.toBe(src)
    expect(r.result.thread).toMatchObject({ forkedFromId: src, ephemeral: false })
    expect(r.result).toMatchObject({ model: expect.any(String), sandbox: 'workspace-write' })
    await c.waitFor((m) => m.method === 'thread/started' && m.params.thread.id === fork)
    expect(existsSync(join(dir, 'home', 'threads', fork))).toBe(true)
    expect(existsSync(join(dir, 'home', 'threads', src))).toBe(true)
    const turn = await c.request('turn/start', { threadId: fork, input: [] })
    expect(turn.error).toBeUndefined()
    await c.waitFor((m) => m.method === 'turn/completed')
    expect(lines(log)[2]).toEqual({
      method: 'thread/fork',
      params: { threadId: src, lastTurnId: 'turn-1', cwd: process.cwd(), sandbox: 'workspace-write' }
    })
  })

  it('an ephemeral fork needs excludeTurns, as the real one does, and writes no marker, so a later process cannot resume it', async () => {
    const c = make()
    const src = await c.open()
    const bad = await c.request('thread/fork', { threadId: src, lastTurnId: 't', ephemeral: true })
    expect(bad.error).toMatchObject({ message: 'ephemeral paginated thread/fork requires `excludeTurns: true`' })
    const r = await c.request('thread/fork', { threadId: src, lastTurnId: 't', ephemeral: true, excludeTurns: true })
    const fork = r.result.thread.id
    expect(r.result.thread).toMatchObject({ ephemeral: true, path: null, forkedFromId: src })
    expect(existsSync(join(dir, 'home', 'threads', fork))).toBe(false)
    // Usable in its own process...
    const turn = await c.request('turn/start', { threadId: fork, input: [] })
    expect(turn.error).toBeUndefined()
    await c.waitFor((m) => m.method === 'turn/completed')
    // ...gone for the next one.
    const later = make()
    await later.request('initialize', {})
    const resume = await later.request('thread/resume', { threadId: fork })
    expect(resume.error).toEqual({ code: -32600, message: `no rollout found for thread id ${fork}` })
  })

  it('refuses a fork of an unknown thread with the missing-thread wording', async () => {
    const c = make()
    await c.open()
    const r = await c.request('thread/fork', { threadId: 'nope', lastTurnId: 't' })
    expect(r.error).toEqual({ code: -32600, message: 'no rollout found for thread id nope' })
  })

  it('FAKE_CODEX_FORK_ERROR refuses a fork of a known thread with -32603 and its message, and makes no thread', async () => {
    const c = make({ FAKE_CODEX_FORK_ERROR: 'fork exploded' })
    const src = await c.open()
    const r = await c.request('thread/fork', { threadId: src, lastTurnId: 't' })
    expect(r.error).toEqual({ code: -32603, message: 'fork exploded' })
    // Only thread/start's own notice: the refused fork started nothing.
    expect(c.methods().filter((m) => m === 'thread/started')).toHaveLength(1)
  })

  it('FAKE_CODEX_FORK_SAME=1 answers a fork with the source id', async () => {
    const c = make({ FAKE_CODEX_FORK_SAME: '1' })
    const src = await c.open()
    const r = await c.request('thread/fork', { threadId: src, lastTurnId: 't' })
    expect(r.result.thread.id).toBe(src)
  })

  it('thread/compact/start answers {} at once, then plays check 9: a turn holding one contextCompaction item, and no thread/compacted', async () => {
    const c = make()
    const thread = await c.open()
    const r = await c.request('thread/compact/start', { threadId: thread })
    expect(r.result).toEqual({})
    const done = await c.waitFor((m) => m.method === 'turn/completed')
    expect(done.params).toMatchObject({ threadId: thread, turn: { status: 'completed' } })
    const turnId = done.params.turn.id
    const answerAt = c.seen.indexOf(r)
    const after = c.seen.slice(answerAt + 1).filter((m) => m.method)
    expect(after.map((m) => m.method)).toEqual([
      'thread/status/changed',
      'turn/started',
      'item/started',
      'thread/tokenUsage/updated',
      'item/completed',
      'thread/status/changed',
      'turn/completed'
    ])
    const [started, completed] = after.filter((m) => m.method === 'item/started' || m.method === 'item/completed')
    expect(started.params).toMatchObject({ threadId: thread, turnId, item: { type: 'contextCompaction' } })
    expect(completed.params).toMatchObject({ threadId: thread, turnId, item: { type: 'contextCompaction', id: started.params.item.id } })
    expect(after.find((m) => m.method === 'turn/started')!.params).toMatchObject({
      threadId: thread,
      turn: { id: turnId, status: 'inProgress' }
    })
    expect(c.methods()).not.toContain('thread/compacted')
  })

  it('a compaction is a turn: turn/interrupt ends it interrupted, before its item completes', async () => {
    const c = make({ FAKE_CODEX_COMPACT_MS: '60000' })
    const thread = await c.open()
    await c.request('thread/compact/start', { threadId: thread })
    const started = await c.waitFor((m) => m.method === 'item/started')
    await c.request('turn/interrupt', { threadId: thread, turnId: started.params.turnId })
    const done = await c.waitFor((m) => m.method === 'turn/completed')
    expect(done.params.turn).toMatchObject({ id: started.params.turnId, status: 'interrupted' })
    expect(c.seen.some((m) => m.method === 'item/completed')).toBe(false)
  })

  it('refuses to compact a thread it has not opened', async () => {
    const c = make()
    await c.open()
    const r = await c.request('thread/compact/start', { threadId: 'nope' })
    expect(r.error).toMatchObject({ code: -32600 })
  })

  it('logs every request it received with its params', async () => {
    const log = join(dir, 'log.jsonl')
    const c = make({ FAKE_CODEX_LOG: log })
    const thread = await c.open({ config: { 'mcp_servers.x': { command: 'y' } } })
    await c.request('turn/start', { threadId: thread, input: [{ type: 'text', text: 'hello', text_elements: [] }] })
    await c.waitFor((m) => m.method === 'turn/completed')
    const got = lines(log)
    expect(got.map((l) => l.method)).toEqual(['initialize', 'thread/start', 'turn/start'])
    expect(got[1].params.config).toEqual({ 'mcp_servers.x': { command: 'y' } })
    expect(got[2].params.input[0].text).toBe('hello')
  })

  it('fails a turn with an unauthorized error when FAKE_CODEX_UNAUTHORIZED=1', async () => {
    const c = make({
      FAKE_CODEX_UNAUTHORIZED: '1',
      FAKE_CODEX_SCRIPT: script({ notify: { method: 'item/agentMessage/delta', params: {} } })
    })
    const thread = await c.open()
    const turn = await c.request('turn/start', { threadId: thread, input: [] })
    const done = await c.waitFor((m) => m.method === 'turn/completed')
    const err = c.seen.find((m) => m.method === 'error')!
    expect(err.params).toMatchObject({
      error: { codexErrorInfo: 'unauthorized' },
      willRetry: false,
      threadId: thread,
      turnId: turn.result.turn.id
    })
    expect(typeof err.params.error.message).toBe('string')
    expect(done.params.turn.status).toBe('failed')
    expect(c.methods().indexOf('error')).toBeLessThan(c.methods().indexOf('turn/completed'))
    expect(c.methods()).not.toContain('item/agentMessage/delta')
  })

  it('answers an unknown request with an error and ignores unknown notifications', async () => {
    const c = make()
    c.send({ method: 'whatever/else', params: {} })
    const r = await c.request('nope/nothing', {})
    expect(r.error).toMatchObject({ code: -32601 })
    const init = await c.request('initialize', {})
    expect(init.result).toBeTruthy()
  })

  it('exits when stdin closes', async () => {
    const c = make()
    await c.request('initialize', {})
    c.close()
    expect(await c.exited).toBe(0)
  })

  it('exits on SIGTERM', async () => {
    const c = make()
    await c.request('initialize', {})
    c.child.kill('SIGTERM')
    await c.exited
  })

  it('mcpCall runs the stdio server of the thread config, forwarding only env and env_vars', async () => {
    const cwd = mkdtempSync(join(dir, 'ws-'))
    const spec = { command: process.execPath, args: [PROBE_MCP], env_vars: ['PROBE_TOKEN'], tool_timeout_sec: 20 }
    const c = make({
      PROBE_TOKEN: 'tok-123',
      FAKE_CODEX_SCRIPT: script({ mcpCall: { server: 'probe', tool: 'probe_echo', args: { text: 'hello' } } })
    })
    const thread = await c.open({ cwd, config: { 'mcp_servers.probe': spec } })
    await c.request('turn/start', { threadId: thread, input: [] })
    await c.waitFor((m) => m.method === 'turn/completed')
    const started = c.seen.find((m) => m.method === 'item/started' && m.params.item.type === 'mcpToolCall')!
    const completed = c.seen.find((m) => m.method === 'item/completed' && m.params.item.type === 'mcpToolCall')!
    expect(started.params.item).toMatchObject({
      server: 'probe',
      tool: 'probe_echo',
      status: 'inProgress',
      arguments: { text: 'hello' },
      result: null
    })
    expect(started.params).toMatchObject({ threadId: thread })
    expect(completed.params.item).toMatchObject({
      id: started.params.item.id,
      status: 'completed',
      result: { content: [{ type: 'text', text: 'echo: hello' }] },
      error: null
    })
    expect(readFileSync(join(cwd, 'marker-mcp.txt'), 'utf8')).toBe('hello\ntok-123\n')
  })

  it('mcpCall does not hand over env_vars that were not listed', async () => {
    const cwd = mkdtempSync(join(dir, 'ws-'))
    const spec = { command: process.execPath, args: [PROBE_MCP] }
    const c = make({
      PROBE_TOKEN: 'tok-123',
      FAKE_CODEX_SCRIPT: script({ mcpCall: { server: 'probe', tool: 'probe_echo', args: { text: 'hi' } } })
    })
    const thread = await c.open({ cwd, config: { 'mcp_servers.probe': spec } })
    await c.request('turn/start', { threadId: thread, input: [] })
    await c.waitFor((m) => m.method === 'turn/completed')
    expect(readFileSync(join(cwd, 'marker-mcp.txt'), 'utf8')).toBe('hi\n\n')
  })

  it('mcpCall completes failed when the thread config does not name the server', async () => {
    const c = make({ FAKE_CODEX_SCRIPT: script({ mcpCall: { server: 'ghost', tool: 't', args: {} } }) })
    const thread = await c.open()
    await c.request('turn/start', { threadId: thread, input: [] })
    await c.waitFor((m) => m.method === 'turn/completed')
    const completed = c.seen.find((m) => m.method === 'item/completed' && m.params.item.type === 'mcpToolCall')!
    expect(completed.params.item.status).toBe('failed')
    expect(completed.params.item.error.message).toMatch(/ghost/)
    expect(existsSync(join(dir, 'marker-mcp.txt'))).toBe(false)
  })
})

// Hooks the way check 11 found them: `-c hooks.PreToolUse=[…]` on argv (a sessionFlags hook), run only once `-c hooks.state`
// trusts it by its hash; each runs through `sh -c` before a scripted tool call with check 11's stdin; exit 2 blocks.
describe('fake-codex hooks', () => {
  const KEY = '/<session-flags>/config.toml:pre_tool_use:0:0'
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  const toml = (v: unknown): string =>
    typeof v === 'string'
      ? JSON.stringify(v)
      : typeof v === 'number'
        ? String(v)
        : Array.isArray(v)
          ? `[${v.map(toml).join(',')}]`
          : `{${Object.entries(v as object)
              .map(([k, x]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k)}=${toml(x)}`)
              .join(',')}}`
  type H = { command: string; timeout?: number; matcher?: string }
  const preToolUse = (hooks: H[]) => [
    '-c',
    `hooks.PreToolUse=${toml(hooks.map((h) => ({ ...(h.matcher ? { matcher: h.matcher } : {}), hooks: [{ type: 'command', command: h.command, timeout: h.timeout ?? 5 }] })))}`
  ]
  const state = (table: Record<string, string>) => [
    '-c',
    `hooks.state=${toml(Object.fromEntries(Object.entries(table).map(([k, h]) => [k, { trusted_hash: h }])))}`
  ]
  const listed = async (args: string[], env: Record<string, string> = {}) => {
    const c = make(env, args)
    await c.request('initialize', { clientInfo: { name: 't', title: null, version: '0' }, capabilities: null })
    const r = await c.request('hooks/list', { cwds: [dir] })
    c.close()
    return r
  }
  const hooksOf = (r: Msg) => r.result.data[0].hooks as any[]
  // The probe's hook: logs its stdin, blocks on `blocked-marker` (exit 2), exit 1 on `exit1-marker`, outlives its timeout on `timeout-marker`.
  function probeHook() {
    const file = join(dir, 'hook.sh'),
      log = join(dir, 'hook-log.jsonl')
    writeFileSync(
      file,
      [
        '#!/bin/sh',
        'input=$(cat)',
        `printf '%s\\n' "$input" >> ${q(log)}`,
        'case "$input" in',
        '  *blocked-marker*) echo "BLOCKED-BY-PROBE" >&2; exit 2 ;;',
        '  *exit1-marker*) echo "EXIT1-BY-PROBE" >&2; exit 1 ;;',
        '  *timeout-marker*) exec sleep 20 ;;',
        'esac',
        'exit 0',
        ''
      ].join('\n')
    )
    return { command: `sh ${q(file)}`, log, inputs: () => (existsSync(log) ? lines(log) : []) }
  }
  // A process whose hooks are trusted: the hash comes from a first process's hooks/list, as ZumiBot's pre-flight does.
  async function trusted(hooks: H[], env: Record<string, string> = {}) {
    const r = await listed(preToolUse(hooks), env)
    return [...preToolUse(hooks), ...state(Object.fromEntries(hooksOf(r).map((h) => [h.key, h.currentHash])))]
  }
  const turn = async (c: Client, params: Record<string, unknown> = {}) => {
    const thread = await c.open(params)
    await c.request('turn/start', { threadId: thread, input: [] })
    await c.waitFor((m) => m.method === 'turn/completed', 15_000)
    return thread
  }
  const hookNotes = (c: Client) => c.seen.filter((m) => m.method?.startsWith('hook/'))
  const commandItems = (c: Client, phase: 'started' | 'completed') =>
    c.seen.filter((m) => m.method === `item/${phase}` && m.params.item.type === 'commandExecution')

  it("hooks/list shows a -c hook in check 11's shape, untrusted; hooks.state trusts it only by the listed hash, and only in the inline form", async () => {
    const plain = hooksOf(await listed(preToolUse([{ command: 'echo hi' }])))
    expect(plain).toEqual([
      {
        key: KEY,
        eventName: 'preToolUse',
        handlerType: 'command',
        command: 'echo hi',
        async: false,
        matcher: null,
        timeoutSec: 5,
        statusMessage: null,
        additionalContextLimit: null,
        sourcePath: '/<session-flags>/config.toml',
        source: 'sessionFlags',
        pluginId: null,
        displayOrder: 0,
        enabled: true,
        isManaged: false,
        currentHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        trustStatus: 'untrusted'
      }
    ])
    const hash = plain[0].currentHash
    expect(hooksOf(await listed([...preToolUse([{ command: 'echo hi' }]), ...state({ [KEY]: hash })]))[0].trustStatus).toBe('trusted')
    expect(hooksOf(await listed([...preToolUse([{ command: 'echo hi' }]), ...state({ [KEY]: 'sha256:0' })]))[0].trustStatus).toBe(
      'untrusted'
    )
    // The dotted form is ignored, as real codex ignores it.
    expect(
      hooksOf(await listed([...preToolUse([{ command: 'echo hi' }]), '-c', `hooks.state."${KEY}".trusted_hash="${hash}"`]))[0].trustStatus
    ).toBe('untrusted')
    // No -c hook: nothing listed.
    expect(hooksOf(await listed([]))).toEqual([])
  })

  it('the hash follows the command, timeout, matcher and salt, not the position; keys follow the group', async () => {
    const hashOf = async (hooks: H[], i = 0, env: Record<string, string> = {}) =>
      hooksOf(await listed(preToolUse(hooks), env))[i].currentHash
    const base = await hashOf([{ command: 'a' }])
    expect(await hashOf([{ command: 'b' }])).not.toBe(base)
    expect(await hashOf([{ command: 'a', timeout: 6 }])).not.toBe(base)
    expect(await hashOf([{ command: 'a', matcher: 'Bash' }])).not.toBe(base)
    expect(await hashOf([{ command: 'z' }, { command: 'a' }], 1)).toBe(base)
    expect(await hashOf([{ command: 'a' }], 0, { FAKE_CODEX_HOOK_SALT: 'next-version' })).not.toBe(base)
    const two = hooksOf(await listed(preToolUse([{ command: 'a' }, { command: 'b', matcher: 'Bash' }])))
    expect(two.map((h) => [h.key, h.matcher, h.displayOrder])).toEqual([
      [KEY, null, 0],
      ['/<session-flags>/config.toml:pre_tool_use:1:0', 'Bash', 1]
    ])
  })

  it('FAKE_CODEX_HOOKS_LIST=off refuses hooks/list as an older codex would; empty lists no hooks', async () => {
    const off = await listed(preToolUse([{ command: 'a' }]), { FAKE_CODEX_HOOKS_LIST: 'off' })
    expect(off.error).toMatchObject({ code: -32601 })
    expect(hooksOf(await listed(preToolUse([{ command: 'a' }]), { FAKE_CODEX_HOOKS_LIST: 'empty' }))).toEqual([])
  })

  it("an exec step runs each trusted hook with check 11's stdin: exit 0 runs the call, exit 2 blocks it (no item, stderr as feedback), exit 1 fails open", async () => {
    const hook = probeHook()
    const out = join(dir, 'hooks-out.jsonl')
    const c = make(
      {
        FAKE_CODEX_HOOKS_OUT: out,
        FAKE_CODEX_SCRIPT: script(
          { exec: { command: 'echo ok', output: 'ok\n' } },
          { exec: { command: 'touch blocked-marker' } },
          { exec: { command: 'touch exit1-marker', exitCode: 1, output: 'no' } }
        )
      },
      await trusted([{ command: hook.command }])
    )
    const thread = await turn(c, { cwd: dir })
    const turnId = c.seen.find((m) => m.method === 'turn/started')!.params.turn.id
    // The inputs, key for key in check 11's order.
    const inputs = hook.inputs()
    expect(inputs.map((i) => i.tool_input.command)).toEqual(['echo ok', 'touch blocked-marker', 'touch exit1-marker'])
    expect(Object.keys(inputs[0])).toEqual([
      'session_id',
      'turn_id',
      'transcript_path',
      'cwd',
      'hook_event_name',
      'model',
      'permission_mode',
      'tool_name',
      'tool_input',
      'tool_use_id'
    ])
    expect(inputs[0]).toMatchObject({
      session_id: thread,
      turn_id: turnId,
      cwd: dir,
      hook_event_name: 'PreToolUse',
      permission_mode: 'default',
      tool_name: 'Bash',
      tool_use_id: expect.stringMatching(/^exec-/)
    })
    // Each call: hook/started, hook/completed, then its item unless blocked.
    const notes = hookNotes(c)
    expect(notes.map((m) => [m.method, m.params.run.status])).toEqual([
      ['hook/started', 'running'],
      ['hook/completed', 'completed'],
      ['hook/started', 'running'],
      ['hook/completed', 'blocked'],
      ['hook/started', 'running'],
      ['hook/completed', 'failed']
    ])
    expect(notes[3].params).toMatchObject({
      threadId: thread,
      turnId,
      run: {
        id: `pre-tool-use:0:/<session-flags>/config.toml:${inputs[1].tool_use_id}`,
        eventName: 'preToolUse',
        handlerType: 'command',
        executionMode: 'sync',
        scope: 'turn',
        sourcePath: '/<session-flags>/config.toml',
        source: 'sessionFlags',
        entries: [{ kind: 'feedback', text: 'BLOCKED-BY-PROBE' }]
      }
    })
    expect(notes[5].params.run.entries).toEqual([{ kind: 'error', text: 'hook exited with code 1' }])
    const started = commandItems(c, 'started').map((m) => m.params.item)
    expect(started.map((i) => i.id)).toEqual([inputs[0].tool_use_id, inputs[2].tool_use_id])
    expect(started[0]).toMatchObject({ command: "/bin/bash -lc 'echo ok'", cwd: dir, status: 'inProgress' })
    const completed = commandItems(c, 'completed').map((m) => m.params.item)
    expect(completed.map((i) => [i.status, i.exitCode, i.aggregatedOutput])).toEqual([
      ['completed', 0, 'ok\n'],
      ['failed', 1, 'no']
    ])
    // The hook runs before the item starts.
    const order = c.seen.map((m) => m.method)
    expect(order.indexOf('hook/completed')).toBeLessThan(order.indexOf('item/started'))
    expect(lines(out)).toEqual([
      { id: inputs[0].tool_use_id, tool: 'Bash', agentId: null, blocked: false },
      { id: inputs[1].tool_use_id, tool: 'Bash', agentId: null, blocked: true },
      { id: inputs[2].tool_use_id, tool: 'Bash', agentId: null, blocked: false }
    ])
  })

  it('an untrusted hook never runs and sends nothing, so every call goes through', async () => {
    const hook = probeHook()
    const c = make({ FAKE_CODEX_SCRIPT: script({ exec: { command: 'touch blocked-marker' } }) }, preToolUse([{ command: hook.command }]))
    await turn(c, { cwd: dir })
    expect(hook.inputs()).toEqual([])
    expect(hookNotes(c)).toEqual([])
    expect(commandItems(c, 'completed')).toHaveLength(1)
  })

  // POSIX: the fake ends a hook by its process group. Git Bash's children are not in the hook's Windows process tree, so
  // there the `sleep` keeps stderr open past the kill and the hook never ends.
  it.skipIf(process.platform === 'win32')(
    'a hook that outlives its timeout is failed and the call runs',
    async () => {
      const hook = probeHook()
      const c = make(
        { FAKE_CODEX_SCRIPT: script({ exec: { command: 'touch timeout-marker' } }) },
        await trusted([{ command: hook.command, timeout: 1 }])
      )
      await turn(c, { cwd: dir })
      const done = hookNotes(c).find((m) => m.method === 'hook/completed')!
      expect(done.params.run).toMatchObject({ status: 'failed', entries: [{ kind: 'error', text: 'hook timed out after 1s' }] })
      expect(commandItems(c, 'completed')).toHaveLength(1)
    },
    15_000
  )

  it("a subagent's exec carries agent_id and agent_type, and its hook notices and item carry the child's thread", async () => {
    const hook = probeHook()
    const c = make(
      {
        FAKE_CODEX_SCRIPT: script(
          { exec: { command: 'echo sub', agent: { threadId: 'child-1' } } },
          { exec: { command: 'touch blocked-marker', agent: { threadId: 'child-1', type: 'explorer', turnId: 'child-turn' } } }
        )
      },
      await trusted([{ command: hook.command }])
    )
    const thread = await turn(c, { cwd: dir })
    const [sub, blocked] = hook.inputs()
    expect(Object.keys(sub)).toEqual([
      'session_id',
      'turn_id',
      'agent_id',
      'agent_type',
      'transcript_path',
      'cwd',
      'hook_event_name',
      'model',
      'permission_mode',
      'tool_name',
      'tool_input',
      'tool_use_id'
    ])
    expect(sub).toMatchObject({ session_id: thread, agent_id: 'child-1', agent_type: 'default' })
    expect(blocked).toMatchObject({ session_id: thread, turn_id: 'child-turn', agent_id: 'child-1', agent_type: 'explorer' })
    expect(hookNotes(c).every((m) => m.params.threadId === 'child-1')).toBe(true)
    expect(hookNotes(c).find((m) => m.params.run.status === 'blocked')!.params.turnId).toBe('child-turn')
    expect(commandItems(c, 'started').map((m) => m.params.threadId)).toEqual(['child-1'])
  })

  it('an mcpCall runs the hooks first (tool mcp__<server>__<tool>, its arguments as input); a block skips the call and its item', async () => {
    const file = join(dir, 'mcp-hook.sh'),
      log = join(dir, 'mcp-hook.jsonl')
    writeFileSync(file, `#!/bin/sh\ninput=$(cat)\nprintf '%s\\n' "$input" >> ${q(log)}\necho NO-MCP >&2\nexit 2\n`)
    const c = make(
      { FAKE_CODEX_SCRIPT: script({ mcpCall: { server: 'ghost', tool: 'echo', args: { text: 'hook' } } }) },
      await trusted([{ command: `sh ${q(file)}` }])
    )
    await turn(c)
    const [input] = lines(log)
    expect(input).toMatchObject({ tool_name: 'mcp__ghost__echo', tool_input: { text: 'hook' } })
    expect(hookNotes(c).at(-1)!.params.run).toMatchObject({ status: 'blocked', entries: [{ kind: 'feedback', text: 'NO-MCP' }] })
    expect(hookNotes(c).at(-1)!.params.run.id.endsWith(`:${input.tool_use_id}`)).toBe(true)
    expect(c.seen.some((m) => m.method?.startsWith('item/') && m.params.item.type === 'mcpToolCall')).toBe(false)
  })

  it('a matcher limits a hook to the tools it names', async () => {
    const hook = probeHook()
    const c = make(
      { FAKE_CODEX_SCRIPT: script({ exec: { command: 'touch blocked-marker' } }) },
      await trusted([{ command: hook.command, matcher: '^mcp__' }])
    )
    await turn(c, { cwd: dir })
    expect(hook.inputs()).toEqual([])
    expect(commandItems(c, 'completed')).toHaveLength(1)
  })
})

// Probe check 13's child thread: the spawn is a main-thread `subAgentActivity` (started, then completed), the child's own
// notices carry its thread id, a wait is a `collabAgentToolCall`, and a turn/interrupt never stops the child (only exiting does).
describe('fake-codex subagents', () => {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  const toml = (v: unknown): string =>
    typeof v === 'string'
      ? JSON.stringify(v)
      : typeof v === 'number'
        ? String(v)
        : Array.isArray(v)
          ? `[${v.map(toml).join(',')}]`
          : `{${Object.entries(v as object)
              .map(([k, x]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k)}=${toml(x)}`)
              .join(',')}}`
  const preToolUse = (command: string) => ['-c', `hooks.PreToolUse=${toml([{ hooks: [{ type: 'command', command, timeout: 5 }] }])}`]
  // A hook that logs its stdin and blocks a call whose input holds `blocked-marker` or names the wait.
  async function trustedHook() {
    const file = join(dir, 'hook.sh'),
      log = join(dir, 'hook-log.jsonl')
    writeFileSync(
      file,
      [
        '#!/bin/sh',
        'input=$(cat)',
        `printf '%s\\n' "$input" >> ${q(log)}`,
        'case "$input" in',
        '  *blocked-marker*|*\\"collaborationwait_agent\\"*) echo "NO" >&2; exit 2 ;;',
        'esac',
        'exit 0',
        ''
      ].join('\n')
    )
    const pre = make({}, preToolUse(`sh ${q(file)}`))
    await pre.request('initialize', { clientInfo: { name: 't', title: null, version: '0' }, capabilities: null })
    const listed = await pre.request('hooks/list', { cwds: [dir] })
    pre.close()
    const h = listed.result.data[0].hooks[0]
    return {
      args: [...preToolUse(`sh ${q(file)}`), '-c', `hooks.state=${toml({ [h.key]: { trusted_hash: h.currentHash } })}`],
      inputs: () => (existsSync(log) ? lines(log) : [])
    }
  }
  const turn = async (c: Client) => {
    const thread = await c.open({ cwd: dir })
    const t = await c.request('turn/start', { threadId: thread, input: [] })
    return { thread, turnId: t.result.turn.id as string }
  }
  const brief = (m: Msg) =>
    `${m.method} ${m.params?.threadId ?? '-'}${m.params?.item ? ` ${m.params.item.type}:${m.params.item.kind ?? m.params.item.tool ?? m.params.item.status}` : ''}${m.method?.startsWith('turn/') ? ` ${m.params.turn.status}` : ''}`
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  // A fake the test killed (SIGKILL) cannot end its held commands: end them here, so no `sleep` outlives a failed case. Only
  // a pid that is still one of ours (by its command line), never one the system has given to another process since.
  afterEach(() => {
    const pids = join(dir, 'pids.jsonl')
    if (!existsSync(pids)) return
    for (const p of lines(pids)) {
      let cmd = ''
      try {
        cmd = readFileSync(`/proc/${p.pid}/cmdline`, 'utf8')
      } catch {
        continue
      }
      if (/sleep|fake-codex/.test(cmd)) {
        try {
          process.kill(p.pid, 'SIGKILL')
        } catch {
          /* gone */
        }
      }
    }
  })
  async function goneWithin(pid: number, ms: number) {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) if (!alive(pid)) return true
    return !alive(pid)
  }

  it("spawn, the child's steps, childEnd and a wait play check 13's notices in its order and shapes", async () => {
    const c = make({
      FAKE_CODEX_SCRIPT: script(
        { spawn: { name: 'echo_child', threadId: 'kid', id: 'call_sp' } },
        { collab: { tool: 'wait', id: 'call_w' } },
        {
          notify: {
            method: 'item/completed',
            params: { threadId: 'kid', turnId: 'kid-turn', item: { type: 'agentMessage', id: 'km', text: 'printed child' } }
          }
        },
        { childEnd: { threadId: 'kid' } },
        { collab: { tool: 'wait', id: 'call_w', status: 'completed' } }
      )
    })
    const { thread, turnId } = await turn(c)
    await c.waitFor((m) => m.method === 'turn/completed' && m.params.threadId === thread)
    const played = c.seen.filter(
      (m) =>
        (m.method && !['thread/started', 'turn/started'].includes(m.method)) || (m.method === 'turn/started' && m.params.threadId === 'kid')
    )
    expect(played.map(brief)).toEqual([
      `item/started ${thread} subAgentActivity:started`,
      'thread/status/changed kid',
      `item/completed ${thread} subAgentActivity:started`,
      'thread/status/changed kid',
      'turn/started kid inProgress',
      `item/started ${thread} collabAgentToolCall:wait`,
      'item/completed kid agentMessage:undefined',
      `item/started ${thread} subAgentActivity:completed`,
      'thread/status/changed kid',
      'turn/completed kid completed',
      `item/completed ${thread} subAgentActivity:completed`,
      `item/completed ${thread} collabAgentToolCall:wait`,
      `turn/completed ${thread} completed`
    ])
    const spawn = c.seen.find((m) => m.method === 'item/started' && m.params.item.type === 'subAgentActivity')!
    expect(spawn.params).toMatchObject({
      threadId: thread,
      turnId,
      item: {
        type: 'subAgentActivity',
        id: 'call_sp',
        kind: 'started',
        agentThreadId: 'kid',
        agentPath: '/root/echo_child',
        model: expect.any(String)
      }
    })
    expect(c.seen.find((m) => m.method === 'turn/started' && m.params.threadId === 'kid')!.params.turn).toMatchObject({
      id: 'kid-turn',
      rootTurnId: turnId,
      status: 'inProgress'
    })
    const end = c.seen.find((m) => m.method === 'item/started' && m.params.item.kind === 'completed')!
    expect(end.params.item).toEqual({
      type: 'subAgentActivity',
      model: null,
      reasoningEffort: null,
      id: 'subagent-completed-kid-turn',
      kind: 'completed',
      agentThreadId: 'kid',
      agentPath: '/root/echo_child'
    })
    const wait = c.seen.filter((m) => m.params?.item?.type === 'collabAgentToolCall').map((m) => m.params.item)
    expect(wait).toEqual([
      {
        type: 'collabAgentToolCall',
        id: 'call_w',
        tool: 'wait',
        status: 'inProgress',
        senderThreadId: thread,
        receiverThreadIds: [],
        prompt: null,
        model: null,
        reasoningEffort: null,
        agentsStates: {}
      },
      {
        type: 'collabAgentToolCall',
        id: 'call_w',
        tool: 'wait',
        status: 'completed',
        senderThreadId: thread,
        receiverThreadIds: [],
        prompt: null,
        model: null,
        reasoningEffort: null,
        agentsStates: {}
      }
    ])
  })

  it("a spawn and a wait run the main thread's hooks with check 11's tool names; a block leaves no item, and the wait's end too", async () => {
    const hook = await trustedHook()
    const c = make(
      {
        FAKE_CODEX_SCRIPT: script(
          { spawn: { name: 'fine_child', threadId: 'k1', id: 'call_ok' } },
          { spawn: { name: 'blocked-marker', threadId: 'k2', id: 'call_no' } },
          { collab: { tool: 'wait', id: 'call_w' } },
          { collab: { tool: 'wait', id: 'call_w', status: 'completed' } }
        )
      },
      hook.args
    )
    const { thread } = await turn(c)
    await c.waitFor((m) => m.method === 'turn/completed' && m.params.threadId === thread)
    expect(hook.inputs().map((i) => [i.tool_name, i.tool_use_id, 'agent_id' in i])).toEqual([
      ['collaborationspawn_agent', 'call_ok', false],
      ['collaborationspawn_agent', 'call_no', false],
      ['collaborationwait_agent', 'call_w', false]
    ])
    expect(hook.inputs()[0].tool_input).toMatchObject({ task_name: 'fine_child' })
    expect(hook.inputs()[2].tool_input).toEqual({ timeout_ms: 10000 })
    const items = c.seen.filter((m) => m.method?.startsWith('item/')).map((m) => m.params.item.id)
    expect(items).toEqual(['call_ok', 'call_ok'])
    expect(c.seen.some((m) => m.params?.threadId === 'k2')).toBe(false)
  })

  it('until waits for a file, and goes on at once when it exists', async () => {
    const flag = join(dir, 'flag')
    const c = make({
      FAKE_CODEX_SCRIPT: script(
        { until: { file: flag } },
        { notify: { method: 'item/agentMessage/delta', params: { threadId: '$THREAD', delta: 'after' } } }
      )
    })
    const { thread } = await turn(c)
    await new Promise((r) => setTimeout(r, 200))
    expect(c.methods()).not.toContain('item/agentMessage/delta')
    writeFileSync(flag, '')
    await c.waitFor((m) => m.method === 'turn/completed' && m.params.threadId === thread)
    expect(c.methods()).toContain('item/agentMessage/delta')
  })

  it("a subagent's held exec is a real process: turn/interrupt leaves it running with no item end, and only the fake's exit ends it", async () => {
    const pids = join(dir, 'pids.jsonl')
    const c = make({
      FAKE_CODEX_PIDS: pids,
      FAKE_CODEX_SCRIPT: script(
        { spawn: { name: 'sleep_child', threadId: 'kid' } },
        { exec: { command: 'sleep 60', id: 'exec-sleep', hold: 60_000, agent: { threadId: 'kid' } } }
      )
    })
    const { thread, turnId } = await turn(c)
    await c.waitFor((m) => m.method === 'item/started' && m.params.item.id === 'exec-sleep')
    const procs = lines(pids)
    expect(procs.map((p) => p.role)).toEqual(['app-server', 'exec'])
    expect(procs[0].pid).toBe(c.child.pid)
    const sleeper = procs[1]
    expect(sleeper).toMatchObject({ id: 'exec-sleep', threadId: 'kid' })
    expect(alive(sleeper.pid)).toBe(true)
    await c.request('turn/interrupt', { threadId: thread, turnId })
    const done = await c.waitFor((m) => m.method === 'turn/completed' && m.params.threadId === thread)
    expect(done.params.turn.status).toBe('interrupted')
    await new Promise((r) => setTimeout(r, 200))
    // Nothing more for the child, and its command still runs.
    expect(c.seen.some((m) => m.method === 'item/completed' && m.params.item.id === 'exec-sleep')).toBe(false)
    expect(c.seen.some((m) => m.method === 'turn/completed' && m.params.threadId === 'kid')).toBe(false)
    expect(alive(sleeper.pid)).toBe(true)
    c.close()
    expect(await c.exited).toBe(0)
    expect(await goneWithin(sleeper.pid, 3000)).toBe(true)
  }, 15_000)

  it('a held exec that ends by itself completes its item; a main-thread one is killed by the interrupt', async () => {
    const pids = join(dir, 'pids.jsonl')
    const c = make({
      FAKE_CODEX_PIDS: pids,
      FAKE_CODEX_SCRIPT: script(
        { exec: { command: 'sleep 0.1', id: 'exec-short', hold: 100, output: 'ok' } },
        { exec: { command: 'sleep 60', id: 'exec-main', hold: 60_000 } }
      )
    })
    const { thread, turnId } = await turn(c)
    await c.waitFor((m) => m.method === 'item/completed' && m.params.item.id === 'exec-short')
    await c.waitFor((m) => m.method === 'item/started' && m.params.item.id === 'exec-main')
    const main = lines(pids).find((p) => p.id === 'exec-main')!
    await c.request('turn/interrupt', { threadId: thread, turnId })
    await c.waitFor((m) => m.method === 'turn/completed')
    expect(await goneWithin(main.pid, 3000)).toBe(true)
  }, 15_000)

  it("a server request names the child's thread in its resolved notice", async () => {
    const c = make({
      FAKE_CODEX_SCRIPT: script(
        { spawn: { name: 'asker', threadId: 'kid' } },
        {
          request: {
            method: 'item/commandExecution/requestApproval',
            params: { threadId: 'kid', turnId: 'kid-turn', itemId: 'e1', command: 'ls' }
          }
        }
      )
    })
    await turn(c)
    const ask = await c.waitFor((m) => m.method === 'item/commandExecution/requestApproval')
    c.send({ id: ask.id, result: { decision: 'accept' } })
    const resolved = await c.waitFor((m) => m.method === 'serverRequest/resolved')
    expect(resolved.params).toEqual({ threadId: 'kid', requestId: ask.id })
  })
})
