import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { NOTICE_TEXT, type AgentSummary, type ChatItem, type ChatPush } from '@zumibot/shared/types'
import type { ConditionCheck, Routine, RoutineRun, RoutineTarget } from '@zumibot/shared/routines'
import type { RoutineFailure } from '@zumibot/shared/notify'
import { CODEX_REFUSALS, SPEND_CAP_UNCHECKED, engineCaps, spendCapRefusal, type Engine, type EngineCaps } from '@zumibot/shared/engine'
import { ChatStore } from '../../src/core/store/chatStore'
import { RoutineStore } from '../../src/core/routines/routineStore'
import { RoutineRunner } from '../../src/core/routines/routineRunner'
import { capEngines } from '../../src/core/caps/capEngines'
import { branch } from '../../src/core/chat/versions'
import { NO_MCP } from '../../src/core/ipc/mcpSpec'

const NOW = Date.parse('2026-10-27T05:00:00Z')
let dir: string
let chats: ChatStore
let store: RoutineStore
let runner: RoutineRunner
let sent: unknown[][]
let active: Set<string>
let changed: () => void
let nextId: number
let failed: RoutineFailure[]
let timers: { fn: () => void; ms: number; cleared: boolean }[]
const agent: AgentSummary = {
  filePath: '/agents/alpha.md',
  name: 'alpha',
  description: '',
  color: null,
  icon: null,
  error: null,
  builtIn: false
}

const routine = (overrides: Partial<Routine> = {}): Routine => ({
  id: 'r1',
  name: 'Daily AI digest',
  enabled: true,
  timeZone: 'Asia/Baghdad',
  trigger: { kind: 'manual' },
  target: { kind: 'new-chat', agent: 'alpha', cwd: '/work' },
  prompt: 'Summarize',
  nextRunAt: null,
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})
const savedRun = (overrides: Partial<RoutineRun> = {}): RoutineRun => ({
  id: 'old',
  routineId: 'r1',
  via: 'schedule',
  status: 'running',
  late: false,
  chatId: 'chat-old',
  messageId: 'm-old',
  startedAt: 1,
  ...overrides
})
const waitFor = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Timed out waiting for routine run update')
}

beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-routine-runner-'))
  let clock = Date.parse('2026-10-27T05:00:00Z')
  chats = new ChatStore(
    dir,
    () => ++clock,
    () => `chat-${++nextId}`
  )
  store = new RoutineStore(dir)
  sent = []
  active = new Set()
  changed = vi.fn()
  nextId = 0
  failed = []
  timers = []
  runner = new RoutineRunner({
    store,
    chats,
    tasks: {
      submit: async (...args) => {
        sent.push(args)
        return 'sent'
      }
    },
    agents: async () => [agent],
    isRunning: (id) => active.has(id),
    builtInCwd: () => null,
    changed,
    now: () => NOW,
    newId: () => `run-${++nextId}`,
    onFailed: (e) => failed.push(e),
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false }
      timers.push(t)
      return {
        clear: () => {
          t.cleared = true
        }
      }
    }
  })
})

afterEach(async () => fs.rm(dir, { recursive: true, force: true }))

