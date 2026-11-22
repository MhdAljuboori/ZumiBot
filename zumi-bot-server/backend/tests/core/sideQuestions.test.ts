import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ChatItem, ChatMeta } from '@zumibot/shared/types'
import { SIDE_ASK_FIRST_TEXT, sourceGoneText, type SideQuestion } from '@zumibot/shared/btw'
import type { BrowserTurn } from '../../src/core/browser/browserIpc'
import type { SideBase } from '../../src/core/chat/chatService'
import type { RunOptions, RunOutcome } from '../../src/core/chat/claudeRunner'
import type { CodexRunOptions } from '../../src/core/codex/codexRunner'
import { denyResponse } from '../../src/core/chat/controlProtocol'
import type { ResultEvent, RunEvent } from '../../src/core/chat/streamParser'
import { publicEntry, SideQuestions, type SideQuestionsDeps, type StoredSide } from '../../src/core/btw/sideQuestions'
import { askedLead, askedSideNote, askingSideNote, FOLLOW_LEAD, NO_ASK_SIDE_NOTE, SIDE_NOTE } from '../../src/core/btw/sidePrompt'
import { SIDE_GUARD_ASKING, SIDE_GUARD_SETTINGS } from '../../src/core/btw/sideRun'
import { KEEP_WARM_MESSAGE } from '../../src/core/btw/keepWarm'
import { KEEP_WARM_AGENT } from '@zumibot/shared/usageReport'
import { NO_MCP } from '../../src/core/ipc/mcpSpec'
import { CODEX_REFUSALS, engineCaps, type Engine } from '@zumibot/shared/engine'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const result: ResultEvent = {
  kind: 'result',
  subtype: 'success',
  isError: false,
  numTurns: 1,
  sessionId: 'side',
  denials: [],
  windows: {},
  uuid: 'result-id',
  cost: null
}
const old: ChatItem = { type: 'assistant', id: 'a', text: 'Main history', ts: 1, end: { session: 'end-session', at: 'end-at' } }
const active: SideBase = {
  bin: '/claude',
  cwd: '/work',
  browser: false,
  asks: false,
  tmpDir: null,
  active: true,
  args: {
    agentName: 'helper',
    permissionMode: 'manual',
    extraArgs: ['--add-dir', '/files'],
    disallowedTools: ['Edit(//memory.md)'],
    appendSystemPrompt: 'House and memory'
  },
  live: { session: 'live-session', at: 'live-at' },
  start: { session: 'start-session', at: 'start-at' }
}
const open = (id: string): SideQuestion => ({
  id,
  question: 'Old question',
  agent: 'helper',
  askedAt: 1,
  after: null,
  state: 'running',
  answer: 'Partial'
})
const fixtures: { service: SideQuestions }[] = []
type FakeRun = { options: RunOptions; stop: ReturnType<typeof vi.fn>; finish(o?: Partial<RunOutcome>): void; emit(e: RunEvent): void }
function fakeRun(runs: FakeRun[]): SideQuestionsDeps['run'] {
  return (options) => {
    const pending = deferred<RunOutcome>()
    const stop = vi.fn(() =>
      pending.resolve({ exitCode: null, signal: 'SIGTERM', stderr: '', spawnError: null, result: null, stopped: true })
    )
    runs.push({
      options,
      stop,
      emit: (e) => options.onEvent(e),
      finish: (o) => pending.resolve({ exitCode: 0, signal: null, stderr: '', spawnError: null, result, stopped: false, ...o })
    })
    return { stop, send: () => true, done: pending.promise }
  }
}
type FakeCodexRun = {
  options: CodexRunOptions
  stop: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  finish(o?: Partial<RunOutcome>): void
  emit(e: RunEvent): void
}
function fakeCodexRun(runs: FakeCodexRun[]): NonNullable<SideQuestionsDeps['codexRun']> {
  return (options) => {
    const pending = deferred<RunOutcome>()
    const stop = vi.fn(() =>
      pending.resolve({ exitCode: null, signal: 'SIGTERM', stderr: '', spawnError: null, result: null, stopped: true })
    )
    const send = vi.fn(() => true)
    runs.push({
      options,
      stop,
      send,
      emit: (e) => options.onEvent(e),
      finish: (o) => pending.resolve({ exitCode: 0, signal: null, stderr: '', spawnError: null, result, stopped: false, ...o })
    })
    return { stop, send, done: pending.promise }
  }
}
function fixture(room = false) {
  let meta: ChatMeta | null = {
    id: 'chat',
    agentName: 'helper',
    sessionId: 'end-session',
    cwd: '/work',
    title: '',
    createdAt: 0,
    updatedAt: 0,
    inFlight: false,
    ...(room
      ? { group: { members: ['helper', 'writer'], sessions: { helper: 'member-session' }, seen: {}, role: '', active: [], queue: [] } }
      : {})
  }
  let items: ChatItem[] = [structuredClone(old)]
  // Side files per chat; `saved` is the main chat's.
  const sides: Record<string, StoredSide[]> = {}
  const others = new Map<string, ChatMeta>()
  let base: SideBase | null = structuredClone(active)
  let now = 100
  const runs: FakeRun[] = []
  const codexRuns: FakeCodexRun[] = []
  const store = {
    get: vi.fn(async (id: string) => structuredClone(id === 'chat' ? meta : (others.get(id) ?? null))),
    loadItems: vi.fn(async () => structuredClone(items)),
    list: vi.fn(async () => structuredClone([...(meta ? [meta] : []), ...others.values()])),
    loadSide: vi.fn(async (id: string) => structuredClone(sides[id] ?? [])),
    saveSide: vi.fn(async (id: string, entries: StoredSide[]) => {
      sides[id] = structuredClone(entries)
    })
  }
  const deps: SideQuestionsDeps = {
    store,
    chats: {
      sideBase: () => structuredClone(base),
      refreshSideBase: async (_agent, kept) => kept,
      sideBrowser: vi.fn(async () => null),
      sideDesktop: vi.fn(async () => null)
    },
    groups: {
      refuseCodex: vi.fn(async () => {}),
      sideThread: vi.fn(async () => [{ from: 'writer', text: 'Room progress' }]),
      pickInput: vi.fn(async (_id, question) => ({
        question,
        members: [
          { name: 'helper', description: '' },
          { name: 'writer', description: '' }
        ],
        working: ['writer'],
        messages: []
      }))
    },
    pick: vi.fn(async () => 'writer'),
    baseFor: vi.fn(async (_id, agent) => ({ ...structuredClone(active), active: false, args: { ...active.args, agentName: agent } })),
    run: fakeRun(runs),
    codexRun: fakeCodexRun(codexRuns),
    broadcast: vi.fn(),
    recordCost: vi.fn(),
    now: () => now
  }
  const service = new SideQuestions(deps)
  const f = {
    service,
    deps,
    store,
    runs,
    codexRuns,
    get saved() {
      return sides.chat ?? []
    },
    set saved(v) {
      sides.chat = v
    },
    get meta() {
      return meta!
    },
    remove: () => {
      meta = null
    },
    setItems: (v: ChatItem[]) => {
      items = v
    },
    setBase: (v: SideBase | null) => {
      base = v
    },
    time: (v: number) => {
      now = v
    },
    sideOf: (id: string) => sides[id] ?? [],
    // Another chat: by default the chat 'chat' (agent helper) asked `agent` there.
    addChat: (id: string, agent: string, from = 'chat') => {
      others.set(id, { ...structuredClone(meta!), id, agentName: agent, asked: { by: 'helper', from, fromTitle: '', chain: [] } })
    }
  }
  fixtures.push(f)
  return f
}
async function until(check: () => boolean) {
  for (let n = 0; n < 100 && !check(); n++) await Promise.resolve()
  expect(check()).toBe(true)
}
async function started(f: { runs: unknown[] }, count = 1) {
  await until(() => f.runs.length === count)
}
async function finished(f: { service: SideQuestions }) {
  await until(() => f.service.runningCount() === 0)
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.service.stopAll().catch(() => {})
  vi.useRealTimers()
})

test('refuses empty questions and nonmembers before storing', async () => {
  const f = fixture(true)
  await expect(f.service.ask('chat', '  ', 'q')).rejects.toThrow()
  await expect(f.service.ask('chat', '@stranger hello', 'q')).rejects.toThrow('Stranger is not in this chat')
  expect(f.store.saveSide).not.toHaveBeenCalled()
  expect(f.runs).toHaveLength(0)
})

test('stores the trimmed entry and anchor before starting the run', async () => {
  const f = fixture(),
    gate = deferred<void>()
  f.store.saveSide.mockImplementationOnce(async () => {
    await gate.promise
  })
  const accepted = f.service.ask('chat', '  How far?  ', 'q')
  await until(() => f.store.saveSide.mock.calls.length === 1)
  expect(f.runs).toHaveLength(0)
  gate.resolve()
  expect(await accepted).toEqual({ id: 'q', question: 'How far?', agent: 'helper', after: 'a', askedAt: 100, state: 'running', answer: '' })
  await started(f)
})

test('an empty chat anchors before the first item', async () => {
  const f = fixture()
  f.setItems([])
  expect((await f.service.ask('chat', 'Hello?', 'q')).after).toBeNull()
})

test('simultaneous asks refuse the fourth open entry', async () => {
  const f = fixture()
  const results = await Promise.allSettled(['1', '2', '3', '4'].map((id) => f.service.ask('chat', 'Hello?', id)))
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3)
  expect(results.find((r) => r.status === 'rejected')).toMatchObject({
    reason: new Error('3 side questions are already running in this chat')
  })
  expect(f.service.runningCount()).toBe(3)
  expect(await f.service.list('chat')).toHaveLength(3)
})

test('duplicate ids cannot create overlapping runs', async () => {
  const f = fixture()
  await f.service.ask('chat', 'Hello?', 'q')
  await expect(f.service.ask('chat', 'Hello again?', 'q')).rejects.toThrow()
  await started(f)
})

test.each([
  ['live clean point', { ...active }, 'live-session', 'live-at'],
  ['turn start before init', { ...active, live: null }, 'start-session', 'start-at'],
  ['current end while idle', { ...active, active: false, live: null }, 'end-session', 'end-at']
])('forks at the %s', async (_name, base, session, at) => {
  const f = fixture()
  f.setBase(base)
  await f.service.ask('chat', 'How far?', 'q')
  await started(f)
  expect(f.runs[0].options.args).toEqual(
    expect.arrayContaining(['--resume', session, '--resume-session-at', at, '--fork-session', '--no-session-persistence', '--settings'])
  )
  expect(f.runs[0].options.stdin).toContain('<btw>How far?</btw>')
})

test.each([false, true])('idle explicit cuts override retained points (room=%s)', async (room) => {
  const f = fixture(room)
  f.setBase({ ...active, active: false, live: null })
  if (room) f.meta.group!.next = { helper: { at: 'edited' } }
  else f.meta.next = { at: 'edited' }
  await f.service.ask('chat', room ? '@helper How far?' : 'How far?', 'q')
  await started(f)
  expect(f.runs[0].options.args).toEqual(
    expect.arrayContaining(['--resume', room ? 'member-session' : 'end-session', '--resume-session-at', 'edited'])
  )
})

test.each(['no session', 'active reseed', 'idle edit seed', 'room edit seed'])('seeds visible items with %s', async (mode) => {
  const f = fixture(mode === 'room edit seed')
  f.setBase({ ...active, active: mode === 'active reseed', live: null, start: mode === 'active reseed' ? null : active.start })
  if (mode === 'no session') f.setItems([{ type: 'user', id: 'u', text: 'Main history', ts: 1 }])
  if (mode === 'idle edit seed') f.meta.next = { seed: true }
  if (mode === 'room edit seed') f.meta.group!.next = { helper: { seed: true } }
  await f.service.ask('chat', mode === 'room edit seed' ? '@helper How far?' : 'How far?', 'q')
  await started(f)
  const { args, stdin } = f.runs[0].options
  expect(args).not.toContain('--resume')
  expect(args).not.toContain('--fork-session')
  expect(args).toContain('--settings')
  expect(stdin).toContain('Main history')
  expect(stdin).toContain('<btw>How far?</btw>')
})

test('cache misses build fresh settings and use the current item end', async () => {
  const f = fixture()
  f.setBase(null)
  await f.service.ask('chat', 'How far?', 'q')
  await started(f)
  expect(f.deps.baseFor).toHaveBeenCalledWith('chat', 'helper')
  expect(f.runs[0].options.args).toContain('end-at')
})

test('a side base that cannot be built ends the entry with its fixed sentence and runs nothing', async () => {
  const f = fixture()
  f.setBase(null)
  vi.mocked(f.deps.baseFor).mockRejectedValueOnce(new Error(CODEX_REFUSALS.notFound))
  await f.service.ask('chat', 'How far?', 'q')
  await finished(f)
  expect(f.runs).toHaveLength(0)
  expect(f.codexRuns).toHaveLength(0)
  expect(f.saved[0]).toMatchObject({ id: 'q', state: 'error', error: CODEX_REFUSALS.notFound })
})

test('a side question awaits ensure before using a kept base', async () => {
  const f = fixture(),
    order: string[] = []
  const gate = deferred<void>()
  f.deps.ensure = vi.fn(async (id: string) => {
    order.push(`ensure:${id}`)
    await gate.promise
    order.push('ensured')
  })
  const run = f.deps.run
  f.deps.run = (o) => {
    order.push('spawn')
    return run(o)
  }
  await f.service.ask('chat', 'How far?', 'q')
  await Promise.resolve()
  expect(f.runs).toHaveLength(0)
  gate.resolve()
  await started(f)
  expect(order).toEqual(['ensure:chat', 'ensured', 'spawn'])
  expect(f.deps.baseFor).not.toHaveBeenCalled() // the kept base was used, yet ensure ran first
})

