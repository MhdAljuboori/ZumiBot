import { appendFile, access, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, test, vi } from 'vitest'
import type { ChatItem } from '@zumibot/shared/types'
import type { UsageQuery } from '@zumibot/shared/usageReport'
import { ChatStore } from '../../src/core/store/chatStore'
import { EstimateCache } from '../../src/core/usage/estimateCache'
import { UsageService, usageAgentLabel } from '../../src/core/usage/usageService'
import { UsageStore } from '../../src/core/usage/usageStore'

const Q: UsageQuery = { from: null, to: null, agent: null, chatId: null, timeZone: 'UTC' }
const T0 = Date.parse('2026-10-01T10:00:00.000Z')
const logLine = (id: string, at = T0, input = 1_000_000) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date(at).toISOString(),
    message: {
      id,
      model: 'claude-sonnet-5-5',
      usage: { input_tokens: input, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    }
  }) + '\n'
const user = (id: string, ts = 1): Extract<ChatItem, { type: 'user' }> => ({ type: 'user', id, text: id, ts })

let dir: string
let projects: string
let chats: ChatStore
let store: UsageStore
let changed: Array<string | null>
let svc: UsageService

const make = (): UsageService =>
  new UsageService({
    store,
    cache: new EstimateCache(join(dir, 'est.json')),
    chats,
    projectsDir: projects,
    changed: (c) => changed.push(c),
    agentLabel: usageAgentLabel
  })
const writeLog = async (session: string, text: string): Promise<string> => {
  await mkdir(join(projects, 'p'), { recursive: true })
  const f = join(projects, 'p', `${session}.jsonl`)
  await writeFile(f, text)
  return f
}
const startAndWait = async (s = svc): Promise<void> => {
  await s.start()
  await s.idle()
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usvc-'))
  projects = join(dir, 'projects')
  await mkdir(projects)
  chats = new ChatStore(dir)
  store = new UsageStore(join(dir, 'usage-records.jsonl'))
  changed = []
  svc = make()
})

test('start imports user messages from items and versions files once', async () => {
  const c = await chats.create('alpha', '/w')
  await chats.saveItems(c.id, [user('u1'), { type: 'assistant', id: 'a1', text: 'x', ts: 2 }])
  await chats.saveVersions(c.id, { u1: { current: 0, list: [null, { user: user('u1b'), tail: [user('u1c')] }] } })
  await startAndWait()
  const count = () => store.all().filter((r) => r.kind === 'msg').length
  expect(count()).toBe(3)
  await startAndWait()
  expect(count()).toBe(3)
})

test("start estimates a chat's old session and marks estimating false after", async () => {
  const c = await chats.create('alpha', '/w')
  await chats.update(c.id, { sessionId: 'S1' })
  await writeLog('S1', logLine('m1'))
  await svc.start()
  expect((await svc.query(Q)).estimating).toBe(true)
  await svc.idle()
  const s = await svc.query(Q)
  expect(s.estimating).toBe(false)
  expect(s.estimatedUsd).toBeCloseTo(2)
  expect(s.exactUsd).toBe(0)
  expect(changed).toContain(null)
})

test('recordRun after an estimate removes the covered messages from the estimate', async () => {
  const c = await chats.create('alpha', '/w')
  await chats.update(c.id, { sessionId: 'S1' })
  await writeLog('S1', logLine('m1'))
  await startAndWait()
  svc.recordRun({
    id: 'r1',
    chatId: c.id,
    agent: 'alpha',
    sessionId: 'S1',
    window: [T0 - 10, T0 + 10],
    cost: { totalUsd: 1.5, models: { 'claude-sonnet-5-5': { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 1.5 } } }
  })
  await svc.idle()
  const s = await svc.query(Q)
  expect(s.estimatedUsd).toBe(0)
  expect(s.exactUsd).toBeCloseTo(1.5)
  expect(changed).toContain(c.id)
})