describe('RoutineRunner', () => {
  it('creates, titles, sends and completes a new-chat run', async () => {
    const run = await runner.run(routine(), 'manual')
    expect(run.status).toBe('running')
    expect(run.messageId).toBeTruthy()
    const chat = await chats.get(run.chatId!)
    expect(chat).toMatchObject({ agentName: 'alpha', cwd: '/work', title: 'Daily AI digest · Oct 27' })
    expect(sent).toEqual([[run.chatId, 'Summarize', [], undefined, run.messageId, undefined, undefined, 'routine']])
    await chats.saveItems(run.chatId!, [
      { type: 'user', id: run.messageId!, text: 'Summarize', ts: 1 },
      { type: 'assistant', id: 'a1', text: 'Done', ts: 2 }
    ])
    runner.chatIdle(run.chatId!)
    await waitFor(async () => (await store.runs()).r1[0].status === 'done')
    expect((await store.runs()).r1[0].status).toBe('done')
  })

  it('pushes the running run once it names its chat, so Open chat shows while it runs', async () => {
    const seen: (string | null)[] = []
    runner = new RoutineRunner({
      store,
      chats,
      tasks: {
        submit: async (...args) => {
          sent.push(args)
          return new Promise<'sent'>(() => {})
        }
      },
      agents: async () => [agent],
      isRunning: () => true,
      builtInCwd: () => null,
      now: () => NOW,
      newId: () => `run-${++nextId}`,
      changed: () => {
        void store.runs().then((r) => seen.push(r.r1?.[0]?.chatId ?? null))
      }
    })
    const run = await runner.run(routine(), 'manual')
    await waitFor(async () => seen.includes(run.chatId))
    expect((await store.runs()).r1[0]).toMatchObject({ status: 'running', chatId: run.chatId })
  })

  it("names a new chat with the target's title instead of the routine's name and date", async () => {
    const run = await runner.run(routine({ target: { kind: 'new-chat', agent: 'alpha', cwd: '/work', title: 'Morning brief' } }), 'manual')
    expect(await chats.get(run.chatId!)).toMatchObject({ title: 'Morning brief' })
  })

  describe('a new room with a section', () => {
    const beta: AgentSummary = { ...agent, filePath: '/agents/beta.md', name: 'beta' }
    const target: RoutineTarget = {
      kind: 'new-group',
      members: ['alpha', 'beta'],
      role: '',
      cwd: '/work',
      title: 'Standup',
      section: 'sec-1'
    }
    const roomRunner = (placeRoom: (chatId: string, sectionId: string) => Promise<void>): RoutineRunner =>
      new RoutineRunner({
        store,
        chats,
        tasks: {
          submit: async (...args) => {
            sent.push(args)
            return 'sent'
          }
        },
        agents: async () => [agent, beta],
        isRunning: () => false,
        builtInCwd: () => null,
        changed,
        now: () => NOW,
        newId: () => `run-${++nextId}`,
        placeRoom
      })

    it('is titled and placed in its section before the prompt goes in', async () => {
      const placed: [string, string, number][] = []
      runner = roomRunner(async (chatId, sectionId) => {
        placed.push([chatId, sectionId, sent.length])
      })
      const run = await runner.run(routine({ target }), 'manual')
      expect(run.status).toBe('running')
      expect(await chats.get(run.chatId!)).toMatchObject({ title: 'Standup', group: { members: ['alpha', 'beta'] } })
      expect(placed).toEqual([[run.chatId, 'sec-1', 0]])
      expect(sent).toHaveLength(1)
    })

    it('still runs when placing it fails', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      runner = roomRunner(async () => {
        throw new Error('disk full')
      })
      const run = await runner.run(routine({ target }), 'manual')
      expect(run.status).toBe('running')
      expect(sent).toHaveLength(1)
      expect(error).toHaveBeenCalledWith('placing a routine room failed:', 'disk full')
      error.mockRestore()
    })

    it('is not placed without a section', async () => {
      const placeRoom = vi.fn(async () => {})
      runner = roomRunner(placeRoom)
      const { section: _section, ...outside } = target as Extract<RoutineTarget, { kind: 'new-group' }>
      const run = await runner.run(routine({ target: outside }), 'manual')
      expect(run.status).toBe('running')
      expect(placeRoom).not.toHaveBeenCalled()
    })
  })

  it('marks an error item after the run message failed', async () => {
    const run = await runner.run(routine(), 'manual')
    await chats.saveItems(run.chatId!, [
      { type: 'user', id: run.messageId!, text: 'Summarize', ts: 1 },
      { type: 'error', id: 'e1', text: 'provider failed', ts: 2 }
    ])
    runner.chatIdle(run.chatId!)
    await waitFor(async () => (await store.runs()).r1[0].status === 'failed')
    expect((await store.runs()).r1[0]).toMatchObject({ status: 'failed', error: 'provider failed' })
  })

  it('fails a run whose turn a shutdown interrupted', async () => {
    const run = await runner.run(routine(), 'manual')
    await chats.saveItems(run.chatId!, [
      { type: 'user', id: run.messageId!, text: 'Summarize', ts: 1 },
      { type: 'assistant', id: 'a1', text: 'Half', ts: 2 },
      { type: 'notice', id: 'n1', kind: 'interrupted', text: NOTICE_TEXT.interrupted, ts: 3 }
    ])
    runner.chatIdle(run.chatId!)
    await waitFor(async () => (await store.runs()).r1[0].status !== 'running')
    expect((await store.runs()).r1[0]).toMatchObject({ status: 'failed', error: 'Interrupted by a restart' })
  })

  describe('a later turn', () => {
    const laterTurn = (run: RoutineRun, ...after: ChatItem[]): ChatItem[] => [
      { type: 'user', id: run.messageId!, text: 'Summarize', ts: 1 },
      { type: 'assistant', id: 'a1', text: 'Done', ts: 2 },
      { type: 'user', id: 'u2', text: 'And more?', ts: 3 },
      ...after
    ]
    const settled = async () => {
      await waitFor(async () => (await store.runs()).r1[0].status !== 'running')
      return (await store.runs()).r1[0]
    }

    it('does not pin its stop on a finished run', async () => {
      const run = await runner.run(routine(), 'manual')
      await chats.saveItems(run.chatId!, laterTurn(run, { type: 'notice', id: 'n1', kind: 'stopped', text: NOTICE_TEXT.stopped, ts: 4 }))
      runner.chatIdle(run.chatId!)
      expect(await settled()).toMatchObject({ status: 'done' })
    })

    it('does not pin its error on a finished run', async () => {
      const run = await runner.run(routine(), 'manual')
      await chats.saveItems(run.chatId!, laterTurn(run, { type: 'error', id: 'e1', text: 'provider failed', ts: 4 }))
      runner.chatIdle(run.chatId!)
      expect(await settled()).toMatchObject({ status: 'done' })
      expect((await store.runs()).r1[0].error).toBeUndefined()
    })

    it('settles a finished run at once while the later turn still runs', async () => {
      const run = await runner.run(routine(), 'manual')
      await chats.saveItems(run.chatId!, laterTurn(run))
      active.add(run.chatId!)
      runner.chatIdle(run.chatId!)
      expect(await settled()).toMatchObject({ status: 'done' })
      expect(runner.activeCount('r1')).toBe(0)
    })

    it('finalizes a finished run instead of marking it waiting on its approval card', async () => {
      const run = await runner.run(routine(), 'manual')
      await chats.saveItems(run.chatId!, laterTurn(run))
      active.add(run.chatId!)
      runner.chatPush({ kind: 'approvals', chatId: run.chatId!, pending: 1 })
      expect(await settled()).toMatchObject({ status: 'done' })
      expect(runner.activeCount('r1')).toBe(0)
    })
  })

  it('keeps a run active while its own turn still runs', async () => {
    const run = await runner.run(routine(), 'manual')
    await chats.saveItems(run.chatId!, [
      { type: 'user', id: run.messageId!, text: 'Summarize', ts: 1 },
      { type: 'assistant', id: 'a1', text: 'Working', ts: 2 }
    ])
    active.add(run.chatId!)
    runner.chatIdle(run.chatId!)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect((await store.runs()).r1[0].status).toBe('running')
    expect(runner.activeCount('r1')).toBe(1)
  })

  it('reads no chat on an approval push when the chat has no active run', async () => {
    const gets = vi.spyOn(chats, 'get')
    runner.chatPush({ kind: 'approvals', chatId: 'other', pending: 1 })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(gets).not.toHaveBeenCalled()
  })

  it('keeps queued runs active until their task is gone and chat is idle', async () => {
    const chat = await chats.create('alpha', dir)
    await chats.addTask(chat.id, { id: 'm1', text: 'hello', ts: 1 })
    await store.put(routine({ target: { kind: 'chat', chatId: chat.id } }))
    const run = await runner.run(routine({ target: { kind: 'chat', chatId: chat.id } }), 'manual')
    // A separate queued item with this run's message id models TaskQueue's queued path.
    await chats.addTask(chat.id, { id: run.messageId!, text: 'Summarize', ts: 2 })
    runner.chatIdle(chat.id)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect((await store.runs()).r1[0].status).toBe('running')
    await chats.dropTask(chat.id, run.messageId!)
    await chats.saveItems(chat.id, [{ type: 'user', id: run.messageId!, text: 'Summarize', ts: 3 }])
    runner.chatIdle(chat.id)
    await waitFor(async () => (await store.runs()).r1[0].status === 'done')
    expect((await store.runs()).r1[0].status).toBe('done')
  })

  it('fails a run when its queued task is explicitly dropped', async () => {
    const chat = await chats.create('alpha', dir)
    const target = routine({ target: { kind: 'chat', chatId: chat.id } })
    const run = await runner.run(target, 'manual')
    await chats.addTask(chat.id, { id: run.messageId!, text: 'Summarize', ts: 1 })

    runner.taskDropped(chat.id, run.messageId!)

    await waitFor(async () => (await store.runs()).r1[0].status === 'failed')
    expect((await store.runs()).r1[0]).toMatchObject({ status: 'failed', error: 'Removed from the queue' })
    expect(runner.activeCount('r1')).toBe(0)
  })

  it('fails every active run when its chat is removed', async () => {
    const chat = await chats.create('alpha', dir)
    const target = routine({ target: { kind: 'chat', chatId: chat.id } })
    const first = await runner.run(target, 'manual')
    const second = await runner.run(target, 'manual')

    runner.chatRemoved(chat.id)

    await waitFor(async () => (await store.runs()).r1.filter((run) => run.status === 'failed').length === 2)
    expect((await store.runs()).r1.filter((run) => [first.id, second.id].includes(run.id))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'failed', error: 'Chat was deleted' }),
        expect.objectContaining({ status: 'failed', error: 'Chat was deleted' })
      ])
    )
    expect(runner.activeCount('r1')).toBe(0)
  })

  it('fails a run whose message an edit or resend branched away, and frees its slot', async () => {
    const run = await runner.run(routine(), 'manual')
    const old: ChatItem[] = [
      { type: 'user', id: run.messageId!, text: 'Summarize', ts: 1 },
      { type: 'assistant', id: 'a1', text: 'Half', ts: 2 }
    ]
    const b = branch(old, {}, run.messageId!, { type: 'user', id: 'u-new', text: 'Summarize again', ts: 3 })
    await chats.saveVersions(run.chatId!, b.versions)
    await chats.saveItems(run.chatId!, b.items)
    expect(runner.activeCount('r1')).toBe(1)
    // An approval push must not flip the orphaned run back to waiting either.
    runner.chatPush({ kind: 'approvals', chatId: run.chatId!, pending: 1 })
    await waitFor(async () => (await store.runs()).r1[0].status === 'failed')
    expect((await store.runs()).r1[0]).toMatchObject({ status: 'failed', error: 'Replaced by an edit or resend' })
    expect(runner.activeCount('r1')).toBe(0)
  })

  it('settles a branched-away run on chat idle too', async () => {
    const run = await runner.run(routine(), 'manual')
    const old: ChatItem[] = [{ type: 'user', id: run.messageId!, text: 'Summarize', ts: 1 }]
    const b = branch(old, {}, run.messageId!, { type: 'user', id: 'u-new', text: 'Other', ts: 3 })
    await chats.saveVersions(run.chatId!, b.versions)
    await chats.saveItems(run.chatId!, b.items)
    runner.chatIdle(run.chatId!)
    await waitFor(async () => (await store.runs()).r1[0].status === 'failed')
    expect((await store.runs()).r1[0]).toMatchObject({ status: 'failed', error: 'Replaced by an edit or resend' })
    expect(runner.activeCount('r1')).toBe(0)
  })

  it('tracks approval pushes as waiting and running', async () => {
    const run = await runner.run(routine(), 'manual')
    const push = (pending: number): ChatPush => ({ kind: 'approvals', chatId: run.chatId!, pending })
    runner.chatPush(push(1))
    await waitFor(async () => (await store.runs()).r1[0].status === 'waiting')
    expect((await store.runs()).r1[0].status).toBe('waiting')
    runner.chatPush(push(0))
    await waitFor(async () => (await store.runs()).r1[0].status === 'running')
    expect((await store.runs()).r1[0].status).toBe('running')
  })

  it('fails a missing agent without sending', async () => {
    runner = new RoutineRunner({
      store,
      chats,
      tasks: {
        submit: async (...args) => {
          sent.push(args)
          return 'sent'
        }
      },
      agents: async () => [],
      isRunning: () => false,
      builtInCwd: () => null,
      changed,
      now: () => 1,
      newId: () => 'missing'
    })
    const run = await runner.run(routine({ target: { kind: 'new-chat', agent: 'ghost', cwd: '/work' } }), 'manual')
    expect(run).toMatchObject({ status: 'failed', error: 'Agent "ghost" not found', chatId: null })
    expect(sent).toHaveLength(0)
  })

  it('fails an existing-chat run whose agent is gone, without sending', async () => {
    const chat = await chats.create('ghost', dir)
    const run = await runner.run(routine({ target: { kind: 'chat', chatId: chat.id } }), 'manual')
    expect(run).toMatchObject({ status: 'failed', error: 'Agent "ghost" not found', chatId: null })
    expect(sent).toHaveLength(0)
  })

  it('fails an existing-chat run on a read-only asked chat, without sending', async () => {
    const chat = await chats.create('alpha', dir)
    await chats.update(chat.id, { asked: { by: 'beta', from: 'src', fromTitle: 'Source', chain: ['beta'] } })
    const run = await runner.run(routine({ target: { kind: 'chat', chatId: chat.id } }), 'manual')
    expect(run).toMatchObject({ status: 'failed', error: 'This chat is read-only', chatId: null })
    expect(sent).toHaveLength(0)
  })

  describe('start fresh each run', () => {
    const big = { used: 500_000, window: 1_000_000, at: 1 }

    it("starts the chat's agent on a new session seeded from the chat, and drops its old meter", async () => {
      const chat = await chats.create('alpha', dir)
      await chats.update(chat.id, { sessionId: 's-old', context: big })
      await runner.run(routine({ target: { kind: 'chat', chatId: chat.id }, sessionPolicy: 'fresh' }), 'manual')
      const meta = await chats.get(chat.id)
      expect(meta?.next).toEqual({ seed: true, fresh: true })
      expect(meta?.context).toBeUndefined()
      expect(sent).toHaveLength(1)
    })

    it('restarts every room member that has a session', async () => {
      const room = await chats.createGroup(['alpha', 'beta'], dir)
      await chats.updateGroup(room.id, (g) => ({ ...g, sessions: { alpha: 's-a', beta: null }, context: { alpha: big } }))
      await runner.run(routine({ target: { kind: 'chat', chatId: room.id }, sessionPolicy: 'fresh' }), 'manual')
      const g = (await chats.get(room.id))?.group
      expect(g?.next).toEqual({ alpha: { seed: true, fresh: true } })
      expect(g?.context).toBeUndefined()
      expect(sent).toHaveLength(1)
    })

    it('keeps the sessions by default', async () => {
      const chat = await chats.create('alpha', dir)
      await chats.update(chat.id, { sessionId: 's-old', context: big })
      await runner.run(routine({ target: { kind: 'chat', chatId: chat.id } }), 'manual')
      const meta = await chats.get(chat.id)
      expect(meta?.next).toBeUndefined()
      expect(meta?.context).toEqual(big)
    })

    it('a chat with no session yet is left as it is', async () => {
      const chat = await chats.create('alpha', dir)
      await runner.run(routine({ target: { kind: 'chat', chatId: chat.id }, sessionPolicy: 'fresh' }), 'manual')
      expect((await chats.get(chat.id))?.next).toBeUndefined()
    })
  })

  it('fails an existing-chat run whose agent file is broken', async () => {
    runner = new RoutineRunner({
      store,
      chats,
      tasks: {
        submit: async (...args) => {
          sent.push(args)
          return 'sent'
        }
      },
      agents: async () => [{ ...agent, error: 'bad frontmatter' }],
      isRunning: () => false,
      builtInCwd: () => null,
      changed,
      now: () => 1,
      newId: () => `run-${++nextId}`
    })
    const chat = await chats.create('alpha', dir)
    const run = await runner.run(routine({ target: { kind: 'chat', chatId: chat.id } }), 'manual')
    expect(run).toMatchObject({ status: 'failed', error: 'Agent "alpha" not found' })
    expect(sent).toHaveLength(0)
  })

  it('still runs in an existing group chat whose member is gone', async () => {
    const group = await chats.createGroup(['alpha', 'ghost'], dir)
    const run = await runner.run(routine({ target: { kind: 'chat', chatId: group.id } }), 'manual')
    expect(run.status).toBe('running')
    expect(sent).toHaveLength(1)
  })

  it('fails a new-group run that names Zumi Bot, without making a chat', async () => {
    runner = new RoutineRunner({
      store,
      chats,
      tasks: {
        submit: async (...args) => {
          sent.push(args)
          return 'sent'
        }
      },
      agents: async () => [agent, { ...agent, filePath: '/agents/zumi-bot.md', name: 'zumi-bot', builtIn: true }],
      isRunning: () => false,
      builtInCwd: () => null,
      changed,
      now: () => 1,
      newId: () => `run-${++nextId}`
    })
    const target: RoutineTarget = { kind: 'new-group', members: ['alpha', 'zumi-bot'], role: '', cwd: '/work' }
    const run = await runner.run(routine({ target }), 'manual')
    expect(run).toMatchObject({ status: 'failed', error: "Zumi Bot can't join a group chat", chatId: null })
    expect(await chats.list()).toEqual([])
    expect(sent).toHaveLength(0)
  })

  it('a new-group run takes a Codex agent; with Codex rooms off it fails without making a chat', async () => {
    const make = (caps?: (e: Engine) => EngineCaps) =>
      new RoutineRunner({
        store,
        chats,
        tasks: {
          submit: async (...args) => {
            sent.push(args)
            return 'sent'
          }
        },
        agents: async () => [agent, { ...agent, filePath: '/agents/cx.md', name: 'cx', provider: 'codex' }],
        isRunning: () => false,
        builtInCwd: () => null,
        changed,
        now: () => 1,
        newId: () => `run-${++nextId}`,
        ...(caps ? { caps } : {})
      })
    const target: RoutineTarget = { kind: 'new-group', members: ['alpha', 'cx'], role: '', cwd: '/work' }
    runner = make((e) => ({ ...engineCaps(e), ...(e === 'codex' ? { rooms: false } : {}) }))
    const refused = await runner.run(routine({ target }), 'manual')
    expect(refused).toMatchObject({ status: 'failed', error: CODEX_REFUSALS.room('cx'), chatId: null })
    expect(await chats.list()).toEqual([])
    expect(sent).toHaveLength(0)
    // A single Codex chat still runs.
    const single = await runner.run(routine({ target: { kind: 'new-chat', agent: 'cx', cwd: '/work' } }), 'manual')
    expect(single.status).toBe('running')
    // With rooms on (the default), the room is made and the message sent.
    runner = make()
    const run = await runner.run(routine({ target }), 'manual')
    expect(run.status).toBe('running')
    expect((await chats.get(run.chatId!))?.group?.members).toEqual(['alpha', 'cx'])
  })

  it('caps active runs at five per routine', async () => {
    const runs = await Promise.all(Array.from({ length: 6 }, () => runner.run(routine(), 'manual')))
    expect(runs.filter((r) => r.status === 'running')).toHaveLength(5)
    expect(runs[5]).toMatchObject({ status: 'failed', error: 'Too many runs in progress', chatId: null })
    expect(sent).toHaveLength(5)
  })

  it('does not release another start reservation when a later step throws', async () => {
    const chat = await chats.create('alpha', dir)
    const target = routine({ target: { kind: 'chat', chatId: chat.id } })
    await Promise.all(Array.from({ length: 3 }, () => runner.run(target, 'manual')))

    let reachedUpdate = () => {}
    const updateReached = new Promise<void>((resolve) => {
      reachedUpdate = resolve
    })
    let rejectUpdate = () => {}
    const failUpdate = new Promise<void>((_resolve, reject) => {
      rejectUpdate = () => reject(new Error('update failed'))
    })
    const originalUpdateRun = store.updateRun.bind(store)
    let failNextUpdate = true
    vi.spyOn(store, 'updateRun').mockImplementation(async (...args) => {
      if (failNextUpdate) {
        failNextUpdate = false
        reachedUpdate()
        await failUpdate
      }
      return originalUpdateRun(...args)
    })

    let releaseSecondTarget = () => {}
    const secondTargetGate = new Promise<void>((resolve) => {
      releaseSecondTarget = resolve
    })
    const originalGet = chats.get.bind(chats)
    let holdNextGet = false
    vi.spyOn(chats, 'get').mockImplementation(async (id) => {
      if (holdNextGet) {
        holdNextGet = false
        await secondTargetGate
      }
      return originalGet(id)
    })

    const failing = runner.run(target, 'manual')
    await updateReached
    holdNextGet = true
    const secondStarting = runner.run(target, 'manual')
    await waitFor(async () => runner.activeCount('r1') === 5)
    rejectUpdate()
    await failing

    const moreStarts = await Promise.all([runner.run(target, 'manual'), runner.run(target, 'manual')])
    releaseSecondTarget()
    const second = await secondStarting

    expect(moreStarts.filter((run) => run.status === 'running')).toHaveLength(1)
    expect(second.status).toBe('running')
    expect(runner.activeCount('r1')).toBe(5)
  })

  it('without a resolver, a routine prompt starting with a command name is sent as plain text', async () => {
    await runner.run(routine({ prompt: '/check L' }), 'manual')
    expect(sent[0][1]).toBe('/check L')
    expect(sent[0]).toEqual([expect.any(String), '/check L', [], undefined, expect.any(String), undefined, undefined, 'routine'])
  })

  describe('commands', () => {
    const command = { agent: 'alpha', name: 'check', prompt: 'Use check on L' }
    const withCommands = (forRoutine: (...args: unknown[]) => Promise<typeof command | undefined>) => {
      const resolve = vi.fn(forRoutine)
      runner = new RoutineRunner({
        store,
        chats,
        tasks: {
          submit: async (...args) => {
            sent.push(args)
            return 'sent'
          }
        },
        commands: { forRoutine: resolve },
        agents: async () => [agent],
        isRunning: (id) => active.has(id),
        builtInCwd: () => null,
        changed,
        now: () => NOW,
        newId: () => `run-${++nextId}`,
        onFailed: (e) => failed.push(e)
      })
      return resolve
    }

    it("sends the saved prompt's command with the run's message, asking with the saved pick", async () => {
      const resolve = withCommands(async () => command)
      const pick = { agent: 'alpha', name: 'check' }
      const run = await runner.run(routine({ prompt: '/check L', command: pick }), 'manual')
      expect(resolve).toHaveBeenCalledWith(run.chatId, '/check L', '/check L', pick)
      expect(sent).toEqual([[run.chatId, '/check L', [], undefined, run.messageId, command, undefined, 'routine']])
    })

    it('a routine run of a flagged command asks for the to-do list, as a send of it does', async () => {
      const flagged = { ...command, todos: true as const }
      withCommands(async () => flagged as unknown as typeof command)
      const run = await runner.run(routine({ prompt: '/check L' }), 'manual')
      expect(sent).toEqual([[run.chatId, '/check L', [], undefined, run.messageId, flagged, true, 'routine']])
    })

    it('a leading /todo in a routine prompt stays plain text: no command, no to-do request', async () => {
      const resolve = withCommands(async () => undefined)
      const run = await runner.run(routine({ prompt: '/todo /check L' }), 'manual')
      expect(resolve).toHaveBeenCalledWith(run.chatId, '/todo /check L', '/todo /check L', undefined)
      expect(sent).toEqual([[run.chatId, '/todo /check L', [], undefined, run.messageId, undefined, undefined, 'routine']])
    })

    it('asks with the saved prompt and the filled-in text apart, so a webhook field cannot name a command', async () => {
      const resolve = withCommands(async () => undefined)
      const call = { method: 'POST', query: {}, body: { text: '/check all' }, receivedAt: 2 }
      const run = await runner.run(routine({ trigger: { kind: 'webhook', sample: null }, prompt: '{{body.text}}' }), 'webhook', { call })
      expect(resolve).toHaveBeenCalledWith(run.chatId, '{{body.text}}', '/check all', undefined)
      expect(sent).toEqual([[run.chatId, '/check all', [], undefined, run.messageId, undefined, undefined, 'routine']])
    })

    it('fails the run, with its chat, when the command is refused', async () => {
      withCommands(async () => {
        throw new Error('Several members have /check (Alpha, Beta): pick one from the / menu')
      })
      const run = await runner.run(routine({ prompt: '/check L' }), 'manual')
      expect(sent).toEqual([])
      expect(run).toMatchObject({ status: 'failed', error: expect.stringContaining('Several members have /check') })
      expect((await store.runs()).r1[0]).toMatchObject({ status: 'failed', chatId: run.chatId })
      expect(failed).toEqual([{ routineId: 'r1', chatId: run.chatId, cause: 'start' }])
      expect(runner.activeCount('r1')).toBe(0)
    })
  })

  it('sends manual non-webhook prompts verbatim', async () => {
    await runner.run(routine({ prompt: 'Use {{x}} literally' }), 'manual')
    expect(sent[0][1]).toBe('Use {{x}} literally')
  })

  it('renders manual webhook runs and records missing fields', async () => {
    const sample = { method: 'POST', query: {}, body: { a: 'A' }, receivedAt: 1 }
    const run = await runner.run(routine({ trigger: { kind: 'webhook', sample }, prompt: '{{body.a}} {{body.b}}' }), 'manual')
    expect(sent[0][1]).toBe('A ')
    expect(run.missingFields).toEqual(['body.b'])
  })

  describe('webhook condition', () => {
    const call = { method: 'POST', query: {}, body: { status: 'failed' }, receivedAt: 2 }
    const hooked = (condition?: string) =>
      routine({ trigger: { kind: 'webhook', sample: null, ...(condition ? { condition } : {}) }, prompt: '{{body.status}}' })
    const withCondition = (check: () => Promise<ConditionCheck | null>) => {
      const condition = vi.fn(check)
      runner = new RoutineRunner({
        store,
        chats,
        tasks: {
          submit: async (...args) => {
            sent.push(args)
            return 'sent'
          }
        },
        agents: async () => [agent],
        isRunning: (id) => active.has(id),
        builtInCwd: () => null,
        changed,
        now: () => Date.parse('2026-10-27T05:00:00Z'),
        newId: () => `run-${++nextId}`,
        condition
      })
      return condition
    }

    it('runs a call that meets the condition and records the check', async () => {
      const condition = withCondition(async () => ({ met: true, p: 0.8 }))
      const run = await runner.run(hooked('the build failed'), 'webhook', { call })
      expect(condition).toHaveBeenCalledWith('the build failed', call)
      expect(run.status).toBe('running')
      expect(sent[0][1]).toBe('failed')
      expect((await store.runs()).r1[0].condition).toEqual({ met: true, p: 0.8 })
    })

    it('skips a call that does not meet it, without a chat', async () => {
      withCondition(async () => ({ met: false, p: 0.1 }))
      const run = await runner.run(hooked('the build failed'), 'webhook', { call })
      expect(run.status).toBe('skipped')
      expect(run.chatId).toBeNull()
      expect(sent).toEqual([])
      expect(await chats.list()).toEqual([])
      expect((await store.runs()).r1[0]).toMatchObject({
        status: 'skipped',
        condition: { met: false, p: 0.1 },
        endedAt: expect.any(Number)
      })
      expect(runner.activeCount('r1')).toBe(0)
    })

    it('holds no start slot while Jev checks', async () => {
      let answer: (c: ConditionCheck) => void = () => {}
      withCondition(
        () =>
          new Promise((resolve) => {
            answer = resolve
          })
      )
      const pending = runner.run(hooked('the build failed'), 'webhook', { call })
      await new Promise((resolve) => setTimeout(resolve, 5))
      expect(runner.activeCount('r1')).toBe(0)
      answer({ met: true, p: 1 })
      expect((await pending).status).toBe('running')
    })

    it('runs as before, with nothing recorded, while Jev is off', async () => {
      withCondition(async () => null)
      const run = await runner.run(hooked('the build failed'), 'webhook', { call })
      expect(run.status).toBe('running')
      expect((await store.runs()).r1[0].condition).toBeUndefined()
    })

    it('runs and says so when Jev could not tell', async () => {
      withCondition(async () => ({ met: null }))
      expect((await runner.run(hooked('the build failed'), 'webhook', { call })).status).toBe('running')
      expect((await store.runs()).r1[0].condition).toEqual({ met: null })
      withCondition(async () => {
        throw new Error('boom')
      })
      expect((await runner.run(hooked('the build failed'), 'webhook', { call })).status).toBe('running')
      expect((await store.runs()).r1[1].condition).toEqual({ met: null })
    })

    it('does not check routines without a condition, or a Run now', async () => {
      const condition = withCondition(async () => ({ met: false, p: 0 }))
      expect((await runner.run(hooked(), 'webhook', { call })).status).toBe('running')
      expect(
        (
          await runner.run(
            { ...hooked('the build failed'), trigger: { kind: 'webhook', sample: call, condition: 'the build failed' } },
            'manual'
          )
        ).status
      ).toBe('running')
      expect(condition).not.toHaveBeenCalled()
    })
  })

  describe('failure signal', () => {
    const settledFail = async () => {
      await waitFor(async () => failed.length > 0)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    it('says start for the cap, once, with no chat', async () => {
      await Promise.all(Array.from({ length: 6 }, () => runner.run(routine(), 'manual')))
      expect(failed).toEqual([{ routineId: 'r1', chatId: null, cause: 'start' }])
    })

    it('says start when the run cannot begin', async () => {
      const chat = await chats.create('ghost', dir)
      await runner.run(routine({ target: { kind: 'chat', chatId: chat.id } }), 'manual')
      expect(failed).toEqual([{ routineId: 'r1', chatId: null, cause: 'start' }])
    })

    it('says start when submit rejects', async () => {
      runner = new RoutineRunner({
        store,
        chats,
        tasks: {
          submit: async () => {
            throw new Error('queue broke')
          }
        },
        agents: async () => [agent],
        isRunning: () => false,
        builtInCwd: () => null,
        changed,
        now: () => 1,
        newId: () => `run-${++nextId}`,
        onFailed: (e) => failed.push(e)
      })
      const run = await runner.run(routine(), 'manual')
      await settledFail()
      expect(failed).toEqual([{ routineId: 'r1', chatId: run.chatId, cause: 'start' }])
    })

    it('says turn for an error item', async () => {
      const run = await runner.run(routine(), 'manual')
      await chats.saveItems(run.chatId!, [
        { type: 'user', id: run.messageId!, text: 'Summarize', ts: 1 },
        { type: 'error', id: 'e1', text: 'provider failed', ts: 2 }
      ])
      runner.chatIdle(run.chatId!)
      await settledFail()
      expect(failed).toEqual([{ routineId: 'r1', chatId: run.chatId, cause: 'turn' }])
    })

    it('says user for a stop', async () => {
      const run = await runner.run(routine(), 'manual')
      await chats.saveItems(run.chatId!, [
        { type: 'user', id: run.messageId!, text: 'Summarize', ts: 1 },
        { type: 'notice', id: 'n1', kind: 'stopped', text: NOTICE_TEXT.stopped, ts: 2 }
      ])
      runner.chatIdle(run.chatId!)
      await settledFail()
      expect(failed).toEqual([{ routineId: 'r1', chatId: run.chatId, cause: 'user' }])
    })

    it('says user for a dropped task and a deleted chat', async () => {
      const chat = await chats.create('alpha', dir)
      const target = routine({ target: { kind: 'chat', chatId: chat.id } })
      const dropped = await runner.run(target, 'manual')
      runner.taskDropped(chat.id, dropped.messageId!)
      await settledFail()
      expect(failed).toEqual([{ routineId: 'r1', chatId: chat.id, cause: 'user' }])
      failed.length = 0
      await runner.run(target, 'manual')
      runner.chatRemoved(chat.id)
      await settledFail()
      expect(failed).toEqual([{ routineId: 'r1', chatId: chat.id, cause: 'user' }])
    })

    it('says user for an edit or resend', async () => {
      const run = await runner.run(routine(), 'manual')
      const b = branch([{ type: 'user', id: run.messageId!, text: 'Summarize', ts: 1 }], {}, run.messageId!, {
        type: 'user',
        id: 'u-new',
        text: 'Other',
        ts: 3
      })
      await chats.saveVersions(run.chatId!, b.versions)
      await chats.saveItems(run.chatId!, b.items)
      runner.chatIdle(run.chatId!)
      await settledFail()
      expect(failed).toEqual([{ routineId: 'r1', chatId: run.chatId, cause: 'user' }])
    })

    it('says restart for an interrupted turn and for recover', async () => {
      const run = await runner.run(routine(), 'manual')
      await chats.saveItems(run.chatId!, [
        { type: 'user', id: run.messageId!, text: 'Summarize', ts: 1 },
        { type: 'notice', id: 'n1', kind: 'interrupted', text: NOTICE_TEXT.interrupted, ts: 2 }
      ])
      runner.chatIdle(run.chatId!)
      await settledFail()
      expect(failed).toEqual([{ routineId: 'r1', chatId: run.chatId, cause: 'restart' }])
      failed.length = 0
      const chat = await chats.create('alpha', dir)
      await store.put(routine({ target: { kind: 'chat', chatId: chat.id } }))
      await store.addRun(savedRun({ id: 'stale', chatId: chat.id }))
      await runner.recover()
      expect(failed).toEqual([{ routineId: 'r1', chatId: chat.id, cause: 'restart' }])
    })

    it('stays silent for a run that is done, waiting or skipped', async () => {
      const run = await runner.run(routine(), 'manual')
      runner.chatPush({ kind: 'approvals', chatId: run.chatId!, pending: 1 })
      await waitFor(async () => (await store.runs()).r1[0].status === 'waiting')
      await chats.saveItems(run.chatId!, [
        { type: 'user', id: run.messageId!, text: 'Summarize', ts: 1 },
        { type: 'assistant', id: 'a1', text: 'Done', ts: 2 }
      ])
      runner.chatIdle(run.chatId!)
      await waitFor(async () => (await store.runs()).r1[0].status === 'done')
      expect(failed).toEqual([])
    })

    it('survives a throwing onFailed', async () => {
      runner = new RoutineRunner({
        store,
        chats,
        tasks: { submit: async () => 'sent' },
        agents: async () => [agent],
        isRunning: () => false,
        builtInCwd: () => null,
        changed,
        now: () => 1,
        newId: () => `run-${++nextId}`,
        onFailed: () => {
          throw new Error('boom')
        }
      })
      const chat = await chats.create('ghost', dir)
      const run = await runner.run(routine({ target: { kind: 'chat', chatId: chat.id } }), 'manual')
      expect(run).toMatchObject({ status: 'failed', error: 'Agent "ghost" not found' })
    })
  })

  describe('routineOfChat', () => {
    it('names the routine while the run is active and not after it settles', async () => {
      const run = await runner.run(routine(), 'manual')
      expect(runner.routineOfChat(run.chatId!)).toBe('r1')
      expect(runner.routineOfChat('other')).toBeNull()
      await chats.saveItems(run.chatId!, [
        { type: 'user', id: run.messageId!, text: 'Summarize', ts: 1 },
        { type: 'assistant', id: 'a1', text: 'Done', ts: 2 }
      ])
      runner.chatIdle(run.chatId!)
      await waitFor(async () => (await store.runs()).r1[0].status === 'done')
      expect(runner.routineOfChat(run.chatId!)).toBeNull()
    })

    it('still names the routine when the turn of a real ChatService ends', async () => {
      const { ChatService } = await import('../../src/core/chat/chatService')
      const { AttachmentStore } = await import('../../src/core/attachments/attachmentStore')
      type RunOutcome = import('../../src/core/chat/claudeRunner').RunOutcome
      const seen: (string | null)[] = []
      const svc: InstanceType<typeof ChatService> = new ChatService({
        store: chats,
        files: new AttachmentStore(join(dir, 'attachments'), () => 'unused'),
        locate: async () => '/fake/claude',
        run: () => ({
          done: Promise.resolve<RunOutcome>({ exitCode: 1, signal: null, stderr: 'broke', spawnError: null, stopped: false, result: null }),
          send: () => true,
          stop: () => {}
        }),
        push: (p) => runner.chatPush(p),
        now: Date.now,
        newId: () => `item-${++nextId}`,
        permissionMode: 'auto',
        disallowedToolsFor: () => [],
        onIdle: (id) => runner.chatIdle(id),
        onTurnEnd: (e) => seen.push(runner.routineOfChat(e.chatId))
      })
      runner = new RoutineRunner({
        store,
        chats,
        tasks: {
          submit: async (id, text, _a, _r, messageId) => {
            await svc.send(id, text, [], undefined, messageId)
            return 'sent'
          }
        },
        agents: async () => [agent],
        isRunning: (id) => svc.isRunning(id),
        builtInCwd: () => null,
        changed,
        now: Date.now,
        newId: () => `run-${++nextId}`
      })
      await runner.run(routine(), 'manual')
      await waitFor(async () => seen.length > 0)
      expect(seen).toEqual(['r1'])
      await waitFor(async () => (await store.runs()).r1[0].status === 'failed')
    })
  })

  describe('usage limit', () => {
    const HOUR = 3_600_000
    const limitError = (resetsAt: number | null, agentName?: string): ChatItem => ({
      type: 'error',
      id: `e-${++nextId}`,
      text: 'Claude exited with code 1',
      ts: 2,
      limit: { resetsAt, ...(agentName ? { agent: agentName } : {}) }
    })
    const limitedRun = async (overrides: Partial<Routine> = {}, ...errors: ChatItem[]) => {
      await store.put(routine(overrides))
      const run = await runner.run(routine(overrides), 'manual')
      await chats.saveItems(run.chatId!, [
        { type: 'user', id: run.messageId!, text: 'Summarize', ts: 1 },
        { type: 'assistant', id: 'a1', text: "You've hit your session limit", ts: 2 },
        ...(errors.length > 0 ? errors : [limitError(NOW + HOUR)])
      ])
      runner.chatIdle(run.chatId!)
      await waitFor(async () => (await store.runs()).r1[0].status !== 'running')
      return run
    }
    const stored = async () => (await store.runs()).r1[0]
    const fire = () =>
      timers
        .filter((t) => !t.cleared)
        .at(-1)!
        .fn()
    const settleTimers = () => new Promise((resolve) => setTimeout(resolve, 30))

    it('waits for the reset, then continues the same chat and settles on the new turn', async () => {
      const run = await limitedRun()
      expect(await stored()).toMatchObject({ status: 'limited', resumeAt: NOW + HOUR + 60_000, waits: 1 })
      expect(await stored()).not.toHaveProperty('endedAt')
      expect(timers.at(-1)!.ms).toBe(HOUR + 60_000)
      expect(runner.activeCount('r1')).toBe(1)
      expect(runner.routineOfChat(run.chatId!)).toBe('r1')
      expect(failed).toEqual([])

      fire()
      await waitFor(async () => sent.length === 2)
      const [chatId, text, , , messageId] = sent[1] as [string, string, unknown, unknown, string]
      expect([chatId, text]).toEqual([run.chatId, 'continue'])
      expect(await stored()).toMatchObject({ status: 'running', messageId })
      expect(await stored()).not.toHaveProperty('resumeAt')

      await chats.saveItems(run.chatId!, [
        ...(await chats.loadItems(run.chatId!)),
        { type: 'user', id: messageId, text: 'continue', ts: 3 },
        { type: 'assistant', id: 'a2', text: 'Done', ts: 4 }
      ])
      runner.chatIdle(run.chatId!)
      await waitFor(async () => (await stored()).status === 'done')
      expect(runner.activeCount('r1')).toBe(0)
    })

    it('resumes soon when the reset already passed', async () => {
      await limitedRun({}, limitError(NOW - HOUR))
      expect(await stored()).toMatchObject({ status: 'limited', resumeAt: NOW + 5_000 })
    })

    it('ignores the chat going idle or pushing approvals again while it waits', async () => {
      const run = await limitedRun()
      runner.chatIdle(run.chatId!)
      runner.chatPush({ chatId: run.chatId!, kind: 'approvals', pending: 0 } as ChatPush)
      await settleTimers()
      expect(await stored()).toMatchObject({ status: 'limited', waits: 1 })
      expect(timers.filter((t) => !t.cleared)).toHaveLength(1)
    })

    it('skips the run when the routine says skip, without a failure signal', async () => {
      const run = await limitedRun({ limitPolicy: 'skip' })
      expect(await stored()).toMatchObject({ status: 'skipped', skipReason: 'limit', chatId: run.chatId })
      expect(await stored()).toHaveProperty('endedAt')
      expect(timers).toEqual([])
      expect(failed).toEqual([])
      expect(runner.activeCount('r1')).toBe(0)
    })

    it('fails as before when the reset is unknown', async () => {
      await limitedRun({}, limitError(null))
      expect(await stored()).toMatchObject({ status: 'failed', error: 'Claude exited with code 1' })
      expect(timers).toEqual([])
    })

    it('fails as before when another error came with the limit', async () => {
      await limitedRun({}, limitError(NOW + HOUR), { type: 'error', id: 'e-x', text: 'provider failed', ts: 2 })
      expect(await stored()).toMatchObject({ status: 'failed', error: 'Claude exited with code 1' })
      expect(timers).toEqual([])
    })

    it('ends the wait when the user continued by hand', async () => {
      const run = await limitedRun()
      await chats.saveItems(run.chatId!, [...(await chats.loadItems(run.chatId!)), { type: 'user', id: 'by-hand', text: 'go on', ts: 3 }])
      runner.chatIdle(run.chatId!)
      await waitFor(async () => (await stored()).status === 'failed')
      expect(await stored()).toMatchObject({ error: 'Continued by hand' })
      expect(failed).toEqual([{ routineId: 'r1', chatId: run.chatId, cause: 'user' }])
      expect(timers.every((t) => t.cleared)).toBe(true)
      timers[0]!.fn()
      await settleTimers()
      expect(sent).toHaveLength(1)
    })

    it('a resume that finds the user already continued sends nothing', async () => {
      const run = await limitedRun()
      await chats.saveItems(run.chatId!, [...(await chats.loadItems(run.chatId!)), { type: 'user', id: 'by-hand', text: 'go on', ts: 3 }])
      fire()
      await waitFor(async () => (await stored()).status === 'failed')
      expect(await stored()).toMatchObject({ error: 'Continued by hand' })
      expect(sent).toHaveLength(1)
    })

    it('waits again after another hit, and fails past the cap', async () => {
      const run = await limitedRun()
      for (let wait = 2; wait <= 6; wait++) {
        fire()
        await waitFor(async () => sent.length === wait)
        const messageId = (sent.at(-1) as string[])[4]
        await chats.saveItems(run.chatId!, [
          ...(await chats.loadItems(run.chatId!)),
          { type: 'user', id: messageId, text: 'continue', ts: 3 },
          limitError(NOW + HOUR)
        ])
        runner.chatIdle(run.chatId!)
        await waitFor(async () => (await stored()).status !== 'running')
        if (wait <= 5) expect(await stored()).toMatchObject({ status: 'limited', waits: wait })
      }
      expect(await stored()).toMatchObject({ status: 'failed', error: 'Claude exited with code 1' })
      expect(failed).toEqual([{ routineId: 'r1', chatId: run.chatId, cause: 'turn' }])
    })

    it('in a room, asks each member the limit stopped to continue', async () => {
      const room = await chats.createGroup(['alpha', 'beta'], dir)
      await limitedRun({ target: { kind: 'chat', chatId: room.id } }, limitError(NOW + HOUR, 'alpha'), limitError(NOW + 2 * HOUR, 'beta'))
      expect(await stored()).toMatchObject({ status: 'limited', resumeAt: NOW + 2 * HOUR + 60_000 })
      fire()
      await waitFor(async () => sent.length === 2)
      expect((sent[1] as string[])[1]).toBe('@alpha @beta continue')
    })

    it("ends 'Continued by hand', sending no continue, when the chat is paused as the wait comes due", async () => {
      const run = await limitedRun()
      await chats.update(run.chatId!, { pause: 'paused' })
      fire()
      await waitFor(async () => (await store.runs()).r1[0].status === 'failed')
      expect(await stored()).toMatchObject({ status: 'failed', error: 'Continued by hand' })
      expect(sent).toHaveLength(1)
      expect(failed).toEqual([{ routineId: 'r1', chatId: run.chatId, cause: 'user' }]) // 'user' is silent in NotifyService
      expect(runner.activeCount('r1')).toBe(0)
    })

    it('a wait that comes due in a pausing chat ends the same way', async () => {
      const run = await limitedRun()
      await chats.update(run.chatId!, { pause: 'pausing' })
      fire()
      await waitFor(async () => (await store.runs()).r1[0].status === 'failed')
      expect(await stored()).toMatchObject({ error: 'Continued by hand' })
      expect(sent).toHaveLength(1)
    })

    it('drops the resume of a routine deleted while it waits', async () => {
      await limitedRun()
      await store.remove('r1')
      fire()
      await settleTimers()
      expect(sent).toHaveLength(1)
      expect(runner.activeCount('r1')).toBe(0)
    })

    it('stop() clears the waits, and a late timer does nothing', async () => {
      await limitedRun()
      runner.stop()
      expect(timers.every((t) => t.cleared)).toBe(true)
      timers[0]!.fn()
      await settleTimers()
      expect(sent).toHaveLength(1)
      expect(await stored()).toMatchObject({ status: 'limited' })
    })

    it('recover re-arms a stored wait, and resumes one already due', async () => {
      const chat = await chats.create('alpha', dir)
      await store.put(routine({ target: { kind: 'chat', chatId: chat.id } }))
      await chats.saveItems(chat.id, [{ type: 'user', id: 'm-old', text: 'Summarize', ts: 1 }, limitError(NOW - HOUR)])
      await store.addRun(savedRun({ chatId: chat.id, status: 'limited', resumeAt: NOW + 1_000, waits: 1 }))
      await runner.recover()
      expect(timers.at(-1)!.ms).toBe(1_000)
      expect(runner.activeCount('r1')).toBe(1)
      fire()
      await waitFor(async () => sent.length === 1)
      expect(sent[0]).toEqual([chat.id, 'continue', [], undefined, expect.any(String), undefined, undefined, 'routine'])

      await store.addRun(savedRun({ id: 'due', chatId: chat.id, status: 'limited', resumeAt: NOW - 1_000 }))
      await runner.recover()
      expect(timers.at(-1)!.ms).toBe(0)
    })

    it('recover leaves a wait of a routine that is off untouched, like a synced copy of the VPS', async () => {
      const chat = await chats.create('alpha', dir)
      await store.put(routine({ enabled: false, target: { kind: 'chat', chatId: chat.id } }))
      await chats.saveItems(chat.id, [{ type: 'user', id: 'm-old', text: 'Summarize', ts: 1 }, limitError(NOW - HOUR)])
      const waiting = savedRun({ chatId: chat.id, status: 'limited', resumeAt: NOW + 1_000, waits: 1 })
      await store.addRun(waiting)
      const before = await fs.readFile(join(dir, 'routine-runs.json'), 'utf8')
      await runner.recover()
      expect(timers).toEqual([])
      expect(runner.activeCount('r1')).toBe(0)
      expect(await fs.readFile(join(dir, 'routine-runs.json'), 'utf8')).toBe(before) // never newer than the VPS's copy
    })

    it('recover fails a stored wait whose chat is gone', async () => {
      await store.put(routine())
      await store.addRun(savedRun({ chatId: 'gone', status: 'limited', resumeAt: NOW + 1_000 }))
      await runner.recover()
      expect(await stored()).toMatchObject({ status: 'failed', error: 'Interrupted by a restart' })
      expect(timers).toEqual([])
    })
  })

  describe('a paused chat', () => {
    const big = { used: 500_000, window: 1_000_000, at: 1 }
    const into = (chatId: string, overrides: Partial<Routine> = {}) => routine({ target: { kind: 'chat', chatId }, ...overrides })
    const userPaused = (id = 'n-p'): ChatItem => ({ type: 'notice', id, kind: 'userPaused', text: NOTICE_TEXT.userPaused, ts: 3 })

    it("leaves the paused session alone under 'start fresh', and sends the message as the routine's", async () => {
      const chat = await chats.create('alpha', dir)
      await chats.update(chat.id, { sessionId: 's-old', context: big, pause: 'paused' })
      const run = await runner.run(into(chat.id, { sessionPolicy: 'fresh' }), 'manual')
      const meta = await chats.get(chat.id)
      expect(meta?.next).toBeUndefined()
      expect(meta?.context).toEqual(big)
      expect(sent).toEqual([[chat.id, 'Summarize', [], undefined, run.messageId, undefined, undefined, 'routine']])
    })

    it("leaves a pausing chat's session alone too", async () => {
      const chat = await chats.create('alpha', dir)
      await chats.update(chat.id, { sessionId: 's-old', pause: 'pausing' })
      await runner.run(into(chat.id, { sessionPolicy: 'fresh' }), 'manual')
      expect((await chats.get(chat.id))?.next).toBeUndefined()
    })

    it("leaves a paused room's members alone under 'start fresh'", async () => {
      const room = await chats.createGroup(['alpha', 'beta'], dir)
      await chats.updateGroup(room.id, (g) => ({ ...g, sessions: { alpha: 's-a', beta: 's-b' }, context: { alpha: big } }))
      await chats.update(room.id, { pause: 'paused' })
      await runner.run(into(room.id, { sessionPolicy: 'fresh' }), 'manual')
      const g = (await chats.get(room.id))?.group
      expect(g?.next).toBeUndefined()
      expect(g?.context).toEqual({ alpha: big })
    })

    it('stays running while its message waits in the held tray', async () => {
      const chat = await chats.create('alpha', dir)
      await chats.update(chat.id, { pause: 'paused' })
      const run = await runner.run(into(chat.id), 'manual')
      await chats.update(chat.id, { tasks: [{ id: run.messageId!, text: 'Summarize', ts: 1 }], held: true })
      runner.chatIdle(chat.id)
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect((await store.runs()).r1[0].status).toBe('running')
      expect(runner.activeCount('r1')).toBe(1)
    })

    it('a run into a chat that is not paused still starts it fresh', async () => {
      const chat = await chats.create('alpha', dir)
      await chats.update(chat.id, { sessionId: 's-old' })
      await runner.run(into(chat.id, { sessionPolicy: 'fresh' }), 'manual')
      expect((await chats.get(chat.id))?.next).toEqual({ seed: true, fresh: true })
    })

    const pausedRun = async (...turn: ChatItem[]) => {
      const run = await runner.run(routine(), 'manual')
      await chats.saveItems(run.chatId!, [
        { type: 'user', id: run.messageId!, text: 'Summarize', ts: 1 },
        ...(turn.length > 0 ? turn : [{ type: 'assistant', id: 'a1', text: 'Half, then paused', ts: 2 } as ChatItem]),
        userPaused()
      ])
      await chats.update(run.chatId!, { pause: 'paused' })
      runner.chatIdle(run.chatId!)
      await waitFor(async () => (await store.runs()).r1[0].status !== 'running')
      return run
    }
    const stored = async () => (await store.runs()).r1[0]
    const settleQueue = () => new Promise((resolve) => setTimeout(resolve, 30))

    it("is paused, not failed, when the user pauses the run's own turn, and Resume's Continue carries it to done", async () => {
      const run = await pausedRun()
      expect(await stored()).toMatchObject({ status: 'paused' })
      expect(await stored()).not.toHaveProperty('endedAt')
      expect(await stored()).not.toHaveProperty('error')
      expect(failed).toEqual([])
      expect(runner.activeCount('r1')).toBe(1)
      expect(runner.routineOfChat(run.chatId!)).toBe('r1')

      // Idle rounds and approval pushes while paused change nothing.
      runner.chatIdle(run.chatId!)
      runner.chatPush({ chatId: run.chatId!, kind: 'approvals', pending: 0 } as ChatPush)
      await settleQueue()
      expect(await stored()).toMatchObject({ status: 'paused' })

      runner.chatResumed(run.chatId!, 'resume-1')
      await waitFor(async () => (await stored()).status === 'running')
      expect(await stored()).toMatchObject({ status: 'running', messageId: 'resume-1', resumes: 1 })
      expect(runner.messagesOf(run.chatId!)).toEqual(new Set(['resume-1']))

      await chats.update(run.chatId!, { pause: undefined })
      await chats.saveItems(run.chatId!, [
        ...(await chats.loadItems(run.chatId!)),
        { type: 'user', id: 'resume-1', text: 'Continue', ts: 4 },
        { type: 'assistant', id: 'a2', text: 'Done', ts: 5 }
      ])
      runner.chatIdle(run.chatId!)
      await waitFor(async () => (await stored()).status === 'done')
      expect(await stored()).not.toHaveProperty('error')
      expect(failed).toEqual([])
      expect(runner.activeCount('r1')).toBe(0)
    })

    it('follows the Continue even when the pause is only settled after Resume sent it', async () => {
      const run = await runner.run(routine(), 'manual')
      await chats.saveItems(run.chatId!, [
        { type: 'user', id: run.messageId!, text: 'Summarize', ts: 1 },
        userPaused(),
        { type: 'user', id: 'resume-1', text: 'Continue', ts: 4 }
      ])
      // The paused turn's idle comes first, Resume's hook right after it; neither has run yet.
      runner.chatIdle(run.chatId!)
      runner.chatResumed(run.chatId!, 'resume-1')
      await waitFor(async () => (await stored()).status === 'running' && (await stored()).messageId === 'resume-1')
      await chats.saveItems(run.chatId!, [...(await chats.loadItems(run.chatId!)), { type: 'assistant', id: 'a2', text: 'Done', ts: 5 }])
      runner.chatIdle(run.chatId!)
      await waitFor(async () => (await stored()).status === 'done')
    })

    it('a Continue that is paused again waits again, and counts each Resume', async () => {
      const run = await pausedRun()
      runner.chatResumed(run.chatId!, 'resume-1')
      await waitFor(async () => (await stored()).status === 'running')
      await chats.saveItems(run.chatId!, [
        ...(await chats.loadItems(run.chatId!)),
        { type: 'user', id: 'resume-1', text: 'Continue', ts: 4 },
        userPaused('n-p2')
      ])
      runner.chatIdle(run.chatId!)
      await waitFor(async () => (await stored()).status === 'paused')
      runner.chatResumed(run.chatId!, 'resume-2')
      await waitFor(async () => (await stored()).status === 'running')
      expect(await stored()).toMatchObject({ messageId: 'resume-2', resumes: 2 })
    })

    it("ends silently 'Continued by hand' when the user sends a message of their own into the paused chat", async () => {
      const run = await pausedRun()
      await chats.saveItems(run.chatId!, [
        ...(await chats.loadItems(run.chatId!)),
        { type: 'user', id: 'by-hand', text: 'Do something else', ts: 4 },
        { type: 'assistant', id: 'a2', text: 'Ok', ts: 5 }
      ])
      runner.chatIdle(run.chatId!)
      await waitFor(async () => (await stored()).status !== 'paused')
      expect(await stored()).toMatchObject({ status: 'failed', error: 'Continued by hand' })
      expect(failed).toEqual([{ routineId: 'r1', chatId: run.chatId, cause: 'user' }]) // 'user' is silent in NotifyService
      expect(runner.activeCount('r1')).toBe(0)
    })

    it('a Resume in a chat with no paused run changes nothing', async () => {
      const run = await runner.run(routine(), 'manual')
      runner.chatResumed(run.chatId!, 'resume-1')
      await settleQueue()
      expect(await stored()).toMatchObject({ status: 'running', messageId: run.messageId })
    })

    it('a pause that ended a limited turn waits for Resume, not for the reset', async () => {
      await store.put(routine())
      await pausedRun({ type: 'error', id: 'e1', text: 'Claude exited with code 1', ts: 2, limit: { resetsAt: NOW + 3_600_000 } })
      expect(await stored()).toMatchObject({ status: 'paused' })
      expect(await stored()).not.toHaveProperty('resumeAt')
      expect(timers).toEqual([])
    })

    it('recover keeps a paused run waiting for Resume, writing nothing', async () => {
      const chat = await chats.create('alpha', dir)
      await store.put(routine({ target: { kind: 'chat', chatId: chat.id } }))
      await chats.saveItems(chat.id, [{ type: 'user', id: 'm-old', text: 'Summarize', ts: 1 }, userPaused()])
      await chats.update(chat.id, { pause: 'paused' })
      await store.addRun(savedRun({ chatId: chat.id, status: 'paused' }))
      const before = await fs.readFile(join(dir, 'routine-runs.json'), 'utf8')
      await runner.recover()
      expect(await fs.readFile(join(dir, 'routine-runs.json'), 'utf8')).toBe(before)
      expect(runner.activeCount('r1')).toBe(1)
      runner.chatResumed(chat.id, 'resume-1')
      await waitFor(async () => (await stored()).status === 'running')
      expect(await stored()).toMatchObject({ messageId: 'resume-1', resumes: 1 })
    })

    it('recover pauses a run whose turn a restart ended paused, instead of failing it', async () => {
      const chat = await chats.create('alpha', dir)
      await store.put(routine({ target: { kind: 'chat', chatId: chat.id } }))
      await chats.saveItems(chat.id, [
        { type: 'user', id: 'm-old', text: 'Summarize', ts: 1 },
        { type: 'notice', id: 'n-i', kind: 'interrupted', text: NOTICE_TEXT.interrupted, ts: 2 },
        userPaused()
      ])
      await chats.update(chat.id, { pause: 'paused' })
      await store.addRun(savedRun({ chatId: chat.id }))
      await runner.recover()
      expect(await stored()).toMatchObject({ status: 'paused' })
      expect(await stored()).not.toHaveProperty('endedAt')
      expect(failed).toEqual([])
      expect(runner.activeCount('r1')).toBe(1)
    })

    it('a pause on a turn that also failed still reports the error', async () => {
      const run = await runner.run(routine(), 'manual')
      await chats.saveItems(run.chatId!, [
        { type: 'user', id: run.messageId!, text: 'Summarize', ts: 1 },
        { type: 'error', id: 'e1', text: 'provider failed', ts: 2 },
        userPaused()
      ])
      runner.chatIdle(run.chatId!)
      await waitFor(async () => (await store.runs()).r1[0].status !== 'running')
      expect((await store.runs()).r1[0]).toMatchObject({ status: 'failed', error: 'provider failed' })
      expect(failed).toEqual([{ routineId: 'r1', chatId: run.chatId, cause: 'turn' }])
    })

    it('fails the run with the cap error when the paused chat already holds 50 queued messages', async () => {
      const cap = 'A chat can hold at most 50 queued messages'
      runner = new RoutineRunner({
        store,
        chats,
        tasks: {
          submit: async () => {
            throw new Error(cap)
          }
        },
        agents: async () => [agent],
        isRunning: () => false,
        builtInCwd: () => null,
        changed,
        now: () => NOW,
        newId: () => `run-${++nextId}`,
        onFailed: (e) => failed.push(e)
      })
      const chat = await chats.create('alpha', dir)
      await chats.update(chat.id, { pause: 'paused' })
      await runner.run(into(chat.id), 'manual')
      await waitFor(async () => (await store.runs()).r1[0].status === 'failed')
      expect((await store.runs()).r1[0]).toMatchObject({ status: 'failed', error: cap })
      expect(runner.activeCount('r1')).toBe(0)
    })
  })

  describe('missed run', () => {
    const scheduled = (missedPolicy?: Routine['missedPolicy']) =>
      routine({
        trigger: { kind: 'schedule', schedule: { freq: 'daily', time: '09:00', days: [0, 1, 2, 3, 4, 5, 6] } },
        ...(missedPolicy ? { missedPolicy } : {})
      })

    it('is skipped without a chat when the routine says skip', async () => {
      const run = await runner.run(scheduled('skip'), 'schedule', { late: true })
      expect(run).toMatchObject({ status: 'skipped', skipReason: 'missed', late: true, chatId: null })
      expect((await store.runs()).r1[0]).toMatchObject({ status: 'skipped', skipReason: 'missed' })
      expect(sent).toEqual([])
      expect(await chats.list()).toEqual([])
      expect(failed).toEqual([])
    })

    it('runs once late by default, and on time even with skip', async () => {
      expect(await runner.run(scheduled(), 'schedule', { late: true })).toMatchObject({ status: 'running', late: true })
      expect(await runner.run(scheduled('skip'), 'schedule')).toMatchObject({ status: 'running', late: false })
      expect(sent).toHaveLength(2)
    })
  })

  it('recovers stored running runs whose message is no longer queued', async () => {
    const chat = await chats.create('alpha', dir)
    await store.put(routine({ target: { kind: 'chat', chatId: chat.id } }))
    await store.addRun(savedRun({ chatId: chat.id }))
    await runner.recover()
    expect((await store.runs()).r1[0]).toMatchObject({ status: 'failed', error: 'Interrupted by a restart' })
  })
})