test('a failing ensure fails the side question with its message', async () => {
  const f = fixture(),
    text = 'Branch x is checked out in /p. Switch that checkout to another branch, then send again.'
  f.deps.ensure = vi.fn(async () => {
    throw new Error(text)
  })
  await f.service.ask('chat', 'How far?', 'q')
  await finished(f)
  expect(f.runs).toHaveLength(0)
  expect(f.saved[0]).toMatchObject({ id: 'q', state: 'error', error: text })
})

test('a keep-warm ping awaits ensure before using a kept base, and a failing ensure rejects it with nothing run', async () => {
  const f = fixture(),
    order: string[] = []
  f.setBase({ ...active, active: false, live: null })
  f.deps.ensure = vi.fn(async (id: string) => {
    order.push(`ensure:${id}`)
  })
  const run = f.deps.run
  f.deps.run = (o) => {
    order.push('spawn')
    return run(o)
  }
  const warm = f.service.warm('chat', 'helper')
  await started(f)
  expect(order).toEqual(['ensure:chat', 'spawn'])
  f.runs[0].finish()
  expect(await warm).toBe(true)
  f.deps.ensure = vi.fn(async () => {
    throw new Error('nope')
  })
  await expect(f.service.warm('chat', 'helper')).rejects.toThrow('nope') // KeepWarm turns a rejected ping into a quiet skip
  expect(f.runs).toHaveLength(1)
})

test('room member end ignores another members later end', async () => {
  const f = fixture(true)
  f.setBase({ ...active, active: false, live: null })
  f.setItems([
    { ...old, end: { session: 'own', at: 'own-at', agent: 'helper' } },
    { ...old, id: 'other', end: { session: 'other', at: 'other-at', agent: 'writer' } }
  ])
  await f.service.ask('chat', '@helper Status?', 'q')
  await started(f)
  expect(f.runs[0].options.args).toContain('own-at')
  expect(f.runs[0].options.args).not.toContain('other-at')
  expect(f.runs[0].options.stdin).toContain('Room progress')
  expect(f.deps.pick).not.toHaveBeenCalled()
  expect(f.saved[0]).toMatchObject({ agent: 'helper', mention: true })
})

test.each(['moderator', 'null', 'throws', 'invalid'])('room picks then runs using %s result', async (mode) => {
  const f = fixture(true),
    gate = deferred<string | null>()
  vi.mocked(f.deps.pick).mockImplementation(() => gate.promise)
  expect(await f.service.ask('chat', 'Status?', 'q')).toMatchObject({ state: 'picking', agent: null })
  await until(() => vi.mocked(f.deps.pick).mock.calls.length === 1)
  expect(f.runs).toHaveLength(0)
  if (mode === 'throws') gate.reject(new Error('Picker failed'))
  else gate.resolve(mode === 'null' ? null : mode === 'invalid' ? 'stranger' : 'writer')
  await started(f)
  expect(f.saved[0]).toMatchObject({ state: 'running', agent: 'writer' })
  expect(f.runs[0].options.args).toContain('writer')
})

test('streams and flushes the done answer with its end time', async () => {
  const f = fixture()
  await f.service.ask('chat', 'Status?', 'q')
  await started(f)
  f.runs[0].emit({ kind: 'textDelta', text: 'Part' })
  f.runs[0].emit({ kind: 'textDelta', text: ' done' })
  f.time(200)
  f.runs[0].finish()
  await finished(f)
  expect(f.saved[0]).toMatchObject({ answer: 'Part done', state: 'done', endedAt: 200 })
  expect(f.deps.broadcast).toHaveBeenLastCalledWith('chat', publicEntry(f.saved[0]))
})

test('streaming coalesces saves and broadcasts and flushes the latest snapshot', async () => {
  const f = fixture()
  await f.service.ask('chat', 'Status?', 'q')
  await started(f)
  const gate = deferred<void>()
  let inFlight = 0,
    maximum = 0
  f.store.saveSide.mockImplementationOnce(async () => {
    maximum = Math.max(maximum, ++inFlight)
    await gate.promise
    inFlight--
  })
  const before = f.store.saveSide.mock.calls.length,
    pushes = vi.mocked(f.deps.broadcast).mock.calls.length
  f.runs[0].emit({ kind: 'textDelta', text: 'A' })
  await until(() => f.store.saveSide.mock.calls.length > before)
  for (let n = 0; n < 20; n++) f.runs[0].emit({ kind: 'textDelta', text: 'B' })
  f.runs[0].finish()
  await Promise.resolve()
  expect(f.store.saveSide.mock.calls.length).toBe(before + 1)
  expect(vi.mocked(f.deps.broadcast).mock.calls.length - pushes).toBeLessThanOrEqual(1)
  gate.resolve()
  await finished(f)
  expect(maximum).toBe(1)
  expect(f.saved[0]).toMatchObject({ answer: 'A' + 'B'.repeat(20), state: 'done' })
  expect(f.store.saveSide.mock.calls.length - before).toBeLessThanOrEqual(2)
})

test.each(['stop', 'stopChat', 'stopAll'])('%s keeps partial answer and releases the run', async (method) => {
  const f = fixture()
  await f.service.ask('chat', 'Status?', 'q')
  await started(f)
  f.runs[0].emit({ kind: 'textDelta', text: 'Partial' })
  if (method === 'stop') f.service.stop('chat', 'q')
  else if (method === 'stopChat') f.service.stopChat('chat')
  else await f.service.stopAll()
  await finished(f)
  expect(f.runs[0].stop).toHaveBeenCalledOnce()
  expect(f.saved[0]).toMatchObject({ state: 'stopped', answer: 'Partial', endedAt: 100 })
})

test.each(['stop', 'timeout'])('a run stays busy after %s until its process exits', async (mode) => {
  if (mode === 'timeout') vi.useFakeTimers()
  const f = fixture()
  await f.service.ask('chat', 'Status?', 'q')
  await started(f)
  f.runs[0].stop.mockImplementation(() => {})
  if (mode === 'stop') f.service.stop('chat', 'q')
  else await vi.advanceTimersByTimeAsync(180_000)
  await until(() => f.saved[0]?.state === (mode === 'stop' ? 'stopped' : 'error'))
  for (let n = 0; n < 20; n++) await Promise.resolve()
  expect(f.service.runningCount()).toBe(1)
  f.runs[0].finish({ stopped: true, result: null })
  await finished(f)
})

test('a room pick forks at the picked member point read after picking', async () => {
  const f = fixture(true),
    gate = deferred<string | null>()
  f.setBase({ ...active, active: false, live: null })
  const before: ChatItem = { ...old, end: { session: 'writer-old', at: 'old-at', agent: 'writer' } }
  f.setItems([before])
  vi.mocked(f.deps.pick).mockImplementation(() => gate.promise)
  await f.service.ask('chat', 'Status?', 'q')
  await until(() => vi.mocked(f.deps.pick).mock.calls.length === 1)
  // The writer finished a turn while the moderator was picking.
  f.setItems([before, { ...old, id: 'b', end: { session: 'writer-new', at: 'new-at', agent: 'writer' } }])
  gate.resolve('writer')
  await started(f)
  expect(f.runs[0].options.args).toEqual(expect.arrayContaining(['--resume', 'writer-new', '--resume-session-at', 'new-at']))
  expect(f.saved[0].after).toBe('a')
})

test.each(['picker', 'base', 'browser'])('the answer deadline covers %s preparation', async (mode) => {
  vi.useFakeTimers()
  const f = fixture(mode === 'picker'),
    browser = deferred<BrowserTurn | null>(),
    dispose = vi.fn(async () => {})
  // Ignores the deadline; settled at the end only, since stopAll (afterEach) waits for a call the answer left running.
  const hung = deferred<null>()
  if (mode === 'picker') vi.mocked(f.deps.pick).mockImplementation(() => hung.promise)
  if (mode === 'base') {
    f.setBase(null)
    vi.mocked(f.deps.baseFor).mockImplementation(() => hung.promise)
  }
  if (mode === 'browser') {
    f.setBase({ ...active, browser: true })
    vi.mocked(f.deps.chats.sideBrowser).mockImplementation(() => browser.promise)
  }
  await f.service.ask('chat', 'Status?', 'q')
  await vi.advanceTimersByTimeAsync(180_000)
  await finished(f)
  expect(f.runs).toHaveLength(0)
  expect(f.saved[0]).toMatchObject({ state: 'error', error: 'Took too long' })
  if (mode === 'picker') expect(vi.mocked(f.deps.pick).mock.calls[0][2].aborted).toBe(true)
  if (mode === 'browser') {
    browser.resolve({ mcp: NO_MCP, args: [], env: {}, prompt: '', dispose })
    await until(() => dispose.mock.calls.length === 1)
  }
  hung.resolve(null)
})

test('again reruns in place with a fresh point and reset answer', async () => {
  const f = fixture()
  await f.service.ask('chat', 'Status?', 'q')
  await started(f)
  f.runs[0].emit({ kind: 'textDelta', text: 'Partial' })
  f.runs[0].finish({ result: null, stderr: 'Oops', exitCode: 1 })
  await finished(f)
  expect(f.saved[0]).toMatchObject({ state: 'error', error: 'Oops' })
  f.setBase({ ...active, live: { session: 'fresh', at: 'fresh-at' } })
  f.time(300)
  expect(await f.service.again('chat', 'q')).toEqual({
    id: 'q',
    question: 'Status?',
    agent: 'helper',
    askedAt: 100,
    after: 'a',
    state: 'running',
    answer: ''
  })
  await started(f, 2)
  expect(f.runs[1].options.args).toContain('fresh-at')
  await expect(f.service.again('chat', 'q')).rejects.toThrow()
  f.runs[1].finish()
  await finished(f)
  await expect(f.service.again('chat', 'q')).rejects.toThrow()
})

test('list recovers orphaned entries once without interrupting newly accepted asks', async () => {
  const f = fixture(),
    gate = deferred<SideQuestion[]>()
  f.store.loadSide.mockImplementationOnce(() => gate.promise)
  const listing = f.service.list('chat'),
    asking = f.service.ask('chat', 'New?', 'new')
  gate.resolve([open('orphan'), { ...open('picking'), state: 'picking', agent: null }])
  expect(await listing).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: 'orphan', state: 'error', error: 'Interrupted by a restart' })])
  )
  await asking
  await started(f)
  expect((await f.service.list('chat')).find((q) => q.id === 'new')?.state).toBe('running')
  expect(f.store.loadSide).toHaveBeenCalledOnce()
  expect(f.store.saveSide.mock.calls.filter(([, list]) => list.length === 2)).toHaveLength(1)
})

test('rename during streaming changes subsequent saved entries and costs', async () => {
  const f = fixture()
  await f.service.ask('chat', 'Status?', 'q')
  await started(f)
  f.service.renameAgent('helper', 'aide')
  f.runs[0].emit({ kind: 'init', sessionId: 'side-own' })
  f.runs[0].emit({ ...result, cost: { totalUsd: 0.1, models: {} } })
  f.runs[0].emit({ kind: 'textDelta', text: 'Done' })
  f.runs[0].finish()
  await finished(f)
  expect(f.saved[0].agent).toBe('aide')
  expect(f.deps.recordCost).toHaveBeenCalledWith({
    id: 'result-id',
    chatId: 'chat',
    agent: 'aide',
    sessionId: 'side-own',
    window: [100, 100],
    cost: { totalUsd: 0.1, models: {} }
  })
})

test('rename while fresh base preparation awaits follows the new identity', async () => {
  const f = fixture(),
    gate = deferred<SideBase | null>()
  f.setBase(null)
  vi.mocked(f.deps.baseFor).mockImplementationOnce(() => gate.promise)
  await f.service.ask('chat', 'Status?', 'q')
  await until(() => vi.mocked(f.deps.baseFor).mock.calls.length === 1)
  f.service.renameAgent('helper', 'aide')
  f.meta.agentName = 'aide'
  gate.resolve(structuredClone(active))
  await started(f)
  expect(f.runs[0].options.args).toContain('aide')
  expect(f.runs[0].options.args).not.toContain('helper')
  f.runs[0].finish()
  await finished(f)
  expect(f.saved[0].agent).toBe('aide')
})

test.each(['success', 'error', 'stop', 'timeout'])('owns and disposes a browser on %s', async (mode) => {
  if (mode === 'timeout') vi.useFakeTimers()
  const f = fixture(),
    dispose = vi.fn(async () => {})
  f.setBase({ ...active, browser: true })
  vi.mocked(f.deps.chats.sideBrowser).mockResolvedValue({
    mcp: NO_MCP,
    args: ['--mcp-config', 'side-browser'],
    prompt: 'Browser',
    env: { CAP: 'side' },
    dispose
  })
  await f.service.ask('chat', 'Status?', 'q')
  await started(f)
  expect(f.runs[0].options.args).toContain('side-browser')
  expect(f.runs[0].options.env).toEqual({ CAP: 'side' })
  if (mode === 'stop') f.service.stop('chat', 'q')
  else if (mode === 'timeout') await vi.advanceTimersByTimeAsync(180_000)
  else f.runs[0].finish(mode === 'error' ? { result: null, stderr: 'Oops' } : {})
  await finished(f)
  expect(dispose).toHaveBeenCalledOnce()
  if (mode === 'timeout') expect(f.saved[0]).toMatchObject({ state: 'error', error: 'Took too long' })
})