test('recordRun stores a per-run record', async () => {
  const c = await chats.create('alpha', '/w')
  await startAndWait()
  svc.recordRun({
    id: 'r1',
    chatId: c.id,
    agent: 'alpha',
    sessionId: 'S1',
    window: [T0, T0 + 1],
    cost: { totalUsd: 1, models: { m: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 1 } } }
  })
  await svc.idle()
  expect(store.all().find((r) => r.id === 'r1')).toMatchObject({ kind: 'cost', v: 2 })
})

test("an old session run's record (whole-session totals) gives way to its log", async () => {
  const c = await chats.create('alpha', '/w')
  await chats.update(c.id, { sessionId: 'S1' })
  await writeLog('S1', logLine('m1') + logLine('m2', T0 + 60_000))
  // Before per-run records, each turn stored the session's totals so far: 1 message, then both.
  const old = (id: string, at: number, input: number, usd: number) =>
    JSON.stringify({
      kind: 'cost',
      id,
      chatId: c.id,
      agent: 'alpha',
      at,
      sessionId: 'S1',
      window: [at - 10, at],
      models: { 'claude-sonnet-5-5': { input, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: usd } }
    }) + '\n'
  await appendFile(join(dir, 'usage-records.jsonl'), old('r1', T0 + 10, 1_000_000, 1.5) + old('r2', T0 + 60_010, 2_000_000, 3))
  await startAndWait()
  const s = await svc.query(Q)
  expect(s.exactUsd).toBe(0)
  expect(s.estimatedUsd).toBeCloseTo(4) // two 1M-input messages at the table's $2 each, not the records' 1.5 + 3
})

test('an old record with no session (moderator, handoff) still counts as exact', async () => {
  const c = await chats.create('alpha', '/w')
  await appendFile(
    join(dir, 'usage-records.jsonl'),
    JSON.stringify({
      kind: 'cost',
      id: 'm1',
      chatId: c.id,
      agent: '#moderator',
      at: T0,
      sessionId: null,
      window: null,
      models: { 'claude-haiku-5-5': { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0.25 } }
    }) + '\n'
  )
  await startAndWait()
  expect((await svc.query(Q)).exactUsd).toBeCloseTo(0.25)
})

test("refreshSession turns a stopped turn's logged messages into an estimate", async () => {
  const c = await chats.create('alpha', '/w')
  await startAndWait()
  const f = await writeLog('S2', logLine('m1'))
  svc.refreshSession(c.id, 'alpha', 'S2')
  await svc.idle()
  expect((await svc.query(Q)).estimatedUsd).toBeCloseTo(2)
  await appendFile(f, logLine('m2', T0 + 1000))
  svc.refreshSession(c.id, 'alpha', 'S2')
  await svc.idle()
  expect((await svc.query(Q)).estimatedUsd).toBeCloseTo(4)
  svc.refreshSession(c.id, 'alpha', 'nolog') // a session with no log is a silent miss
  svc.refreshSession(c.id, 'alpha', null)
  await svc.idle()
})

test('a truncated log is read again from the start', async () => {
  const c = await chats.create('alpha', '/w')
  await chats.update(c.id, { sessionId: 'S1' })
  const f = await writeLog('S1', logLine('m1') + logLine('m2', T0 + 1))
  await startAndWait()
  await writeFile(f, logLine('m3', T0 + 2))
  svc.refreshSession(c.id, 'alpha', 'S1')
  await svc.idle()
  expect((await svc.query(Q)).estimatedUsd).toBeCloseTo(2) // cache dropped, file re-read from 0: only m3
})

test("a room member's session is owned by that member", async () => {
  const c = await chats.createGroup(['alpha', 'beta'], '/w')
  await chats.updateGroup(c.id, (g) => ({ ...g, sessions: { alpha: 'SA', beta: 'SB' } }))
  await writeLog('SB', logLine('m1'))
  await startAndWait()
  const s = await svc.query(Q)
  expect(s.byAgent.map((r) => r.key)).toEqual(['beta'])
})