it('browser handoff pushes from a real ChatService turn keep a routine waiting until the terminal card is persisted', async () => {
  const { ChatService } = await import('../../src/core/chat/chatService')
  const { AttachmentStore } = await import('../../src/core/attachments/attachmentStore')
  type BrowserHandoff = import('../../src/core/browser/types').BrowserHandoff
  type RunOutcome = import('../../src/core/chat/claudeRunner').RunOutcome
  let publish!: (handoff: BrowserHandoff) => Promise<void>
  let own!: import('../../src/core/browser/types').BrowserOwner
  let end!: (outcome: RunOutcome) => void
  let turn: Promise<unknown> | undefined
  const card = (): BrowserHandoff => ({
    ...own,
    id: 'browser-card',
    agent: 'alpha',
    generation: 'generation',
    site: 'example.com',
    reason: 'Sign in',
    createdAt: 1,
    status: 'pending'
  })
  const svc = new ChatService({
    store: chats,
    files: new AttachmentStore(join(dir, 'attachments'), () => 'unused'),
    locate: async () => '/fake/claude',
    run: () => ({
      done: new Promise<RunOutcome>((resolve) => {
        end = resolve
      }),
      send: () => true,
      stop: () => {}
    }),
    push: (p) => runner.chatPush(p),
    now: Date.now,
    newId: () => `item-${++nextId}`,
    permissionMode: 'auto',
    disallowedToolsFor: () => [],
    browserTurns: {
      profileId: async () => 'profile',
      create: async (owner, callback) => {
        own = owner
        publish = callback
        return { mcp: NO_MCP, args: [], env: {}, prompt: 'Browser instructions', dispose: async () => {} }
      }
    },
    onIdle: (id) => runner.chatIdle(id)
  })
  runner = new RoutineRunner({
    store,
    chats,
    tasks: {
      submit: async (id, text, _attachments, _reply, messageId) => {
        turn = svc.send(id, text, [], undefined, messageId)
        await turn
        return 'sent'
      }
    },
    agents: async () => [agent],
    isRunning: (id) => svc.isRunning(id),
    builtInCwd: () => null,
    changed,
    now: Date.now,
    newId: () => `run-${++nextId}`
  })
  const run = await runner.run(routine({ target: { kind: 'new-chat', agent: 'alpha', cwd: dir } }), 'manual')
  await waitFor(async () => typeof publish === 'function' && typeof end === 'function')
  await publish(card())
  await waitFor(async () => (await store.runs()).r1[0].status === 'waiting')
  await publish({ ...card(), status: 'done' })
  await waitFor(async () => (await store.runs()).r1[0].status === 'running')
  expect((await chats.loadItems(run.chatId!)).find((i) => i.type === 'browser-action')).toMatchObject({ handoff: { status: 'done' } })
  end({
    exitCode: 0,
    signal: null,
    stderr: '',
    spawnError: null,
    stopped: false,
    result: {
      kind: 'result',
      subtype: 'success',
      isError: false,
      numTurns: 1,
      sessionId: 's',
      denials: [],
      windows: {},
      uuid: null,
      cost: null
    }
  })
  await turn
  await waitFor(async () => (await store.runs()).r1[0].status === 'done')
})