test.each(['success', 'stop'])('owns and disposes a desktop next to the browser on %s', async (mode) => {
  const f = fixture(),
    disposeBrowser = vi.fn(async () => {}),
    disposeDesktop = vi.fn(async () => {})
  f.setBase({ ...active, browser: true, desktop: true })
  vi.mocked(f.deps.chats.sideBrowser).mockResolvedValue({
    mcp: NO_MCP,
    args: ['--mcp-config', 'side-browser'],
    prompt: 'Browser',
    env: { CAP: 'side' },
    dispose: disposeBrowser
  })
  vi.mocked(f.deps.chats.sideDesktop).mockResolvedValue({
    mcp: NO_MCP,
    args: ['--mcp-config', 'side-desktop'],
    prompt: 'Desktop',
    env: { DESK: 'side' },
    dispose: disposeDesktop
  })
  await f.service.ask('chat', 'Status?', 'q')
  await started(f)
  expect(vi.mocked(f.deps.chats.sideDesktop)).toHaveBeenCalledWith('chat', 'helper')
  const args = f.runs[0].options.args
  expect(args.indexOf('side-desktop')).toBeGreaterThan(args.indexOf('side-browser'))
  expect(args.filter((a) => a === '--settings')).toHaveLength(1)
  expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('House and memory\n\nBrowser\n\nDesktop')
  expect(f.runs[0].options.env).toEqual({ CAP: 'side', DESK: 'side' })
  if (mode === 'stop') f.service.stop('chat', 'q')
  else f.runs[0].finish()
  await finished(f)
  expect(disposeBrowser).toHaveBeenCalledOnce()
  expect(disposeDesktop).toHaveBeenCalledOnce()
})

test('a base without a desktop never asks for one', async () => {
  const f = fixture()
  await f.service.ask('chat', 'Status?', 'q')
  await started(f)
  expect(vi.mocked(f.deps.chats.sideDesktop)).not.toHaveBeenCalled()
  f.runs[0].finish()
  await finished(f)
})

test.each(['stop', 'delete'])('does not spawn after %s during browser preparation', async (mode) => {
  const f = fixture(),
    gate = deferred<BrowserTurn | null>(),
    dispose = vi.fn(async () => {})
  f.setBase({ ...active, browser: true })
  vi.mocked(f.deps.chats.sideBrowser).mockImplementation(() => gate.promise)
  await f.service.ask('chat', 'Status?', 'q')
  await until(() => vi.mocked(f.deps.chats.sideBrowser).mock.calls.length === 1)
  if (mode === 'delete') {
    f.service.stopChat('chat')
    f.remove()
  } else f.service.stop('chat', 'q')
  gate.resolve({ mcp: NO_MCP, args: [], env: {}, prompt: '', dispose })
  await finished(f)
  expect(f.runs).toHaveLength(0)
  expect(dispose).toHaveBeenCalledOnce()
})

test('stopChat cancels an ask still loading its items', async () => {
  const f = fixture(),
    gate = deferred<ChatItem[]>()
  f.store.loadItems.mockImplementation(() => gate.promise)
  const ask = f.service.ask('chat', 'Status?', 'q')
  await until(() => f.store.loadItems.mock.calls.length === 1)
  f.service.stopChat('chat')
  gate.resolve([old])
  await expect(ask).rejects.toThrow()
  expect(f.runs).toHaveLength(0)
  expect(f.saved).toHaveLength(0)
})

test('stop during picking aborts the picker and never spawns', async () => {
  const f = fixture(true),
    gate = deferred<string | null>()
  vi.mocked(f.deps.pick).mockImplementation(() => gate.promise)
  await f.service.ask('chat', 'Status?', 'q')
  await until(() => vi.mocked(f.deps.pick).mock.calls.length === 1)
  f.service.stop('chat', 'q')
  gate.resolve('writer')
  await finished(f)
  expect(vi.mocked(f.deps.pick).mock.calls[0][2].aborted).toBe(true)
  expect(f.runs).toHaveLength(0)
  expect(f.saved[0].state).toBe('stopped')
})

test.each(['No conversation found with session ID gone', 'generic failure', 'fork ignored'])(
  'missing-session fallback classification: %s',
  async (error) => {
    const f = fixture()
    await f.service.ask('chat', 'Status?', 'q')
    await started(f)
    if (error === 'fork ignored') f.runs[0].emit({ kind: 'init', sessionId: 'live-session', version: '2.1.317' })
    else f.runs[0].finish({ result: null, stderr: error, exitCode: 1 })
    if (error.startsWith('No conversation')) {
      await started(f, 2)
      expect(f.runs[1].options.args).not.toContain('--resume')
      expect(f.runs[1].options.args).not.toContain('--fork-session')
      expect(f.runs[1].options.args).toContain('--settings')
      expect(f.runs[1].options.stdin).toContain('Main history')
      f.runs[1].finish({ result: null, stderr: error, exitCode: 1 })
      await finished(f)
      expect(f.runs).toHaveLength(2)
    } else {
      await finished(f)
      expect(f.runs).toHaveLength(1)
    }
    expect(f.saved[0].state).toBe('error')
  }
)

test('a rejected initial save refuses the ask and releases its reservation', async () => {
  const f = fixture()
  f.store.saveSide.mockRejectedValueOnce(new Error('Disk unavailable'))
  await expect(f.service.ask('chat', 'Status?', 'q')).rejects.toThrow('Disk unavailable')
  expect(f.runs).toHaveLength(0)
  expect(f.service.runningCount()).toBe(0)
  expect(await f.service.list('chat')).toEqual([])
})

test('a streaming save failure is handled and the final answer is flushed', async () => {
  const f = fixture()
  await f.service.ask('chat', 'Status?', 'q')
  await started(f)
  f.store.saveSide.mockRejectedValueOnce(new Error('Transient write failure'))
  f.runs[0].emit({ kind: 'textDelta', text: 'Answer' })
  await Promise.resolve()
  await Promise.resolve()
  f.runs[0].finish()
  await finished(f)
  expect(f.saved[0]).toMatchObject({ state: 'done', answer: 'Answer' })
})

test('a final save failure is retained for shutdown to retry without an unhandled rejection', async () => {
  const f = fixture()
  await f.service.ask('chat', 'Status?', 'q')
  await started(f)
  f.store.saveSide.mockRejectedValueOnce(new Error('Transient final write failure'))
  f.runs[0].finish()
  await finished(f)
  await f.service.stopAll()
  expect(f.saved[0].state).toBe('done')
})

test('seeded room answers include unseen live room progress', async () => {
  const f = fixture(true)
  f.setBase({ ...active, live: null, start: null })
  await f.service.ask('chat', '@helper Status?', 'q')
  await started(f)
  expect(f.runs[0].options.stdin).toContain('Room progress')
})

test('a missing-session fallback shares the answer timeout and owns a new browser turn', async () => {
  vi.useFakeTimers()
  const f = fixture(),
    disposeFirst = vi.fn(async () => {}),
    disposeSecond = vi.fn(async () => {})
  f.setBase({ ...active, browser: true })
  vi.mocked(f.deps.chats.sideBrowser)
    .mockResolvedValueOnce({ mcp: NO_MCP, args: [], env: { CAP: 'first' }, prompt: '', dispose: disposeFirst })
    .mockResolvedValueOnce({ mcp: NO_MCP, args: [], env: { CAP: 'second' }, prompt: '', dispose: disposeSecond })
  await f.service.ask('chat', 'Status?', 'q')
  await started(f)
  await vi.advanceTimersByTimeAsync(179_000)
  f.time(179_100)
  f.runs[0].finish({ result: null, stderr: 'No conversation found with session ID gone' })
  await started(f, 2)
  expect(disposeFirst).toHaveBeenCalledOnce()
  expect(f.runs[1].options.env).toEqual({ CAP: 'second' })
  await vi.advanceTimersByTimeAsync(1000)
  await finished(f)
  expect(f.saved[0]).toMatchObject({ state: 'error', error: 'Took too long' })
  expect(disposeSecond).toHaveBeenCalledOnce()
})

test('shutdown reports a persistent write failure while list keeps the answer available', async () => {
  const f = fixture()
  await f.service.ask('chat', 'Status?', 'q')
  await started(f)
  f.store.saveSide.mockRejectedValue(new Error('Disk unavailable'))
  f.runs[0].finish()
  await finished(f)
  await expect(f.service.stopAll()).rejects.toThrow('Disk unavailable')
  f.store.saveSide.mockImplementation(async (_id, entries) => {
    f.saved = structuredClone(entries)
  })
  expect((await f.service.list('chat'))[0].state).toBe('done')
})

test('rename while the picker awaits keeps the picked member current', async () => {
  const f = fixture(true),
    gate = deferred<string | null>()
  vi.mocked(f.deps.pick).mockImplementation(() => gate.promise)
  await f.service.ask('chat', 'Status?', 'q')
  await until(() => vi.mocked(f.deps.pick).mock.calls.length === 1)
  f.service.renameAgent('writer', 'author')
  gate.resolve('writer')
  await started(f)
  expect(f.runs[0].options.args).toContain('author')
  expect(f.saved[0].agent).toBe('author')
})

test('stopping during the initial save persists a stopped entry without spawning', async () => {
  const f = fixture(),
    gate = deferred<void>()
  f.store.saveSide.mockImplementationOnce(() => gate.promise)
  const ask = f.service.ask('chat', 'Status?', 'q')
  await until(() => f.store.saveSide.mock.calls.length === 1)
  f.service.stopChat('chat')
  gate.resolve()
  await ask
  await finished(f)
  expect(f.runs).toHaveLength(0)
  expect(f.saved[0].state).toBe('stopped')
})

test('a failing in-flight stream save cannot swallow the final flush', async () => {
  const f = fixture(),
    gate = deferred<void>()
  await f.service.ask('chat', 'Status?', 'q')
  await started(f)
  // The root's snapshot is saved before any text; the gate holds the stream's save after it.
  await until(() => f.saved[0]?.snapshot !== undefined)
  const saves = f.store.saveSide.mock.calls.length,
    broadcasts = vi.mocked(f.deps.broadcast).mock.calls.length
  f.store.saveSide.mockImplementationOnce(() => gate.promise)
  f.runs[0].emit({ kind: 'textDelta', text: 'Complete answer' })
  await until(() => f.store.saveSide.mock.calls.length === saves + 1)
  f.runs[0].finish()
  await until(() => vi.mocked(f.deps.broadcast).mock.calls.length === broadcasts)
  gate.reject(new Error('Transient stream write failure'))
  await finished(f)
  expect(f.saved[0]).toMatchObject({ state: 'done', answer: 'Complete answer' })
})

test('rename during the final existence check rebuilds browser ownership before spawning', async () => {
  const f = fixture(),
    gate = deferred<ChatMeta | null>()
  f.setBase({ ...active, browser: true })
  const owners: string[] = [],
    dispose = vi.fn(async () => {})
  vi.mocked(f.deps.chats.sideBrowser).mockImplementation(async (_id, agent) => {
    owners.push(agent)
    return { mcp: NO_MCP, args: [], env: { OWNER: agent }, prompt: '', dispose }
  })
  f.store.get.mockImplementationOnce(async () => structuredClone(f.meta)).mockImplementationOnce(() => gate.promise)
  await f.service.ask('chat', 'Status?', 'q')
  await until(() => f.store.get.mock.calls.length === 2)
  f.service.renameAgent('helper', 'aide')
  f.meta.agentName = 'aide'
  gate.resolve(structuredClone(f.meta))
  await started(f)
  expect(f.runs[0].options.args).toContain('aide')
  expect(f.runs[0].options.env).toEqual({ OWNER: 'aide' })
  expect(owners).toEqual(['helper', 'aide'])
  expect(dispose).toHaveBeenCalledTimes(1)
})

test('stop while base preparation awaits never starts the process', async () => {
  const f = fixture(),
    gate = deferred<SideBase | null>()
  f.setBase(null)
  vi.mocked(f.deps.baseFor).mockImplementation(() => gate.promise)
  await f.service.ask('chat', 'Status?', 'q')
  await until(() => vi.mocked(f.deps.baseFor).mock.calls.length === 1)
  f.service.stop('chat', 'q')
  gate.resolve(structuredClone(active))
  await finished(f)
  expect(f.runs).toHaveLength(0)
  expect(f.saved[0].state).toBe('stopped')
})

test('stopAll waits for base preparation the stop cut off', async () => {
  const f = fixture(),
    gate = deferred<SideBase | null>()
  f.setBase(null)
  vi.mocked(f.deps.baseFor).mockImplementation(() => gate.promise)
  await f.service.ask('chat', 'Status?', 'q')
  await until(() => vi.mocked(f.deps.baseFor).mock.calls.length === 1)
  let done = false
  const stopping = f.service.stopAll().then(() => {
    done = true
  })
  await finished(f)
  for (let n = 0; n < 20; n++) await Promise.resolve()
  expect(done).toBe(false)
  gate.resolve(structuredClone(active))
  await stopping
  expect(f.runs).toHaveLength(0)
  expect(f.saved[0].state).toBe('stopped')
})

test('stopAll waits for a browser turn the stop cut off to be disposed', async () => {
  const f = fixture(),
    gate = deferred<BrowserTurn | null>(),
    disposed = deferred<void>(),
    dispose = vi.fn(() => disposed.promise)
  f.setBase({ ...active, browser: true })
  vi.mocked(f.deps.chats.sideBrowser).mockImplementation(() => gate.promise)
  await f.service.ask('chat', 'Status?', 'q')
  await until(() => vi.mocked(f.deps.chats.sideBrowser).mock.calls.length === 1)
  let done = false
  const stopping = f.service.stopAll().then(() => {
    done = true
  })
  await finished(f)
  gate.resolve({ mcp: NO_MCP, args: [], env: {}, prompt: '', dispose })
  await until(() => dispose.mock.calls.length === 1)
  for (let n = 0; n < 20; n++) await Promise.resolve()
  expect(done).toBe(false)
  disposed.resolve()
  await stopping
  expect(f.runs).toHaveLength(0)
})

test('again on a stopped entry enforces the same open limit', async () => {
  const f = fixture()
  await f.service.ask('chat', 'Status?', 'q')
  await started(f)
  f.service.stop('chat', 'q')
  await finished(f)
  for (const id of ['1', '2', '3']) await f.service.ask('chat', 'Status?', id)
  await expect(f.service.again('chat', 'q')).rejects.toThrow('3 side questions are already running in this chat')
  await f.service.stopAll()
  const retry = await f.service.again('chat', 'q')
  expect(retry).toMatchObject({ id: 'q', after: 'a', askedAt: 100, state: 'running', answer: '' })
})