test("a deleted chat's exact session is still read", async () => {
  await writeLog('SX', logLine('m1', T0) + logLine('m2', T0 + 50_000))
  await store.add([
    {
      kind: 'cost',
      id: 'r1',
      chatId: 'gone',
      agent: 'alpha',
      at: T0 + 10,
      sessionId: 'SX',
      window: [T0 - 10, T0 + 10],
      models: { 'claude-sonnet-5-5': { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 2 } },
      v: 2
    }
  ])
  await startAndWait()
  const s = await svc.query(Q)
  expect(s.exactUsd).toBeCloseTo(2)
  expect(s.estimatedUsd).toBeCloseTo(2) // m2 lies outside the exact window
  expect(s.byAgent.map((r) => r.key)).toEqual(['alpha'])
})

test('renameAgent rewrites records and the query shows the new name', async () => {
  const c = await chats.create('alpha', '/w')
  await chats.update(c.id, { sessionId: 'S1' })
  await writeLog('S1', logLine('m1'))
  await startAndWait()
  svc.recordModerator(
    c.id,
    { totalUsd: 1, models: { 'claude-haiku-4-5': { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 1 } } },
    null,
    T0
  )
  svc.recordRun({
    id: 'r1',
    chatId: c.id,
    agent: 'alpha',
    sessionId: null,
    window: [T0, T0 + 1],
    cost: { totalUsd: 1, models: { 'claude-sonnet-5-5': { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 1 } } }
  })
  await svc.idle()
  await svc.renameAgent('alpha', 'gamma')
  const s = await svc.query(Q)
  expect(s.byAgent.map((r) => r.label).sort()).toEqual(['Gamma', 'Room moderator'])
  expect(s.byAgent.find((r) => r.key === 'alpha')).toBeUndefined()
})

test('recordSummary writes a handoff cost record with its own label', async () => {
  const c = await chats.create('alpha', '/w')
  await startAndWait()
  svc.recordSummary(
    c.id,
    { totalUsd: 1, models: { 'claude-sonnet-5-5': { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 1 } } },
    null,
    T0
  )
  await svc.idle()
  const s = await svc.query(Q)
  expect(s.byAgent.map((r) => [r.key, r.label])).toEqual([['#handoff', 'Room handoff']])
  expect(usageAgentLabel('#handoff')).toBe('Room handoff')
})

test('recordWorkflow keys by workflow id and #workflow agent', async () => {
  await startAndWait()
  const cost = { totalUsd: 1, models: { 'claude-haiku-4-5': { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 1 } } }
  svc.recordWorkflow('w1', cost, 'res-1', T0)
  svc.recordWorkflow('w1', cost, null, T0 + 1) // no result uuid: a fresh id, never a collision
  await svc.idle()
  const records = store.all().filter((r) => r.kind === 'cost')
  expect(records).toEqual([
    expect.objectContaining({
      id: 'res-1',
      chatId: 'workflow:w1',
      agent: '#workflow',
      at: T0,
      sessionId: null,
      window: null,
      models: cost.models
    }),
    expect.objectContaining({ chatId: 'workflow:w1', agent: '#workflow', at: T0 + 1 })
  ])
  expect(records[1]!.id).not.toBe('res-1')
  const s = await svc.query({ ...Q, chatId: 'workflow:w1' })
  expect(s.exactUsd).toBeCloseTo(2)
  expect(s.byAgent.map((r) => [r.key, r.label])).toEqual([['#workflow', 'Workflow step']])
  expect(changed).toContain('workflow:w1')
})

const workflowRows = async (names?: () => Promise<ReadonlyMap<string, string>>): Promise<string[]> => {
  const s2 = new UsageService({
    store,
    cache: new EstimateCache(join(dir, 'est.json')),
    chats,
    projectsDir: projects,
    changed: (c) => changed.push(c),
    agentLabel: usageAgentLabel,
    ...(names ? { workflowNames: names } : {})
  })
  return (await s2.query(Q)).byChat.map((r) => r.label)
}
const seedWorkflowCost = async (): Promise<void> => {
  await startAndWait()
  svc.recordWorkflow(
    'w1',
    { totalUsd: 1, models: { 'claude-haiku-4-5': { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 1 } } },
    'res-w',
    T0
  )
  await svc.idle()
}