it('a vault approval card from a real ChatService turn keeps a routine waiting until it is answered', async () => {
  const { ChatService } = await import('../../src/core/chat/chatService')
  const { AttachmentStore } = await import('../../src/core/attachments/attachmentStore')
  type VaultApprovalRequest = import('@zumibot/shared/vault').VaultApprovalRequest
  type RunOutcome = import('../../src/core/chat/claudeRunner').RunOutcome
  let publish: ((r: VaultApprovalRequest) => Promise<void>) | undefined
  let turnId = ''
  let end!: (outcome: RunOutcome) => void
  let turn: Promise<unknown> | undefined
  const svc = new ChatService({
    store: chats,
    files: new AttachmentStore(join(dir, 'attachments'), () => 'unused'),
    locate: async () => '/fake/claude',
    run: () => ({
      done: new Promise<RunOutcome>((resolve) => {
        end = resolve
      }),
      send: () => true,
      stop: () => {}
    }),
    push: (p) => runner.chatPush(p),
    now: Date.now,
    newId: () => `item-${++nextId}`,
    permissionMode: 'auto',
    disallowedToolsFor: () => [],
    // The same callback VaultApprovals calls with a pending card, then with its answer.
    vaultApprovals: {
      registerTurn: (id, cb) => {
        turnId = id
        publish = cb
        return () => {}
      }
    },
    onIdle: (id) => runner.chatIdle(id)
  })
  runner = new RoutineRunner({
    store,
    chats,
    tasks: {
      submit: async (id, text, _attachments, _reply, messageId) => {
        turn = svc.send(id, text, [], undefined, messageId)
        await turn
        return 'sent'
      }
    },
    agents: async () => [agent],
    isRunning: (id) => svc.isRunning(id),
    builtInCwd: () => null,
    changed,
    now: Date.now,
    newId: () => `run-${++nextId}`
  })
  const run = await runner.run(routine({ target: { kind: 'new-chat', agent: 'alpha', cwd: dir } }), 'manual')
  await waitFor(async () => typeof publish === 'function' && typeof end === 'function')
  const card = (status: VaultApprovalRequest['status']): VaultApprovalRequest => ({
    id: 'vault-card',
    chatId: run.chatId!,
    turnId,
    profileId: 'profile',
    itemId: 'i1',
    itemName: 'Work Visa',
    label: 'Visa •4242',
    site: 'shop.example.com',
    frameSite: 'js.stripe.com',
    status
  })
  await publish!(card('pending'))
  await waitFor(async () => (await store.runs()).r1[0].status === 'waiting')
  await publish!(card('allowed'))
  await waitFor(async () => (await store.runs()).r1[0].status === 'running')
  expect((await chats.loadItems(run.chatId!)).find((i) => i.type === 'vault-approval')).toMatchObject({ request: { status: 'allowed' } })
  end({
    exitCode: 0,
    signal: null,
    stderr: '',
    spawnError: null,
    stopped: false,
    result: {
      kind: 'result',
      subtype: 'success',
      isError: false,
      numTurns: 1,
      sessionId: 's',
      denials: [],
      windows: {},
      uuid: null,
      cost: null
    }
  })
  await turn
  await waitFor(async () => (await store.runs()).r1[0].status === 'done')
})