test('the fresh missing-session fallback follows a rename during the first attempt', async () => {
  const f = fixture()
  await f.service.ask('chat', 'Status?', 'q')
  await started(f)
  f.service.renameAgent('helper', 'aide')
  f.runs[0].finish({ result: null, stderr: 'No conversation found with session ID gone' })
  await started(f, 2)
  expect(f.runs[1].options.args).toContain('aide')
  expect(f.runs[1].options.args).not.toContain('helper')
})

test.each(['single', 'mention', 'picker', 'fallback'])('a reused agent name stays current for a new %s ask', async (mode) => {
  const f = fixture(mode !== 'single')
  f.service.renameAgent('helper', 'aide')
  // Current metadata names a new helper created after the original helper was renamed.
  if (mode === 'picker') vi.mocked(f.deps.pick).mockResolvedValue('helper')
  if (mode === 'fallback') {
    vi.mocked(f.deps.pick).mockResolvedValue(null)
    vi.mocked(f.deps.groups.pickInput).mockResolvedValue({
      question: 'Status?',
      members: [{ name: 'helper', description: '' }],
      working: ['helper'],
      messages: []
    })
  }
  await f.service.ask('chat', mode === 'mention' ? '@helper Status?' : 'Status?', 'q')
  await started(f)
  const args = f.runs[0].options.args
  expect(args[args.indexOf('--agent') + 1]).toBe('helper')
  expect(f.saved[0].agent).toBe('helper')
  expect(f.meta.group?.members ?? [f.meta.agentName]).toContain(f.saved[0].agent)
})

test('loading entries created after name reuse does not replay an older rename', async () => {
  const f = fixture()
  f.service.renameAgent('helper', 'aide')
  f.saved = [{ ...open('q'), state: 'done', endedAt: 2 }]
  expect((await f.service.list('chat'))[0].agent).toBe('helper')
  expect(f.store.saveSide).not.toHaveBeenCalled()
})

test('again uses the current single-chat identity after name reuse', async () => {
  const f = fixture()
  f.service.renameAgent('helper', 'aide')
  f.saved = [{ ...open('q'), state: 'stopped', endedAt: 2 }]
  await f.service.again('chat', 'q')
  await started(f)
  const args = f.runs[0].options.args
  expect(args[args.indexOf('--agent') + 1]).toBe('helper')
})

test('an ask follows only renames made while its metadata is pending', async () => {
  const f = fixture(),
    gate = deferred<ChatMeta | null>()
  f.service.renameAgent('helper', 'aide')
  f.store.get.mockImplementationOnce(() => gate.promise)
  const ask = f.service.ask('chat', 'Status?', 'q')
  await until(() => f.store.get.mock.calls.length === 1)
  f.service.renameAgent('helper', 'new-helper')
  gate.resolve(structuredClone(f.meta))
  await ask
  await started(f)
  const args = f.runs[0].options.args
  expect(args[args.indexOf('--agent') + 1]).toBe('new-helper')
})

test('an in-flight load follows renames without replaying older identities', async () => {
  const f = fixture(),
    gate = deferred<SideQuestion[]>()
  f.service.renameAgent('helper', 'aide')
  f.store.loadSide.mockImplementationOnce(() => gate.promise)
  const list = f.service.list('chat')
  await until(() => f.store.loadSide.mock.calls.length === 1)
  f.service.renameAgent('helper', 'new-helper')
  gate.resolve([{ ...open('q'), state: 'done', endedAt: 2 }])
  expect((await list)[0].agent).toBe('new-helper')
})

const never = () => new AbortController().signal
// Fake timers and the fixture's clock move together, as the side deadline reads both.
function clock(f: ReturnType<typeof fixture>) {
  let t = 100
  return async (ms: number) => {
    t += ms
    f.time(t)
    await vi.advanceTimersByTimeAsync(ms)
  }
}
const settingsOf = (args: string[]) => args[args.indexOf('--settings') + 1]

test('askFrom stores from and resolves with the answer', async () => {
  const f = fixture()
  f.addChat('ab', 'coder')
  const asked = f.service.askFrom('ab', { question: 'What padding?', from: 'helper', link: null, signal: never() })
  await started(f)
  const { args, stdin } = f.runs[0].options
  expect(args[args.indexOf('--agent') + 1]).toBe('coder')
  expect(stdin).toContain(askedSideNote('helper'))
  expect(stdin).not.toContain(SIDE_NOTE)
  expect(stdin).toContain('<btw>What padding?</btw>')
  f.runs[0].emit({ kind: 'textDelta', text: '12px' })
  f.time(200)
  f.runs[0].finish()
  const entry = await asked
  expect(entry).toMatchObject({ question: 'What padding?', from: 'helper', agent: 'coder', state: 'done', answer: '12px', endedAt: 200 })
  await finished(f)
  expect(f.sideOf('ab').map(publicEntry)).toEqual([entry])
  expect(f.saved).toEqual([])
})

test('askFrom rejects only what ask would', async () => {
  const f = fixture()
  f.addChat('ab', 'coder')
  await expect(f.service.askFrom('gone', { question: 'Q?', from: 'helper', link: null, signal: never() })).rejects.toThrow('Chat not found')
  for (const id of ['1', '2', '3']) await f.service.ask('ab', 'Status?', id)
  await expect(f.service.askFrom('ab', { question: 'Q?', from: 'helper', link: null, signal: never() })).rejects.toThrow(
    '3 side questions are already running in this chat'
  )
})

test("askFrom links and updates the asker's entry", async () => {
  const f = fixture()
  f.addChat('ab', 'coder')
  await f.service.ask('chat', 'How is coder doing?', 'qa')
  await started(f)
  const asked = f.service.askFrom('ab', { question: 'Padding?', from: 'helper', link: { chatId: 'chat', entryId: 'qa' }, signal: never() })
  await started(f, 2)
  await until(() => f.saved[0]?.asks?.[0]?.state === 'running')
  const link = { agent: 'coder', chatId: 'ab', entryId: f.sideOf('ab')[0].id, state: 'running' }
  expect(f.saved[0].asks).toEqual([link])
  expect(f.deps.broadcast).toHaveBeenCalledWith('chat', expect.objectContaining({ id: 'qa', asks: [link] }))
  f.runs[1].finish()
  expect((await asked).state).toBe('done')
  await until(() => f.saved[0]?.asks?.[0]?.state === 'done')
  expect(f.saved[0].asks).toEqual([{ ...link, state: 'done' }])
  expect(f.deps.broadcast).toHaveBeenCalledWith('chat', expect.objectContaining({ id: 'qa', asks: [{ ...link, state: 'done' }] }))
  // The asker's own entry is untouched otherwise.
  expect(f.saved[0].state).toBe('running')
})

test('askFrom with a link to an entry that is gone still answers', async () => {
  const f = fixture()
  f.addChat('ab', 'coder')
  const asked = f.service.askFrom('ab', {
    question: 'Padding?',
    from: 'helper',
    link: { chatId: 'chat', entryId: 'gone' },
    signal: never()
  })
  await started(f)
  f.runs[0].finish()
  expect((await asked).state).toBe('done')
  expect(f.saved).toEqual([])
})

test('askFrom stops on signal', async () => {
  const f = fixture()
  f.addChat('ab', 'coder')
  const call = new AbortController()
  const asked = f.service.askFrom('ab', { question: 'Padding?', from: 'helper', link: null, signal: call.signal })
  await started(f)
  f.runs[0].emit({ kind: 'textDelta', text: 'Part' })
  call.abort()
  expect(await asked).toMatchObject({ state: 'stopped', answer: 'Part' })
  expect(f.runs[0].stop).toHaveBeenCalledOnce()
})

test('askFrom resolves stopped when the user stops its entry', async () => {
  const f = fixture()
  f.addChat('ab', 'coder')
  await f.service.ask('chat', 'How is coder doing?', 'qa')
  await started(f)
  const asked = f.service.askFrom('ab', { question: 'Padding?', from: 'helper', link: { chatId: 'chat', entryId: 'qa' }, signal: never() })
  await started(f, 2)
  f.service.stop('ab', f.sideOf('ab')[0].id)
  expect((await asked).state).toBe('stopped')
  await until(() => f.saved[0]?.asks?.[0]?.state === 'stopped')
})

test("askFrom pauses the asker's clock", async () => {
  vi.useFakeTimers()
  const f = fixture(),
    advance = clock(f)
  f.addChat('ab', 'coder')
  await f.service.ask('chat', 'How is coder doing?', 'qa')
  await started(f)
  await advance(170_000)
  const asked = f.service.askFrom('ab', { question: 'Padding?', from: 'helper', link: { chatId: 'chat', entryId: 'qa' }, signal: never() })
  await started(f, 2)
  // Past the asker's own 3 minutes in wall time, but only 170 s of them count.
  await advance(100_000)
  expect(f.saved[0].state).toBe('running')
  expect(f.sideOf('ab')[0].state).toBe('running')
  f.runs[1].finish()
  expect((await asked).state).toBe('done')
  await advance(9_000)
  expect(f.saved[0].state).toBe('running')
  await advance(1_000)
  await until(() => f.saved[0]?.state === 'error')
  expect(f.saved[0].error).toBe('Took too long')
})

test("a slow asked agent times out on its own clock, not the asker's", async () => {
  vi.useFakeTimers()
  const f = fixture(),
    advance = clock(f)
  f.addChat('ab', 'coder')
  await f.service.ask('chat', 'How is coder doing?', 'qa')
  await started(f)
  await advance(170_000)
  const asked = f.service.askFrom('ab', { question: 'Padding?', from: 'helper', link: { chatId: 'chat', entryId: 'qa' }, signal: never() })
  await started(f, 2)
  await advance(180_000)
  expect(await asked).toMatchObject({ state: 'error', error: 'Took too long' })
  expect(f.saved[0].state).toBe('running')
  await until(() => f.saved[0]?.asks?.[0]?.state === 'error')
})

test('again refuses an entry with from', async () => {
  const f = fixture()
  f.addChat('ab', 'coder')
  const asked = f.service.askFrom('ab', { question: 'Padding?', from: 'helper', link: null, signal: never() })
  await started(f)
  f.runs[0].finish({ result: null, stderr: 'Oops', exitCode: 1 })
  const entry = await asked
  await finished(f)
  expect(entry.state).toBe('error')
  await expect(f.service.again('ab', entry.id)).rejects.toThrow()
  expect(f.runs).toHaveLength(1)
})

test("again clears asks on the asker's entry", async () => {
  const f = fixture()
  f.addChat('ab', 'coder')
  await f.service.ask('chat', 'How is coder doing?', 'qa')
  await started(f)
  const asked = f.service.askFrom('ab', { question: 'Padding?', from: 'helper', link: { chatId: 'chat', entryId: 'qa' }, signal: never() })
  await started(f, 2)
  f.runs[1].finish()
  await asked
  f.runs[0].finish({ result: null, stderr: 'Oops', exitCode: 1 })
  await finished(f)
  expect(f.saved[0].asks).toHaveLength(1)
  const again = await f.service.again('chat', 'qa')
  expect(again).not.toHaveProperty('asks')
  expect(f.saved[0]).not.toHaveProperty('asks')
  await started(f, 3)
})

test('load marks open links error', async () => {
  const f = fixture()
  const link = { agent: 'coder', chatId: 'ab', entryId: 'b1' }
  f.saved = [
    {
      ...open('qa'),
      state: 'done',
      endedAt: 2,
      asks: [
        { ...link, state: 'running' },
        { ...link, entryId: 'b0', state: 'done' }
      ]
    }
  ]
  const [entry] = await f.service.list('chat')
  expect(entry.asks).toEqual([
    { ...link, state: 'error' },
    { ...link, entryId: 'b0', state: 'done' }
  ])
  expect(f.saved[0].asks![0].state).toBe('error')
})

test('rename moves from and asks agent', async () => {
  const f = fixture(),
    gate = deferred<SideQuestion[]>()
  f.store.loadSide.mockImplementationOnce(() => gate.promise)
  const list = f.service.list('chat')
  await until(() => f.store.loadSide.mock.calls.length === 1)
  // Renames made while the file loads reach both fields.
  f.service.renameAgent('coder', 'writer')
  f.service.renameAgent('boss', 'chief')
  gate.resolve([
    { ...open('from'), agent: 'helper', from: 'boss', state: 'done', endedAt: 2 },
    { ...open('link'), state: 'done', endedAt: 2, asks: [{ agent: 'coder', chatId: 'ab', entryId: 'b1', state: 'done' }] }
  ])
  const loaded = await list
  expect(loaded.find((q) => q.id === 'from')!.from).toBe('chief')
  expect(loaded.find((q) => q.id === 'link')!.asks![0].agent).toBe('writer')
  // And a rename of a loaded room.
  f.service.renameAgent('writer', 'author')
  f.service.renameAgent('chief', 'head')
  await until(() => f.saved.find((q) => q.id === 'link')?.asks?.[0].agent === 'author')
  expect(f.saved.find((q) => q.id === 'from')!.from).toBe('head')
})