test('a workflow row is named from the workflows dep, and follows a rename', async () => {
  await seedWorkflowCost()
  let name = 'Digest'
  const names = async () => new Map([['w1', name]])
  expect(await workflowRows(names)).toEqual(['Workflow: Digest'])
  name = 'Weekly digest'
  expect(await workflowRows(names)).toEqual(['Workflow: Weekly digest'])
})

test('a failing workflow-name read does not fail the query', async () => {
  await seedWorkflowCost()
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const names = async (): Promise<Map<string, string>> => {
    throw Object.assign(new Error('EACCES: /secret/path'), { code: 'EACCES' })
  }
  expect(await workflowRows(names)).toEqual(['Workflow (deleted)'])
  expect(log).toHaveBeenCalledWith('usage workflow names failed:', 'EACCES')
  expect(JSON.stringify(log.mock.calls)).not.toContain('/secret/path')
  log.mockRestore()
})

test('without a workflows dep a workflow row reads Workflow (deleted)', async () => {
  await seedWorkflowCost()
  expect(await workflowRows()).toEqual(['Workflow (deleted)'])
})

test('a session the meta does not name yet is attributed from the event', async () => {
  const c = await chats.create('alpha', '/w')
  await startAndWait()
  await writeLog('S9', logLine('m1'))
  svc.refreshSession(c.id, 'beta', 'S9') // the session id is not saved on the chat yet
  await svc.idle()
  const s = await svc.query({ ...Q, chatId: c.id })
  expect(s.estimatedUsd).toBeCloseTo(2)
  expect(s.byAgent.map((r) => r.key)).toEqual(['beta'])
})

const sonnet = (n: number) => ({ 'claude-sonnet-5-5': { input: n, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: (n * 2) / 1_000_000 } })

test('copied history of exact turns is not estimated again after a cut run is stopped', async () => {
  const c = await chats.create('alpha', '/w')
  await chats.update(c.id, { sessionId: 'S' })
  await startAndWait()
  // two turns on S after start: exact, S's cache never saw their lines
  const f = await writeLog('S', logLine('m1', T0) + logLine('m2', T0 + 10_000))
  svc.recordRun({
    id: 'r1',
    chatId: c.id,
    agent: 'alpha',
    sessionId: 'S',
    window: [T0 - 1, T0 + 1],
    cost: { totalUsd: 2, models: sonnet(1_000_000) }
  })
  svc.recordRun({
    id: 'r2',
    chatId: c.id,
    agent: 'alpha',
    sessionId: 'S',
    window: [T0 + 9_000, T0 + 11_000],
    cost: { totalUsd: 2, models: sonnet(1_000_000) }
  })
  await svc.idle()
  // an edit forks S' that copies both turns, then runs one exact turn; then a stopped turn on S'
  await writeLog('S2', logLine('m1', T0) + logLine('m2', T0 + 10_000) + logLine('m3', T0 + 20_000))
  await chats.update(c.id, { sessionId: 'S2' })
  svc.recordRun({
    id: 'r3',
    chatId: c.id,
    agent: 'alpha',
    sessionId: 'S2',
    window: [T0 + 19_000, T0 + 21_000],
    cost: { totalUsd: 2, models: sonnet(1_000_000) }
  })
  await svc.idle()
  await appendFile(join(projects, 'p', 'S2.jsonl'), logLine('m4', T0 + 30_000))
  svc.refreshSession(c.id, 'alpha', 'S2')
  await svc.idle()
  expect(f).toBeTruthy()
  const s = await svc.query(Q)
  expect(s.estimatedUsd).toBeCloseTo(2) // only m4
  expect(s.exactUsd).toBeCloseTo(6)
})