describe('RoutineRunner spend caps', () => {
  const gated = (over: string | null, asked: string[][]) =>
    new RoutineRunner({
      store,
      chats,
      tasks: {
        submit: async (...args) => {
          sent.push(args)
          return 'sent'
        }
      },
      agents: async () => [agent],
      isRunning: (id) => active.has(id),
      builtInCwd: () => null,
      changed,
      now: () => NOW,
      newId: () => `run-${++nextId}`,
      capGate: async (agents) => {
        asked.push(agents)
        return agents.includes(over ?? '') ? over : null
      }
    })

  it('a run that would start an agent past its daily cap is skipped, with no chat and no send', async () => {
    const asked: string[][] = []
    runner = gated('alpha', asked)
    const run = await runner.run(routine(), 'schedule')
    expect(run).toMatchObject({
      status: 'skipped',
      skipReason: 'cap',
      error: '@Alpha reached its daily spend cap',
      chatId: null,
      endedAt: NOW
    })
    expect(asked).toEqual([['alpha']])
    expect(sent).toEqual([])
    expect((await store.runs()).r1).toEqual([run])
  })

  it("asks about a room's members, and an existing chat's agent as it is now", async () => {
    const asked: string[][] = []
    runner = gated(null, asked)
    await runner.run(routine({ target: { kind: 'new-group', members: ['alpha', 'beta'], role: '', cwd: '/work' } }), 'manual')
    const chat = await chats.create('alpha', dir)
    await runner.run(routine({ id: 'r2', target: { kind: 'chat', chatId: chat.id } }), 'manual')
    expect(asked).toEqual([['alpha', 'beta'], ['alpha']])
  })

  it("an open run counts only its own turn's costs, not the user's in its chat; the cap marks and Resume's limit go on the run", async () => {
    const run = await runner.run(routine(), 'manual')
    expect(runner.runsIn(run.chatId!)).toEqual([{ routineId: 'r1', runId: run.id, messageId: run.messageId }])
    // Its message still waits (the tray): nothing that runs now is its turn.
    runner.chatCost(run.chatId!, 3)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect((await store.getRun('r1', run.id))?.costUsd).toBeUndefined()
    await chats.saveItems(run.chatId!, [{ type: 'user', id: run.messageId!, text: 'Summarize', ts: 1 }])
    runner.chatCost(run.chatId!, 0.25)
    runner.chatCost(run.chatId!, 0.5)
    runner.chatCost('another-chat', 9)
    await waitFor(async () => (await store.getRun('r1', run.id))?.costUsd === 0.75)
    // The user's own message after it: that turn is not the run's.
    await chats.saveItems(run.chatId!, [
      ...(await chats.loadItems(run.chatId!)),
      { type: 'assistant', id: 'a1', text: 'Done', ts: 2 },
      { type: 'user', id: 'u2', text: 'More', ts: 3 }
    ])
    runner.chatCost(run.chatId!, 4)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect((await store.getRun('r1', run.id))?.costUsd).toBe(0.75)
    await runner.capMark('r1', run.id, { capped: true })
    expect(await store.getRun('r1', run.id)).toMatchObject({ capped: true, costUsd: 0.75 })
    await runner.capMark('r1', run.id, { limit: 1.5 })
    const after = await store.getRun('r1', run.id)
    expect(after).toMatchObject({ capLimitUsd: 1.5 })
    expect(after && 'capped' in after).toBe(false)
  })
})