test("a user's side question in a chat with the bridge runs asking", async () => {
  const f = fixture()
  f.setBase({ ...active, browser: true, asks: true })
  f.addChat('ab-c', 'coder')
  f.addChat('ab-b', 'builder')
  f.addChat('elsewhere', 'zed', 'other-chat')
  await f.service.ask('chat', 'Status?', 'q')
  await started(f)
  expect(f.deps.chats.sideBrowser).toHaveBeenCalledWith('chat', 'helper', { chatId: 'chat', entryId: 'q' }, true) // the base's own answer, never recomputed
  expect(settingsOf(f.runs[0].options.args)).toBe(SIDE_GUARD_ASKING)
  expect(f.runs[0].options.stdin).toContain(askingSideNote(['builder', 'coder']))
  // An entry from an agent never gets the exception, even where the bridge is.
  const asked = f.service.askFrom('ab-c', { question: 'Padding?', from: 'helper', link: null, signal: never() })
  await started(f, 2)
  expect(settingsOf(f.runs[1].options.args)).toBe(SIDE_GUARD_SETTINGS)
  expect(f.runs[1].options.stdin).toContain(askedSideNote('helper'))
  expect(f.runs[1].options.stdin).not.toContain('side_question')
  f.runs[1].finish()
  await asked
})

test('a side question without the bridge keeps the plain guard and note', async () => {
  const f = fixture()
  f.addChat('ab', 'coder')
  await f.service.ask('chat', 'Status?', 'q')
  await started(f)
  expect(settingsOf(f.runs[0].options.args)).toBe(SIDE_GUARD_SETTINGS)
  expect(f.runs[0].options.stdin).toContain(SIDE_NOTE)
  expect(f.store.list).not.toHaveBeenCalled()
})

// An A→B chat: coder (B) was asked by planner (A) from the chat 'src'; planner's session lives there, not here.
const abItems: ChatItem[] = [
  { type: 'user', id: 'u', text: 'Write the CSV parser', ts: 1, from: 'planner' },
  {
    type: 'tool',
    id: 't',
    name: 'Bash',
    input: { command: 'npm test\nmore' },
    result: 'ok',
    isError: false,
    blocked: false,
    ts: 2,
    turn: 'live'
  },
  { type: 'assistant', id: 'b', text: 'Parser half done', ts: 3, turn: 'live' },
  { type: 'notice', id: 'n', kind: 'stopped', text: 'Stopped', ts: 4 },
  { type: 'assistant', id: 'e', text: 'Coder history', ts: 5, end: { session: 'coder-session', at: 'coder-at' } }
]
function askedFixture() {
  const chat = (id: string, agentName: string, sessionId: string): ChatMeta => ({
    id,
    agentName,
    sessionId,
    cwd: '/work',
    title: '',
    createdAt: 0,
    updatedAt: 0,
    inFlight: false
  })
  const metas: Record<string, ChatMeta> = {
    ab: { ...chat('ab', 'coder', 'coder-session'), asked: { by: 'planner', from: 'src', fromTitle: 'Import', chain: [] } },
    src: chat('src', 'planner', 'planner-session')
  }
  const items: Record<string, ChatItem[]> = {
    ab: structuredClone(abItems),
    src: [{ type: 'assistant', id: 'p', text: 'Plan history', ts: 1, end: { session: 'planner-session', at: 'planner-at' } }]
  }
  const bases: Record<string, SideBase> = {}
  const saved: Record<string, StoredSide[]> = {}
  const runs: FakeRun[] = []
  const store = {
    get: vi.fn(async (id: string) => structuredClone(metas[id] ?? null)),
    loadItems: vi.fn(async (id: string) => structuredClone(items[id] ?? [])),
    list: vi.fn(async () => structuredClone(Object.values(metas))),
    loadSide: vi.fn(async (id: string) => structuredClone(saved[id] ?? [])),
    saveSide: vi.fn(async (id: string, entries: StoredSide[]) => {
      saved[id] = structuredClone(entries)
    })
  }
  const deps: SideQuestionsDeps = {
    store,
    chats: {
      sideBase: (id, agent) => structuredClone(bases[`${id}\n${agent}`] ?? null),
      refreshSideBase: async (_agent, kept) => kept,
      sideBrowser: vi.fn(async () => null),
      sideDesktop: vi.fn(async () => null)
    },
    groups: {
      refuseCodex: vi.fn(async () => {}),
      sideThread: vi.fn(async () => []),
      pickInput: vi.fn(async () => {
        throw new Error('Not a room')
      })
    },
    pick: vi.fn(async () => null),
    // A browser base, so the tests see which chat the side browser is made for.
    baseFor: vi.fn(async (_id, agent) => ({
      ...structuredClone(active),
      active: false,
      live: null,
      start: null,
      browser: true,
      args: { ...active.args, agentName: agent }
    })),
    run: fakeRun(runs),
    broadcast: vi.fn(),
    recordCost: vi.fn(),
    now: () => 100
  }
  const service = new SideQuestions(deps)
  const f = {
    service,
    deps,
    store,
    runs,
    metas,
    items,
    bases,
    remove: (id: string) => {
      delete metas[id]
    }
  }
  fixtures.push(f)
  return f
}

test('an A→B chat with no mention answers as the asked agent from its own chat', async () => {
  const f = askedFixture()
  expect(await f.service.ask('ab', 'Where are you at?', 'q')).toMatchObject({ agent: 'coder' })
  expect((await f.service.list('ab'))[0].mention).toBeUndefined()
  await started(f)
  expect(f.deps.baseFor).toHaveBeenCalledWith('ab', 'coder')
  expect(f.runs[0].options.args).toEqual(expect.arrayContaining(['--resume', 'coder-session', '--resume-session-at', 'coder-at']))
  expect(f.runs[0].options.stdin).not.toContain('These are the messages')
})

test('a typed @ of the asked agent is the same entry as no mention', async () => {
  const f = askedFixture()
  const entry = await f.service.ask('ab', '@coder Where are you at?', 'q')
  expect(entry).toMatchObject({ agent: 'coder', question: 'Where are you at?' })
  expect(entry.mention).toBeUndefined()
})

test('@asker answers as the asker from the source chat with the A→B snapshot', async () => {
  const f = askedFixture()
  expect(await f.service.ask('ab', '@planner How is coder doing?', 'q')).toMatchObject({ agent: 'planner', mention: true })
  await started(f)
  expect(f.deps.baseFor).toHaveBeenCalledWith('src', 'planner')
  expect(f.deps.chats.sideBrowser).toHaveBeenCalledWith('src', 'planner', { chatId: 'ab', entryId: 'q' }, false)
  expect(f.runs[0].options.args).toEqual(expect.arrayContaining(['--resume', 'planner-session', '--resume-session-at', 'planner-at']))
  const stdin = f.runs[0].options.stdin
  expect(stdin).toContain(askedLead('coder', false))
  expect(stdin).toContain('Parser half done')
  expect(stdin).toContain('Used Bash(npm test)')
  expect(stdin).toContain('<btw>How is coder doing?</btw>')
  expect((await f.service.list('ab'))[0].agent).toBe('planner')
  // Stored, broadcast and costed under the A→B chat, as the asker.
  f.runs[0].emit({ ...result, cost: { totalUsd: 0.1, models: {} } })
  f.runs[0].finish()
  await finished(f)
  expect(f.deps.recordCost).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'ab', agent: 'planner' }))
  expect(f.deps.broadcast).toHaveBeenLastCalledWith('ab', expect.objectContaining({ id: 'q', state: 'done' }))
  expect(f.store.saveSide).not.toHaveBeenCalledWith('src', expect.anything())
})

test('the asker forks at its waiting run’s clean point in the source chat', async () => {
  const f = askedFixture()
  f.bases['src\nplanner'] = {
    ...structuredClone(active),
    args: { ...active.args, agentName: 'planner' },
    live: { session: 'planner-live', at: 'before-ask' }
  }
  await f.service.ask('ab', '@planner Status?', 'q')
  await started(f)
  expect(f.deps.baseFor).not.toHaveBeenCalled()
  expect(f.runs[0].options.args).toEqual(expect.arrayContaining(['--resume', 'planner-live', '--resume-session-at', 'before-ask']))
})

test('the asker seeds from the source chat’s items when it has no point', async () => {
  const f = askedFixture()
  f.items.src = [{ type: 'user', id: 'p', text: 'Plan the import', ts: 1 }]
  await f.service.ask('ab', '@planner Status?', 'q')
  await started(f)
  const { args, stdin } = f.runs[0].options
  expect(args).not.toContain('--resume')
  expect(stdin).toContain('Plan the import')
  expect(stdin).toContain(askedLead('coder', false))
  expect(stdin).toContain('Parser half done')
})

test('a deleted source chat fails the asker entry with no run', async () => {
  const f = askedFixture()
  f.remove('src')
  await f.service.ask('ab', '@planner status?', 'q')
  await finished(f)
  expect(f.runs).toHaveLength(0)
  expect(f.deps.baseFor).not.toHaveBeenCalled()
  expect(f.deps.chats.sideBrowser).not.toHaveBeenCalled()
  expect((await f.service.list('ab'))[0]).toMatchObject({ state: 'error', error: 'The chat @planner asked from was deleted' })
})

test('an A→B chat refuses a mention of anyone else', async () => {
  await expect(askedFixture().service.ask('ab', '@writer hi', 'q')).rejects.toThrow('Writer is not in this chat')
})

test('the source chat may itself be an A→B chat', async () => {
  const f = askedFixture()
  f.metas.src.asked = { by: 'lead', from: 'top', fromTitle: 'Top', chain: [] }
  await f.service.ask('ab', '@planner Status?', 'q')
  await started(f)
  expect(f.deps.baseFor).toHaveBeenCalledWith('src', 'planner')
  expect(vi.mocked(f.deps.baseFor).mock.calls.some(([id]) => id === 'top')).toBe(false)
  expect(f.store.get).not.toHaveBeenCalledWith('top')
  expect(f.runs[0].options.args).toEqual(expect.arrayContaining(['--resume', 'planner-session', '--resume-session-at', 'planner-at']))
})

test('Ask again keeps the asker, after a rename too, and fails once the source is gone', async () => {
  const f = askedFixture()
  await f.service.ask('ab', '@planner Status?', 'q')
  await started(f)
  f.runs[0].finish({ exitCode: 1, result: null })
  await finished(f)
  expect((await f.service.list('ab'))[0].state).toBe('error')
  f.service.renameAgent('planner', 'boss')
  f.metas.ab.asked!.by = 'boss'
  f.metas.src.agentName = 'boss'
  expect(await f.service.again('ab', 'q')).toMatchObject({ agent: 'boss', mention: true, state: 'running' })
  await started(f, 2)
  expect(f.deps.baseFor).toHaveBeenLastCalledWith('src', 'boss')
  const args = f.runs[1].options.args
  expect(args[args.indexOf('--agent') + 1]).toBe('boss')
  f.runs[1].finish({ exitCode: 1, result: null })
  await finished(f)
  f.remove('src')
  await f.service.again('ab', 'q')
  await finished(f)
  expect(f.runs).toHaveLength(2)
  expect((await f.service.list('ab'))[0]).toMatchObject({ state: 'error', error: sourceGoneText('boss') })
})

test('Ask again refuses an asker entry once the chat names another asker', async () => {
  const f = askedFixture()
  await f.service.ask('ab', '@planner Status?', 'q')
  await started(f)
  f.runs[0].finish({ exitCode: 1, result: null })
  await finished(f)
  f.metas.ab.asked!.by = 'lead'
  await expect(f.service.again('ab', 'q')).rejects.toThrow('Planner is not in this chat')
  expect(f.runs).toHaveLength(1)
})

test("a user's question to the asker in an A→B chat may side-question, linked to its entry here", async () => {
  const f = askedFixture()
  f.bases['src\nplanner'] = { ...structuredClone(active), browser: true, asks: true, args: { ...active.args, agentName: 'planner' } }
  await f.service.ask('ab', '@planner How is coder doing?', 'q')
  await started(f)
  // The session's chat owns the side ask, so it finds this A→B chat; the entry it links and pauses lives here.
  expect(f.deps.chats.sideBrowser).toHaveBeenCalledWith('src', 'planner', { chatId: 'ab', entryId: 'q' }, true)
  const { args } = f.runs[0].options,
    stdin = String(f.runs[0].options.stdin)
  expect(settingsOf(args)).toBe(SIDE_GUARD_ASKING)
  expect(stdin).toContain(askingSideNote(['coder']))
  expect(stdin.indexOf(askedLead('coder', false))).toBeLessThan(stdin.indexOf(askingSideNote(['coder'])))
  // Its side ask to coder is an entry of this same chat, linked on the asker's entry.
  const asked = f.service.askFrom('ab', { question: 'Padding?', from: 'planner', link: { chatId: 'ab', entryId: 'q' }, signal: never() })
  await started(f, 2)
  expect(settingsOf(f.runs[1].options.args)).toBe(SIDE_GUARD_SETTINGS)
  const b = (await f.service.list('ab')).find((e) => e.from === 'planner')!
  expect(b).toMatchObject({ agent: 'coder', question: 'Padding?' })
  expect((await f.service.list('ab')).find((e) => e.id === 'q')!.asks).toEqual([
    { agent: 'coder', chatId: 'ab', entryId: b.id, state: 'running' }
  ])
  f.runs[1].finish()
  expect((await asked).state).toBe('done')
  await until(() => f.store.saveSide.mock.calls.some(([, entries]) => entries.find((e) => e.id === 'q')?.asks?.[0]?.state === 'done'))
})

test("a user's question to the asked agent in an A→B chat may side-question whom it asked from there", async () => {
  const f = askedFixture()
  f.metas.bc = { ...f.metas.ab, id: 'bc', agentName: 'tester', asked: { by: 'coder', from: 'ab', fromTitle: '', chain: [] } }
  f.bases['ab\ncoder'] = { ...structuredClone(active), browser: true, asks: true, args: { ...active.args, agentName: 'coder' } }
  await f.service.ask('ab', 'Where are you at?', 'q')
  await started(f)
  expect(f.deps.chats.sideBrowser).toHaveBeenCalledWith('ab', 'coder', { chatId: 'ab', entryId: 'q' }, true)
  expect(settingsOf(f.runs[0].options.args)).toBe(SIDE_GUARD_ASKING)
  expect(f.runs[0].options.stdin).toContain(askingSideNote(['tester']))
  expect(f.runs[0].options.stdin).not.toContain('These are the messages')
})