test('a deleted estimate-only chat stays in the totals after a restart', async () => {
  const c = await chats.create('alpha', '/w')
  await chats.update(c.id, { sessionId: 'S1' })
  await writeLog('S1', logLine('m1'))
  await startAndWait()
  expect((await svc.query(Q)).estimatedUsd).toBeCloseTo(2)
  await chats.remove(c.id)
  const again = make()
  await again.start()
  await again.idle()
  const s = await again.query(Q)
  expect(s.estimatedUsd).toBeCloseTo(2)
  expect(s.byChat.map((r) => r.label)).toEqual(['Deleted chat'])
  expect(s.byAgent.map((r) => r.key)).toEqual(['alpha'])
})

test('renamed agent keeps a deleted chat estimate under the new name', async () => {
  const c = await chats.create('alpha', '/w')
  await chats.update(c.id, { sessionId: 'S1' })
  await writeLog('S1', logLine('m1'))
  await startAndWait()
  await svc.renameAgent('alpha', 'gamma')
  await chats.remove(c.id)
  const again = make()
  await again.start()
  await again.idle()
  expect((await again.query(Q)).byAgent.map((r) => r.key)).toEqual(['gamma'])
})

test('backfill walks chats oldest first so a fork does not claim its parent messages', async () => {
  const parent = await chats.create('alpha', '/w')
  await new Promise((r) => setTimeout(r, 5))
  const fork = await chats.create('alpha', '/w')
  await chats.saveItems(parent.id, [user('u1')])
  await chats.saveItems(fork.id, [user('u1')])
  await chats.update(parent.id, { title: 'p' }) // the parent was updated last: list() puts it first anyway
  await chats.update(fork.id, { title: 'f' }) // now the fork is the most recently updated
  const s = make()
  await startAndWait(s)
  expect(store.all().find((r) => r.kind === 'msg' && r.id === 'u1')).toMatchObject({ chatId: parent.id })
})

test('an unreadable log does not stop the pass', async () => {
  const c = await chats.create('alpha', '/w')
  const d = await chats.create('alpha', '/w')
  await chats.update(c.id, { sessionId: 'BAD' })
  await chats.update(d.id, { sessionId: 'S1' })
  await mkdir(join(projects, 'p', 'BAD.jsonl'), { recursive: true }) // reading a directory throws EISDIR
  await writeLog('S1', logLine('m1'))
  const err = vi.spyOn(console, 'error').mockImplementation(() => {})
  await startAndWait()
  err.mockRestore()
  const s = await svc.query(Q)
  expect(s.estimating).toBe(false)
  expect(s.estimatedUsd).toBeCloseTo(2)
})

test('stop ends background estimating without writing its cache, but finishes queued record writes', async () => {
  const exists = (f: string) =>
    access(f).then(
      () => true,
      () => false
    )
  const c = await chats.create('alpha', '/w')
  await chats.update(c.id, { sessionId: 'S1' })
  await writeLog('S1', logLine('m1'))
  await svc.start()
  svc.noteItems(c.id, [user('kept')])
  svc.refreshSession(c.id, 'alpha', 'S1')
  await svc.stop()
  // Shutdown releases the data lock next: nothing may land in the data dir after this.
  await new Promise((r) => setTimeout(r, 50))
  expect(await exists(join(dir, 'est.json'))).toBe(false)
  expect(
    store
      .all()
      .filter((r) => r.kind === 'msg')
      .map((r) => r.id)
  ).toEqual(['kept'])
  svc.refreshSession(c.id, 'alpha', 'S1')
  await svc.idle()
  expect(await exists(join(dir, 'est.json'))).toBe(false)
  // The cache is derived: the next start rebuilds what the stopped one skipped.
  const again = make()
  await startAndWait(again)
  expect((await again.query(Q)).estimatedUsd).toBeCloseTo(2)
  expect(await exists(join(dir, 'est.json'))).toBe(true)
})