describe('RoutineRunner spend cap and the agent engine', () => {
  const gem: AgentSummary = { ...agent, filePath: '/agents/gem.md', name: 'gem', provider: 'acp' }
  const checked = () =>
    new RoutineRunner({
      store,
      chats,
      tasks: {
        submit: async (...args) => {
          sent.push(args)
          return 'sent'
        }
      },
      agents: async () => [agent, gem],
      isRunning: (id) => active.has(id),
      builtInCwd: () => null,
      changed,
      now: () => NOW,
      newId: () => `run-${++nextId}`,
      onFailed: (e) => failed.push(e),
      capEngines: capEngines({ agents: async () => [agent, gem], chats })
    })

  it('a capped run whose agent is now on an engine without cost fails at its start with the fixed sentence: no chat, no send', async () => {
    runner = checked()
    const run = await runner.run(routine({ spendCap: 5, target: { kind: 'new-chat', agent: 'gem', cwd: '/work' } }), 'schedule')
    expect(run).toMatchObject({ status: 'failed', error: spendCapRefusal('acp', 'gem'), chatId: null, endedAt: NOW })
    expect(sent).toEqual([])
    expect(await chats.list()).toEqual([])
    expect((await store.runs()).r1).toEqual([run])
    expect(failed).toHaveLength(1)
  })

  it('a lookup that throws fails the capped run with the fixed sentence, never runs it uncapped', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    runner = new RoutineRunner({
      store,
      chats,
      tasks: {
        submit: async (...args) => {
          sent.push(args)
          return 'sent'
        }
      },
      agents: async () => [agent],
      isRunning: (id) => active.has(id),
      builtInCwd: () => null,
      changed,
      now: () => NOW,
      newId: () => `run-${++nextId}`,
      onFailed: (e) => failed.push(e),
      capEngines: {
        routine: async () => {
          throw Object.assign(new Error('secret /path'), { code: 'EIO' })
        }
      }
    })
    const run = await runner.run(routine({ spendCap: 5 }), 'manual')
    expect(run).toMatchObject({ status: 'failed', error: SPEND_CAP_UNCHECKED, chatId: null })
    expect(sent).toEqual([])
    expect(err.mock.calls.flat().join(' ')).toContain('EIO')
    expect(err.mock.calls.flat().join(' ')).not.toContain('secret')
    err.mockRestore()
  })

  it('the same routine without a cap, or with a cap on an agent that reports a cost, runs as before', async () => {
    runner = checked()
    expect((await runner.run(routine({ target: { kind: 'new-chat', agent: 'gem', cwd: '/work' } }), 'manual')).status).toBe('running')
    expect((await runner.run(routine({ id: 'r2', spendCap: 5 }), 'manual')).status).toBe('running')
  })
})