// Side threads: a follow-up answers from its root's moment, with the thread's earlier pairs.
const pairOf = (question: string, answer: string) => `<btw>${question}</btw>\n<answer>${answer}</answer>`
// Asks 'q' in the single fixture and finishes it with `text`.
async function answeredRoot(f: ReturnType<typeof fixture>, text = 'Three') {
  const n = f.runs.length
  await f.service.ask('chat', 'How far?', 'q')
  await started(f, n + 1)
  f.runs[n].emit({ kind: 'textDelta', text })
  f.runs[n].finish()
  await finished(f)
}

test("a follow-up forks from its root's point after the main run moved on", async () => {
  const f = fixture()
  await answeredRoot(f)
  f.setBase({ ...active, active: false, live: null })
  f.setItems([structuredClone(old), { ...old, id: 'newer', end: { session: 'newer-session', at: 'newer-at' } }])
  await f.service.follow('chat', 'q', 'And now?', 'f')
  await started(f, 2)
  const { args, stdin } = f.runs[1].options
  expect(args).toEqual(expect.arrayContaining(['--resume', 'live-session', '--resume-session-at', 'live-at', '--fork-session']))
  expect(args).not.toContain('newer-at')
  expect(stdin).toBe(`${SIDE_NOTE}\n${FOLLOW_LEAD}\n${pairOf('How far?', 'Three')}\n<btw>And now?</btw>`)
})

test('a follow-up entry copies agent and anchor from its root', async () => {
  const f = fixture()
  await answeredRoot(f)
  f.setItems([structuredClone(old), { ...old, id: 'newer' }])
  f.time(300)
  expect(await f.service.follow('chat', 'q', '  And now?  ', 'f')).toEqual({
    id: 'f',
    question: 'And now?',
    agent: 'helper',
    thread: 'q',
    after: 'a',
    askedAt: 300,
    state: 'running',
    answer: ''
  })
  await started(f, 2)
  // Any open entry holds the whole thread.
  await expect(f.service.follow('chat', 'q', 'Third?', 'g')).rejects.toThrow('Wait for this answer to finish')
  f.runs[1].emit({ kind: 'textDelta', text: 'Four' })
  f.runs[1].finish()
  await finished(f)
  // Any entry of the thread names it: the server resolves its root.
  f.time(400)
  expect(await f.service.follow('chat', 'f', 'Third?', 'g')).toMatchObject({ thread: 'q', after: 'a' })
  await started(f, 3)
  expect(f.runs[2].options.stdin).toContain(`${pairOf('How far?', 'Three')}\n${pairOf('And now?', 'Four')}\n<btw>Third?</btw>`)
})

test('the snapshot never leaves the server', async () => {
  const f = fixture()
  const asked = await f.service.ask('chat', 'How far?', 'q')
  await started(f)
  f.runs[0].emit({ kind: 'textDelta', text: 'Three' })
  f.runs[0].finish()
  await finished(f)
  expect(f.saved[0].snapshot).toEqual({ point: { session: 'live-session', at: 'live-at' }, upTo: 'a', context: '' })
  const followed = await f.service.follow('chat', 'q', 'And now?', 'f')
  await started(f, 2)
  f.runs[1].finish()
  await finished(f)
  expect(f.saved.find((e) => e.id === 'f')).not.toHaveProperty('snapshot')
  const out = [asked, followed, ...(await f.service.list('chat')), ...vi.mocked(f.deps.broadcast).mock.calls.map(([, entry]) => entry)]
  expect(out.length).toBeGreaterThan(4)
  for (const entry of out) expect(entry).not.toHaveProperty('snapshot')
})

test("a seeded root's follow-up reseeds from items through upTo", async () => {
  const f = fixture()
  f.setBase({ ...active, active: false, live: null })
  const first: ChatItem = { type: 'user', id: 'u', text: 'Main history', ts: 1 }
  f.setItems([first])
  await answeredRoot(f)
  expect(f.runs[0].options.args).not.toContain('--resume')
  expect(f.saved[0].snapshot).toEqual({ point: null, upTo: 'u', context: '' })
  // A point exists now, but the root was seeded: so is the follow-up, from what the root saw.
  f.setItems([first, { type: 'assistant', id: 'later', text: 'Later reply', ts: 2, end: { session: 'later-session', at: 'later-at' } }])
  await f.service.follow('chat', 'q', 'And now?', 'f')
  await started(f, 2)
  const { args, stdin } = f.runs[1].options
  expect(args).not.toContain('--resume')
  expect(stdin).toContain('Main history')
  expect(stdin).not.toContain('Later reply')
  expect(stdin).toContain(`${pairOf('How far?', 'Three')}\n<btw>And now?</btw>`)
})

test('a seeded follow-up gets every item once its upTo item is gone, and none for an empty root', async () => {
  const f = fixture()
  f.setBase({ ...active, active: false, live: null })
  f.saved = [
    { ...open('gone'), state: 'done', answer: 'A1', endedAt: 2, snapshot: { point: null, upTo: 'hidden', context: '' } },
    { ...open('empty'), state: 'done', answer: 'A2', endedAt: 2, snapshot: { point: null, upTo: null, context: '' } }
  ]
  f.setItems([{ type: 'user', id: 'u', text: 'Main history', ts: 1 }])
  await f.service.follow('chat', 'gone', 'Next?', 'f1')
  await started(f)
  expect(f.runs[0].options.stdin).toContain('Main history')
  await f.service.follow('chat', 'empty', 'Next?', 'f2')
  await started(f, 2)
  expect(f.runs[1].options.stdin).not.toContain('Main history')
  expect(f.runs[1].options.stdin).toContain(`${pairOf('Old question', 'A2')}\n<btw>Next?</btw>`)
})

test('a missing root session reseeds the follow-up once, through upTo', async () => {
  const f = fixture()
  await answeredRoot(f)
  f.setItems([structuredClone(old), { ...old, id: 'later', text: 'Later history' }])
  await f.service.follow('chat', 'q', 'And now?', 'f')
  await started(f, 2)
  expect(f.runs[1].options.args).toContain('live-at')
  f.runs[1].finish({ result: null, stderr: 'No conversation found with session ID live-session', exitCode: 1 })
  await started(f, 3)
  const { args, stdin } = f.runs[2].options
  expect(args).not.toContain('--resume')
  expect(stdin).toContain('Main history')
  expect(stdin).not.toContain('Later history')
  expect(stdin).toContain(`${pairOf('How far?', 'Three')}\n<btw>And now?</btw>`)
  f.runs[2].finish({ result: null, stderr: 'No conversation found with session ID gone', exitCode: 1 })
  await finished(f)
  expect(f.runs).toHaveLength(3)
  // The follow-up never rewrites its root's snapshot.
  expect(f.saved[0].snapshot?.point).toEqual({ session: 'live-session', at: 'live-at' })
})

test("a root's missing-session reseed records a seeded snapshot", async () => {
  const f = fixture()
  await f.service.ask('chat', 'How far?', 'q')
  await started(f)
  f.runs[0].finish({ result: null, stderr: 'No conversation found with session ID gone', exitCode: 1 })
  await started(f, 2)
  f.runs[1].finish()
  await finished(f)
  expect(f.saved[0].snapshot).toEqual({ point: null, upTo: 'a', context: '' })
})

test('follow refuses with fixed messages and runs nothing', async () => {
  const f = fixture()
  f.saved = [
    { ...open('asked'), from: 'helper', state: 'done', endedAt: 2 },
    { ...open('unpicked'), agent: null, state: 'error', endedAt: 2 }
  ]
  await expect(f.service.follow('chat', 'nope', 'Q?', 'x1')).rejects.toThrow('Side question not found')
  await expect(f.service.follow('chat', 'asked', 'Q?', 'x2')).rejects.toThrow('Asked by @helper; follow-ups are not available')
  await expect(f.service.follow('chat', 'unpicked', 'Q?', 'x3')).rejects.toThrow('Ask this side question again first')
  await f.service.ask('chat', 'How far?', 'q')
  await started(f)
  await expect(f.service.follow('chat', 'q', 'Q?', 'x4')).rejects.toThrow('Wait for this answer to finish')
  f.runs[0].finish()
  await finished(f)
  await expect(f.service.follow('chat', 'q', '   ', 'x5')).rejects.toThrow('A side question cannot be empty')
  for (const id of ['1', '2', '3']) await f.service.ask('chat', 'Other?', id)
  await started(f, 4)
  await expect(f.service.follow('chat', 'q', 'Q?', 'x6')).rejects.toThrow('3 side questions are already running in this chat')
  expect(f.runs).toHaveLength(4)
  expect((await f.service.list('chat')).filter((e) => e.id.startsWith('x'))).toEqual([])
})

test('a root stopped before it saved a snapshot refuses follow-ups and runs nothing', async () => {
  const f = fixture(),
    gate = deferred<SideBase | null>()
  f.setBase(null)
  vi.mocked(f.deps.baseFor).mockImplementation(() => gate.promise)
  await f.service.ask('chat', 'Status?', 'q')
  await until(() => vi.mocked(f.deps.baseFor).mock.calls.length === 1)
  f.service.stop('chat', 'q')
  gate.resolve(structuredClone(active))
  await finished(f)
  expect(f.saved[0].state).toBe('stopped')
  expect(f.saved[0]).not.toHaveProperty('snapshot')
  await expect(f.service.follow('chat', 'q', 'And?', 'f')).rejects.toThrow(SIDE_ASK_FIRST_TEXT)
  expect(f.runs).toHaveLength(0)
  expect((await f.service.list('chat')).map((e) => e.id)).toEqual(['q'])
})

test("a root's snapshot is saved before its first text, so a stopped root still takes follow-ups", async () => {
  const f = fixture()
  await f.service.ask('chat', 'Status?', 'q')
  await started(f)
  await until(() => f.saved[0]?.snapshot !== undefined)
  expect(f.saved[0]).toMatchObject({
    state: 'running',
    answer: '',
    snapshot: { point: { session: 'live-session', at: 'live-at' }, upTo: 'a', context: '' }
  })
  f.service.stop('chat', 'q')
  await finished(f)
  f.setBase({ ...active, live: { session: 'fresh', at: 'fresh-at' } })
  await f.service.follow('chat', 'q', 'And?', 'f')
  await started(f, 2)
  expect(f.runs[1].options.args).toContain('live-at')
})

test('a room follow-up is refused once its member left the room', async () => {
  const f = fixture(true)
  await f.service.ask('chat', 'Status?', 'q')
  await started(f)
  f.runs[0].finish()
  await finished(f)
  expect(f.saved[0]).toMatchObject({ agent: 'writer' })
  expect(f.saved[0]).not.toHaveProperty('mention')
  f.meta.group!.members = ['helper']
  await expect(f.service.follow('chat', 'q', 'And?', 'f')).rejects.toThrow('Writer is not in this chat')
  expect(f.runs).toHaveLength(1)
})

test('Ask again on a room follow-up is refused once its member left the room', async () => {
  const f = fixture(true)
  await f.service.ask('chat', 'Status?', 'q')
  await started(f)
  f.runs[0].finish()
  await finished(f)
  await f.service.follow('chat', 'q', 'And?', 'f')
  await started(f, 2)
  f.service.stop('chat', 'f')
  await finished(f)
  f.meta.group!.members = ['helper']
  await expect(f.service.again('chat', 'f')).rejects.toThrow('Writer is not in this chat')
  expect(f.runs).toHaveLength(2)
  expect(f.saved.find((e) => e.id === 'f')).toMatchObject({ state: 'stopped', agent: 'writer' })
})

test('a picking root asks to wait, not to ask again', async () => {
  const f = fixture(true),
    gate = deferred<string | null>()
  vi.mocked(f.deps.pick).mockImplementation(() => gate.promise)
  await f.service.ask('chat', 'Status?', 'q')
  await until(() => vi.mocked(f.deps.pick).mock.calls.length === 1)
  await expect(f.service.follow('chat', 'q', 'And?', 'f')).rejects.toThrow('Wait for this answer to finish')
  gate.resolve('writer')
  await started(f)
})

test('an orphan follow-up is its own root', async () => {
  const f = fixture()
  f.saved = [{ ...open('orphan'), thread: 'gone', state: 'done', answer: 'Old answer', endedAt: 2 }]
  expect(await f.service.follow('chat', 'orphan', 'And now?', 'f')).toMatchObject({ thread: 'orphan', agent: 'helper' })
  await started(f)
  expect(f.runs[0].options.stdin).toContain(`${pairOf('Old question', 'Old answer')}\n<btw>And now?</btw>`)
})

test('a follow-up of a root saved before snapshots answers from the chat now', async () => {
  const f = fixture(true)
  f.saved = [{ ...open('legacy'), agent: 'writer', state: 'done', answer: 'Old answer', endedAt: 2 }]
  f.setBase({ ...active, live: { session: 'now', at: 'now-at' } })
  vi.mocked(f.deps.groups.sideThread).mockResolvedValue([{ from: 'helper', text: 'Current progress' }])
  const threads = vi.mocked(f.deps.groups.sideThread).mock.calls.length
  expect(await f.service.follow('chat', 'legacy', 'And now?', 'f')).toMatchObject({ thread: 'legacy', agent: 'writer' })
  await started(f)
  const { args, stdin } = f.runs[0].options
  expect(args).toEqual(expect.arrayContaining(['--resume', 'now', '--resume-session-at', 'now-at', '--fork-session']))
  // No snapshot to reuse: the room context is read again, as a new question's would be.
  expect(vi.mocked(f.deps.groups.sideThread).mock.calls.length).toBe(threads + 1)
  expect(stdin).toContain('Current progress')
  expect(stdin).toContain(`${pairOf('Old question', 'Old answer')}\n<btw>And now?</btw>`)
})

test('a room follow-up keeps the picked member and its room context', async () => {
  const f = fixture(true)
  await f.service.ask('chat', 'Status?', 'q')
  await started(f)
  f.runs[0].emit({ kind: 'textDelta', text: 'Fine' })
  f.runs[0].finish()
  await finished(f)
  expect(f.saved[0]).toMatchObject({ agent: 'writer' })
  const threads = vi.mocked(f.deps.groups.sideThread).mock.calls.length
  vi.mocked(f.deps.groups.sideThread).mockResolvedValue([{ from: 'helper', text: 'Later progress' }])
  expect(await f.service.follow('chat', 'q', 'And now?', 'f')).toMatchObject({ agent: 'writer', state: 'running', thread: 'q' })
  await started(f, 2)
  expect(f.deps.pick).toHaveBeenCalledOnce()
  expect(vi.mocked(f.deps.groups.sideThread).mock.calls.length).toBe(threads)
  const { args, stdin } = f.runs[1].options
  expect(args[args.indexOf('--agent') + 1]).toBe('writer')
  expect(f.saved[0].snapshot!.context).toContain('Room progress')
  expect(String(stdin).startsWith(`${f.saved[0].snapshot!.context}\n`)).toBe(true)
  expect(stdin).not.toContain('Later progress')
  // Ask again on the follow-up keeps the member: no new pick.
  f.service.stop('chat', 'f')
  await finished(f)
  expect(await f.service.again('chat', 'f')).toMatchObject({ agent: 'writer', state: 'running', thread: 'q' })
  await started(f, 3)
  expect(f.deps.pick).toHaveBeenCalledOnce()
})

test('a renamed agent answers the follow-up', async () => {
  const f = fixture()
  await answeredRoot(f)
  f.service.renameAgent('helper', 'helper2')
  f.meta.agentName = 'helper2'
  expect(await f.service.follow('chat', 'q', 'And now?', 'f')).toMatchObject({ agent: 'helper2', thread: 'q' })
  await started(f, 2)
  const args = f.runs[1].options.args
  expect(args[args.indexOf('--agent') + 1]).toBe('helper2')
})

test('Ask again only on the last entry of a thread', async () => {
  const f = fixture()
  await answeredRoot(f)
  await f.service.follow('chat', 'q', 'And now?', 'f')
  await started(f, 2)
  f.service.stop('chat', 'f')
  await finished(f)
  await expect(f.service.again('chat', 'q')).rejects.toThrow('Only the last question in a side thread can be asked again')
  f.setBase({ ...active, live: { session: 'fresh', at: 'fresh-at' } })
  expect(await f.service.again('chat', 'f')).toEqual({
    id: 'f',
    question: 'And now?',
    agent: 'helper',
    thread: 'q',
    after: 'a',
    askedAt: 100,
    state: 'running',
    answer: ''
  })
  await started(f, 3)
  // Still the root's moment, not the chat's fresh point.
  expect(f.runs[2].options.args).toContain('live-at')
  expect(f.runs[2].options.stdin).toContain(`${pairOf('How far?', 'Three')}\n<btw>And now?</btw>`)
})

test('Ask again on a root takes a fresh snapshot', async () => {
  const f = fixture()
  await f.service.ask('chat', 'Status?', 'q')
  await started(f)
  f.runs[0].finish({ result: null, stderr: 'Oops', exitCode: 1 })
  await finished(f)
  expect(f.saved[0].snapshot?.point).toEqual({ session: 'live-session', at: 'live-at' })
  f.setBase({ ...active, live: { session: 'fresh', at: 'fresh-at' } })
  expect(await f.service.again('chat', 'q')).not.toHaveProperty('snapshot')
  await started(f, 2)
  f.runs[1].finish()
  await finished(f)
  expect(f.saved[0].snapshot?.point).toEqual({ session: 'fresh', at: 'fresh-at' })
})

test('an A→B asker follow-up reads the source chat through the root snapshot', async () => {
  const f = askedFixture()
  f.items.src = [{ type: 'user', id: 'p', text: 'Plan the import', ts: 1 }]
  await f.service.ask('ab', '@planner How is coder doing?', 'q')
  await started(f)
  f.runs[0].emit({ kind: 'textDelta', text: 'Halfway' })
  f.runs[0].finish()
  await finished(f)
  f.items.src.push({ type: 'assistant', id: 'p2', text: 'Later plan', ts: 2 })
  f.items.ab.push({ type: 'assistant', id: 'b2', text: 'Parser fully done', ts: 6, turn: 'live' })
  const abReads = () => f.store.loadItems.mock.calls.filter(([id]) => id === 'ab').length
  const before = abReads()
  expect(await f.service.follow('ab', 'q', 'And the tests?', 'f')).toMatchObject({ agent: 'planner', mention: true, thread: 'q' })
  await started(f, 2)
  expect(f.deps.baseFor).toHaveBeenLastCalledWith('src', 'planner')
  const { args, stdin } = f.runs[1].options
  expect(args).not.toContain('--resume')
  expect(stdin).toContain('Plan the import')
  expect(stdin).not.toContain('Later plan')
  expect(stdin).toContain(askedLead('coder', false))
  expect(stdin).toContain('Parser half done')
  expect(stdin).not.toContain('Parser fully done')
  expect(stdin).toContain(`${pairOf('How is coder doing?', 'Halfway')}\n<btw>And the tests?</btw>`)
  // The asked thread comes from the snapshot: the A→B chat is not read again.
  expect(abReads()).toBe(before)
})

test('an A→B asker follow-up fails once its source chat is gone, and is refused once another agent asks there', async () => {
  const f = askedFixture()
  await f.service.ask('ab', '@planner Status?', 'q')
  await started(f)
  f.runs[0].finish()
  await finished(f)
  f.remove('src')
  await f.service.follow('ab', 'q', 'And?', 'f')
  await finished(f)
  expect(f.runs).toHaveLength(1)
  expect((await f.service.list('ab')).find((e) => e.id === 'f')).toMatchObject({ state: 'error', error: sourceGoneText('planner') })
  f.metas.ab.asked!.by = 'lead'
  await expect(f.service.follow('ab', 'q', 'And?', 'g')).rejects.toThrow('Planner is not in this chat')
})

test('warm pings an idle chat from its clean point, saves no entry and records the cost as keep warm', async () => {
  const f = fixture()
  f.setBase(null) // idle: a fresh base, as for a side question
  const warm = f.service.warm('chat', 'helper')
  await started(f)
  const { args, stdin } = f.runs[0].options
  expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 5)).toEqual([
    '--resume',
    'end-session',
    '--resume-session-at',
    'end-at',
    '--fork-session'
  ])
  expect(args).toContain('--no-session-persistence')
  expect(args).toContain(SIDE_GUARD_SETTINGS)
  expect(stdin).toBe(KEEP_WARM_MESSAGE)
  f.runs[0].emit({
    ...result,
    cost: { totalUsd: 0.08, models: { m: { input: 0, output: 2, cacheRead: 400_000, cacheWrite: 0, costUsd: 0.08 } } }
  })
  f.runs[0].finish()
  expect(await warm).toBe(true)
  expect(f.deps.recordCost).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'chat', agent: KEEP_WARM_AGENT }))
  expect(f.store.saveSide).not.toHaveBeenCalled()
  expect(f.deps.broadcast).not.toHaveBeenCalled()
  expect(f.service.runningCount()).toBe(0)
})

test('warm skips a running chat, one with no session to resume, and reports a failed run', async () => {
  const f = fixture()
  expect(await f.service.warm('chat', 'helper')).toBe(false) // the base is live: the chat runs
  f.setBase(null)
  f.setItems([{ type: 'assistant', id: 'a', text: 'never stamped', ts: 1 }])
  f.meta.sessionId = null
  expect(await f.service.warm('chat', 'helper')).toBe(false)
  expect(f.runs).toHaveLength(0)
  f.setItems([structuredClone(old)])
  const warm = f.service.warm('chat', 'helper')
  await started(f)
  f.runs[0].finish({ exitCode: 1, result: { ...result, isError: true } })
  expect(await warm).toBe(false)
})

test('stopAll stops a ping', async () => {
  const f = fixture()
  f.setBase(null)
  const warm = f.service.warm('chat', 'helper')
  await started(f)
  await f.service.stopAll()
  expect(f.runs[0].stop).toHaveBeenCalled()
  expect(await warm).toBe(false)
})

test('stopAll waits for a ping still preparing its base, which then never starts', async () => {
  const f = fixture(),
    gate = deferred<SideBase | null>()
  f.setBase(null)
  vi.mocked(f.deps.baseFor).mockImplementation(() => gate.promise)
  const warm = f.service.warm('chat', 'helper')
  await until(() => vi.mocked(f.deps.baseFor).mock.calls.length === 1)
  let done = false
  const stopping = f.service.stopAll().then(() => {
    done = true
  })
  for (let n = 0; n < 20; n++) await Promise.resolve()
  expect(done).toBe(false)
  gate.resolve({ ...structuredClone(active), active: false })
  await stopping
  expect(await warm).toBe(false)
  expect(f.runs).toHaveLength(0)
})

test("stopAll waits for a stopped ping's browser turn to be disposed", async () => {
  const f = fixture(),
    disposed = deferred<void>(),
    dispose = vi.fn(() => disposed.promise)
  f.setBase(null)
  vi.mocked(f.deps.baseFor).mockResolvedValue({ ...structuredClone(active), active: false, browser: true })
  vi.mocked(f.deps.chats.sideBrowser).mockResolvedValue({ mcp: NO_MCP, args: [], env: {}, prompt: '', dispose })
  const warm = f.service.warm('chat', 'helper')
  await started(f)
  let done = false
  const stopping = f.service.stopAll().then(() => {
    done = true
  })
  await until(() => dispose.mock.calls.length === 1)
  for (let n = 0; n < 20; n++) await Promise.resolve()
  expect(done).toBe(false)
  disposed.resolve()
  await stopping
  expect(await warm).toBe(false)
})

describe('Codex side questions', () => {
  const codexActive: SideBase = {
    bin: '/codex',
    cwd: '/work',
    browser: false,
    asks: false,
    tmpDir: null,
    active: true,
    live: null,
    start: null,
    args: { agentName: 'helper', permissionMode: 'auto', extraArgs: [], disallowedTools: [], appendSystemPrompt: 'Main system' },
    codex: { threadId: 'thread-1', at: 'turn-1', baseInstructions: 'Codex body\n\nMain system', model: 'gpt-6' }
  }
  const idle: SideBase = { ...codexActive, active: false }
  const codexEnd: ChatItem = {
    type: 'assistant',
    id: 'a',
    text: 'Main history',
    ts: 1,
    end: { session: 'thread-9', at: 'turn-9', engine: 'codex' }
  }
  const fork = (threadId: string, lastTurnId: string) => ({ kind: 'fork', threadId, lastTurnId, ephemeral: true })
  const promptOf = (o: CodexRunOptions) => (o.action.kind === 'turn' ? (o.action.prompt as string) : '')

  test('while its turn runs, a side question forks the last completed turn on Codex, read-only and declining, and the answer lands', async () => {
    const f = fixture()
    f.setBase(structuredClone(codexActive))
    await f.service.ask('chat', 'How far?', 'q')
    await until(() => f.codexRuns.length === 1)
    expect(f.runs).toHaveLength(0)
    const { options } = f.codexRuns[0]
    expect(options).toMatchObject({
      bin: '/codex',
      cwd: '/work',
      start: fork('thread-1', 'turn-1'),
      thread: { permissionMode: 'manual', sandbox: 'read-only', model: 'gpt-6' }
    })
    expect(promptOf(options)).toBe(`${SIDE_NOTE}\n<btw>How far?</btw>`)
    f.codexRuns[0].emit({
      kind: 'permissionRequest',
      requestId: 'tag:0',
      toolName: 'Bash',
      input: { command: 'touch x' },
      description: null,
      reason: null,
      toolUseId: 'tool'
    })
    expect(f.codexRuns[0].send).toHaveBeenCalledExactlyOnceWith(denyResponse('tag:0', 'No tools in a side answer'))
    f.codexRuns[0].emit({ kind: 'assistantText', text: 'Three' })
    f.codexRuns[0].finish()
    await finished(f)
    expect(f.saved[0]).toMatchObject({
      state: 'done',
      answer: 'Three',
      snapshot: { point: { session: 'thread-1', at: 'turn-1', engine: 'codex' } }
    })
  })

  test('an idle Codex chat forks its last Codex stamp; with no completed turn a new thread is seeded', async () => {
    const f = fixture()
    f.setBase(structuredClone(idle))
    f.setItems([structuredClone(codexEnd)])
    await f.service.ask('chat', 'How far?', 'q')
    await until(() => f.codexRuns.length === 1)
    expect(f.codexRuns[0].options.start).toEqual(fork('thread-9', 'turn-9'))
    f.codexRuns[0].finish()
    await finished(f)
    f.setBase({ ...structuredClone(codexActive), codex: { ...codexActive.codex!, threadId: '', at: null } })
    await f.service.ask('chat', 'And now?', 'q2')
    await until(() => f.codexRuns.length === 2)
    expect(f.codexRuns[1].options.start).toEqual({ kind: 'new' })
    expect(promptOf(f.codexRuns[1].options)).toContain('Main history')
    expect(promptOf(f.codexRuns[1].options)).toContain('<btw>And now?</btw>')
  })

  test('a stamp of the other engine is never forked: Claude seeds over a Codex stamp, and Codex over a Claude one', async () => {
    const f = fixture()
    f.setBase({ ...active, active: false, live: null })
    f.setItems([structuredClone(codexEnd)])
    await f.service.ask('chat', 'How far?', 'q')
    await started(f)
    expect(f.runs[0].options.args).not.toContain('--resume')
    expect(f.runs[0].options.args).not.toContain('thread-9')
    expect(f.runs[0].options.stdin).toContain('Main history')
    f.runs[0].finish()
    await finished(f)
    f.setBase(structuredClone(idle))
    f.setItems([structuredClone(old)])
    await f.service.ask('chat', 'And now?', 'q2')
    await until(() => f.codexRuns.length === 1)
    expect(f.codexRuns[0].options.start).toEqual({ kind: 'new' })
    expect(promptOf(f.codexRuns[0].options)).toContain('Main history')
  })

  test("an explicit cut is forked only by its session's engine", async () => {
    const f = fixture()
    f.setBase(structuredClone(idle))
    Object.assign(f.meta, { sessionId: 'thread-5', sessionEngine: 'codex', next: { at: 'edited' } })
    await f.service.ask('chat', 'How far?', 'q')
    await until(() => f.codexRuns.length === 1)
    expect(f.codexRuns[0].options.start).toEqual(fork('thread-5', 'edited'))
    f.codexRuns[0].finish()
    await finished(f)
    f.setBase({ ...active, active: false, live: null })
    await f.service.ask('chat', 'And now?', 'q2')
    await started(f)
    expect(f.runs[0].options.args).not.toContain('--resume')
    expect(f.runs[0].options.args).not.toContain('edited')
  })

  test("a room side question to a Codex member answers on Codex, forking that member's thread at its stamp, or at its explicit cut only while the room marks that session Codex's", async () => {
    const f = fixture(true)
    f.deps.engineOf = async (agent) => (agent === 'writer' ? 'codex' : 'claude')
    f.setBase(null)
    vi.mocked(f.deps.baseFor).mockImplementation(async (_id, agent) =>
      agent === 'writer'
        ? { ...structuredClone(idle), args: { ...idle.args, agentName: 'writer' } }
        : { ...structuredClone(active), active: false, args: { ...active.args, agentName: agent } }
    )
    f.setItems([
      { type: 'user', id: 'u', text: 'Ship it', ts: 1 },
      {
        type: 'assistant',
        id: 'w',
        agent: 'writer',
        text: 'Writer history',
        ts: 2,
        end: { session: 'thread-w', at: 'turn-w', agent: 'writer', seen: 'u', engine: 'codex' }
      }
    ])
    await f.service.ask('chat', '@writer How far?', 'q')
    await until(() => f.codexRuns.length === 1)
    expect(f.codexRuns[0].options.start).toEqual(fork('thread-w', 'turn-w'))
    // The room's lines the member has not read go with the question, as on Claude.
    expect(promptOf(f.codexRuns[0].options)).toContain('Room progress')
    f.codexRuns[0].emit({ kind: 'assistantText', text: 'Nearly' })
    f.codexRuns[0].finish()
    await finished(f)
    expect(f.saved[0]).toMatchObject({ agent: 'writer', state: 'done', answer: 'Nearly' })
    // An explicit cut (a rewind) on the member's Codex thread.
    Object.assign(f.meta.group!, {
      sessions: { helper: 'member-session', writer: 'thread-5' },
      sessionEngines: { writer: 'codex' },
      next: { writer: { at: 'edited' } }
    })
    await f.service.ask('chat', '@writer And now?', 'q2')
    await until(() => f.codexRuns.length === 2)
    expect(f.codexRuns[1].options.start).toEqual(fork('thread-5', 'edited'))
    f.codexRuns[1].finish()
    await finished(f)
    // The same cut on a session the room marks as Claude's is never forked by codex: it seeds.
    Object.assign(f.meta.group!, { sessionEngines: undefined })
    await f.service.ask('chat', '@writer Once more?', 'q3')
    await until(() => f.codexRuns.length === 3)
    expect(f.codexRuns[2].options.start).toEqual({ kind: 'new' })
    expect(f.runs).toHaveLength(0)
  })

  test("a Codex agent's own side question gets no asking exception, and its note says it can ask nobody", async () => {
    const f = fixture()
    f.setBase({ ...structuredClone(codexActive), browser: true, asks: true })
    f.addChat('ab-c', 'coder')
    await f.service.ask('chat', 'Status?', 'q')
    await until(() => f.codexRuns.length === 1)
    // The bridges still join, so the tools match the main run's; the run declines every call.
    expect(f.deps.chats.sideBrowser).toHaveBeenCalledWith('chat', 'helper', { chatId: 'chat', entryId: 'q' }, true)
    expect(promptOf(f.codexRuns[0].options)).toBe(`${NO_ASK_SIDE_NOTE}\n<btw>Status?</btw>`)
    expect(NO_ASK_SIDE_NOTE).not.toContain('side_question')
    expect(f.store.list).not.toHaveBeenCalled()
    f.codexRuns[0].emit({
      kind: 'permissionRequest',
      requestId: 'tag:1',
      toolName: 'mcp__zumibot_agents__side_question',
      input: { agent: 'coder' },
      description: null,
      reason: null,
      toolUseId: 'tool'
    })
    expect(f.codexRuns[0].send).toHaveBeenCalledExactlyOnceWith(denyResponse('tag:1', 'No tools in a side answer'))
  })

  test("a Codex root's follow-up forks the root's Codex point; once the agent is on Claude it seeds through upTo", async () => {
    const f = fixture()
    f.setBase(structuredClone(codexActive))
    await f.service.ask('chat', 'How far?', 'q')
    await until(() => f.codexRuns.length === 1)
    f.codexRuns[0].emit({ kind: 'assistantText', text: 'Three' })
    f.codexRuns[0].finish()
    await finished(f)
    f.setBase(structuredClone(idle))
    f.setItems([
      structuredClone(old),
      { ...structuredClone(codexEnd), id: 'later', text: 'Later history', end: { session: 'thread-2', at: 'turn-7', engine: 'codex' } }
    ])
    await f.service.follow('chat', 'q', 'And now?', 'f1')
    await until(() => f.codexRuns.length === 2)
    expect(f.codexRuns[1].options.start).toEqual(fork('thread-1', 'turn-1'))
    expect(promptOf(f.codexRuns[1].options)).toBe(`${SIDE_NOTE}\n${FOLLOW_LEAD}\n${pairOf('How far?', 'Three')}\n<btw>And now?</btw>`)
    f.codexRuns[1].emit({ kind: 'assistantText', text: 'Four' })
    f.codexRuns[1].finish()
    await finished(f)
    f.setBase({ ...active, active: false, live: null })
    await f.service.follow('chat', 'q', 'Third?', 'f2')
    await started(f)
    const { args, stdin } = f.runs[0].options
    expect(args).not.toContain('--resume')
    expect(args).not.toContain('turn-1')
    expect(stdin).toContain('Main history')
    expect(stdin).not.toContain('Later history')
  })

  test('a missing Codex thread reseeds the side answer once, on a new thread', async () => {
    const f = fixture()
    f.setBase(structuredClone(codexActive))
    await f.service.ask('chat', 'How far?', 'q')
    await until(() => f.codexRuns.length === 1)
    f.codexRuns[0].finish({ result: null, missingSession: true })
    await until(() => f.codexRuns.length === 2)
    expect(f.codexRuns[1].options.start).toEqual({ kind: 'new' })
    expect(promptOf(f.codexRuns[1].options)).toContain('Main history')
    f.codexRuns[1].emit({ kind: 'assistantText', text: 'Seeded' })
    f.codexRuns[1].finish()
    await finished(f)
    expect(f.saved[0]).toMatchObject({ state: 'done', answer: 'Seeded', snapshot: { point: null, upTo: 'a' } })
  })

  test('stop stops the Codex side run', async () => {
    const f = fixture()
    f.setBase(structuredClone(codexActive))
    await f.service.ask('chat', 'How far?', 'q')
    await until(() => f.codexRuns.length === 1)
    f.codexRuns[0].emit({ kind: 'textDelta', text: 'Part' })
    f.service.stop('chat', 'q')
    await finished(f)
    expect(f.codexRuns[0].stop).toHaveBeenCalled()
    expect(f.saved[0]).toMatchObject({ state: 'stopped', answer: 'Part' })
  })

  test('Ask again reruns a stopped Codex entry on Codex, from the point it reads now', async () => {
    const f = fixture()
    f.setBase(structuredClone(codexActive))
    await f.service.ask('chat', 'How far?', 'q')
    await until(() => f.codexRuns.length === 1)
    f.service.stop('chat', 'q')
    await finished(f)
    f.setBase({ ...structuredClone(codexActive), codex: { ...codexActive.codex!, threadId: 'thread-1', at: 'turn-3' } })
    await f.service.again('chat', 'q')
    await until(() => f.codexRuns.length === 2)
    expect(f.codexRuns[1].options.start).toEqual(fork('thread-1', 'turn-3'))
    f.codexRuns[1].emit({ kind: 'assistantText', text: 'Again' })
    f.codexRuns[1].finish()
    await finished(f)
    expect(f.saved[0]).toMatchObject({ state: 'done', answer: 'Again' })
    expect(f.runs).toHaveLength(0)
  })

  test('a room side question to a member whose agent is now on Codex is refused with the room sentence before anything starts, picked or named', async () => {
    const f = fixture(true)
    vi.mocked(f.deps.groups.refuseCodex).mockImplementation(async (m: string) => {
      if (m === 'writer') throw new Error(CODEX_REFUSALS.room(m))
    })
    await f.service.ask('chat', '@writer How far?', 'named')
    await f.service.ask('chat', 'How far?', 'picked') // the moderator picks writer
    await until(() => f.saved.filter((q) => q.state === 'error').length === 2)
    expect(f.saved.map((q) => [q.id, q.agent, q.error])).toEqual([
      ['named', 'writer', CODEX_REFUSALS.room('writer')],
      ['picked', 'writer', CODEX_REFUSALS.room('writer')]
    ])
    expect(f.deps.baseFor).not.toHaveBeenCalled()
    expect(f.deps.chats.sideBrowser).not.toHaveBeenCalled()
    expect(f.runs).toHaveLength(0)
    expect(f.codexRuns).toHaveLength(0)
    // A Claude member still answers.
    await f.service.ask('chat', '@helper Status?', 'claude')
    await started(f)
  })

  test('btw off (a later probe failed): a Codex chat refuses side questions with the Phase 1 sentence and runs nothing; a Claude one still answers', async () => {
    const f = fixture()
    f.setBase(structuredClone(codexActive))
    let engine: Engine = 'codex'
    f.deps.engineOf = async () => engine
    f.deps.caps = (e) => ({ ...engineCaps(e), ...(e === 'codex' ? { btw: false } : {}) })
    await f.service.ask('chat', 'How far?', 'q')
    await until(() => f.saved[0]?.state === 'error')
    expect(f.saved[0].error).toBe(CODEX_REFUSALS.btw)
    expect(f.codexRuns).toHaveLength(0)
    expect(f.runs).toHaveLength(0)
    engine = 'claude'
    f.setBase(structuredClone(active))
    await f.service.ask('chat', 'And now?', 'q2')
    await started(f)
  })

  test('questions off: the Codex side run goes without the question feature; on by default', async () => {
    const f = fixture()
    f.setBase(structuredClone(codexActive))
    f.deps.engineOf = async () => 'codex'
    await f.service.ask('chat', 'How far?', 'q')
    await until(() => f.codexRuns.length === 1)
    expect(f.codexRuns[0].options.questions).toBeUndefined()
    f.codexRuns[0].finish()
    await finished(f)
    f.deps.caps = (e) => ({ ...engineCaps(e), ...(e === 'codex' ? { questions: false } : {}) })
    await f.service.ask('chat', 'And now?', 'q2')
    await until(() => f.codexRuns.length === 2)
    expect(f.codexRuns[1].options.questions).toBe(false)
  })

  test('a kept base of the engine the agent has left is dropped: baseFor builds one on the engine its next main run would use', async () => {
    const f = fixture()
    let engine: Engine = 'claude'
    f.deps.engineOf = async () => engine
    // The last main run was Codex's; the agent is on Claude now and has sent no turn since.
    f.setBase(structuredClone(idle))
    await f.service.ask('chat', 'How far?', 'q')
    await started(f)
    expect(f.deps.baseFor).toHaveBeenCalledTimes(1)
    expect(f.codexRuns).toHaveLength(0)
    f.runs[0].finish()
    await finished(f)
    // And the other way round.
    engine = 'codex'
    f.setBase({ ...structuredClone(active), active: false, live: null })
    vi.mocked(f.deps.baseFor).mockResolvedValueOnce(structuredClone(idle))
    await f.service.ask('chat', 'And now?', 'q2')
    await until(() => f.codexRuns.length === 1)
    expect(f.deps.baseFor).toHaveBeenCalledTimes(2)
    expect(f.runs).toHaveLength(1)
    // A kept base of the agent's own engine is still the one used.
    f.codexRuns[0].finish()
    await finished(f)
    f.setBase(structuredClone(idle))
    await f.service.ask('chat', 'Third?', 'q3')
    await until(() => f.codexRuns.length === 2)
    expect(f.deps.baseFor).toHaveBeenCalledTimes(2)
  })

  test('warm never pings the Claude session a kept base names once the agent is on Codex', async () => {
    const f = fixture()
    f.setBase({ ...structuredClone(active), active: false, live: null })
    f.deps.engineOf = async () => 'codex'
    vi.mocked(f.deps.baseFor).mockResolvedValueOnce(structuredClone(idle))
    expect(await f.service.warm('chat', 'helper')).toBe(false)
    expect(f.runs).toHaveLength(0)
  })

  test('warm never pings a Codex chat', async () => {
    const f = fixture()
    f.setBase(structuredClone(idle))
    f.setItems([structuredClone(codexEnd)])
    expect(await f.service.warm('chat', 'helper')).toBe(false)
    f.setBase(null)
    vi.mocked(f.deps.baseFor).mockResolvedValueOnce(structuredClone(idle))
    expect(await f.service.warm('chat', 'helper')).toBe(false)
    expect(f.runs).toHaveLength(0)
    expect(f.codexRuns).toHaveLength(0)
  })
})
