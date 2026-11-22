import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { isArchived } from '@zumibot/shared/archive'
import type { AgentSummary, ChatItem, ChatMeta, NoticeKind, WorkflowSent } from '@zumibot/shared/types'
import type { WebhookCall } from '@zumibot/shared/routines'
import {
  CHAT_NOT_FOUND,
  CHAT_OF_WORKFLOW,
  CHAT_READ_ONLY,
  CONDITION_TEXT,
  FOREACH_OUTPUT_MAX,
  LIMIT_SKIP_TEXT,
  MISSED_TEXT,
  summaryOf as summarize,
  type Edge,
  type ItemRun,
  type Port,
  type Step,
  type Visit,
  type Workflow,
  type WorkflowRun
} from '@zumibot/shared/workflows'
import { ChatStore } from '../../src/core/store/chatStore'
import { branch } from '../../src/core/chat/versions'
import { WorkflowStore } from '../../src/core/workflows/workflowStore'
import { WorkflowMessages } from '../../src/core/workflows/workflowMessages'
import type { BareResult } from '../../src/core/workflows/bareCalls'
import type { RunCost } from '../../src/core/usage/runCost'
import { EVENT_SAMPLES, eventCall } from '@zumibot/shared/workflowEvents'
import { capEngines } from '../../src/core/caps/capEngines'
import { SPEND_CAP_UNCHECKED, spendCapRefusal } from '@zumibot/shared/engine'
import {
  ACCOUNT_MISSING,
  EVENT_SKIPPED_BUSY,
  PROBLEMS_TEXT,
  WorkflowRunner,
  type WorkflowRunnerDeps
} from '../../src/core/workflows/workflowRunner'
import { chatStepProblem } from '../../src/core/workflows/workflowAgentSteps'
import { MATERIAL_RULE } from '@zumibot/shared/workflowTemplate'
import type { AgentCommand, CommandPick, SentCommand } from '@zumibot/shared/commands'
import { CommandResolver } from '../../src/core/chat/commandResolver'
import type { RoomTarget } from '../../src/core/workflows/workflowRooms'

const NOW = Date.parse('2026-11-07T09:00:00Z')
const COST: RunCost = { totalUsd: 0.01, models: {} }

let dir: string
let store: WorkflowStore
let chats: ChatStore
let runner: WorkflowRunner
let nextId: number
type FakeTimer = { fn: () => void; ms: number; cleared: boolean }
let timers: FakeTimer[]
let notes: { kind: string; o: unknown }[]
let costs: unknown[][]
let changed: ReturnType<typeof vi.fn<() => void>>
let stoppedChats: string[]
let llmPrompts: { prompt: string; system?: string; signal: AbortSignal }[]
let conditionPrompts: string[]
let conditionAnswer: 'yes' | 'no'
let gate: { open(): void; wait: Promise<void> }
let flaky: number
let missingDirs: Set<string>
let mailAccounts: Set<string>
const agent: AgentSummary = {
  filePath: '/agents/alpha.md',
  name: 'alpha',
  description: '',
  color: null,
  icon: null,
  error: null,
  builtIn: false
}
let agentList: AgentSummary[]
// An Agent step's chat, faked: each submit plays the next scripted turn into the chat's items, then reports idle.
type FakeTurn = { tail?: () => ChatItem[]; hold?: boolean; queue?: boolean; reject?: string }
let turns: FakeTurn[]
let sends: { chatId: string; text: string; messageId: string; from?: string; sent?: WorkflowSent; command?: SentCommand }[]
let running: Set<string>
let held: Map<string, () => Promise<void>>
let dropped: [string, string][]
let metaPushes: ChatMeta[]
let messages: WorkflowMessages
let order: string[] // 'add' and 'push', in the order the runner did them
let inboxChanges: number
let roomCopies: RoomTarget[] // what the fake room copy was asked for

const deferred = () => {
  let open!: () => void
  const wait = new Promise<void>((resolve) => {
    open = resolve
  })
  return { open, wait }
}

// Answers by what the prompt holds, as the real model's output would differ by prompt.
async function llm(o: { prompt: string; system?: string }, signal: AbortSignal): Promise<BareResult> {
  llmPrompts.push({ prompt: o.prompt, system: o.system, signal })
  if (o.prompt.includes('#GATE')) await gate.wait
  if (o.prompt.includes('#HANG')) {
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    return { ok: false, limit: null, error: 'Stopped' }
  }
  if (o.prompt.includes('#FAIL')) return { ok: false, limit: null, error: 'The model call failed' }
  if (o.prompt.includes('#FLAKY') && flaky++ === 0) return { ok: false, limit: null, error: 'The model call failed' }
  if (o.prompt.includes('#LIMITNULL')) return { ok: false, limit: { resetsAt: null }, error: 'The model call failed' }
  if (o.prompt.includes('#LIMIT')) return { ok: false, limit: { resetsAt: NOW + 1000 }, error: 'The model call failed' }
  if (o.prompt.includes('#LONG')) return { ok: true, text: 'L'.repeat(500), cost: null, id: null }
  return { ok: true, text: `out:${o.prompt.split('\n')[0]}`, cost: COST, id: `cost-${llmPrompts.length}` }
}

async function condition(o: { prompt: string }): Promise<BareResult> {
  conditionPrompts.push(o.prompt)
  const answer = o.prompt.includes('YES') ? 'yes' : o.prompt.includes('NO') ? 'no' : conditionAnswer
  return { ok: true, text: '', answer, reason: `said ${answer}`, cost: null, id: null }
}

const base = (id: string, name: string) => ({ id, handle: id, name, x: 0, y: 0 })
const said = (text: string): ChatItem => ({ type: 'assistant', id: `a-${++nextId}`, text, ts: NOW })
const notice = (kind: NoticeKind): ChatItem => ({ type: 'notice', id: `n-${++nextId}`, kind, text: kind, ts: NOW })
const failure = (text: string, resetsAt?: number | null): ChatItem => ({
  type: 'error',
  id: `e-${++nextId}`,
  text,
  ts: NOW,
  ...(resetsAt !== undefined ? { limit: { resetsAt } } : {})
})
const T = (): Step => ({ ...base('t', 'Start'), kind: 'trigger' })
const L = (id: string, prompt: string): Step => ({ ...base(id, id.toUpperCase()), kind: 'llm', prompt, model: 'haiku' })
const C = (id: string, question: string): Step => ({ ...base(id, id.toUpperCase()), kind: 'condition', question, model: 'haiku' })
const P = (id: string, question: string, editable = true): Step => ({ ...base(id, id.toUpperCase()), kind: 'approval', question, editable })
const W = (id: string, minutes: number): Step => ({ ...base(id, id.toUpperCase()), kind: 'wait', minutes })
const N = (id: string, title: string, body?: string): Step => ({
  ...base(id, id.toUpperCase()),
  kind: 'notify',
  title,
  ...(body !== undefined ? { body } : {})
})
const e = (from: string, to: string, port: Port = 'out'): Edge => ({ id: `${from}-${port}-${to}`, from, port, to })

const flow = (steps: Step[], edges: Edge[], over: Partial<Workflow> = {}): Workflow => ({
  id: 'w1',
  name: 'Release flow',
  enabled: true,
  timeZone: 'UTC',
  trigger: { kind: 'manual' },
  steps: [T(), ...steps],
  edges,
  nextRunAt: null,
  createdAt: 1,
  updatedAt: 1,
  ...over
})

// By the clock, not by a count of tries: under a loaded full-suite run 400 short sleeps passed before a turn had started.
const waitFor = async (check: () => Promise<boolean> | boolean, what = 'condition', ms = 5000) => {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}
const getRun = async (id: string): Promise<WorkflowRun> => (await store.getRun(id))!
const ended = (id: string) =>
  waitFor(async () => {
    const r = await store.getRun(id)
    return !!r && r.status !== 'running' && r.status !== 'waiting'
  }, 'the run to end')
const visitsOf = (r: WorkflowRun, stepId: string): Visit[] => r.visits.filter((v) => v.stepId === stepId)
const only = (r: WorkflowRun, stepId: string): Visit => {
  const vs = visitsOf(r, stepId)
  expect(vs).toHaveLength(1)
  return vs[0]!
}
const kinds = (kind: string) => notes.filter((n) => n.kind === kind).map((n) => n.o)
const live = (t: FakeTimer[]) => t.filter((x) => !x.cleared)
const fireAll = () => {
  const due = live(timers)
  for (const t of due) {
    t.cleared = true
    t.fn()
  }
}

async function playTurn(
  self: () => WorkflowRunner,
  chatId: string,
  text: string,
  messageId: string,
  from?: string,
  sent?: WorkflowSent,
  command?: SentCommand
): Promise<'sent' | 'queued'> {
  sends.push({ chatId, text, messageId, from, ...(sent ? { sent } : {}), ...(command ? { command } : {}) })
  const turn = turns.shift() ?? { tail: () => [said('ok')] }
  if (turn.reject) throw new Error(turn.reject)
  if (turn.queue) {
    await chats.addTask(chatId, { id: messageId, text, ts: NOW })
    return 'queued'
  }
  await chats.saveItems(chatId, [
    ...(await chats.loadItems(chatId)),
    { type: 'user', id: messageId, text, ts: NOW, ...(sent ? { workflowSent: sent } : {}) }
  ])
  await chats.update(chatId, { inFlight: true })
  running.add(chatId)
  const finish = async (): Promise<void> => {
    held.delete(chatId)
    await chats.saveItems(chatId, [...(await chats.loadItems(chatId)), ...(turn.tail?.() ?? [])])
    await chats.update(chatId, { inFlight: false })
    running.delete(chatId)
    self().chatIdle(chatId)
  }
  if (turn.hold) held.set(chatId, finish)
  else await finish()
  return 'sent'
}

function makeRunner(extra: Partial<WorkflowRunnerDeps> = {}): WorkflowRunner {
  const self: WorkflowRunner = new WorkflowRunner({
    store,
    bare: { llm: vi.fn(llm), condition: vi.fn(condition), stopAll: vi.fn() },
    chats,
    tasks: {
      submit: (
        chatId: string,
        text: string,
        _staged: string[],
        _replyTo?: string,
        messageId?: string,
        command?: SentCommand,
        _todo?: true,
        from?: string,
        sent?: WorkflowSent
      ) => playTurn(() => self, chatId, text, messageId!, from, sent, command),
      // As TaskQueue.drop: true only when the message was still in the tray.
      drop: async (chatId: string, taskId: string) => {
        dropped.push([chatId, taskId])
        return (await chats.dropTask(chatId, taskId).catch(() => ({ task: null }))).task !== null
      }
    },
    stopChat: (id) => {
      stoppedChats.push(id)
    },
    isRunning: (id) => running.has(id),
    pushMeta: (meta) => {
      metaPushes.push(meta)
    },
    agents: async () => agentList,
    zumiBot: 'zumi-bot',
    builtInCwd: () => null,
    dirExists: async (path) => !missingDirs.has(path),
    notify: {
      waiting: (o) => notes.push({ kind: 'waiting', o }),
      cleared: (runId) => notes.push({ kind: 'cleared', o: runId }),
      failed: (o) => notes.push({ kind: 'failed', o }),
      message: (o) => {
        order.push('push')
        notes.push({ kind: 'message', o })
      }
    },
    messages: {
      add: async (m) => {
        order.push('add')
        return messages.add(m)
      },
      has: (id) => messages.has(id)
    },
    inboxChanged: () => {
      inboxChanges++
    },
    recordCost: (...args) => {
      costs.push(args)
    },
    changed,
    now: () => NOW,
    newId: () => `id-${++nextId}`,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false }
      timers.push(t)
      return {
        clear: () => {
          t.cleared = true
        }
      }
    },
    vaultKey: () => null,
    mailAccount: (id) => (mailAccounts.has(id) ? { username: 'u', password: 'p' } : null),
    // A Room step's copy, faked as a plain chat: the slot code follows a chat's turn, whatever its members are.
    rooms: {
      copy: async (t) => {
        roomCopies.push(t)
        const copy = await chats.create('alpha', '/work')
        await chats.update(copy.id, { workflow: t.link }) // as the real copy is marked, so it is archived at the end
        return { chatId: copy.id }
      }
    },
    ...extra
  })
  return self
}

beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-workflow-runner-'))
  store = new WorkflowStore(dir)
  let clock = NOW
  chats = new ChatStore(
    dir,
    () => ++clock,
    () => `chat-${++nextId}`
  )
  nextId = 0
  timers = []
  notes = []
  costs = []
  changed = vi.fn<() => void>()
  stoppedChats = []
  llmPrompts = []
  conditionPrompts = []
  conditionAnswer = 'no'
  gate = deferred()
  flaky = 0
  missingDirs = new Set()
  mailAccounts = new Set()
  agentList = [agent]
  turns = []
  sends = []
  running = new Set()
  held = new Map()
  dropped = []
  metaPushes = []
  messages = new WorkflowMessages(dir, () => NOW)
  order = []
  inboxChanges = 0
  roomCopies = []
  runner = makeRunner()
})

afterEach(async () => {
  runner.stop()
  // A run's last writes (its chat's files) can still land after it reads as ended: retry instead of failing on ENOTEMPTY.
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})

describe('WorkflowRunner', () => {
  it('linear llm run ends done with outputs chained', async () => {
    const w = flow([L('a', 'Summarize'), L('b', 'Polish')], [e('t', 'a'), e('a', 'b')])
    const summary = await runner.run(w, 'manual', { input: 'hello' })
    await ended(summary.id)
    const r = await getRun(summary.id)
    expect(r).toMatchObject({ status: 'done', via: 'manual', input: 'hello', endedAt: NOW })
    expect(only(r, 't')).toMatchObject({ status: 'done', port: 'out', output: 'hello' })
    expect(llmPrompts[0]!.prompt).toBe('Summarize\n\n<input from="Start">\nhello\n</input>')
    expect(only(r, 'a')).toMatchObject({ status: 'done', n: 1, input: 'hello', output: 'out:Summarize', port: 'out' })
    expect(llmPrompts[1]!.prompt).toBe('Polish\n\n<input from="A">\nout:Summarize\n</input>')
    expect(only(r, 'b')).toMatchObject({ status: 'done', input: 'out:Summarize', output: 'out:Polish' })
    expect(costs).toEqual([
      ['w1', COST, 'cost-1'],
      ['w1', COST, 'cost-2']
    ])
    expect(changed).toHaveBeenCalled()
    expect(kinds('failed')).toEqual([])
  })

  it('condition picks branch and passes input through', async () => {
    const w = flow([C('c', 'Is it ready?'), L('y', 'Yes path'), L('n', 'No path')], [e('t', 'c'), e('c', 'y', 'yes'), e('c', 'n', 'no')])
    const { id } = await runner.run(w, 'manual', { input: 'YES please' })
    await ended(id)
    const r = await getRun(id)
    expect(conditionPrompts[0]).toBe('Is it ready?\n\n<input from="Start">\nYES please\n</input>')
    expect(only(r, 'c')).toMatchObject({ status: 'done', port: 'yes', reason: 'said yes', output: 'YES please' })
    expect(only(r, 'y')).toMatchObject({ status: 'done', input: 'YES please' })
    expect(visitsOf(r, 'n')).toEqual([])
    expect(r.status).toBe('done')
  })

  it('join after condition runs once with one input', async () => {
    const w = flow(
      [C('c', 'Ready?'), L('y', 'Yes path'), L('n', 'No path'), L('j', 'Join')],
      [e('t', 'c'), e('c', 'y', 'yes'), e('c', 'n', 'no'), e('y', 'j'), e('n', 'j')]
    )
    const { id } = await runner.run(w, 'manual', { input: 'NO thanks' })
    await ended(id)
    const r = await getRun(id)
    expect(visitsOf(r, 'y')).toEqual([])
    expect(only(r, 'j')).toMatchObject({ status: 'done', input: 'out:No path' }) // one input: as it is, no label
    expect(r.status).toBe('done')
  })

  it('parallel branches both run, join gets two labelled inputs', async () => {
    const w = flow([L('a', 'Alpha #GATE'), L('b', 'Beta'), L('j', 'Join')], [e('t', 'a'), e('t', 'b'), e('a', 'j'), e('b', 'j')])
    const { id } = await runner.run(w, 'manual', { input: 'go' })
    await waitFor(async () => visitsOf(await getRun(id), 'b')[0]?.status === 'done', 'b to finish')
    // A is still running and can still feed the join: it must not start with B's output alone.
    expect(visitsOf(await getRun(id), 'j')).toEqual([])
    expect((await getRun(id)).status).toBe('running')
    gate.open()
    await ended(id)
    const r = await getRun(id)
    expect(only(r, 'j')).toMatchObject({
      status: 'done',
      input: 'From A:\nout:Alpha #GATE\n\nFrom B:\nout:Beta'
    })
    expect(only(r, 'j').inputs.map((d) => d.from)).toEqual(['a', 'b'])
    expect(r.status).toBe('done')
  })

  it('approval waits, notifies, approve with edited text and note continues', async () => {
    const w = flow([P('p', 'Ship it?'), L('a', 'Announce')], [e('t', 'p'), e('p', 'a', 'approved')])
    const { id, status } = await runner.run(w, 'manual', { input: 'draft' })
    expect(status).toBe('waiting')
    const r = await getRun(id)
    expect(r.status).toBe('waiting')
    const visit = only(r, 'p')
    expect(visit).toMatchObject({ status: 'waiting', input: 'draft' })
    expect(kinds('waiting')).toEqual([{ workflowId: 'w1', runId: id, name: 'Release flow' }])
    expect(runner.waitingRuns()).toBe(1)

    await runner.approve(id, visit.id, { ok: true, text: 'edited', note: 'looks good' })
    await ended(id)
    const after = await getRun(id)
    expect(only(after, 'p')).toMatchObject({
      status: 'done',
      port: 'approved',
      note: 'looks good',
      output: 'edited\n\nNote from the user: looks good'
    })
    expect(kinds('cleared')).toEqual([id])
    expect(llmPrompts[0]!.prompt).toContain('edited\n\nNote from the user: looks good')
    expect(after.status).toBe('done')
    expect(runner.waitingRuns()).toBe(0)
  })

  it('an approval answered with a whole For each output keeps every character into its output and the next step', async () => {
    const big = 'y'.repeat(FOREACH_OUTPUT_MAX)
    const w = flow([P('p', 'Ship it?'), L('a', 'Announce')], [e('t', 'p'), e('p', 'a', 'approved')])
    const { id } = await runner.run(w, 'manual', { input: big })
    const visit = only(await getRun(id), 'p')
    expect(visit.input).toHaveLength(FOREACH_OUTPUT_MAX)
    await runner.approve(id, visit.id, { ok: true, text: big })
    await ended(id)
    expect(only(await getRun(id), 'p').output).toBe(big)
    expect(llmPrompts[0]!.prompt).toContain(big)
  })

  it('an approval visit stores its question filled raw, so the run view shows what the user is asked', async () => {
    const call: WebhookCall = { method: 'POST', receivedAt: NOW, query: {}, body: { title: 'Login broken' } }
    const w = flow([P('p', 'Post a comment on "{{trigger.body.title}}" with {{input}}? {{trigger.query.ref}}')], [e('t', 'p')], {
      trigger: { kind: 'webhook', sample: null, filters: [] }
    })
    const { id } = await runner.run(w, 'webhook', { call })
    const v = only(await getRun(id), 'p')
    expect(v.status).toBe('waiting')
    expect(v.question).toBe(`Post a comment on "Login broken" with ${JSON.stringify(call.body, null, 2)}? `)
    expect(v.missing).toEqual(['trigger.query.ref'])
  })

  it('reject goes out rejected port; unconnected reject ends branch, run done', async () => {
    const w = flow([P('p', 'Ship it?', false), L('a', 'Announce')], [e('t', 'p'), e('p', 'a', 'approved')])
    const { id } = await runner.run(w, 'manual', { input: 'draft' })
    const visit = only(await getRun(id), 'p')
    await runner.approve(id, visit.id, { ok: false, text: 'ignored', note: 'not yet' })
    await ended(id)
    const r = await getRun(id)
    expect(only(r, 'p')).toMatchObject({ status: 'done', port: 'rejected', output: 'draft\n\nNote from the user: not yet' })
    expect(visitsOf(r, 'a')).toEqual([])
    expect(r.status).toBe('done')
    expect(kinds('failed')).toEqual([])
    expect(kinds('cleared')).toEqual([id])
  })

  it('second approve throws Already answered and the step runs once', async () => {
    const w = flow([P('p', 'Ship it?'), L('a', 'Announce')], [e('t', 'p'), e('p', 'a', 'approved')])
    const { id } = await runner.run(w, 'manual', { input: 'draft' })
    const visit = only(await getRun(id), 'p')
    // Two tabs at once: the per-run queue lets one through.
    const results = await Promise.allSettled([runner.approve(id, visit.id, { ok: true }), runner.approve(id, visit.id, { ok: false })])
    expect(results.map((x) => x.status).sort()).toEqual(['fulfilled', 'rejected'])
    const refused = results.find((x): x is PromiseRejectedResult => x.status === 'rejected')!
    expect((refused.reason as Error).message).toBe('Already answered')
    await expect(runner.approve(id, visit.id, { ok: true })).rejects.toThrow('Already answered')
    await ended(id)
    const r = await getRun(id)
    expect(only(r, 'p')).toMatchObject({ port: 'approved', output: 'draft' })
    expect(only(r, 'a').status).toBe('done')
    expect(llmPrompts).toHaveLength(1)
    await expect(runner.approve('nope', visit.id, { ok: true })).rejects.toThrow()
  })

  it('wait arms timer and continues after minutes', async () => {
    const w = flow([W('w', 5), L('a', 'After')], [e('t', 'w'), e('w', 'a')])
    const { id } = await runner.run(w, 'manual', { input: 'hold this' })
    const r = await getRun(id)
    expect(only(r, 'w')).toMatchObject({ status: 'running', until: NOW + 5 * 60_000 })
    expect(r.status).toBe('running') // a Wait does not wait on the user
    expect(live(timers).map((t) => t.ms)).toEqual([5 * 60_000])
    expect(visitsOf(r, 'a')).toEqual([])
    fireAll()
    await ended(id)
    const after = await getRun(id)
    expect(only(after, 'w')).toMatchObject({ status: 'done', output: 'hold this', port: 'out' })
    expect(only(after, 'a').input).toBe('hold this')
    expect(after.status).toBe('done')
  })

  it('a wait scale divides the minutes, for the e2e dev hook', async () => {
    runner.stop()
    runner = makeRunner({ waitScale: 60 })
    const w = flow([W('w', 2), L('a', 'After')], [e('t', 'w'), e('w', 'a')])
    const { id } = await runner.run(w, 'manual', { input: 'hold this' })
    expect(only(await getRun(id), 'w').until).toBe(NOW + 2_000)
    expect(live(timers).map((t) => t.ms)).toEqual([2_000])
    fireAll()
    await ended(id)
    expect((await getRun(id)).status).toBe('done')
  })

  it("a Wait's due time counts from its visit's own start, however the clock moves meanwhile", async () => {
    runner.stop()
    let clock = NOW
    runner = makeRunner({ waitScale: 60, now: () => ++clock })
    const { id } = await runner.run(flow([W('w', 1)], [e('t', 'w')]), 'manual')
    const v = only(await getRun(id), 'w')
    expect(v.until! - v.startedAt).toBe(1_000)
  })

  it('notify stores the message before sending the push', async () => {
    const w = flow([N('n', 'Hello', 'Body')], [e('t', 'n')])
    const { id } = await runner.run(w, 'manual', { input: 'go' })
    await ended(id)
    const v = only(await getRun(id), 'n')
    const { messages: stored } = await messages.list()
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ id: v.id, workflowId: 'w1', runId: id, stepName: 'N', title: 'Hello', body: 'Body' })
    expect(kinds('message')).toEqual([
      expect.objectContaining({ workflowId: 'w1', runId: id, title: 'Hello', body: 'Body', messageId: v.id })
    ])
    expect(order).toEqual(['add', 'push'])
    expect(inboxChanges).toBe(1)
  })

  it('stores the fallback title the push used', async () => {
    const w = flow([N('n', '{{trigger.body.x}}')], [e('t', 'n')], { name: 'W'.repeat(100) })
    const { id } = await runner.run(w, 'manual')
    await ended(id)
    const { messages: stored } = await messages.list()
    expect(stored[0]!.title).toBe('W'.repeat(80))
    expect((kinds('message') as { title: string }[])[0]!.title).toBe('W'.repeat(80))
  })

  it('two Notify steps in one run make two messages', async () => {
    const w = flow([N('a', 'One'), N('b', 'Two')], [e('t', 'a'), e('t', 'b')])
    const { id } = await runner.run(w, 'manual')
    await ended(id)
    const { messages: stored } = await messages.list()
    expect(stored.map((m) => m.title).sort()).toEqual(['One', 'Two'])
    expect(new Set(stored.map((m) => m.id)).size).toBe(2)
  })

  it('the visit keeps title and body', async () => {
    const w = flow([N('n', 'Hi {{input}}', 'Body {{input}}')], [e('t', 'n')])
    const { id } = await runner.run(w, 'manual', { input: 'there' })
    await ended(id)
    expect(only(await getRun(id), 'n')).toMatchObject({ title: 'Hi there', body: 'Body there' })
  })

  it('a store failure still sends the push', async () => {
    const failing = makeRunner({
      messages: {
        add: async () => {
          throw new Error('disk gone')
        },
        has: async () => false
      }
    })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const w = flow([N('n', 'Secret title', 'Secret body')], [e('t', 'n')])
    const { id } = await failing.run(w, 'manual')
    await ended(id)
    expect((await getRun(id)).status).toBe('done')
    expect(kinds('message')).toHaveLength(1)
    expect(inboxChanges).toBe(0)
    expect(JSON.stringify(spy.mock.calls)).not.toContain('Secret')
    spy.mockRestore()
    failing.stop()
  })

  describe('recover and the Inbox', () => {
    const seed = async (extra: Partial<Visit>): Promise<void> => {
      const w = flow([N('n', 'Hello', 'Body')], [e('t', 'n')])
      await store.put(w)
      await store.addRun({
        id: 'run-old',
        workflowId: 'w1',
        via: 'manual',
        late: false,
        status: 'running',
        input: 'in',
        snapshot: { steps: w.steps, edges: w.edges },
        visits: [
          {
            id: 'vt',
            stepId: 't',
            n: 1,
            status: 'done',
            input: '',
            inputs: [],
            output: 'in',
            port: 'out',
            startedAt: NOW - 1000,
            endedAt: NOW - 1000
          },
          {
            id: 'vn',
            stepId: 'n',
            n: 1,
            status: 'running',
            input: 'in',
            inputs: [{ edgeId: 't-out-n', from: 't', text: 'in' }],
            startedAt: NOW - 1000,
            ...extra
          }
        ],
        inbox: {},
        allowance: { perStep: {}, total: 200 },
        halted: false,
        startedAt: NOW - 1000
      })
    }

    it('recover files a running Notify visit’s message without a push', async () => {
      await seed({ title: 'Hello', body: 'Body' })
      const fresh = makeRunner()
      await fresh.recover()
      await ended('run-old')
      const { messages: stored } = await messages.list()
      expect(stored).toEqual([expect.objectContaining({ id: 'vn', runId: 'run-old', title: 'Hello', body: 'Body', stepName: 'N' })])
      expect(kinds('message')).toEqual([])
      expect(inboxChanges).toBe(1)
    })

    it('recover does not duplicate a stored message', async () => {
      await seed({ title: 'Hello', body: 'Body' })
      await messages.add({
        id: 'vn',
        workflowId: 'w1',
        workflowName: 'Release flow',
        runId: 'run-old',
        stepName: 'N',
        title: 'Hello',
        body: 'Body',
        at: NOW
      })
      const fresh = makeRunner()
      await fresh.recover()
      await ended('run-old')
      expect((await messages.list()).messages).toHaveLength(1)
      expect(kinds('message')).toEqual([])
      expect(order).toEqual([])
      expect(inboxChanges).toBe(0)
    })
  })

  it('notify fills raw template, cuts to 80/200, calls message', async () => {
    const w = flow([L('a', 'Write #LONG'), N('n', '{{steps.a.output}}!', 'B {{trigger.body.x}}{{input}}')], [e('t', 'a'), e('a', 'n')])
    const { id } = await runner.run(w, 'manual', { input: 'go' })
    await ended(id)
    const r = await getRun(id)
    const [msg] = kinds('message') as { workflowId: string; runId: string; title: string; body?: string }[]
    expect(msg).toMatchObject({ workflowId: 'w1', runId: id })
    expect(msg!.title).toBe('L'.repeat(80))
    expect(msg!.body).toBe(`B ${'L'.repeat(198)}`)
    expect(msg!.title + msg!.body).not.toContain('<input')
    expect(only(r, 'n')).toMatchObject({ status: 'done', output: 'L'.repeat(500), port: 'out', missing: ['trigger.body.x'] })
    expect(r.status).toBe('done')
  })

  it('notify keeps 1 000 characters in the Inbox and the visit while the push body is cut at 200', async () => {
    const { id } = await runner.run(flow([N('n', 'T', 'y'.repeat(1_000))], [e('t', 'n')]), 'manual')
    await ended(id)
    const v = only(await getRun(id), 'n')
    const { messages: stored } = await messages.list()
    expect(stored[0]!.body).toBe('y'.repeat(1_000))
    expect(v.body).toBe('y'.repeat(1_000))
    const [msg] = kinds('message') as { body?: string }[]
    expect(msg!.body).toBe('y'.repeat(200))
  })

  it('notify cuts the Inbox body at 20 000 characters', async () => {
    // The template is short (it saves within its own cap); two copies of a 20 000-character input fill to 40 000.
    const { id } = await runner.run(flow([N('n', 'T', '{{input}}{{input}}')], [e('t', 'n')]), 'manual', { input: 'z'.repeat(20_000) })
    await ended(id)
    const v = only(await getRun(id), 'n')
    expect(v.body).toBe('z'.repeat(20_000))
    expect((await messages.list()).messages[0]!.body).toBe('z'.repeat(20_000))
    expect((kinds('message') as { body?: string }[])[0]!.body).toBe('z'.repeat(200))
  })

  it('notify leaves a short body unchanged everywhere', async () => {
    const { id } = await runner.run(flow([N('n', 'T', 'short')], [e('t', 'n')]), 'manual')
    await ended(id)
    expect(only(await getRun(id), 'n').body).toBe('short')
    expect((await messages.list()).messages[0]!.body).toBe('short')
    expect((kinds('message') as { body?: string }[])[0]!.body).toBe('short')
  })

  it('loop with condition always no fails at visit 20 with Ran too many times', async () => {
    const w = flow(
      [L('a', 'Poll'), C('c', 'Released?'), L('end', 'End')],
      [e('t', 'a'), e('a', 'c'), e('c', 'a', 'no'), e('c', 'end', 'yes')]
    )
    const { id } = await runner.run(w, 'schedule')
    await ended(id)
    const r = await getRun(id)
    const polls = visitsOf(r, 'a')
    expect(polls.filter((v) => v.status === 'done')).toHaveLength(20)
    expect(polls.at(-1)).toMatchObject({ status: 'failed', error: 'Ran too many times', n: 21, input: 'out:Poll' })
    expect(visitsOf(r, 'c').filter((v) => v.status === 'done')).toHaveLength(20)
    expect(visitsOf(r, 'end')).toEqual([])
    expect(r).toMatchObject({ status: 'failed', error: 'Ran too many times', halted: true })
    expect(kinds('failed')).toEqual([{ workflowId: 'w1', runId: id, name: 'Release flow' }])
  })

  it('retry after cap gives 20 more visits', async () => {
    // A self-loop, so only one step counts.
    const w = flow([C('c', 'Released?'), L('end', 'End')], [e('t', 'c'), e('c', 'c', 'no'), e('c', 'end', 'yes')])
    const { id } = await runner.run(w, 'manual', { input: 'v1' })
    await ended(id)
    let r = await getRun(id)
    const capped = visitsOf(r, 'c').at(-1)!
    expect(capped).toMatchObject({ status: 'failed', error: 'Ran too many times' })
    expect(visitsOf(r, 'c').filter((v) => v.status === 'done')).toHaveLength(20)
    const visitsAtRetry = r.visits.length

    await runner.retry(id, capped.id)
    await ended(id)
    r = await getRun(id)
    expect(visitsOf(r, 'c').filter((v) => v.status === 'done')).toHaveLength(40)
    expect(visitsOf(r, 'c').at(-1)).toMatchObject({ status: 'failed', error: 'Ran too many times' })
    expect(r.allowance.total).toBe(visitsAtRetry + 200)
    expect(r.status).toBe('failed')
    expect(kinds('failed')).toHaveLength(2)
    await expect(runner.retry(id, capped.id)).rejects.toThrow('Only a failed step can be retried') // no longer the step's latest
  })

  it('one retry after the cap of a two-step loop runs both steps 20 more rounds', async () => {
    const w = flow(
      [L('a', 'Poll'), C('c', 'Released?'), L('end', 'End')],
      [e('t', 'a'), e('a', 'c'), e('c', 'a', 'no'), e('c', 'end', 'yes')]
    )
    const { id } = await runner.run(w, 'schedule')
    await ended(id)
    const capped = visitsOf(await getRun(id), 'a').at(-1)!
    expect(capped).toMatchObject({ status: 'failed', error: 'Ran too many times', n: 21 })
    await runner.retry(id, capped.id)
    await ended(id)
    const r = await getRun(id)
    // The check was at its allowance too, so it gets 20 more as well instead of failing at once.
    expect(visitsOf(r, 'a').filter((v) => v.status === 'done')).toHaveLength(40)
    expect(visitsOf(r, 'c').filter((v) => v.status === 'done')).toHaveLength(40)
    expect(visitsOf(r, 'a').at(-1)).toMatchObject({ status: 'failed', error: 'Ran too many times', n: 42 })
    expect(r.status).toBe('failed')
  })

  it('failed llm halts new starts, run failed, notify.failed called', async () => {
    const w = flow(
      [L('a', 'Broken #FAIL'), L('b', 'After broken'), L('s', 'Slow #GATE'), L('x', 'After slow')],
      [e('t', 'a'), e('a', 'b'), e('t', 's'), e('s', 'x')]
    )
    const { id } = await runner.run(w, 'manual', { input: 'go' })
    await waitFor(async () => visitsOf(await getRun(id), 'a')[0]?.status === 'failed', 'a to fail')
    let r = await getRun(id)
    expect(r).toMatchObject({ status: 'running', halted: true }) // the slow branch still runs
    expect(kinds('failed')).toEqual([])
    gate.open()
    await ended(id)
    r = await getRun(id)
    expect(only(r, 's').status).toBe('done') // what was running finishes and records its output
    expect(visitsOf(r, 'x')).toEqual([]) // but nothing new starts
    expect(visitsOf(r, 'b')).toEqual([])
    expect(only(r, 'a')).toMatchObject({ status: 'failed', error: 'The model call failed' })
    expect(r).toMatchObject({ status: 'failed', error: 'The model call failed' })
    expect(kinds('failed')).toEqual([{ workflowId: 'w1', runId: id, name: 'Release flow' }])
  })

  it('retry of failed llm resumes and run ends done', async () => {
    const w = flow([L('a', 'Shaky #FLAKY'), L('b', 'Next')], [e('t', 'a'), e('a', 'b')])
    const { id } = await runner.run(w, 'manual', { input: 'go' })
    await ended(id)
    let r = await getRun(id)
    expect(r.status).toBe('failed')
    const failed = only(r, 'a')
    await expect(runner.retry(id, only(r, 't').id)).rejects.toThrow('Only a failed step can be retried')

    await runner.retry(id, failed.id)
    await ended(id)
    r = await getRun(id)
    const tries = visitsOf(r, 'a')
    expect(tries.map((v) => v.status)).toEqual(['failed', 'done'])
    expect(tries[1]).toMatchObject({ n: 2, input: failed.input, inputs: failed.inputs })
    expect(only(r, 'b').status).toBe('done')
    expect(r.status).toBe('done')
    expect(r.error).toBeUndefined()
    expect(r.halted).toBe(false)
  })

  it('stopRun stops waits and approvals silently and clears notification', async () => {
    const w = flow([W('w', 5), P('p', 'Ship?'), L('h', 'Think #HANG')], [e('t', 'w'), e('t', 'p'), e('t', 'h')])
    const { id } = await runner.run(w, 'manual', { input: 'go' })
    await waitFor(() => llmPrompts.length === 1, 'the call to start')
    expect((await getRun(id)).status).toBe('waiting')
    const timer = live(timers)[0]!

    await runner.stopRun(id)
    const r = await getRun(id)
    expect(r).toMatchObject({ status: 'stopped', endedAt: NOW })
    expect(r.visits.filter((v) => v.stepId !== 't').map((v) => v.status)).toEqual(['stopped', 'stopped', 'stopped'])
    expect(timer.cleared).toBe(true)
    expect(llmPrompts[0]!.signal.aborted).toBe(true)
    expect(kinds('cleared')).toEqual([id])
    expect(kinds('failed')).toEqual([])
    expect(runner.waitingRuns()).toBe(0)

    timer.fn() // a stale timer finds nothing to do
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect((await getRun(id)).visits.filter((v) => v.stepId !== 't').map((v) => v.status)).toEqual(['stopped', 'stopped', 'stopped'])
    await runner.stopRun(id) // an ended run: nothing to stop
    expect(kinds('cleared')).toEqual([id])
  })

  it('stopAllOf stops every unfinished run of that workflow and clears their notifications', async () => {
    const steps = [P('p', 'Ship?')]
    const w1 = flow(steps, [e('t', 'p')])
    const w2 = flow(steps, [e('t', 'p')], { id: 'w2', name: 'Other' })
    const a = await runner.run(w1, 'manual')
    const b = await runner.run(w1, 'schedule')
    const c = await runner.run(w2, 'manual')
    expect(runner.waitingRuns()).toBe(3)

    await runner.stopAllOf('w1')
    expect((await getRun(a.id)).status).toBe('stopped')
    expect((await getRun(b.id)).status).toBe('stopped')
    expect((await getRun(c.id)).status).toBe('waiting')
    expect((kinds('cleared') as string[]).sort()).toEqual([a.id, b.id].sort())
    expect(runner.waitingRuns()).toBe(1)
    await expect(runner.approve(a.id, only(await getRun(a.id), 'p').id, { ok: true })).rejects.toThrow('Already answered')
    // Delete follows: a late trigger must not start an orphan run that would wait and notify.
    await expect(runner.run(w1, 'webhook', { call: { method: 'POST', query: {}, body: {}, receivedAt: 1 } })).rejects.toThrow()
    expect((await store.runs()).w1).toHaveLength(2)
  })

  it('a retry racing a delete leaves no orphan run, approval or notification', async () => {
    const w = flow([P('p', 'Ship?')], [e('t', 'p'), e('p', 'p', 'approved')])
    await store.put(w)
    await store.addRun({
      id: 'run-capped',
      workflowId: 'w1',
      via: 'manual',
      late: false,
      status: 'failed',
      error: 'Ran too many times',
      snapshot: { steps: w.steps, edges: w.edges },
      visits: [
        { id: 'vt', stepId: 't', n: 1, status: 'done', input: '', inputs: [], output: 'in', port: 'out', startedAt: NOW, endedAt: NOW },
        {
          id: 'vp',
          stepId: 'p',
          n: 21,
          status: 'failed',
          input: 'in',
          inputs: [{ edgeId: 't-out-p', from: 't', text: 'in' }],
          error: 'Ran too many times',
          startedAt: NOW,
          endedAt: NOW
        }
      ],
      inbox: {},
      allowance: { perStep: {}, total: 200 },
      halted: true,
      startedAt: NOW,
      endedAt: NOW
    })
    // Retry is held past its checks (reading the workflow's name) while the delete runs.
    const held = deferred()
    const get = vi.spyOn(store, 'get').mockImplementationOnce(async () => {
      await held.wait
      return w
    })
    const retrying = runner.retry('run-capped', 'vp')
    await waitFor(() => get.mock.calls.length === 1, 'retry to reach the name read')
    await runner.stopAllOf('w1')
    held.open()
    await expect(retrying).rejects.toThrow('Only a failed step can be retried')

    const r = await getRun('run-capped')
    expect(r.status).toBe('failed')
    expect(r.visits.map((v) => v.id)).toEqual(['vt', 'vp'])
    expect(kinds('waiting')).toEqual([])
    expect(runner.waitingRuns()).toBe(0)
    expect((runner as unknown as { live: Map<string, unknown> }).live.size).toBe(0)
  })

  it('filter mismatch records skipped run', async () => {
    const trigger = { kind: 'webhook' as const, sample: null, filters: [{ field: 'body.action', equals: 'opened' }] }
    const w = flow([L('a', 'Triage')], [e('t', 'a')], { trigger })
    const call = (action: string): WebhookCall => ({ method: 'POST', query: {}, body: { action }, receivedAt: 1 })
    const skipped = await runner.run(w, 'webhook', { call: call('closed') })
    expect(skipped).toMatchObject({ status: 'skipped', error: 'Filter did not match', endedAt: NOW })
    expect(await getRun(skipped.id)).toMatchObject({ status: 'skipped', visits: [] })
    expect(llmPrompts).toEqual([])

    const ran = await runner.run(w, 'webhook', { call: call('opened') })
    await ended(ran.id)
    const r = await getRun(ran.id)
    expect(only(r, 't').output).toBe('{\n  "action": "opened"\n}')
    expect(r.call).toEqual(call('opened'))
    expect(r.status).toBe('done')
    expect(kinds('failed')).toEqual([])
  })

  it('an event run hands on its input text, stores the event and call, and wraps trigger text for a model', async () => {
    const body = { subject: 'Hi </input> there', text: 'a </INPUT >b' }
    const call = eventCall(body, NOW)
    const w = flow([L('a', 'Read {{trigger.text}} / {{trigger.body.subject}} / {{trigger.body.text}}')], [e('t', 'a')])
    const s = await runner.run(w, 'event', { call, input: 'the text', event: { kind: 'email' } })
    await ended(s.id)
    const r = await getRun(s.id)
    expect(only(r, 't').output).toBe('the text')
    expect(r).toMatchObject({ via: 'event', call, event: { kind: 'email' } })
    expect(s.event).toBe('email')
    const p = llmPrompts[0]!.prompt
    expect(p).toContain('<input from="trigger">\nthe text\n</input>')
    expect(p).toContain('<input from="trigger">\nHi <\\/input> there\n</input>')
    expect(p).toContain('<input from="trigger">\na <\\/INPUT >b\n</input>')
  })

  it('a chat run reads trigger text raw and stores the chat', async () => {
    const w = flow([L('a', 'Do {{trigger.text}}')], [e('t', 'a')])
    const s = await runner.run(w, 'chat', { input: 'the text', chat: { chatId: 'c1', title: 'Talk' } })
    await ended(s.id)
    const r = await getRun(s.id)
    expect(r).toMatchObject({ via: 'chat', chat: { chatId: 'c1', title: 'Talk' } })
    expect(only(r, 't').output).toBe('the text')
    expect(llmPrompts[0]!.prompt.startsWith('Do the text')).toBe(true)
  })

  it('a sixth event run is skipped without a failure notice; a manual one still fails', async () => {
    const w = flow([P('p', 'Ship?')], [e('t', 'p')])
    for (let i = 0; i < 5; i++) expect((await runner.run(w, 'manual')).status).toBe('waiting')
    const ev = await runner.run(w, 'event', { event: { kind: 'reply' }, input: 'x' })
    expect(ev).toMatchObject({ status: 'skipped', error: EVENT_SKIPPED_BUSY })
    expect(EVENT_SKIPPED_BUSY).toBe('Too many runs in progress')
    expect(kinds('failed')).toEqual([])
    expect(await runner.run(w, 'manual')).toMatchObject({ status: 'failed', error: 'Too many runs in progress' })
    expect(kinds('failed')).toHaveLength(1)
  })

  it('busy is true while a run is unfinished', async () => {
    const w = flow([P('p', 'Ship?')], [e('t', 'p')])
    expect(runner.busy('w1')).toBe(false)
    const s = await runner.run(w, 'manual')
    expect(runner.busy('w1')).toBe(true)
    await runner.approve(s.id, only(await getRun(s.id), 'p').id, { ok: true })
    await ended(s.id)
    expect(runner.busy('w1')).toBe(false)
  })

  it('freeRuns counts the run slots left under the active-run cap', async () => {
    const w = flow([P('p', 'Ship?')], [e('t', 'p')])
    expect(runner.freeRuns('w1')).toBe(5)
    for (let i = 0; i < 5; i++) await runner.run(w, 'manual')
    expect(runner.freeRuns('w1')).toBe(0)
    expect(runner.freeRuns('w2')).toBe(5)
  })

  it("activeDepths lists the chain depth of other workflows' unfinished runs (0 for a run no event started)", async () => {
    const w = flow([P('p', 'Ship?')], [e('t', 'p')])
    const w2 = { ...w, id: 'w2' }
    const a = await runner.run(w, 'event', { event: { kind: 'inbox', depth: 2 }, input: 'x' })
    await runner.run(w2, 'manual')
    await runner.run(w2, 'event', { event: { kind: 'reply' }, input: 'x' })
    expect(runner.activeDepths('w3').sort()).toEqual([0, 0, 2])
    expect(runner.activeDepths('w2')).toEqual([2])
    expect(runner.activeDepths('w1')).toEqual([0, 0])
    await runner.approve(a.id, only(await getRun(a.id), 'p').id, { ok: true })
    await ended(a.id)
    expect(runner.activeDepths('w2')).toEqual([])
  })

  it('endedRecently holds for a window after a run of the workflow ended, and not while one runs', async () => {
    let clock = NOW
    runner = makeRunner({ now: () => clock })
    const w = flow([P('p', 'Ship?')], [e('t', 'p')])
    expect(runner.endedRecently('w1', 2000)).toBe(false)
    const s = await runner.run(w, 'manual')
    expect(runner.endedRecently('w1', 2000)).toBe(false)
    clock = NOW + 5000
    await runner.approve(s.id, only(await getRun(s.id), 'p').id, { ok: true })
    await ended(s.id)
    clock = NOW + 6999
    expect(runner.endedRecently('w1', 2000)).toBe(true)
    expect(runner.endedRecently('w2', 2000)).toBe(false)
    clock = NOW + 7000
    expect(runner.endedRecently('w1', 2000)).toBe(false)
    // A stopped run counts too: its agent may have written up to the Stop.
    const t = await runner.run(w, 'manual')
    clock = NOW + 9000
    await runner.stopRun(t.id)
    clock = NOW + 9500
    expect(runner.endedRecently('w1', 2000)).toBe(true)
  })

  it('an event workflow with problems pushes its failure once per streak, not on every event', async () => {
    const trigger = { kind: 'file' as const, path: '/gone', pattern: '', changes: ['added' as const], filters: [] }
    const w = flow([N('n', 'x')], [e('t', 'n')], { trigger })
    missingDirs.add('/gone')
    const ev = () => runner.run(w, 'event', { event: { kind: 'file', depth: 1 }, input: '/gone/a' })
    expect(await ev()).toMatchObject({ status: 'failed', error: PROBLEMS_TEXT })
    expect(kinds('failed')).toHaveLength(1)
    expect(await ev()).toMatchObject({ status: 'failed', error: PROBLEMS_TEXT })
    expect(await ev()).toMatchObject({ status: 'failed', error: PROBLEMS_TEXT })
    expect(kinds('failed')).toHaveLength(1)
    // Fixed, a run goes through; broken again, the next event's failure is news.
    missingDirs.delete('/gone')
    await ended((await ev()).id)
    missingDirs.add('/gone')
    await ev()
    expect(kinds('failed')).toHaveLength(2)
    // A schedule run is not an event: each one still tells.
    await runner.run(w, 'schedule')
    expect(kinds('failed')).toHaveLength(3)
  })

  it("problems asks for the full folder path when a file trigger's path is relative", async () => {
    const w = (path: string) =>
      flow([N('n', 'x')], [e('t', 'n')], { trigger: { kind: 'file', path, pattern: '', changes: ['added'], filters: [] } })
    const relative = [{ stepId: 't', text: 'Use the full folder path, like /home/you/invoices' }]
    expect(await runner.problems(w('~/invoices'))).toEqual(relative)
    expect(await runner.problems(w('invoices'))).toEqual(relative)
    expect(await runner.problems(w('./invoices'))).toEqual(relative)
    expect(await runner.problems(w(''))).toEqual([{ stepId: 't', text: 'Folder not found' }])
    expect(await runner.problems(w('/here'))).toEqual([])
  })

  it('problems names a missing file folder, a missing mail account and a blank host', async () => {
    const file = (path: string) => ({ kind: 'file' as const, path, pattern: '', changes: ['added' as const], filters: [] })
    const mail = (account: string, host: string) => ({ kind: 'email' as const, account, host, port: 993, folder: 'INBOX', filters: [] })
    const w = (trigger: Workflow['trigger']) => flow([N('n', 'x')], [e('t', 'n')], { trigger })
    const tid = 't'
    missingDirs.add('/gone')
    expect(await runner.problems(w(file('/gone')))).toEqual([{ stepId: tid, text: 'Folder not found' }])
    expect(await runner.problems(w(file('')))).toEqual([{ stepId: tid, text: 'Folder not found' }])
    expect(await runner.problems(w(file('/here')))).toEqual([])
    expect(await runner.problems(w(mail('acc', 'imap.example.com')))).toEqual([{ stepId: tid, text: ACCOUNT_MISSING }])
    expect(await runner.problems(w(mail('acc', '')))).toEqual([
      { stepId: tid, text: ACCOUNT_MISSING },
      { stepId: tid, text: 'Enter the mail server' }
    ])
    mailAccounts.add('acc')
    expect(await runner.problems(w(mail('acc', 'imap.example.com')))).toEqual([])
    expect(await runner.problems(w(mail('acc', '')))).toEqual([{ stepId: tid, text: 'Enter the mail server' }])
  })

  it('sixth unfinished run fails with Too many runs in progress', async () => {
    const w = flow([P('p', 'Ship?')], [e('t', 'p')])
    for (let i = 0; i < 5; i++) expect((await runner.run(w, 'manual')).status).toBe('waiting')
    const sixth = await runner.run(w, 'schedule')
    expect(sixth).toMatchObject({ status: 'failed', error: 'Too many runs in progress' })
    expect(await getRun(sixth.id)).toMatchObject({ status: 'failed', visits: [] })
    // Finishing one frees a slot.
    const first = (await store.runs()).w1!.find((x) => x.status === 'waiting')!
    await runner.approve(first.id, only(first, 'p').id, { ok: true })
    await ended(first.id)
    expect((await runner.run(w, 'manual')).status).toBe('waiting')
  })

  it('run refuses a workflow with problems', async () => {
    const empty = flow([L('a', '  ')], [e('t', 'a')])
    await expect(runner.run(empty, 'manual')).rejects.toThrow('This workflow has problems: fix them before running')
    expect(await store.runs()).toEqual({})

    const agentStep: Step = { ...base('g', 'Agent'), kind: 'agent', agent: 'alpha', prompt: 'Do it', cwd: '/gone' }
    missingDirs.add('/gone')
    const noFolder = flow([agentStep], [e('t', 'g')])
    await expect(runner.run(noFolder, 'manual')).rejects.toThrow('This workflow has problems: fix them before running')

    // A chat run is the user asking, so it throws too, and stores nothing.
    await expect(runner.run(noFolder, 'chat', { input: 'x', chat: { chatId: 'c1', title: 'Talk' } })).rejects.toThrow(
      'This workflow has problems: fix them before running'
    )

    const scheduled = await runner.run(noFolder, 'schedule')
    expect(scheduled).toMatchObject({ status: 'failed', error: 'This workflow has problems: fix them before running' })
    expect(await getRun(scheduled.id)).toMatchObject({ status: 'failed', visits: [] })
    expect(kinds('failed')).toEqual([{ workflowId: 'w1', runId: scheduled.id, name: 'Release flow' }])
  })

  it('edits to the workflow do not change a running run', async () => {
    const w = flow([P('p', 'Ship?'), L('a', 'Old prompt')], [e('t', 'p'), e('p', 'a', 'approved')])
    await store.put(w)
    const starting = runner.run(w, 'manual', { input: 'draft' })
    // The caller's own object changes while the start is still checking, and the workflow is saved mid-approval:
    // the run keeps the copy it took.
    const a = w.steps[2] as Extract<Step, { kind: 'llm' }>
    a.prompt = 'Mutated prompt'
    const { id } = await starting
    await store.put({ ...w, steps: [T(), P('p', 'Ship?'), L('a', 'New prompt')], updatedAt: 2 })
    await runner.approve(id, only(await getRun(id), 'p').id, { ok: true })
    await ended(id)
    expect(llmPrompts[0]!.prompt.split('\n')[0]).toBe('Old prompt')
    expect((await getRun(id)).snapshot.steps.find((s) => s.id === 'a')).toMatchObject({ prompt: 'Old prompt' })
  })

  it("a run snapshots the workflow's notes, and a later edit of a note does not change it", async () => {
    const note = { id: 'n1', x: 1, y: 2, width: 240, height: 160, color: 1 as const, text: 'Old note' }
    const w = flow([L('a', 'Go')], [e('t', 'a')], { notes: [{ ...note }] })
    await store.put(w)
    const starting = runner.run(w, 'manual')
    // The caller's own note object changes in place while the start is still checking (as the step test above does),
    // and the workflow is saved with another: a snapshot that aliased the notes would show either.
    w.notes![0]!.text = 'Mutated note'
    const { id } = await starting
    await store.put({ ...w, notes: [{ ...note, text: 'New note' }], updatedAt: 2 })
    await ended(id)
    expect((await getRun(id)).snapshot.notes).toEqual([{ id: 'n1', x: 1, y: 2, width: 240, height: 160, color: 1, text: 'Old note' }])
  })

  it("a run snapshots the workflow's groups, and a later edit of a group does not change it", async () => {
    const group = { id: 'g1', name: 'Old name', steps: ['a'], notes: [] as string[] }
    const w = flow([L('a', 'Go')], [e('t', 'a')], { groups: [{ ...group, steps: [...group.steps] }] })
    await store.put(w)
    const starting = runner.run(w, 'manual')
    // The caller's own group object changes in place while the start is still checking, and the workflow is saved with
    // another: a snapshot that aliased the groups (or their member lists) would show either.
    w.groups![0]!.name = 'Mutated name'
    w.groups![0]!.steps.push('mutated')
    const { id } = await starting
    await store.put({ ...w, groups: [{ ...group, name: 'New name' }], updatedAt: 2 })
    await ended(id)
    expect((await getRun(id)).snapshot.groups).toEqual([group])
  })

  it('a run of a workflow with no groups snapshots none, and groups never reach a step', async () => {
    const w = flow([L('a', 'Go')], [e('t', 'a')])
    const { id } = await runner.run(w, 'manual')
    await ended(id)
    expect((await getRun(id)).snapshot.groups).toEqual([])
  })

  it('limit result waits until reset and reruns, fails after 5', async () => {
    const w = flow([L('a', 'Busy #LIMIT')], [e('t', 'a')])
    const { id } = await runner.run(w, 'manual')
    await waitFor(() => live(timers).length === 1, 'the limit wait')
    const visit = only(await getRun(id), 'a')
    expect(visit).toMatchObject({ status: 'running', until: NOW + 1000 + 60_000 })
    expect(live(timers)[0]!.ms).toBe(61_000)
    expect((await getRun(id)).status).toBe('running')
    for (let wait = 1; wait <= 5; wait++) {
      await waitFor(() => live(timers).length === 1, `wait ${wait}`)
      fireAll()
      await waitFor(() => llmPrompts.length === wait + 1, `rerun ${wait}`)
    }
    await ended(id)
    const r = await getRun(id)
    expect(llmPrompts).toHaveLength(6)
    expect(only(r, 'a')).toMatchObject({ id: visit.id, status: 'failed', error: 'Usage limit reached' })
    expect(r.status).toBe('failed')

    const unknown = flow([L('a', 'Busy #LIMITNULL')], [e('t', 'a')], { id: 'w2' })
    const second = await runner.run(unknown, 'manual')
    await ended(second.id)
    expect(only(await getRun(second.id), 'a')).toMatchObject({ status: 'failed', error: 'Usage limit reached' })
  })

  it('recover reruns a running llm visit, re-arms wait, keeps approval', async () => {
    const steps: Step[] = [T(), L('l', 'Again'), W('w', 2), P('p', 'Ship?'), N('n', 'Hello')]
    const w = flow(steps.slice(1), [e('t', 'l'), e('t', 'w'), e('t', 'p'), e('t', 'n')])
    await store.put(w)
    const v = (id: string, stepId: string, status: Visit['status'], extra: Partial<Visit> = {}): Visit => ({
      id,
      stepId,
      n: 1,
      status,
      input: 'in',
      inputs: [{ edgeId: `t-out-${stepId}`, from: 't', text: 'in' }],
      startedAt: NOW - 1000,
      ...extra
    })
    const saved: WorkflowRun = {
      id: 'run-old',
      workflowId: 'w1',
      via: 'manual',
      late: false,
      status: 'waiting',
      input: 'in',
      snapshot: { steps: w.steps, edges: w.edges },
      visits: [
        { ...v('vt', 't', 'done'), inputs: [], input: '', output: 'in', port: 'out', endedAt: NOW - 1000 },
        v('vl', 'l', 'running'),
        v('vw', 'w', 'running', { until: NOW + 120_000 }),
        v('vp', 'p', 'waiting'),
        v('vn', 'n', 'running')
      ],
      inbox: {},
      allowance: { perStep: {}, total: 200 },
      halted: false,
      startedAt: NOW - 1000
    }
    await store.addRun(saved)

    const fresh = makeRunner()
    await fresh.recover()
    await waitFor(async () => visitsOf(await getRun('run-old'), 'l')[0]?.status === 'done', 'the rerun')
    let r = await getRun('run-old')
    expect(visitsOf(r, 'l')).toEqual([expect.objectContaining({ id: 'vl', status: 'done', output: 'out:Again' })])
    expect(llmPrompts).toHaveLength(1)
    expect(only(r, 'w')).toMatchObject({ id: 'vw', status: 'running' })
    expect(live(timers).map((t) => t.ms)).toEqual([120_000])
    expect(only(r, 'p')).toMatchObject({ id: 'vp', status: 'waiting' })
    expect(only(r, 'n')).toMatchObject({ id: 'vn', status: 'done', output: 'in' })
    expect(kinds('message')).toEqual([]) // a duplicate is worse than a missing one
    expect(kinds('waiting')).toEqual([])
    expect(r.status).toBe('waiting')
    expect(fresh.waitingRuns()).toBe(1)

    fireAll()
    await waitFor(async () => only(await getRun('run-old'), 'w').status === 'done', 'the wait')
    await fresh.approve('run-old', 'vp', { ok: true })
    await ended('run-old')
    r = await getRun('run-old')
    expect(r.status).toBe('done')
    fresh.stop()
  })

  it('recover moves on a run the server left between writing it and starting its first steps', async () => {
    const w = flow([L('a', 'First'), L('b', 'Second')], [e('t', 'a'), e('a', 'b')])
    await store.put(w)
    // addRun landed, the first advance never did: the trigger is done and its output waits at a's door.
    await store.addRun({
      id: 'run-cut',
      workflowId: 'w1',
      via: 'manual',
      late: false,
      status: 'running',
      input: 'go',
      snapshot: { steps: w.steps, edges: w.edges },
      visits: [
        { id: 'vt', stepId: 't', n: 1, status: 'done', input: '', inputs: [], output: 'go', port: 'out', startedAt: NOW, endedAt: NOW }
      ],
      inbox: { a: [{ edgeId: 't-out-a', from: 't', text: 'go' }] },
      allowance: { perStep: {}, total: 200 },
      halted: false,
      startedAt: NOW
    })
    const fresh = makeRunner()
    await fresh.recover()
    await ended('run-cut')
    const r = await getRun('run-cut')
    expect(only(r, 'a')).toMatchObject({ status: 'done', input: 'go', output: 'out:First' })
    expect(only(r, 'b')).toMatchObject({ status: 'done', output: 'out:Second' })
    expect(r).toMatchObject({ status: 'done', inbox: { a: [], b: [] } })
    fresh.stop()
  })

  it('testStep llm returns output without storing a run', async () => {
    const w = flow([L('a', 'Summarize {{input}}'), C('c', 'Good?'), W('w', 3)], [e('t', 'a'), e('a', 'c'), e('c', 'w', 'yes')])
    const out = await runner.testStep(w, 'a', 'some text')
    expect(out).toEqual({ output: 'out:Summarize <input from="Test input">' })
    expect(llmPrompts[0]!.prompt).toBe('Summarize <input from="Test input">\nsome text\n</input>')
    expect(await runner.testStep(w, 'c', 'YES it is')).toEqual({ output: 'YES it is', port: 'yes', reason: 'said yes' })
    await expect(runner.testStep(w, 'w', 'x')).rejects.toThrow('This step has no test')
    expect(await store.runs()).toEqual({})
    expect(changed).not.toHaveBeenCalled()
  })

  it("testStep on an event workflow fills {{trigger.body.…}} from the kind's sample, as material", async () => {
    const trigger = { kind: 'email' as const, account: '', host: '', port: 993, folder: 'INBOX', filters: [] }
    const w = flow([L('a', 'Reply to {{trigger.body.subject}} from {{trigger.body.from.address}}')], [e('t', 'a')], { trigger })
    expect(await runner.testStep(w, 'a', '')).toEqual({ output: expect.any(String) })
    const p = llmPrompts[0]!.prompt
    expect(p).toContain(`<input from="trigger">\n${EVENT_SAMPLES.email.subject}\n</input>`)
    expect(p).toContain(`<input from="trigger">\n${EVENT_SAMPLES.email.from.address}\n</input>`)
    // A file workflow's sample too, so a field reads in a test as it will in a run.
    const f = flow([L('b', 'Read {{trigger.body.files.0.name}}')], [e('t', 'b')], {
      trigger: { kind: 'file', path: '/x', pattern: '', changes: ['added'], filters: [] }
    })
    await runner.testStep(f, 'b', '')
    expect(llmPrompts[1]!.prompt).toContain(`<input from="trigger">\n${EVENT_SAMPLES.file.files[0]!.name}\n</input>`)
  })
})

describe('startup gate', () => {
  // A run left by the last server: its LLM visit was running, so recover() asks again.
  const leftover = async (runId = 'run-old'): Promise<Workflow> => {
    const w = flow([L('l', 'Again'), P('p', 'Ship?')], [e('t', 'l'), e('t', 'p')])
    await store.put(w)
    const v = (id: string, stepId: string, status: Visit['status']): Visit => ({
      id,
      stepId,
      n: 1,
      status,
      input: 'in',
      inputs: [{ edgeId: `t-out-${stepId}`, from: 't', text: 'in' }],
      startedAt: NOW - 1000
    })
    await store.addRun({
      id: runId,
      workflowId: 'w1',
      via: 'manual',
      late: false,
      status: 'waiting',
      input: 'in',
      snapshot: { steps: w.steps, edges: w.edges },
      visits: [
        {
          id: 'vt',
          stepId: 't',
          n: 1,
          status: 'done',
          input: '',
          inputs: [],
          output: 'in',
          port: 'out',
          startedAt: NOW - 1000,
          endedAt: NOW - 1000
        },
        v('vl', 'l', 'running'),
        v('vp', 'p', 'waiting')
      ],
      inbox: {},
      allowance: { perStep: {}, total: 200 },
      halted: false,
      startedAt: NOW - 1000
    })
    return w
  }
  const settled = () => new Promise((resolve) => setTimeout(resolve, 20))

  it('run waits for recover(), then starts; recover never re-runs what the run started', async () => {
    const w = await leftover()
    const fresh = makeRunner()
    fresh.holdUntilRecovered()
    let started = false
    const pending = fresh.run(flow([L('a', 'New')], [e('t', 'a')], { id: 'w2' }), 'webhook').then((s) => {
      started = true
      return s
    })
    await settled()
    expect(started).toBe(false)
    expect((await store.runs()).w2).toBeUndefined()
    expect(llmPrompts).toEqual([])
    await fresh.recover()
    const { id } = await pending
    await ended(id)
    // One call each: the leftover's re-ask and the new run's, never the new run's twice.
    expect(llmPrompts.map((p) => p.prompt.split('\n')[0])).toEqual(['Again', 'New'])
    expect(only(await getRun(id), 'a')).toMatchObject({ status: 'done', output: 'out:New' })
    expect(w.id).toBe('w1')
    fresh.stop()
  })

  it('approve, retry and stopRun wait for recover() too', async () => {
    await leftover()
    const fresh = makeRunner()
    fresh.holdUntilRecovered()
    const done: string[] = []
    const approving = fresh.approve('run-old', 'vp', { ok: true }).then(() => done.push('approve'))
    const retrying = fresh.retry('run-old', 'vl').catch((err: Error) => {
      done.push(`retry: ${err.message}`)
    })
    await settled()
    expect(done).toEqual([])
    expect(only(await getRun('run-old'), 'p').status).toBe('waiting')
    await fresh.recover()
    await approving
    await retrying
    // The approval was answered once recovery had the run; vl was not failed, so it has nothing to retry.
    expect(done.sort()).toEqual(['approve', 'retry: Only a failed step can be retried'])
    expect(only(await getRun('run-old'), 'p')).toMatchObject({ status: 'done', port: 'approved' })

    await leftover('run-second')
    const other = makeRunner()
    other.holdUntilRecovered()
    let stopped = false
    const stopping = other.stopRun('run-second').then(() => {
      stopped = true
    })
    await settled()
    expect(stopped).toBe(false)
    expect((await getRun('run-second')).status).toBe('waiting')
    await other.recover()
    await stopping
    expect((await getRun('run-second')).status).toBe('stopped')
    fresh.stop()
    other.stop()
  })

  it('a delete during startup waits for recover(), then stops the runs it recovered', async () => {
    await leftover()
    const fresh = makeRunner()
    fresh.holdUntilRecovered()
    let deleted = false
    const deleting = fresh.stopAllOf('w1').then(() => {
      deleted = true
    })
    await settled()
    expect(deleted).toBe(false)
    await fresh.recover()
    await deleting
    expect((await getRun('run-old')).status).toBe('stopped')
    expect(fresh.waitingRuns()).toBe(0)
    fresh.stop()
  })

  it('a recover() that throws still opens the gate', async () => {
    const broken = makeRunner({
      store: Object.assign(Object.create(store) as WorkflowStore, {
        runs: async () => {
          throw new Error('disk gone')
        }
      })
    })
    broken.holdUntilRecovered()
    const pending = broken.run(flow([L('a', 'New')], [e('t', 'a')]), 'manual')
    await expect(broken.recover()).rejects.toThrow('disk gone')
    const { id } = await pending
    await ended(id)
    expect((await getRun(id)).status).toBe('done')
    broken.stop()
  })

  it('stop() opens the gate, so a shutdown during startup leaves no caller hanging', async () => {
    const fresh = makeRunner()
    fresh.holdUntilRecovered()
    let answered = false
    const pending = fresh.stopRun('no-such-run').then(() => {
      answered = true
    })
    await settled()
    expect(answered).toBe(false)
    fresh.stop()
    await pending
    expect(answered).toBe(true)
  })
})

describe('agent steps', () => {
  type AgentStep = Extract<Step, { kind: 'agent' }>
  const A = (id: string, prompt: string, extra: Partial<AgentStep> = {}): Step => ({
    ...base(id, id.toUpperCase()),
    kind: 'agent',
    agent: 'alpha',
    prompt,
    cwd: '/work',
    ...extra
  })
  const chatOf = async (chatId: string | undefined): Promise<ChatMeta> => (await chats.get(chatId!))!
  const startedTurn = () => waitFor(() => held.size === 1, 'the turn to start')

  it('agent step creates titled chat with workflow link and model, output is reply', async () => {
    const tool: ChatItem = { type: 'tool', id: 'tool-1', name: 'Bash', input: {}, result: 'ok', isError: false, blocked: false, ts: NOW }
    turns.push({ tail: () => [said('Looking into it'), tool, said('All fixed')] })
    const w = flow([A('g', 'Fix the bug', { model: 'sonnet' }), L('b', 'Announce')], [e('t', 'g'), e('g', 'b')])
    const { id } = await runner.run(w, 'manual', { input: 'bug 7' })
    await ended(id)
    const r = await getRun(id)
    const v = only(r, 'g')
    expect(v).toMatchObject({ status: 'done', output: 'All fixed', port: 'out', input: 'bug 7' })
    expect(await chatOf(v.chatId)).toMatchObject({
      agentName: 'alpha',
      cwd: '/work',
      title: 'Release flow · G · Nov 7',
      model: 'sonnet',
      workflow: { workflowId: 'w1', runId: id, stepId: 'g', name: 'Release flow' }
    })
    expect(sends).toEqual([
      { chatId: v.chatId, text: 'Fix the bug\n\n<input from="Start">\nbug 7\n</input>', messageId: v.messageId, from: 'routine' }
    ])
    expect(only(r, 'b').input).toBe('All fixed')
    expect(r.status).toBe('done')
    expect(kinds('failed')).toEqual([])

    // No model: the agent's own. The date is the workflow's own day, in its time zone; a long reply is cut.
    turns.push({ tail: () => [said('x'.repeat(50_010))] })
    const late = flow([A('g', 'Fix the bug')], [e('t', 'g')], { id: 'w2', name: 'Night', timeZone: 'Pacific/Honolulu' })
    const second = await runner.run(late, 'manual')
    await ended(second.id)
    const v2 = only(await getRun(second.id), 'g')
    expect(v2.output).toHaveLength(50_000)
    const chat = await chatOf(v2.chatId)
    expect(chat.title).toBe('Night · G · Nov 6')
    expect(chat.model).toBeUndefined()
  })

  it('a stored time zone this Node cannot read dates the chat title in UTC instead of failing the step', async () => {
    const { id } = await runner.run(flow([A('g', 'Work')], [e('t', 'g')], { timeZone: 'Mars/Olympus_Mons' }), 'manual')
    await ended(id)
    const v = only(await getRun(id), 'g')
    expect(v.status).toBe('done')
    expect((await chatOf(v.chatId)).title).toBe('Release flow · G · Nov 7')
  })

  it('agent chat archived after done, not after failure', async () => {
    turns.push({ tail: () => [said('Trying'), failure('Claude exited with code 1')] })
    const w = flow([A('g', 'Deploy')], [e('t', 'g')])
    const { id } = await runner.run(w, 'manual')
    await ended(id)
    let r = await getRun(id)
    const first = only(r, 'g')
    expect(first).toMatchObject({ status: 'failed', error: 'Claude exited with code 1' })
    expect(r).toMatchObject({ status: 'failed', error: 'Claude exited with code 1' })
    expect(kinds('failed')).toEqual([{ workflowId: 'w1', runId: id, name: 'Release flow' }])
    expect(isArchived(await chatOf(first.chatId))).toBe(false)
    expect(metaPushes).toEqual([])

    // Retry sends the step's prompt again into the same chat; done archives it.
    turns.push({ tail: () => [said('Deployed')] })
    await runner.retry(id, first.id)
    await ended(id)
    r = await getRun(id)
    const tries = visitsOf(r, 'g')
    expect(tries.map((v) => v.status)).toEqual(['failed', 'done'])
    expect(tries[1]).toMatchObject({ chatId: first.chatId, output: 'Deployed' })
    expect(tries[1]!.messageId).not.toBe(first.messageId)
    expect(sends.map((s) => [s.chatId, s.text])).toEqual([
      [first.chatId, 'Deploy'],
      [first.chatId, 'Deploy']
    ])
    const chat = await chatOf(first.chatId)
    expect(isArchived(chat)).toBe(true)
    expect(metaPushes).toEqual([chat]) // so the sidebar follows
    expect(r.status).toBe('done')
  })

  it('a kept agent step keeps its chat: not archived when done, linked with keep, titled by the step', async () => {
    turns.push({ tail: () => [said('Deployed')] })
    const { id } = await runner.run(flow([A('g', 'Deploy', { keep: true, title: 'Nightly deploy' })], [e('t', 'g')]), 'manual')
    await ended(id)
    const v = only(await getRun(id), 'g')
    expect(v.status).toBe('done')
    const chat = await chatOf(v.chatId)
    expect(chat.title).toBe('Nightly deploy')
    expect(chat.workflow).toMatchObject({ keep: true })
    expect(isArchived(chat)).toBe(false)
    expect(metaPushes).toEqual([])
  })

  it('an unkept agent step has no keep key on its link and the default title', async () => {
    turns.push({ tail: () => [said('ok')] })
    const { id } = await runner.run(flow([A('g', 'Deploy')], [e('t', 'g')]), 'manual')
    await ended(id)
    const chat = await chatOf(only(await getRun(id), 'g').chatId)
    expect(chat.workflow).not.toHaveProperty('keep')
    expect(chat.title).toBe('Release flow · G · Nov 7')
  })

  it('loop revisit sends into the same chat', async () => {
    turns.push({ tail: () => [said('Still NO release')] }, { tail: () => [said('Now YES, released')] })
    const w = flow(
      [A('g', 'Check the release'), C('c', 'Released?'), L('end', 'Announce')],
      [e('t', 'g'), e('g', 'c'), e('c', 'g', 'no'), e('c', 'end', 'yes')]
    )
    const { id } = await runner.run(w, 'manual', { input: 'v2' })
    await ended(id)
    const r = await getRun(id)
    const polls = visitsOf(r, 'g')
    expect(polls.map((v) => v.status)).toEqual(['done', 'done'])
    expect(polls[1]!.chatId).toBe(polls[0]!.chatId)
    expect(polls[1]!.messageId).not.toBe(polls[0]!.messageId)
    expect(sends.map((s) => s.chatId)).toEqual([polls[0]!.chatId, polls[0]!.chatId])
    expect(sends[1]!.text).toBe('Check the release\n\n<input from="C">\nStill NO release\n</input>')
    expect((await chats.list()).filter((c) => c.workflow?.runId === id)).toHaveLength(1)
    expect(only(r, 'end').input).toBe('Now YES, released')
    expect(isArchived(await chatOf(polls[0]!.chatId))).toBe(true)
    expect(r.status).toBe('done')
  })

  it('approval card push makes run waiting, then running', async () => {
    turns.push({ hold: true, tail: () => [said('Merged')] })
    const { id } = await runner.run(flow([A('g', 'Merge it')], [e('t', 'g')]), 'manual')
    await startedTurn()
    const chatId = only(await getRun(id), 'g').chatId!
    runner.chatPush({ chatId: 'some-other-chat', kind: 'approvals', pending: 1 })
    runner.chatPush({ chatId, kind: 'approvals', pending: 1 })
    await waitFor(async () => (await getRun(id)).status === 'waiting', 'the run to wait')
    expect(only(await getRun(id), 'g').status).toBe('waiting')
    expect(runner.waitingRuns()).toBe(1)
    expect(kinds('waiting')).toEqual([]) // the chat's own push notifies, as any chat's does

    runner.chatPush({ chatId, kind: 'approvals', pending: 0 })
    await waitFor(async () => (await getRun(id)).status === 'running', 'the run to run again')
    expect(only(await getRun(id), 'g').status).toBe('running')
    expect(runner.waitingRuns()).toBe(0)

    runner.chatPush({ chatId, kind: 'approvals', pending: 2 })
    await waitFor(async () => (await getRun(id)).status === 'waiting', 'a second card')
    await held.get(chatId)!() // the turn ends while a card still showed: the end wins
    await ended(id)
    expect(only(await getRun(id), 'g')).toMatchObject({ status: 'done', output: 'Merged' })
    expect(runner.waitingRuns()).toBe(0)
    expect(kinds('cleared')).toEqual([]) // only Approval steps send and clear the run's own notification
  })

  it('stopped turn fails step with Stopped', async () => {
    const cases: [NoticeKind, string][] = [
      ['stopped', 'Stopped'],
      ['interrupted', 'Interrupted by a restart']
    ]
    for (const [kind, text] of cases) {
      turns.push({ tail: () => [said('Half done'), notice(kind)] })
      const { id } = await runner.run(flow([A('g', 'Work')], [e('t', 'g')]), 'manual')
      await ended(id)
      const r = await getRun(id)
      expect(only(r, 'g')).toMatchObject({ status: 'failed', error: text })
      expect(r).toMatchObject({ status: 'failed', error: text })
      expect(isArchived(await chatOf(only(r, 'g').chatId))).toBe(false)
    }
    expect(kinds('failed')).toEqual([]) // the user stopped it, or the server went down: no news
  })

  describe('a paused turn', () => {
    const pausedStep = async (tail: () => ChatItem[] = () => [said('Half done'), notice('userPaused')]) => {
      turns.push({ tail })
      const { id } = await runner.run(flow([A('g', 'Work'), L('b', 'Announce')], [e('t', 'g'), e('g', 'b')]), 'manual')
      await waitFor(async () => only(await getRun(id), 'g').paused === true, 'the step to pause')
      return { id, chatId: only(await getRun(id), 'g').chatId! }
    }
    const settleQueue = () => new Promise((resolve) => setTimeout(resolve, 30))

    it("holds the step open, not failed, and Resume's Continue carries it on to done", async () => {
      const { id, chatId } = await pausedStep()
      let r = await getRun(id)
      expect(only(r, 'g')).toMatchObject({ status: 'running', paused: true })
      expect(only(r, 'g').error).toBeUndefined()
      expect(r.status).toBe('running')
      expect(visitsOf(r, 'b')).toEqual([])
      expect(kinds('failed')).toEqual([])
      expect(isArchived(await chatOf(chatId))).toBe(false)

      // Idle rounds and approval pushes while paused change nothing.
      runner.chatIdle(chatId)
      runner.chatPush({ chatId, kind: 'approvals', pending: 0 })
      await settleQueue()
      expect(only(await getRun(id), 'g')).toMatchObject({ status: 'running', paused: true })

      runner.chatResumed(chatId, 'resume-1')
      await waitFor(async () => only(await getRun(id), 'g').messageId === 'resume-1', 'the step to follow the Continue')
      const v = only(await getRun(id), 'g')
      expect(v).toMatchObject({ status: 'running', resumes: 1 })
      expect(v.paused).toBeUndefined()
      expect(runner.messagesOf(chatId)).toEqual(new Set(['resume-1']))

      await chats.saveItems(chatId, [
        ...(await chats.loadItems(chatId)),
        { type: 'user', id: 'resume-1', text: 'Continue', ts: NOW },
        said('Finished')
      ])
      runner.chatIdle(chatId)
      await ended(id)
      r = await getRun(id)
      expect(only(r, 'g')).toMatchObject({ status: 'done', output: 'Finished', resumes: 1 })
      expect(only(r, 'b').input).toBe('Finished')
      expect(r.status).toBe('done')
      expect(isArchived(await chatOf(chatId))).toBe(true)
    })

    it("fails the step silently 'Continued by hand' when the user sends a message of their own instead", async () => {
      const { id, chatId } = await pausedStep()
      await chats.saveItems(chatId, [
        ...(await chats.loadItems(chatId)),
        { type: 'user', id: 'by-hand', text: 'Do something else', ts: NOW },
        said('Ok')
      ])
      runner.chatIdle(chatId)
      await ended(id)
      expect(only(await getRun(id), 'g')).toMatchObject({ status: 'failed', error: 'Continued by hand' })
      expect(kinds('failed')).toEqual([])
    })

    it('a limit that ended a pausing turn waits for Resume, not for the reset', async () => {
      const { id } = await pausedStep(() => [said('Working'), failure('Usage limit reached', NOW + 1000), notice('userPaused')])
      const v = only(await getRun(id), 'g')
      expect(v).toMatchObject({ status: 'running', paused: true })
      expect(v.until).toBeUndefined()
      expect(live(timers)).toEqual([])
    })

    it('Stop ends the run without stopping the idle paused chat', async () => {
      const { id } = await pausedStep()
      await runner.stopRun(id)
      expect(only(await getRun(id), 'g').status).toBe('stopped')
      expect(stoppedChats).toEqual([])
    })

    it('recover keeps a paused step waiting for Resume', async () => {
      const { id, chatId } = await pausedStep()
      runner.stop()
      const fresh = makeRunner()
      await fresh.recover()
      await settleQueue()
      expect(only(await getRun(id), 'g')).toMatchObject({ status: 'running', paused: true })
      expect(fresh.messagesOf(chatId).size).toBe(1)
      fresh.chatResumed(chatId, 'resume-1')
      await waitFor(async () => only(await getRun(id), 'g').messageId === 'resume-1', 'the step to follow the Continue')
      fresh.stop()
    })
  })

  it('limit turn waits and sends continue', async () => {
    turns.push(
      { tail: () => [said('Working'), failure('Usage limit reached', NOW + 1000)] },
      { tail: () => [said('Finished after the reset')] }
    )
    const { id } = await runner.run(flow([A('g', 'Long job')], [e('t', 'g')]), 'manual')
    await waitFor(() => live(timers).length === 1, 'the limit wait')
    let v = only(await getRun(id), 'g')
    expect(v).toMatchObject({ status: 'running', until: NOW + 1000 + 60_000 })
    expect(live(timers)[0]!.ms).toBe(61_000)
    expect((await getRun(id)).status).toBe('running')
    // So the chat's own limit wait leaves this turn alone: the step sends its own continue.
    expect(runner.messagesOf(v.chatId!)).toEqual(new Set([v.messageId]))
    const firstMessage = v.messageId
    fireAll()
    await ended(id)
    const r = await getRun(id)
    v = only(r, 'g')
    expect(sends).toHaveLength(2)
    expect(sends[1]).toEqual({ chatId: v.chatId, text: 'continue', messageId: v.messageId, from: 'routine' })
    expect(v).toMatchObject({ status: 'done', output: 'Finished after the reset' })
    expect(v.messageId).not.toBe(firstMessage)
    expect(v.until).toBeUndefined()
    expect(runner.messagesOf(v.chatId!).size).toBe(0)
    expect(r.status).toBe('done')

    // Past 5 waits the step fails with the turn's error; an unknown reset fails at once.
    for (let i = 0; i < 6; i++) turns.push({ tail: () => [failure('Usage limit reached', NOW + 1000)] })
    const capped = await runner.run(flow([A('g', 'Long job')], [e('t', 'g')], { id: 'w2' }), 'manual')
    for (let wait = 1; wait <= 5; wait++) {
      await waitFor(() => live(timers).length === 1, `wait ${wait}`)
      fireAll()
    }
    await ended(capped.id)
    expect(only(await getRun(capped.id), 'g')).toMatchObject({ status: 'failed', error: 'Usage limit reached' })
    expect(sends.filter((s) => s.text === 'continue')).toHaveLength(1 + 5)

    turns.push({ tail: () => [failure('Usage limit reached', null)] })
    const unknown = await runner.run(flow([A('g', 'Long job')], [e('t', 'g')], { id: 'w3' }), 'manual')
    await ended(unknown.id)
    expect(only(await getRun(unknown.id), 'g')).toMatchObject({ status: 'failed', error: 'Usage limit reached' })
  })

  it('stopRun during a usage-limit wait leaves the chat running whatever the user sent meanwhile', async () => {
    turns.push({ tail: () => [said('Working'), failure('Usage limit reached', NOW + 1000)] })
    const { id } = await runner.run(flow([A('g', 'Long job')], [e('t', 'g')]), 'manual')
    await waitFor(() => live(timers).length === 1, 'the limit wait')
    const v = only(await getRun(id), 'g')
    running.add(v.chatId!) // the user's own message runs in the step's chat now
    await runner.stopRun(id)
    expect(stoppedChats).toEqual([])
    expect(live(timers)).toEqual([])
    expect(only(await getRun(id), 'g').status).toBe('stopped')
  })

  it('edit of the step message fails with Replaced by an edit or resend', async () => {
    turns.push({ hold: true, tail: () => [said('Old version')] })
    const { id } = await runner.run(flow([A('g', 'Draft it')], [e('t', 'g')]), 'manual')
    await startedTurn()
    const v = only(await getRun(id), 'g')
    const b = branch(await chats.loadItems(v.chatId!), {}, v.messageId!, { type: 'user', id: 'u-edit', text: 'Draft it better', ts: NOW })
    await chats.saveVersions(v.chatId!, b.versions)
    await chats.saveItems(v.chatId!, b.items)
    runner.chatIdle(v.chatId!)
    await ended(id)
    const r = await getRun(id)
    expect(only(r, 'g')).toMatchObject({ status: 'failed', error: 'Replaced by an edit or resend' })
    expect(kinds('failed')).toEqual([]) // the user's own edit
    expect(runner.messagesOf(v.chatId!).size).toBe(0)
  })

  it('stopRun stops the agent chat', async () => {
    // q's chat is busy: its message waits in the tray.
    turns.push({ hold: true, tail: () => [said('Half'), notice('stopped')] }, { queue: true })
    const { id } = await runner.run(flow([A('g', 'Work'), A('q', 'Queued work')], [e('t', 'g'), e('t', 'q')]), 'manual')
    await waitFor(() => sends.length === 2, 'both messages')
    await startedTurn()
    const r0 = await getRun(id)
    const g = only(r0, 'g')
    const q = only(r0, 'q')
    expect((await chatOf(q.chatId)).tasks?.map((t) => t.id)).toEqual([q.messageId])

    await runner.stopRun(id)
    // q's message only waited behind the chat's own turn: dropped, and that turn (the user's, say) left running.
    expect(stoppedChats).toEqual([g.chatId])
    expect(dropped).toContainEqual([q.chatId, q.messageId]) // a queued step message must not run after the Stop
    expect((await chatOf(q.chatId)).tasks ?? []).toEqual([])
    const r = await getRun(id)
    expect(r.status).toBe('stopped')
    expect([only(r, 'g').status, only(r, 'q').status]).toEqual(['stopped', 'stopped'])
    expect(runner.messagesOf(g.chatId!).size).toBe(0)

    await held.get(g.chatId!)!() // the stop's own end arrives later and changes nothing
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(only(await getRun(id), 'g').status).toBe('stopped')
    expect(isArchived(await chatOf(g.chatId))).toBe(false)
    expect(kinds('failed')).toEqual([])
  })

  it('recover fails an interrupted agent visit', async () => {
    const w = flow(
      [A('g1', 'One'), A('g2', 'Two'), A('g3', 'Three'), A('g4', 'Four'), A('g5', 'Five')],
      [e('t', 'g1'), e('t', 'g2'), e('t', 'g3'), e('t', 'g4'), e('t', 'g5')]
    )
    await store.put(w)
    const user = (id: string): ChatItem => ({ type: 'user', id, text: 'x', ts: NOW })
    const made = async (items: ChatItem[]): Promise<string> => {
      const c = await chats.create('alpha', '/work')
      await chats.saveItems(c.id, items)
      return c.id
    }
    const interrupted = await made([user('m1'), said('Half'), notice('interrupted')])
    const queued = await made([])
    await chats.addTask(queued, { id: 'm2', text: 'Two', ts: NOW })
    const finished = await made([user('m3'), said('Complete')]) // ended just before the restart, never settled
    const carded = await made([user('m5'), said('May I?'), notice('interrupted')]) // its card went with the turn
    const visit = (id: string, stepId: string, chatId: string | undefined, messageId: string | undefined): Visit => ({
      id,
      stepId,
      n: 1,
      status: 'running',
      input: 'in',
      inputs: [{ edgeId: `t-out-${stepId}`, from: 't', text: 'in' }],
      startedAt: NOW - 1000,
      ...(chatId ? { chatId } : {}),
      ...(messageId ? { messageId } : {})
    })
    await store.addRun({
      id: 'run-old',
      workflowId: 'w1',
      via: 'manual',
      late: false,
      status: 'running',
      input: 'in',
      snapshot: { steps: w.steps, edges: w.edges },
      visits: [
        {
          id: 'vt',
          stepId: 't',
          n: 1,
          status: 'done',
          input: '',
          inputs: [],
          output: 'in',
          port: 'out',
          startedAt: NOW - 1000,
          endedAt: NOW - 1000
        },
        visit('v1', 'g1', interrupted, 'm1'),
        visit('v2', 'g2', queued, 'm2'),
        visit('v3', 'g3', finished, 'm3'),
        visit('v4', 'g4', undefined, undefined), // the crash came before its message was sent
        { ...visit('v5', 'g5', carded, 'm5'), status: 'waiting' }
      ],
      inbox: {},
      allowance: { perStep: {}, total: 200 },
      halted: false,
      startedAt: NOW - 1000
    })

    const fresh = makeRunner()
    await fresh.recover()
    await waitFor(async () => only(await getRun('run-old'), 'g3').status === 'done', 'the settled turn')
    let r = await getRun('run-old')
    expect(only(r, 'g1')).toMatchObject({ status: 'failed', error: 'Interrupted by a restart' })
    expect(only(r, 'g3')).toMatchObject({ status: 'done', output: 'Complete' })
    expect(only(r, 'g4')).toMatchObject({ status: 'failed', error: 'Interrupted by a restart' })
    expect(only(r, 'g5')).toMatchObject({ status: 'failed', error: 'Interrupted by a restart' })
    expect(only(r, 'g2').status).toBe('running') // still queued: followed
    expect(r.status).toBe('running')
    expect(fresh.messagesOf(queued)).toEqual(new Set(['m2']))

    // The queued message runs now, and its end settles the step.
    await chats.dropTask(queued, 'm2')
    await chats.saveItems(queued, [user('m2'), said('Late reply')])
    fresh.chatIdle(queued)
    await ended('run-old')
    r = await getRun('run-old')
    expect(only(r, 'g2')).toMatchObject({ status: 'done', output: 'Late reply' })
    expect(r).toMatchObject({ status: 'failed', error: 'Interrupted by a restart' })
    expect(kinds('failed')).toEqual([]) // a restart is not news
    fresh.stop()
  })

  it('a queued step message is followed until its own turn ends', async () => {
    turns.push({ queue: true })
    const { id } = await runner.run(flow([A('g', 'Work')], [e('t', 'g')]), 'manual')
    await waitFor(() => sends.length === 1, 'the message')
    const v = only(await getRun(id), 'g')
    runner.chatIdle(v.chatId!) // the chat's earlier turn ended, the message still waits
    // The queue sends it as that turn ends, before this idle is read: its turn has begun and runs.
    await chats.dropTask(v.chatId!, v.messageId!)
    const sent: ChatItem[] = [{ type: 'user', id: v.messageId!, text: 'Work', ts: NOW }, said('Thinking')]
    await chats.saveItems(v.chatId!, sent)
    running.add(v.chatId!)
    runner.chatIdle(v.chatId!)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(only(await getRun(id), 'g').status).toBe('running')
    await chats.saveItems(v.chatId!, [...sent, said('Done late')])
    running.delete(v.chatId!)
    runner.chatIdle(v.chatId!)
    await ended(id)
    expect(only(await getRun(id), 'g')).toMatchObject({ status: 'done', output: 'Done late' })
  })

  it('a check reads whether the chat runs before its items, so a turn ending between the two is not settled half-saved', async () => {
    // The chat's release() clears running only after the turn's final save: a check that read the items first and the
    // running flag after could see the half-saved turn as over.
    let raceOn: string | null = null
    const racing: WorkflowRunnerDeps['chats'] = {
      get: (id) => chats.get(id),
      create: (a, c) => chats.create(a, c),
      update: (id, p) => chats.update(id, p),
      updateGroup: (id, fn) => chats.updateGroup(id, fn),
      patchInPlace: (id, fn) => chats.patchInPlace(id, fn),
      loadVersions: (id) => chats.loadVersions(id),
      loadItems: async (id) => {
        const items = await chats.loadItems(id)
        if (raceOn === id) {
          raceOn = null
          running.delete(id)
        } // the turn's end lands right after this read
        return items
      }
    }
    runner.stop()
    runner = makeRunner({ chats: racing })
    turns.push({ hold: true, tail: () => [said('Working'), said('Final answer')] })
    const { id } = await runner.run(flow([A('g', 'Work')], [e('t', 'g')]), 'manual')
    await startedTurn()
    const v = only(await getRun(id), 'g')
    raceOn = v.chatId!
    runner.chatIdle(v.chatId!)
    await waitFor(() => raceOn === null, 'the racing read')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(only(await getRun(id), 'g').status).toBe('running')
    running.add(v.chatId!)
    await held.get(v.chatId!)!()
    await ended(id)
    expect(only(await getRun(id), 'g')).toMatchObject({ status: 'done', output: 'Final answer' })
  })

  it('task dropped or chat removed fails the agent step', async () => {
    turns.push({ queue: true })
    const a = await runner.run(flow([A('g', 'Work')], [e('t', 'g')]), 'manual')
    await waitFor(() => sends.length === 1, 'the message')
    const va = only(await getRun(a.id), 'g')
    runner.taskDropped(va.chatId!, 'another-message')
    runner.taskDropped(va.chatId!, va.messageId!)
    await ended(a.id)
    expect(only(await getRun(a.id), 'g')).toMatchObject({ status: 'failed', error: 'Removed from the queue' })

    turns.push({ hold: true })
    const b = await runner.run(flow([A('g', 'Work')], [e('t', 'g')]), 'manual')
    await startedTurn()
    const vb = only(await getRun(b.id), 'g')
    await chats.remove(vb.chatId!)
    runner.chatRemoved(vb.chatId!)
    await ended(b.id)
    expect(only(await getRun(b.id), 'g')).toMatchObject({ status: 'failed', error: 'Chat was deleted' })
    expect(kinds('failed')).toEqual([])

    // Retry after the chat was deleted makes a new one for the step.
    turns.push({ tail: () => [said('Done again')] })
    await runner.retry(b.id, vb.id)
    await ended(b.id)
    const again = visitsOf(await getRun(b.id), 'g')[1]!
    expect(again).toMatchObject({ status: 'done', output: 'Done again' })
    expect(again.chatId).not.toBe(vb.chatId)
  })

  it('agent step fails when its agent is gone or broken', async () => {
    const w = flow([P('p', 'Go?'), A('g', 'Work')], [e('t', 'p'), e('p', 'g', 'approved')])
    const { id } = await runner.run(w, 'manual')
    agentList = [{ ...agent, error: 'Bad frontmatter' }]
    await runner.approve(id, only(await getRun(id), 'p').id, { ok: true })
    await ended(id)
    expect(only(await getRun(id), 'g')).toMatchObject({ status: 'failed', error: 'Agent "alpha" has an error' })
    agentList = []
    const v = only(await getRun(id), 'g')
    await runner.retry(id, v.id)
    await ended(id)
    expect(visitsOf(await getRun(id), 'g')[1]).toMatchObject({ status: 'failed', error: 'Agent "alpha" not found' })
    expect(sends).toEqual([])
    expect(await chats.list()).toEqual([])
  })

  it('testStep agent makes a test chat and returns its reply', async () => {
    turns.push({ tail: () => [said('Test reply')] })
    const w = flow([A('g', 'Try {{input}}', { model: 'haiku' })], [e('t', 'g')])
    const out = await runner.testStep(w, 'g', 'sample')
    expect(out).toEqual({ chatId: expect.any(String), output: 'Test reply' })
    const chat = await chatOf(out.chatId)
    expect(chat).toMatchObject({ title: 'Release flow · G · test', model: 'haiku', agentName: 'alpha', cwd: '/work' })
    expect(chat.workflow).toBeUndefined() // no run to report to
    expect(chat.workflowTest).toBe('Release flow') // but its turns get the workflow paragraph and its material rule
    expect(sends[0]!.text).toBe('Try <input from="Test input">\nsample\n</input>')
    expect(await store.runs()).toEqual({})

    turns.push({ tail: () => [failure('Claude exited with code 1')] })
    expect(await runner.testStep(w, 'g', 'sample')).toEqual({ chatId: expect.any(String), error: 'Claude exited with code 1' })
    missingDirs.add('/work')
    expect(await runner.testStep(w, 'g', 'sample')).toEqual({ error: 'Folder not found' })
    expect(sends).toHaveLength(2)
  })
})

describe('room steps', () => {
  type RoomStep = Extract<Step, { kind: 'room' }>
  const R = (id: string, prompt: string, extra: Partial<RoomStep> = {}): Step => ({
    ...base(id, id.toUpperCase()),
    kind: 'room',
    room: 'tpl',
    prompt,
    ...extra
  })
  const chatOf = async (chatId: string | undefined): Promise<ChatMeta> => (await chats.get(chatId!))!
  const user = (id: string, text = 'x'): ChatItem => ({ type: 'user', id, text, ts: NOW })
  const settleQueue = () => new Promise((resolve) => setTimeout(resolve, 30))
  // The room's pass hit its hop cap: a notice with no userPaused, as the room's own end writes it.
  const cappedRun = async (tail: () => ChatItem[] = () => [said('half'), notice('paused')], over: Partial<Workflow> = {}) => {
    turns.push({ tail })
    const { id } = await runner.run(flow([R('r', 'Plan {{input}}'), L('b', 'Announce')], [e('t', 'r'), e('r', 'b')], over), 'manual', {
      input: 'go'
    })
    await waitFor(async () => only(await getRun(id), 'r').capped === true, 'the step to wait for the user')
    return { id, chatId: only(await getRun(id), 'r').chatId! }
  }
  // The user posts into the copy, and the room answers (or does not yet).
  const post = async (chatId: string, id: string, tail: ChatItem[]) =>
    chats.saveItems(chatId, [...(await chats.loadItems(chatId)), user(id, 'carry on'), ...tail])

  it('starts a copy of the template, posts the filled prompt as a routine and ends done with the last reply', async () => {
    turns.push({ tail: () => [said('x'), said('final')] })
    const rules = [{ tool: 'Bash', command: 'ls' }]
    const w = flow([R('r', 'Plan {{input}}', { rules }), L('b', 'Announce')], [e('t', 'r'), e('r', 'b')])
    const { id } = await runner.run(w, 'manual', { input: 'go' })
    await ended(id)
    const r = await getRun(id)
    const v = only(r, 'r')
    expect(roomCopies).toEqual([
      {
        slotId: v.id,
        room: 'tpl',
        rules,
        title: 'Release flow · R · Nov 7',
        link: { workflowId: 'w1', runId: id, stepId: 'r', name: 'Release flow' }
      }
    ])
    expect(sends).toEqual([{ chatId: v.chatId, text: 'Plan <input from="Start">\ngo\n</input>', messageId: v.messageId, from: 'routine' }])
    expect(v).toMatchObject({ status: 'done', output: 'final', port: 'out' })
    expect(v.capped).toBeUndefined()
    expect(only(r, 'b').input).toBe('final')
    expect(r.status).toBe('done')
    expect(isArchived(await chatOf(v.chatId))).toBe(true)
  })

  it('a copy that cannot be made fails the visit with its reason, or takes the failure path', async () => {
    runner.stop()
    runner = makeRunner({ rooms: { copy: async () => ({ error: 'Room not found' }) } })
    let { id } = await runner.run(flow([R('r', 'Plan')], [e('t', 'r')]), 'manual')
    await ended(id)
    expect(only(await getRun(id), 'r')).toMatchObject({ status: 'failed', error: 'Room not found' })
    expect(sends).toEqual([])

    ;({ id } = await runner.run(
      flow([R('r', 'Plan', { onFailure: 'branch' }), L('f', 'Handle')], [e('t', 'r'), e('r', 'f', 'error')], { id: 'w2' }),
      'manual'
    ))
    await ended(id)
    const r = await getRun(id)
    expect(only(r, 'r')).toMatchObject({ status: 'failed', port: 'error' })
    expect(only(r, 'f').input).toBe('Room not found')
    expect(r.status).toBe('done')
  })

  describe('the turn limit', () => {
    it('a capped turn leaves the visit waiting, then follows the user’s own post to done', async () => {
      const { id, chatId } = await cappedRun()
      let r = await getRun(id)
      expect(only(r, 'r')).toMatchObject({ status: 'waiting', capped: true })
      expect(only(r, 'r').output).toBeUndefined()
      expect(only(r, 'r').error).toBeUndefined()
      expect(r.status).toBe('waiting')
      expect(visitsOf(r, 'b')).toEqual([])
      expect(isArchived(await chatOf(chatId))).toBe(false)
      expect(kinds('failed')).toEqual([])

      // Idle rounds and approval pushes before the post change nothing.
      runner.chatIdle(chatId)
      runner.chatPush({ chatId, kind: 'approvals', pending: 0 })
      await settleQueue()
      expect(only(await getRun(id), 'r')).toMatchObject({ status: 'waiting', capped: true })

      await post(chatId, 'by-hand', [said('done')])
      runner.chatIdle(chatId)
      await ended(id)
      r = await getRun(id)
      expect(only(r, 'r')).toMatchObject({ status: 'done', output: 'done', resumes: 1, messageId: 'by-hand' })
      expect(only(r, 'r').capped).toBeUndefined()
      expect(only(r, 'b').input).toBe('done')
      expect(isArchived(await chatOf(chatId))).toBe(true)
      expect(kinds('failed')).toEqual([])
    })

    it('Stop while capped ends the visit stopped with no capped flag left', async () => {
      const { id } = await cappedRun()
      await runner.stopRun(id)
      const v = only(await getRun(id), 'r')
      expect(v.status).toBe('stopped')
      expect(v.capped).toBeUndefined()
    })

    it('two posts: when the room goes quiet the visit follows the later one', async () => {
      const { id, chatId } = await cappedRun()
      await chats.saveItems(chatId, [
        ...(await chats.loadItems(chatId)),
        user('p1'),
        said('first answer'),
        user('p2'),
        said('second answer')
      ])
      runner.chatIdle(chatId)
      await ended(id)
      expect(only(await getRun(id), 'r')).toMatchObject({ status: 'done', output: 'second answer', messageId: 'p2', resumes: 1 })
    })

    it('a post whose turn is capped too waits again', async () => {
      const { id, chatId } = await cappedRun()
      await post(chatId, 'p1', [said('more'), notice('paused')])
      runner.chatIdle(chatId)
      await waitFor(async () => only(await getRun(id), 'r').messageId === 'p1', 'the visit to follow the post')
      await settleQueue()
      const v = only(await getRun(id), 'r')
      expect(v).toMatchObject({ status: 'waiting', capped: true, resumes: 1 })
      expect((await getRun(id)).status).toBe('waiting')

      // And a third time round it finishes.
      await post(chatId, 'p2', [said('all done')])
      runner.chatIdle(chatId)
      await ended(id)
      expect(only(await getRun(id), 'r')).toMatchObject({ status: 'done', output: 'all done', resumes: 2 })
    })

    it('a post still running when the idle event comes is followed, not settled', async () => {
      const { id, chatId } = await cappedRun()
      await chats.saveItems(chatId, [...(await chats.loadItems(chatId)), user('p1')])
      running.add(chatId)
      runner.chatIdle(chatId)
      await waitFor(async () => only(await getRun(id), 'r').messageId === 'p1', 'the visit to follow the post')
      await settleQueue()
      expect(only(await getRun(id), 'r')).toMatchObject({ status: 'running', resumes: 1 })
      expect(only(await getRun(id), 'r').capped).toBeUndefined()
      running.delete(chatId)
      await chats.saveItems(chatId, [...(await chats.loadItems(chatId)), said('late')])
      runner.chatIdle(chatId)
      await ended(id)
      expect(only(await getRun(id), 'r')).toMatchObject({ status: 'done', output: 'late' })
    })

    it('a second post queued in the tray keeps the visit open until its turn ends', async () => {
      const { id, chatId } = await cappedRun()
      await chats.addTask(chatId, { id: 'p2', text: 'and this', ts: NOW })
      await post(chatId, 'p1', [said('first answer')])
      runner.chatIdle(chatId)
      await waitFor(async () => only(await getRun(id), 'r').messageId === 'p1', 'the visit to follow p1')
      await settleQueue()
      expect(only(await getRun(id), 'r')).toMatchObject({ status: 'running', resumes: 1 })
      expect(isArchived(await chatOf(chatId))).toBe(false)

      await chats.dropTask(chatId, 'p2')
      await chats.saveItems(chatId, [...(await chats.loadItems(chatId)), user('p2'), said('second answer')])
      runner.chatIdle(chatId)
      await ended(id)
      expect(only(await getRun(id), 'r')).toMatchObject({ status: 'done', output: 'second answer', messageId: 'p2', resumes: 2 })
    })

    it('a post that arrives after the visit moved to the first one is followed, not passed over', async () => {
      const { id, chatId } = await cappedRun()
      await chats.saveItems(chatId, [...(await chats.loadItems(chatId)), user('p1')])
      running.add(chatId)
      runner.chatIdle(chatId)
      await waitFor(async () => only(await getRun(id), 'r').messageId === 'p1', 'the visit to follow p1')
      // p1's reply lands and p2 starts at once: p1 is over, p2 is not.
      await chats.saveItems(chatId, [...(await chats.loadItems(chatId)), said('first answer'), user('p2')])
      runner.chatIdle(chatId)
      await waitFor(async () => only(await getRun(id), 'r').messageId === 'p2', 'the visit to follow p2')
      await settleQueue()
      expect(only(await getRun(id), 'r')).toMatchObject({ status: 'running', resumes: 2 })
      running.delete(chatId)
      await chats.saveItems(chatId, [...(await chats.loadItems(chatId)), said('second answer')])
      runner.chatIdle(chatId)
      await ended(id)
      expect(only(await getRun(id), 'r')).toMatchObject({ status: 'done', output: 'second answer', resumes: 2 })
    })

    it('a card in the post’s turn shows the visit waiting, and the post’s cost counts', async () => {
      const { id, chatId } = await cappedRun()
      await chats.saveItems(chatId, [...(await chats.loadItems(chatId)), user('p1')])
      running.add(chatId)
      runner.chatPush({ chatId, kind: 'approvals', pending: 1 })
      await waitFor(
        async () => only(await getRun(id), 'r').status === 'waiting' && only(await getRun(id), 'r').messageId === 'p1',
        'the card to show'
      )
      expect(only(await getRun(id), 'r').capped).toBeUndefined()
      runner.chatCost(chatId, 0.02)
      await waitFor(async () => (only(await getRun(id), 'r').costUsd ?? 0) > 0, 'the post’s cost')
    })

    it('Stop while waiting for the user stops the copy', async () => {
      const { id, chatId } = await cappedRun()
      await runner.stopRun(id)
      expect(only(await getRun(id), 'r').status).toBe('stopped')
      expect(stoppedChats).toEqual([chatId])
    })

    it('recover keeps a capped visit waiting, unwritten, while its turn is still the last', async () => {
      const { id, chatId } = await cappedRun()
      const before = JSON.stringify(await getRun(id))
      runner.stop()
      const fresh = makeRunner()
      await fresh.recover()
      await settleQueue()
      expect(JSON.stringify(await getRun(id))).toBe(before)
      expect(fresh.messagesOf(chatId).size).toBe(1)
      await post(chatId, 'p1', [said('after restart')])
      fresh.chatIdle(chatId)
      await ended(id)
      expect(only(await getRun(id), 'r')).toMatchObject({ status: 'done', output: 'after restart', resumes: 1 })
      fresh.stop()
    })

    it('recover settles a capped visit whose copy got a later turn before the restart', async () => {
      const { id, chatId } = await cappedRun()
      await post(chatId, 'p1', [said('finished while down')])
      runner.stop()
      const fresh = makeRunner()
      await fresh.recover()
      await ended(id)
      expect(only(await getRun(id), 'r')).toMatchObject({ status: 'done', output: 'finished while down', resumes: 1 })
      fresh.stop()
    })
  })

  it('Retry goes on in the same copy, so the room is copied once', async () => {
    turns.push({ tail: () => [said('x'), failure('Claude exited with code 1')] }, { tail: () => [said('recovered')] })
    const { id } = await runner.run(flow([R('r', 'Plan')], [e('t', 'r')]), 'manual')
    await ended(id)
    const first = only(await getRun(id), 'r')
    expect(first).toMatchObject({ status: 'failed', error: 'Claude exited with code 1' })
    expect(isArchived(await chatOf(first.chatId))).toBe(false)
    await runner.retry(id, first.id)
    await ended(id)
    const tries = visitsOf(await getRun(id), 'r')
    expect(tries.map((v) => v.status)).toEqual(['failed', 'done'])
    expect(tries[1]).toMatchObject({ chatId: first.chatId, output: 'recovered' })
    expect(sends.map((s) => s.chatId)).toEqual([first.chatId, first.chatId])
    expect(roomCopies).toHaveLength(1)
  })

  describe('a room built from agents', () => {
    const fromAgents = (extra: Partial<RoomStep> = {}): Step =>
      R('r', 'Plan', { room: '', members: ['alpha', 'helper'], role: 'Review', cwd: '/work', ...extra })
    beforeEach(() => {
      agentList = [agent, { ...agent, name: 'helper' }]
    })

    it('asks for the agents, role and folder, and for a section only when kept', async () => {
      turns.push({ tail: () => [said('x'), said('final')] })
      const { id } = await runner.run(flow([fromAgents()], [e('t', 'r')]), 'manual')
      await ended(id)
      expect(roomCopies[0]).toMatchObject({ room: '', agents: { members: ['alpha', 'helper'], role: 'Review', cwd: '/work' } })
      expect(roomCopies[0]).not.toHaveProperty('section')
      turns.push({ tail: () => [said('x'), said('final')] })
      const kept = await runner.run(flow([fromAgents({ keep: true, section: 'S' })], [e('t', 'r')], { id: 'w2' }), 'manual')
      await ended(kept.id)
      expect(roomCopies[1]).toMatchObject({ section: 'S' })
    })

    it('a kept room is titled by the step, linked with keep, and asked to go first in its section', async () => {
      turns.push({ tail: () => [said('x'), said('final')] })
      const { id } = await runner.run(flow([fromAgents({ keep: true, section: 'S', title: 'Weekly review' })], [e('t', 'r')]), 'manual')
      await ended(id)
      expect(roomCopies[0]).toMatchObject({ title: 'Weekly review', section: 'S', link: { keep: true } })
    })

    it('an unkept room has no keep key and keeps the default title', async () => {
      turns.push({ tail: () => [said('x'), said('final')] })
      const { id } = await runner.run(flow([fromAgents()], [e('t', 'r')]), 'manual')
      await ended(id)
      expect(roomCopies[0]!.link).not.toHaveProperty('keep')
      expect(roomCopies[0]!.title).toBe('Release flow · R · Nov 7')
    })

    it('Retry goes on in the same room', async () => {
      turns.push({ tail: () => [said('x'), failure('Claude exited with code 1')] }, { tail: () => [said('recovered')] })
      const { id } = await runner.run(flow([fromAgents()], [e('t', 'r')]), 'manual')
      await ended(id)
      const first = only(await getRun(id), 'r')
      await runner.retry(id, first.id)
      await ended(id)
      expect(visitsOf(await getRun(id), 'r')[1]).toMatchObject({ chatId: first.chatId, output: 'recovered' })
      expect(roomCopies).toHaveLength(1)
    })

    it('is a problem when its folder does not exist, a template room has none', async () => {
      missingDirs.add('/gone')
      const bad = flow([fromAgents({ cwd: '/gone' })], [e('t', 'r')])
      expect(await runner.problems(bad)).toEqual([{ stepId: 'r', text: 'Folder not found' }])
      expect(await runner.problems(flow([R('r', 'Plan')], [e('t', 'r')]))).toEqual([])
    })
  })

  it('recover fails an open visit whose copy was never made', async () => {
    const w = flow([R('r', 'Plan')], [e('t', 'r')])
    await store.put(w)
    await store.addRun({
      id: 'run-old',
      workflowId: 'w1',
      via: 'manual',
      late: false,
      status: 'running',
      input: 'in',
      snapshot: { steps: w.steps, edges: w.edges },
      visits: [
        {
          id: 'vt',
          stepId: 't',
          n: 1,
          status: 'done',
          input: '',
          inputs: [],
          output: 'in',
          port: 'out',
          startedAt: NOW - 1000,
          endedAt: NOW - 1000
        },
        {
          id: 'v1',
          stepId: 'r',
          n: 1,
          status: 'running',
          input: 'in',
          inputs: [{ edgeId: 't-out-r', from: 't', text: 'in' }],
          startedAt: NOW - 1000
        }
      ],
      inbox: {},
      allowance: { perStep: {}, total: 200 },
      halted: false,
      startedAt: NOW - 1000
    })
    const fresh = makeRunner()
    await fresh.recover()
    await ended('run-old')
    expect(only(await getRun('run-old'), 'r')).toMatchObject({ status: 'failed', error: 'Interrupted by a restart' })
    fresh.stop()
  })
})

describe('chat step', () => {
  const K = (id: string, chat: string, prompt: string, extra: Partial<Extract<Step, { kind: 'chat' }>> = {}): Step => ({
    ...base(id, 'Chat'),
    kind: 'chat',
    chat,
    prompt,
    ...extra
  })
  const made = async (extra: Partial<ChatMeta> = {}): Promise<ChatMeta> => {
    const c = await chats.create('alpha', '/work')
    return Object.keys(extra).length > 0 ? chats.update(c.id, extra) : c
  }
  const user = (id: string, text = 'x'): ChatItem => ({ type: 'user', id, text, ts: NOW })
  const settleQueue = () => new Promise((resolve) => setTimeout(resolve, 30))

  it('posts into the given chat, outputs its turn, never archives or marks it', async () => {
    turns.push({ tail: () => [said('x'), said('reply')] })
    const chat = await made()
    const { id } = await runner.run(flow([K('c', chat.id, 'Check it'), L('b', 'Announce')], [e('t', 'c'), e('c', 'b')]), 'manual')
    await ended(id)
    const r = await getRun(id)
    const v = only(r, 'c')
    const sent = { workflowId: 'w1', runId: id, stepId: 'c', name: 'Release flow', step: 'Chat' }
    expect(v).toMatchObject({ status: 'done', output: 'reply', port: 'out', chatId: chat.id })
    expect(sends).toEqual([{ chatId: chat.id, text: 'Check it', messageId: v.messageId, from: 'routine', sent }])
    expect((await chats.loadItems(chat.id)).find((i) => i.type === 'user')).toMatchObject({ workflowSent: sent })
    expect(only(r, 'b').input).toBe('reply')
    expect(r.status).toBe('done')
    const after = (await chats.get(chat.id))!
    expect(isArchived(after)).toBe(false)
    expect(after.archivedAt).toBeUndefined()
    expect(after.workflow).toBeUndefined()
    expect(metaPushes).toEqual([])
  })

  it('starts sessions fresh when asked, but not in a paused chat', async () => {
    const chat = await made({ sessionId: 's1' })
    const { id } = await runner.run(flow([K('c', chat.id, 'Go', { session: 'fresh' })], [e('t', 'c')]), 'manual')
    await ended(id)
    expect((await chats.get(chat.id))!.next).toEqual({ seed: true, fresh: true })

    const paused = await made({ sessionId: 's1', pause: 'paused' })
    turns.push({ queue: true })
    const second = await runner.run(flow([K('c', paused.id, 'Go', { session: 'fresh' })], [e('t', 'c')], { id: 'w2' }), 'manual')
    await waitFor(() => sends.some((x) => x.chatId === paused.id), 'the held message')
    const held_ = (await chats.get(paused.id))!
    expect(held_.next).toBeUndefined()
    expect(held_.tasks?.map((x) => x.id)).toEqual([only(await getRun(second.id), 'c').messageId])
    expect(only(await getRun(second.id), 'c').status).toBe('running') // until Resume carries the message on
  })

  it('ends the material rule after the blocks, and only then', async () => {
    const chat = await made()
    const { id } = await runner.run(flow([K('c', chat.id, 'Do {{input}}')], [e('t', 'c')]), 'manual', { input: 'go' })
    await ended(id)
    expect(sends[0]!.text).toBe(`Do <input from="Start">\ngo\n</input>\n\n${MATERIAL_RULE}`)
    expect(sends[0]!.text.endsWith(MATERIAL_RULE)).toBe(true)
  })

  it("sends a remote agent the blocks alone: none of ZumiBot's own text goes to its host (Rulings 13)", async () => {
    agentList = [{ ...agent, provider: 'ag-ui', remoteHost: 'agents.example.com' }]
    const chat = await made()
    const { id } = await runner.run(flow([K('c', chat.id, 'Do {{input}}')], [e('t', 'c')]), 'manual', { input: 'go' })
    await ended(id)
    expect(sends[0]!.text).toBe('Do <input from="Start">\ngo\n</input>')
    expect(sends[0]!.text).not.toContain(MATERIAL_RULE)
  })

  it('follows its own turn when the user’s turn runs first', async () => {
    const chat = await made()
    running.add(chat.id)
    turns.push({ queue: true })
    const { id } = await runner.run(flow([K('c', chat.id, 'Check it')], [e('t', 'c')]), 'manual')
    await waitFor(() => sends.length === 1, 'the queued message')
    const mid = only(await getRun(id), 'c').messageId!
    // The user's turn ends: not the step's.
    await chats.saveItems(chat.id, [user('u1'), said('user answer')])
    running.delete(chat.id)
    runner.chatIdle(chat.id)
    await settleQueue()
    expect(only(await getRun(id), 'c').status).toBe('running')
    // The queue runs the step's message.
    await chats.dropTask(chat.id, mid)
    await chats.saveItems(chat.id, [...(await chats.loadItems(chat.id)), user(mid, 'Check it'), said('step reply')])
    runner.chatIdle(chat.id)
    await ended(id)
    expect(only(await getRun(id), 'c')).toMatchObject({ status: 'done', output: 'step reply' })
  })

  it('fails Chat not found when the chat was deleted', async () => {
    const chat = await made()
    const w = flow([P('p', 'Go on?'), K('c', chat.id, 'Check it')], [e('t', 'p'), e('p', 'c', 'approved')])
    expect(await runner.problems(w)).toEqual([])
    const { id } = await runner.run(w, 'manual')
    await chats.remove(chat.id)
    expect((await runner.problems(w)).map((p) => p.text)).toEqual([CHAT_NOT_FOUND])
    await runner.approve(id, only(await getRun(id), 'p').id, { ok: true, text: 'go' })
    await ended(id)
    const r = await getRun(id)
    expect(only(r, 'c')).toMatchObject({ status: 'failed', error: CHAT_NOT_FOUND })
    expect(r.status).toBe('failed')
    expect(sends).toEqual([])
  })

  it('Stop drops a queued step message and leaves the user’s turn running', async () => {
    const chat = await made()
    running.add(chat.id)
    turns.push({ queue: true })
    const { id } = await runner.run(flow([K('c', chat.id, 'Check it')], [e('t', 'c')]), 'manual')
    await waitFor(() => sends.length === 1, 'the queued message')
    const mid = only(await getRun(id), 'c').messageId!
    await runner.stopRun(id)
    expect(dropped).toEqual([[chat.id, mid]])
    expect(stoppedChats).toEqual([])
    expect(only(await getRun(id), 'c').status).toBe('stopped')
  })

  it('counts the turn toward the run cost', async () => {
    turns.push({ hold: true, tail: () => [said('Done')] })
    const chat = await made()
    const { id } = await runner.run(flow([K('c', chat.id, 'Check it')], [e('t', 'c')]), 'manual')
    await waitFor(() => held.size === 1, 'the turn')
    runner.chatCost(chat.id, 0.5)
    await waitFor(async () => only(await getRun(id), 'c').costUsd === 0.5, 'the visit’s cost')
    await held.get(chat.id)!()
    await ended(id)
    expect(summarize(await getRun(id)).costUsd).toBe(0.5)
  })

  it('names the run and message it follows in the chat, for the spend caps', async () => {
    turns.push({ hold: true, tail: () => [said('Done')] })
    const chat = await made()
    const { id } = await runner.run(flow([K('c', chat.id, 'Check it')], [e('t', 'c')]), 'manual')
    await waitFor(() => held.size === 1, 'the turn')
    expect(runner.runsIn(chat.id)).toEqual([{ workflowId: 'w1', runId: id, messageId: only(await getRun(id), 'c').messageId }])
    expect(runner.runsIn('some-other-chat')).toEqual([])
    await held.get(chat.id)!()
    await ended(id)
    expect(runner.runsIn(chat.id)).toEqual([])
  })

  describe('chatStepProblem', () => {
    const meta = (extra: Partial<ChatMeta> = {}): ChatMeta =>
      ({ id: 'c1', agentName: 'alpha', cwd: '/work', title: 't', createdAt: 1, updatedAt: 1, sessionId: null, ...extra }) as ChatMeta
    it('names what is wrong, in order', () => {
      expect(chatStepProblem(null, [agent], 'zumi-bot')).toBe(CHAT_NOT_FOUND)
      expect(chatStepProblem(meta({ asked: { by: 'beta', from: 'c0', fromTitle: 'x', chain: [] } }), [agent], 'zumi-bot')).toBe(
        CHAT_READ_ONLY
      )
      expect(chatStepProblem(meta({ workflow: { workflowId: 'w', runId: 'r', stepId: 's', name: 'n' } }), [agent], 'zumi-bot')).toBe(
        CHAT_OF_WORKFLOW
      )
      expect(chatStepProblem(meta({ workflowTest: 'n' }), [agent], 'zumi-bot')).toBe(CHAT_OF_WORKFLOW)
      expect(chatStepProblem(meta({ agentName: 'gone' }), [agent], 'zumi-bot')).toBe('Agent "gone" not found')
      expect(chatStepProblem(meta(), [agent], 'zumi-bot')).toBeNull()
    })
  })
})

describe('run cost', () => {
  const A = (id: string, prompt: string): Step => ({ ...base(id, id.toUpperCase()), kind: 'agent', agent: 'alpha', prompt, cwd: '/work' })
  const startedTurn = () => waitFor(() => held.size === 1, 'the turn to start')
  const summaryOf = async (id: string) => summarize(await getRun(id))

  it('each model call’s cost lands on its visit, and the summary carries the total', async () => {
    const w = flow([L('a', 'Summarize'), C('c', 'Ready?'), L('b', 'Polish')], [e('t', 'a'), e('a', 'c'), e('c', 'b', 'no')])
    const { id } = await runner.run(w, 'manual', { input: 'hello' })
    await ended(id)
    const r = await getRun(id)
    expect(only(r, 'a').costUsd).toBe(0.01)
    expect(only(r, 'b').costUsd).toBe(0.01)
    expect(only(r, 'c').costUsd).toBeUndefined() // the fake condition reports no cost
    expect(only(r, 't').costUsd).toBeUndefined()
    expect((await summaryOf(id)).costUsd).toBeCloseTo(0.02)
  })

  it('a run with nothing paid has no cost in its summary', async () => {
    const { id } = await runner.run(flow([N('n', 'Hello')], [e('t', 'n')]), 'manual')
    await ended(id)
    expect((await summaryOf(id)).costUsd).toBeUndefined()
  })

  it('a call that answers after Stop still adds its cost to the stopped visit', async () => {
    const { id } = await runner.run(flow([L('s', 'Slow #GATE')], [e('t', 's')]), 'manual')
    await waitFor(() => llmPrompts.length === 1, 'the call')
    await runner.stopRun(id)
    expect(only(await getRun(id), 's').status).toBe('stopped')
    gate.open()
    await waitFor(() => costs.length === 1, 'the cost')
    await waitFor(async () => only(await getRun(id), 's').costUsd === 0.01, 'the visit’s cost')
    const r = await getRun(id)
    expect(r).toMatchObject({ status: 'stopped', endedAt: NOW })
    expect(only(r, 's').status).toBe('stopped')
    expect((await summaryOf(id)).costUsd).toBe(0.01)
  })

  it('an Agent step’s turn costs count on its visit, a usage-limit continue’s too', async () => {
    turns.push(
      { hold: true, tail: () => [said('Working'), failure('Usage limit reached', NOW + 1000)] },
      { hold: true, tail: () => [said('Done')] }
    )
    const { id } = await runner.run(flow([A('g', 'Long job')], [e('t', 'g')]), 'manual')
    await startedTurn()
    const chatId = only(await getRun(id), 'g').chatId!
    runner.chatCost('some-other-chat', 9)
    runner.chatCost(chatId, 0.25)
    await waitFor(async () => only(await getRun(id), 'g').costUsd === 0.25, 'the first turn’s cost')
    await held.get(chatId)!()
    await waitFor(() => live(timers).length === 1, 'the limit wait')
    fireAll()
    await startedTurn()
    runner.chatCost(chatId, 0.5)
    await waitFor(async () => only(await getRun(id), 'g').costUsd === 0.75, 'the continue’s cost')
    await held.get(chatId)!()
    await ended(id)
    expect(only(await getRun(id), 'g')).toMatchObject({ status: 'done', output: 'Done', costUsd: 0.75 })
    expect((await summaryOf(id)).costUsd).toBe(0.75)
    // The chat is no longer followed: a later turn of the user's own there is not the run's.
    runner.chatCost(chatId, 1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(only(await getRun(id), 'g').costUsd).toBe(0.75)
  })

  it('a turn that runs while the step’s message waits in the tray is not the step’s', async () => {
    turns.push({ queue: true })
    const { id } = await runner.run(flow([A('g', 'Work')], [e('t', 'g')]), 'manual')
    await waitFor(() => sends.length === 1, 'the message')
    const v = only(await getRun(id), 'g')
    // The user's own turn ahead of it reports its cost.
    runner.chatCost(v.chatId!, 3)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(only(await getRun(id), 'g').costUsd).toBeUndefined()
    // Now the step's own turn runs and reports.
    await chats.dropTask(v.chatId!, v.messageId!)
    await chats.saveItems(v.chatId!, [{ type: 'user', id: v.messageId!, text: 'Work', ts: NOW }, said('Thinking')])
    running.add(v.chatId!)
    runner.chatCost(v.chatId!, 0.4)
    await waitFor(async () => only(await getRun(id), 'g').costUsd === 0.4, 'the step turn’s cost')
    running.delete(v.chatId!)
    runner.chatIdle(v.chatId!)
    await ended(id)
    expect(only(await getRun(id), 'g')).toMatchObject({ status: 'done', costUsd: 0.4 })
  })
})

describe('for each steps', () => {
  const helper: AgentSummary = { ...agent, filePath: '/agents/helper.md', name: 'helper' }
  const FE = (id: string, prompt: string): Step => ({
    ...base(id, id.toUpperCase()),
    kind: 'foreach',
    agent: 'helper',
    prompt,
    cwd: '/tmp'
  })
  const chatOf = async (chatId: string | undefined): Promise<ChatMeta> => (await chats.get(chatId!))!
  const startedTurn = () => waitFor(() => held.size === 1, 'the turn to start')
  const itemOf = (t: string) => `Do <input from="item">\n${t}\n</input>`
  const loop = (more: Step[] = [], edges: Edge[] = []): Workflow =>
    flow([FE('fe', 'Do {{item}}'), ...more], [e('t', 'fe'), ...edges], { name: 'Flow' })
  const itemsOf = (v: Visit): ItemRun[] => v.items!
  const fe = async (id: string): Promise<Visit> => only(await getRun(id), 'fe')
  // Item a ok, item b fails, item c ok (or fails too).
  const failSecond = async (third: 'ok' | 'fail' = 'ok') => {
    turns.push({ tail: () => [said('ok')] }, { tail: () => [failure('Claude exited with code 1')] })
    turns.push(third === 'ok' ? { tail: () => [said('ok')] } : { tail: () => [failure('Claude exited with code 2')] })
    const { id } = await runner.run(loop([L('after', 'Next')], [e('fe', 'after')]), 'manual', { input: 'a\nb\nc' })
    await ended(id)
    return id
  }

  beforeEach(() => {
    agentList = [agent, helper]
  })

  it('for each runs its items in order, each in a fresh chat titled with the item, and joins the replies', async () => {
    const { id } = await runner.run(loop([L('after', 'Next')], [e('fe', 'after')]), 'manual', { input: 'a\nb\nc' })
    await ended(id)
    const r = await getRun(id)
    const v = only(r, 'fe')
    expect(v).toMatchObject({ status: 'done', port: 'out', output: '## a\n\nok\n\n## b\n\nok\n\n## c\n\nok' })
    const items = itemsOf(v)
    expect(items.map((i) => [i.n, i.text, i.status, i.output])).toEqual([
      [1, 'a', 'done', 'ok'],
      [2, 'b', 'done', 'ok'],
      [3, 'c', 'done', 'ok']
    ])
    // In order, one chat per item, the list itself never appended.
    expect(sends.map((s) => s.text)).toEqual(['a', 'b', 'c'].map(itemOf))
    expect(sends.map((s) => s.chatId)).toEqual(items.map((i) => i.chatId))
    expect(sends.map((s) => s.messageId)).toEqual(items.map((i) => i.messageId))
    expect(new Set(sends.map((s) => s.chatId)).size).toBe(3)
    for (const [n, i] of items.entries()) {
      expect(await chatOf(i.chatId)).toMatchObject({
        agentName: 'helper',
        cwd: '/tmp',
        title: `Flow · FE · ${i.text} · Nov 7`,
        workflow: { workflowId: 'w1', runId: id, stepId: 'fe', name: 'Flow', item: { n: n + 1, total: 3 } }
      })
    }
    expect(only(r, 'after').input).toBe(v.output)
    expect(r.status).toBe('done')
    // The title cuts a long item to 60 characters.
    const long = 'x'.repeat(70)
    const second = await runner.run(loop(), 'manual', { input: long })
    await ended(second.id)
    expect((await chatOf(itemsOf(await fe(second.id))[0]!.chatId)).title).toBe(`Flow · FE · ${'x'.repeat(60)} · Nov 7`)
  })

  it('a failed item does not stop the rest; the visit fails "1 of 3 items failed" and the run halts', async () => {
    const id = await failSecond()
    const r = await getRun(id)
    const v = only(r, 'fe')
    expect(sends).toHaveLength(3)
    expect(itemsOf(v).map((i) => i.status)).toEqual(['done', 'failed', 'done'])
    expect(itemsOf(v)[1]!.error).toBe('Claude exited with code 1')
    expect(v).toMatchObject({ status: 'failed', error: '1 of 3 items failed' })
    expect(r).toMatchObject({ status: 'failed', error: '1 of 3 items failed', halted: true })
    expect(visitsOf(r, 'after')).toEqual([])
    expect(kinds('failed')).toEqual([{ workflowId: 'w1', runId: id, name: 'Flow' }])
  })

  it('retry of a failed for each visit runs only the failed items, in their own chats, and the output covers all', async () => {
    const id = await failSecond()
    const first = await fe(id)
    turns.push({ tail: () => [said('fixed')] })
    await runner.retry(id, first.id)
    await ended(id)
    const r = await getRun(id)
    const tries = visitsOf(r, 'fe')
    expect(tries.map((v) => v.status)).toEqual(['failed', 'done'])
    expect(sends).toHaveLength(4)
    expect(sends[3]).toMatchObject({ chatId: itemsOf(first)[1]!.chatId, text: itemOf('b') })
    const again = itemsOf(tries[1]!)
    expect(again.map((i) => [i.text, i.status, i.carried])).toEqual([
      ['a', 'done', true],
      ['b', 'done', undefined],
      ['c', 'done', true]
    ])
    expect(tries[1]!.output).toBe('## a\n\nok\n\n## b\n\nfixed\n\n## c\n\nok')
    expect(only(r, 'after').input).toBe(tries[1]!.output)
    expect(r.status).toBe('done')
  })

  it('retry of one item leaves the other failed items failed', async () => {
    const id = await failSecond('fail')
    const first = await fe(id)
    expect(first.error).toBe('2 of 3 items failed')
    const [a, b, c] = itemsOf(first)
    // Only a failed item of that visit can be retried on its own.
    await expect(runner.retry(id, first.id, a!.id)).rejects.toThrow('Only a failed step can be retried')
    await expect(runner.retry(id, first.id, 'no-such-item')).rejects.toThrow('Only a failed step can be retried')
    turns.push({ tail: () => [said('fixed')] })
    await runner.retry(id, first.id, b!.id)
    await ended(id)
    const r = await getRun(id)
    const second = visitsOf(r, 'fe')[1]!
    expect(sends).toHaveLength(4)
    expect(sends[3]!.chatId).toBe(b!.chatId)
    expect(itemsOf(second).map((i) => [i.text, i.status, i.carried])).toEqual([
      ['a', 'done', true],
      ['b', 'done', undefined],
      ['c', 'failed', true]
    ])
    expect(itemsOf(second)[2]).toMatchObject({ chatId: c!.chatId, error: 'Claude exited with code 2' })
    expect(second).toMatchObject({ status: 'failed', error: '1 of 3 items failed' })
    expect(r.status).toBe('failed')
  })

  describe('several items at once', () => {
    const wide = (concurrency: 2 | 3, more: Step[] = [], edges: Edge[] = []): Workflow =>
      flow([{ ...FE('fe', 'Do {{item}}'), concurrency } as Step, ...more], [e('t', 'fe'), ...edges], { name: 'Flow' })
    const chatOfItem = async (id: string, n: number): Promise<string> => itemsOf(await fe(id))[n]!.chatId!

    it('starts up to its concurrency at once, and an item that ends lets the next pending one start', async () => {
      turns.push({ hold: true, tail: () => [said('A')] }, { hold: true, tail: () => [said('B')] }, { hold: true, tail: () => [said('C')] })
      const { id } = await runner.run(wide(2, [L('after', 'Next')], [e('fe', 'after')]), 'manual', { input: 'a\nb\nc' })
      await waitFor(() => held.size === 2, 'two turns to start')
      let v = await fe(id)
      expect(itemsOf(v).map((i) => i.status)).toEqual(['running', 'running', 'pending'])
      expect(sends.map((s) => s.text)).toEqual([itemOf('a'), itemOf('b')])
      expect(new Set(sends.map((s) => s.chatId)).size).toBe(2)
      expect(summarize(await getRun(id)).progress).toEqual([{ stepId: 'fe', done: 0, failed: 0, total: 3, current: 'a', running: 2 }])

      // b ends first: c takes its slot while a still runs.
      await held.get(await chatOfItem(id, 1))!()
      await waitFor(() => sends.length === 3 && held.size === 2, 'the third item to start')
      v = await fe(id)
      expect(itemsOf(v).map((i) => i.status)).toEqual(['running', 'done', 'running'])
      expect(v.status).toBe('running')
      expect(sends[2]!.text).toBe(itemOf('c'))
      await held.get(await chatOfItem(id, 2))!()
      await waitFor(async () => itemsOf(await fe(id))[2]!.status === 'done', 'c to end')
      expect((await fe(id)).status).toBe('running') // a is still open
      expect(visitsOf(await getRun(id), 'after')).toEqual([])
      await held.get(await chatOfItem(id, 0))!()
      await ended(id)
      v = await fe(id)
      // The output keeps list order, whatever order the replies came in.
      expect(v).toMatchObject({ status: 'done', output: '## a\n\nA\n\n## b\n\nB\n\n## c\n\nC' })
      expect(only(await getRun(id), 'after').input).toBe(v.output)
    })

    it('tries every item before failing, as one at a time does', async () => {
      turns.push({ tail: () => [said('ok')] }, { tail: () => [failure('Claude exited with code 1')] }, { tail: () => [said('ok')] })
      const { id } = await runner.run(wide(3), 'manual', { input: 'a\nb\nc' })
      await ended(id)
      const v = await fe(id)
      expect(sends).toHaveLength(3)
      expect(itemsOf(v).map((i) => i.status)).toEqual(['done', 'failed', 'done'])
      expect(v).toMatchObject({ status: 'failed', error: '1 of 3 items failed' })
    })

    it('a card in one item makes the visit wait while the other item runs on', async () => {
      turns.push({ hold: true, tail: () => [said('A')] }, { hold: true, tail: () => [said('B')] })
      const { id } = await runner.run(wide(2), 'manual', { input: 'a\nb' })
      await waitFor(() => held.size === 2, 'two turns to start')
      const a = await chatOfItem(id, 0)
      runner.chatPush({ chatId: a, kind: 'approvals', pending: 1 })
      await waitFor(async () => (await getRun(id)).status === 'waiting', 'the run to wait')
      let v = await fe(id)
      expect([v.status, ...itemsOf(v).map((i) => i.status)]).toEqual(['waiting', 'waiting', 'running'])
      // b ending leaves the visit waiting on a's card.
      await held.get(await chatOfItem(id, 1))!()
      await waitFor(async () => itemsOf(await fe(id))[1]!.status === 'done', 'b to end')
      v = await fe(id)
      expect(v.status).toBe('waiting')
      runner.chatPush({ chatId: a, kind: 'approvals', pending: 0 })
      await waitFor(async () => (await fe(id)).status === 'running', 'the visit to run again')
      await held.get(a)!()
      await ended(id)
      expect(await fe(id)).toMatchObject({ status: 'done', output: '## a\n\nA\n\n## b\n\nB' })
    })

    it('a paused item holds only its own slot: the others go on, and the visit waits for Resume', async () => {
      turns.push({ tail: () => [said('Half'), notice('userPaused')] }, { tail: () => [said('B')] }, { tail: () => [said('C')] })
      const { id } = await runner.run(wide(2), 'manual', { input: 'a\nb\nc' })
      await waitFor(async () => itemsOf(await fe(id))[2]!.status === 'done', 'b and c to end')
      const v = await fe(id)
      expect(itemsOf(v).map((i) => [i.status, i.paused])).toEqual([
        ['running', true],
        ['done', undefined],
        ['done', undefined]
      ])
      expect(v.status).toBe('running')
      expect(summarize(await getRun(id)).progress).toEqual([{ stepId: 'fe', done: 2, failed: 0, total: 3, current: 'a', paused: true }])
      const a = await chatOfItem(id, 0)
      runner.chatResumed(a, 'resume-1')
      await waitFor(async () => itemsOf(await fe(id))[0]!.messageId === 'resume-1', 'a to follow the Continue')
      await chats.saveItems(a, [...(await chats.loadItems(a)), { type: 'user', id: 'resume-1', text: 'Continue', ts: NOW }, said('A')])
      runner.chatIdle(a)
      await ended(id)
      expect(await fe(id)).toMatchObject({ status: 'done', output: '## a\n\nA\n\n## b\n\nB\n\n## c\n\nC' })
    })

    it('a retry runs the failed items side by side', async () => {
      turns.push(
        { tail: () => [failure('Claude exited with code 1')] },
        { tail: () => [failure('Claude exited with code 2')] },
        { tail: () => [said('ok')] }
      )
      const { id } = await runner.run(wide(2), 'manual', { input: 'a\nb\nc' })
      await ended(id)
      const first = await fe(id)
      turns.push({ hold: true, tail: () => [said('A')] }, { hold: true, tail: () => [said('B')] })
      await runner.retry(id, first.id)
      await waitFor(() => held.size === 2, 'both failed items to start again')
      const again = visitsOf(await getRun(id), 'fe')[1]!
      expect(itemsOf(again).map((i) => [i.status, i.carried])).toEqual([
        ['running', undefined],
        ['running', undefined],
        ['done', true]
      ])
      for (const chatId of [...held.keys()]) await held.get(chatId)!()
      await ended(id)
      expect(visitsOf(await getRun(id), 'fe')[1]).toMatchObject({ status: 'done', output: '## a\n\nA\n\n## b\n\nB\n\n## c\n\nok' })
    })

    it('recover follows every open item, starts an unsent one, and fills a free slot only once one frees up', async () => {
      const w = wide(2)
      await store.put(w)
      const queued = (await chats.create('helper', '/tmp')).id
      await chats.addTask(queued, { id: 'ma', text: 'Do a', ts: NOW })
      await store.addRun({
        id: 'run-wide',
        workflowId: 'w1',
        via: 'manual',
        late: false,
        status: 'running',
        input: 'a\nb\nc\nd',
        snapshot: { steps: w.steps, edges: w.edges },
        visits: [
          {
            id: 'rw-t',
            stepId: 't',
            n: 1,
            status: 'done',
            input: '',
            inputs: [],
            output: 'a\nb\nc\nd',
            port: 'out',
            startedAt: NOW - 1000,
            endedAt: NOW - 1000
          },
          {
            id: 'rw-fe',
            stepId: 'fe',
            n: 1,
            status: 'running',
            input: 'a\nb\nc\nd',
            inputs: [{ edgeId: 't-out-fe', from: 't', text: 'a\nb\nc\nd' }],
            items: [
              { id: 'wa', n: 1, text: 'a', status: 'running', chatId: queued, messageId: 'ma' },
              { id: 'wb', n: 2, text: 'b', status: 'running', startedAt: NOW - 500 },
              { id: 'wc', n: 3, text: 'c', status: 'pending' },
              { id: 'wd', n: 4, text: 'd', status: 'pending' }
            ],
            startedAt: NOW - 1000
          }
        ],
        inbox: {},
        allowance: { perStep: {}, total: 200 },
        halted: false,
        startedAt: NOW - 1000
      })
      turns.push({ hold: true, tail: () => [said('B')] })
      const fresh = makeRunner()
      await fresh.recover()
      // a is followed and b, never sent, starts again: both slots are taken, so c and d wait.
      await waitFor(() => held.size === 1, 'b to start again')
      expect(sends.map((s) => s.text)).toEqual([itemOf('b')])
      expect(fresh.messagesOf(queued)).toEqual(new Set(['ma']))
      const statuses = async () => itemsOf(only(await getRun('run-wide'), 'fe')).map((i) => i.status)
      expect(await statuses()).toEqual(['running', 'running', 'pending', 'pending'])
      await held.get(itemsOf(only(await getRun('run-wide'), 'fe'))[1]!.chatId!)!()
      await waitFor(async () => (await statuses())[3] === 'done', 'c and d to take the slot b left')
      expect(sends.map((s) => s.text)).toEqual([itemOf('b'), itemOf('c'), itemOf('d')])
      expect(await statuses()).toEqual(['running', 'done', 'done', 'done'])
      await chats.dropTask(queued, 'ma')
      await chats.saveItems(queued, [{ type: 'user', id: 'ma', text: 'x', ts: NOW }, said('A late')])
      fresh.chatIdle(queued)
      await ended('run-wide')
      expect(only(await getRun('run-wide'), 'fe')).toMatchObject({
        status: 'done',
        output: '## a\n\nA late\n\n## b\n\nB\n\n## c\n\nok\n\n## d\n\nok'
      })
      fresh.stop()
    })
  })

  // An item follows master's paused Agent step: its turn paused by the user leaves it open, so the rest wait on it.
  describe('a paused item', () => {
    const pausedItem = async (input: string, before: FakeTurn[] = []) => {
      turns.push(...before, { tail: () => [said('Half'), notice('userPaused')] })
      const { id } = await runner.run(loop(), 'manual', { input })
      const n = before.length
      await waitFor(async () => itemsOf(await fe(id))[n]!.paused === true, 'the item to pause')
      return { id, chatId: itemsOf(await fe(id))[n]!.chatId! }
    }
    const settleQueue = () => new Promise((resolve) => setTimeout(resolve, 30))

    it("stays open and holds the rest; Resume's Continue carries it on to done, then the next item runs", async () => {
      const { id, chatId } = await pausedItem('a\nb\nc', [{ tail: () => [said('ok')] }])
      let v = await fe(id)
      expect(itemsOf(v).map((i) => i.status)).toEqual(['done', 'running', 'pending'])
      expect(itemsOf(v)[1]!.error).toBeUndefined()
      expect(v.status).toBe('running')
      expect(summarize(await getRun(id))).toMatchObject({
        status: 'running',
        progress: [{ stepId: 'fe', done: 1, failed: 0, total: 3, current: 'b', paused: true }]
      })
      expect(kinds('failed')).toEqual([])
      expect(isArchived(await chatOf(chatId))).toBe(false)

      // Idle rounds and approval pushes while paused change nothing, and start no further item.
      runner.chatIdle(chatId)
      runner.chatPush({ chatId, kind: 'approvals', pending: 0 })
      await settleQueue()
      expect(itemsOf(await fe(id)).map((i) => [i.status, i.paused])).toEqual([
        ['done', undefined],
        ['running', true],
        ['pending', undefined]
      ])
      expect(sends).toHaveLength(2)

      runner.chatResumed(chatId, 'resume-1')
      await waitFor(async () => itemsOf(await fe(id))[1]!.messageId === 'resume-1', 'the item to follow the Continue')
      const resumed = itemsOf(await fe(id))[1]!
      expect(resumed).toMatchObject({ status: 'running', resumes: 1 })
      expect(resumed.paused).toBeUndefined()
      expect(runner.messagesOf(chatId)).toEqual(new Set(['resume-1']))
      expect(summarize(await getRun(id)).progress).toEqual([{ stepId: 'fe', done: 1, failed: 0, total: 3, current: 'b' }])

      await chats.saveItems(chatId, [
        ...(await chats.loadItems(chatId)),
        { type: 'user', id: 'resume-1', text: 'Continue', ts: NOW },
        said('Finished')
      ])
      runner.chatIdle(chatId)
      await ended(id)
      v = await fe(id)
      expect(itemsOf(v).map((i) => [i.status, i.output])).toEqual([
        ['done', 'ok'],
        ['done', 'Finished'],
        ['done', 'ok']
      ])
      expect(itemsOf(v)[1]).toMatchObject({ resumes: 1 })
      expect(sends.map((s) => s.text)).toEqual([itemOf('a'), itemOf('b'), itemOf('c')])
      expect(v).toMatchObject({ status: 'done', output: '## a\n\nok\n\n## b\n\nFinished\n\n## c\n\nok' })
      expect(isArchived(await chatOf(chatId))).toBe(true)
      expect((await getRun(id)).status).toBe('done')
    })

    it("fails the item quietly 'Continued by hand' when the user sends a message of their own, and the next item runs", async () => {
      const { id, chatId } = await pausedItem('a\nb')
      await chats.saveItems(chatId, [
        ...(await chats.loadItems(chatId)),
        { type: 'user', id: 'by-hand', text: 'Do something else', ts: NOW },
        said('Ok')
      ])
      runner.chatIdle(chatId)
      await ended(id)
      const v = await fe(id)
      expect(itemsOf(v).map((i) => [i.status, i.error])).toEqual([
        ['failed', 'Continued by hand'],
        ['done', undefined]
      ])
      expect(v).toMatchObject({ status: 'failed', error: '1 of 2 items failed' })
      expect(kinds('failed')).toEqual([]) // the user's own doing
    })

    it('Stop ends the run without stopping the idle paused chat; the later items stay pending', async () => {
      const { id } = await pausedItem('a\nb')
      await runner.stopRun(id)
      const v = await fe(id)
      expect(itemsOf(v).map((i) => i.status)).toEqual(['stopped', 'pending'])
      expect(v.status).toBe('stopped')
      expect(stoppedChats).toEqual([])
      expect(sends).toHaveLength(1)
    })

    it('recover keeps a paused item waiting for Resume', async () => {
      const { id, chatId } = await pausedItem('a\nb')
      runner.stop()
      const fresh = makeRunner()
      await fresh.recover()
      await settleQueue()
      expect(itemsOf(await fe(id)).map((i) => [i.status, i.paused])).toEqual([
        ['running', true],
        ['pending', undefined]
      ])
      expect(fresh.messagesOf(chatId).size).toBe(1)
      expect(sends).toHaveLength(1)
      fresh.chatResumed(chatId, 'resume-1')
      await waitFor(async () => itemsOf(await fe(id))[0]!.messageId === 'resume-1', 'the item to follow the Continue')
      fresh.stop()
    })
  })

  it('a Stop pressed in an item’s own chat fails that item quietly, and the next item runs', async () => {
    turns.push({ tail: () => [said('Half'), notice('stopped')] })
    const { id } = await runner.run(loop(), 'manual', { input: 'a\nb' })
    await ended(id)
    const v = await fe(id)
    expect(itemsOf(v).map((i) => [i.status, i.error])).toEqual([
      ['failed', 'Stopped'],
      ['done', undefined]
    ])
    expect(sends.map((s) => s.text)).toEqual([itemOf('a'), itemOf('b')])
    expect(v).toMatchObject({ status: 'failed', error: '1 of 2 items failed' })
    expect(kinds('failed')).toEqual([]) // the user's own Stop
  })

  it('a Retry of the whole list counts as one visit of the step', async () => {
    const id = await failSecond()
    const first = await fe(id)
    await runner.retry(id, first.id)
    await ended(id)
    const r = await getRun(id)
    expect(visitsOf(r, 'fe').map((v) => [v.n, v.status])).toEqual([
      [1, 'failed'],
      [2, 'done']
    ])
    // The trigger, two For each visits and the step after: no visit per item.
    expect(r.visits.map((v) => v.stepId)).toEqual(['t', 'fe', 'fe', 'after'])
  })

  it('stopRun during an item stops its chat and leaves later items pending', async () => {
    turns.push({ tail: () => [said('ok')] }, { hold: true, tail: () => [said('Half'), notice('stopped')] })
    const { id } = await runner.run(loop(), 'manual', { input: 'a\nb\nc' })
    await startedTurn()
    const b = itemsOf(await fe(id))[1]!
    await runner.stopRun(id)
    expect(stoppedChats).toEqual([b.chatId])
    const v = await fe(id)
    expect(itemsOf(v).map((i) => i.status)).toEqual(['done', 'stopped', 'pending'])
    expect(v.status).toBe('stopped')
    expect((await getRun(id)).status).toBe('stopped')
    await held.get(b.chatId!)!() // the stop's own end changes nothing, and nothing more is sent
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(itemsOf(await fe(id)).map((i) => i.status)).toEqual(['done', 'stopped', 'pending'])
    expect(sends).toHaveLength(2)
    expect(kinds('failed')).toEqual([])
  })

  it('an item card makes the item, the visit and the run waiting', async () => {
    turns.push({ hold: true, tail: () => [said('Merged')] })
    const { id } = await runner.run(loop(), 'manual', { input: 'a\nb' })
    await startedTurn()
    const chatId = itemsOf(await fe(id))[0]!.chatId!
    runner.chatPush({ chatId, kind: 'approvals', pending: 1 })
    await waitFor(async () => (await getRun(id)).status === 'waiting', 'the run to wait')
    let v = await fe(id)
    expect([v.status, itemsOf(v)[0]!.status, itemsOf(v)[1]!.status]).toEqual(['waiting', 'waiting', 'pending'])
    expect(runner.waitingRuns()).toBe(1)
    runner.chatPush({ chatId, kind: 'approvals', pending: 0 })
    await waitFor(async () => (await getRun(id)).status === 'running', 'the run to run again')
    v = await fe(id)
    expect([v.status, itemsOf(v)[0]!.status]).toEqual(['running', 'running'])
    await held.get(chatId)!()
    await ended(id)
    expect(await fe(id)).toMatchObject({ status: 'done', output: '## a\n\nMerged\n\n## b\n\nok' })
  })

  it('an item usage limit waits for the reset and continues in the same chat', async () => {
    turns.push({ tail: () => [said('Working'), failure('Usage limit reached', NOW + 1000)] }, { tail: () => [said('Finished')] })
    const { id } = await runner.run(loop(), 'manual', { input: 'a' })
    await waitFor(() => live(timers).length === 1, 'the limit wait')
    let item = itemsOf(await fe(id))[0]!
    expect(item).toMatchObject({ status: 'running', until: NOW + 61_000 })
    expect((await fe(id)).status).toBe('running')
    expect(runner.messagesOf(item.chatId!)).toEqual(new Set([item.messageId]))
    fireAll()
    await ended(id)
    item = itemsOf(await fe(id))[0]!
    expect(sends[1]).toEqual({ chatId: item.chatId, text: 'continue', messageId: item.messageId, from: 'routine' })
    expect(item).toMatchObject({ status: 'done', output: 'Finished' })
    expect(item.until).toBeUndefined()
    expect((await getRun(id)).status).toBe('done')
  })

  describe('after a restart', () => {
    const w = loop()
    const user = (id: string): ChatItem => ({ type: 'user', id, text: 'x', ts: NOW })
    const stored = (id: string, items: ItemRun[]): WorkflowRun => ({
      id,
      workflowId: 'w1',
      via: 'manual',
      late: false,
      status: 'running',
      input: 'a\nb\nc',
      snapshot: { steps: w.steps, edges: w.edges },
      visits: [
        {
          id: `${id}-t`,
          stepId: 't',
          n: 1,
          status: 'done',
          input: '',
          inputs: [],
          output: 'a\nb\nc',
          port: 'out',
          startedAt: NOW - 1000,
          endedAt: NOW - 1000
        },
        {
          id: `${id}-fe`,
          stepId: 'fe',
          n: 1,
          status: 'running',
          input: 'a\nb\nc',
          inputs: [{ edgeId: 't-out-fe', from: 't', text: 'a\nb\nc' }],
          items,
          startedAt: NOW - 1000
        }
      ],
      inbox: {},
      allowance: { perStep: {}, total: 200 },
      halted: false,
      startedAt: NOW - 1000
    })
    const item = (id: string, n: number, text: string, over: Partial<ItemRun> = {}): ItemRun => ({
      id,
      n,
      text,
      status: 'pending',
      ...over
    })

    it('recover follows a running item, and starts the next pending item when none is open', async () => {
      await store.put(w)
      const queued = (await chats.create('helper', '/tmp')).id
      await chats.addTask(queued, { id: 'mb', text: 'Do b', ts: NOW })
      await store.addRun(
        stored('run-follow', [
          item('ia', 1, 'a', { status: 'done', output: 'A', chatId: 'old-a', messageId: 'ma' }),
          item('ib', 2, 'b', { status: 'running', chatId: queued, messageId: 'mb' }),
          item('ic', 3, 'c')
        ])
      )
      // A crash between items: the last one settled, the next not yet marked running.
      await store.addRun(
        stored('run-between', [
          item('ja', 1, 'a', { status: 'done', output: 'A' }),
          item('jb', 2, 'b', { status: 'done', output: 'B' }),
          item('jc', 3, 'c')
        ])
      )

      const fresh = makeRunner()
      await fresh.recover()
      await ended('run-between')
      expect(only(await getRun('run-between'), 'fe')).toMatchObject({ status: 'done', output: '## a\n\nA\n\n## b\n\nB\n\n## c\n\nok' })
      expect(sends.map((s) => s.text)).toEqual([itemOf('c')])
      // The queued item is followed, not failed, and nothing after it has started.
      expect(fresh.messagesOf(queued)).toEqual(new Set(['mb']))
      expect(itemsOf(only(await getRun('run-follow'), 'fe')).map((i) => i.status)).toEqual(['done', 'running', 'pending'])

      await chats.dropTask(queued, 'mb')
      await chats.saveItems(queued, [user('mb'), said('B late')])
      fresh.chatIdle(queued)
      await ended('run-follow')
      const v = only(await getRun('run-follow'), 'fe')
      expect(itemsOf(v).map((i) => [i.status, i.output])).toEqual([
        ['done', 'A'],
        ['done', 'B late'],
        ['done', 'ok']
      ])
      expect(v).toMatchObject({ status: 'done', output: '## a\n\nA\n\n## b\n\nB late\n\n## c\n\nok' })
      expect(sends.map((s) => s.text)).toEqual([itemOf('c'), itemOf('c')])
      fresh.stop()
    })

    it('an item marked running but never sent is started again after a restart', async () => {
      await store.put(w)
      await store.addRun(stored('run-unsent', [item('ka', 1, 'a', { status: 'running', startedAt: NOW - 500 }), item('kb', 2, 'b')]))
      const fresh = makeRunner()
      await fresh.recover()
      await ended('run-unsent')
      const v = only(await getRun('run-unsent'), 'fe')
      expect(sends.map((s) => s.text)).toEqual([itemOf('a'), itemOf('b')])
      expect(itemsOf(v).map((i) => i.status)).toEqual(['done', 'done'])
      expect(v).toMatchObject({ status: 'done', output: '## a\n\nok\n\n## b\n\nok' })
      expect(kinds('failed')).toEqual([])
      fresh.stop()
    })

    it('a restart during an item’s usage-limit wait waits again, then sends continue into the same chat', async () => {
      await store.put(w)
      const chatId = (await chats.create('helper', '/tmp')).id
      await chats.saveItems(chatId, [user('ma'), said('Working'), failure('Usage limit reached', NOW + 1000)])
      const until = NOW + 61_000
      await store.addRun(
        stored('run-limit', [item('la', 1, 'a', { status: 'running', chatId, messageId: 'ma', until }), item('lb', 2, 'b')])
      )
      const fresh = makeRunner()
      await fresh.recover()
      expect(live(timers).map((t) => t.ms)).toEqual([61_000])
      expect(sends).toEqual([])
      fireAll()
      await ended('run-limit')
      const v = only(await getRun('run-limit'), 'fe')
      expect(sends.map((s) => [s.chatId, s.text])).toEqual([
        [chatId, 'continue'],
        [itemsOf(v)[1]!.chatId, itemOf('b')]
      ])
      expect(itemsOf(v).map((i) => [i.status, i.output, i.until])).toEqual([
        ['done', 'ok', undefined],
        ['done', 'ok', undefined]
      ])
      expect(v).toMatchObject({ status: 'done', output: '## a\n\nok\n\n## b\n\nok' })
      fresh.stop()
    })
  })

  it('item costs count on the item and the visit', async () => {
    turns.push({ hold: true, tail: () => [said('ok')] })
    const { id } = await runner.run(loop(), 'manual', { input: 'a\nb' })
    await startedTurn()
    const chatId = itemsOf(await fe(id))[0]!.chatId!
    runner.chatCost(chatId, 0.5)
    await waitFor(async () => (await fe(id)).costUsd === 0.5, 'the visit’s cost')
    expect(itemsOf(await fe(id))[0]!.costUsd).toBe(0.5)
    await held.get(chatId)!()
    await ended(id)
    const v = await fe(id)
    expect(itemsOf(v).map((i) => i.costUsd)).toEqual([0.5, undefined])
    expect(v.costUsd).toBe(0.5)
    expect(summarize(await getRun(id)).costUsd).toBe(0.5)
  })

  it('a bad list fails the visit before any item; an empty list hands on an empty output', async () => {
    const long = Array.from({ length: 101 }, (_, i) => `area ${i}`).join('\n')
    const bad = await runner.run(loop([L('after', 'Next')], [e('fe', 'after')]), 'manual', { input: long })
    await ended(bad.id)
    let r = await getRun(bad.id)
    expect(only(r, 'fe')).toMatchObject({ status: 'failed', error: 'The list has 101 items; the most is 100' })
    expect(only(r, 'fe').items).toBeUndefined()
    expect(r).toMatchObject({ status: 'failed', halted: true })
    expect(visitsOf(r, 'after')).toEqual([])
    expect(sends).toEqual([])

    const empty = await runner.run(loop([L('after', 'Next')], [e('fe', 'after')]), 'manual', { input: '' })
    await ended(empty.id)
    r = await getRun(empty.id)
    expect(only(r, 'fe')).toMatchObject({ status: 'done', output: '', port: 'out', items: [] })
    expect(only(r, 'after')).toMatchObject({ status: 'done', input: '' })
    expect(r.status).toBe('done')
    expect(sends).toEqual([])
  })

  it('done item chats are archived, a failed item chat stays', async () => {
    turns.push({ tail: () => [said('ok')] }, { tail: () => [failure('Claude exited with code 1')] })
    const { id } = await runner.run(loop(), 'manual', { input: 'a\nb' })
    await ended(id)
    const [a, b] = itemsOf(await fe(id))
    expect(isArchived(await chatOf(a!.chatId))).toBe(true)
    expect(isArchived(await chatOf(b!.chatId))).toBe(false)
    expect(metaPushes.map((m) => m.id)).toEqual([a!.chatId])
  })

  it('a deleted item chat fails that item and the next item starts', async () => {
    turns.push({ hold: true })
    const { id } = await runner.run(loop(), 'manual', { input: 'a\nb' })
    await startedTurn()
    const a = itemsOf(await fe(id))[0]!
    await chats.remove(a.chatId!)
    runner.chatRemoved(a.chatId!)
    await ended(id)
    const v = await fe(id)
    expect(itemsOf(v).map((i) => [i.status, i.error])).toEqual([
      ['failed', 'Chat was deleted'],
      ['done', undefined]
    ])
    expect(sends).toHaveLength(2)
    expect(sends[1]!.chatId).not.toBe(a.chatId)
    expect(v).toMatchObject({ status: 'failed', error: '1 of 2 items failed' })
    expect(kinds('failed')).toEqual([]) // the user deleted it
  })

  it('stopAllOf mid-loop stops the item chat and starts no later item', async () => {
    turns.push({ hold: true, tail: () => [said('Half'), notice('stopped')] })
    const { id } = await runner.run(loop(), 'manual', { input: 'a\nb' })
    await startedTurn()
    const a = itemsOf(await fe(id))[0]!
    await runner.stopAllOf('w1')
    expect(stoppedChats).toEqual([a.chatId])
    await held.get(a.chatId!)!()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const v = await fe(id)
    expect(itemsOf(v).map((i) => i.status)).toEqual(['stopped', 'pending'])
    expect(v.status).toBe('stopped')
    expect((await getRun(id)).status).toBe('stopped')
    expect(sends).toHaveLength(1)
  })

  it('a step agent deleted mid-loop fails the later items without chats', async () => {
    turns.push({ hold: true, tail: () => [said('ok')] })
    const { id } = await runner.run(loop(), 'manual', { input: 'a\nb\nc' })
    await startedTurn()
    const a = itemsOf(await fe(id))[0]!
    agentList = []
    await held.get(a.chatId!)!()
    await ended(id)
    const v = await fe(id)
    expect(itemsOf(v).map((i) => [i.status, i.error, i.chatId])).toEqual([
      ['done', undefined, a.chatId],
      ['failed', 'Agent "helper" not found', undefined],
      ['failed', 'Agent "helper" not found', undefined]
    ])
    expect(v).toMatchObject({ status: 'failed', error: '2 of 3 items failed' })
    expect(sends).toHaveLength(1)
    expect((await chats.list()).filter((c) => c.workflow?.runId === id)).toHaveLength(1)
  })

  it('testStep foreach runs the first item only', async () => {
    const w = loop()
    const out = await runner.testStep(w, 'fe', 'x\ny')
    expect(out).toEqual({ chatId: expect.any(String), output: 'ok' })
    expect(sends).toHaveLength(1)
    expect(sends[0]!.text).toBe(itemOf('x'))
    expect(await chatOf(out.chatId)).toMatchObject({ title: 'Flow · FE · test', agentName: 'helper', cwd: '/tmp', workflowTest: 'Flow' })
    expect(await runner.testStep(w, 'fe', '')).toEqual({ error: 'No items in the input' })
    expect(await runner.testStep(w, 'fe', Array.from({ length: 101 }, (_, i) => `${i}`).join('\n'))).toEqual({
      error: 'The list has 101 items; the most is 100'
    })
    missingDirs.add('/tmp')
    expect(await runner.testStep(w, 'fe', 'x')).toEqual({ error: 'Folder not found' })
    expect(await runner.problems(w)).toEqual([{ stepId: 'fe', text: 'Folder not found' }])
    expect(sends).toHaveLength(1)
    expect(await store.runs()).toEqual({})
  })

  it('the run summary carries progress while a for each visit is open', async () => {
    turns.push({ tail: () => [said('ok')] }, { hold: true, tail: () => [said('ok')] })
    const { id } = await runner.run(loop(), 'manual', { input: 'a\nb\nc' })
    await startedTurn()
    expect(summarize(await getRun(id)).progress).toEqual([{ stepId: 'fe', done: 1, failed: 0, total: 3, current: 'b' }])
    await held.get(itemsOf(await fe(id))[1]!.chatId!)!()
    await ended(id)
    expect(summarize(await getRun(id)).progress).toBeUndefined()
  })
})

describe('spend caps', () => {
  const A = (id: string, prompt: string): Step => ({ ...base(id, id.toUpperCase()), kind: 'agent', agent: 'alpha', prompt, cwd: '/work' })
  const helper: AgentSummary = { ...agent, filePath: '/agents/helper.md', name: 'helper' }
  const FE = (id: string, prompt: string): Step => ({
    ...base(id, id.toUpperCase()),
    kind: 'foreach',
    agent: 'helper',
    prompt,
    cwd: '/tmp'
  })
  let cap: number | null
  let liveBy: Map<string, number>
  let over: Map<string, { spentUsd: number; limitUsd: number; capUsd: number }>
  let holds: WorkflowRun[]
  let allowed: string[]
  const capped = (): WorkflowRunner =>
    makeRunner({
      caps: {
        context: async () => ({ cap, liveBy: new Map(liveBy), agents: new Map(over) }),
        held: (run) => {
          holds.push(run)
        },
        allowMore: async (a) => {
          allowed.push(a)
          over.delete(a)
        }
      }
    })
  const held_ = (id: string) => waitFor(async () => (await getRun(id)).capHold !== undefined, 'the cap hold')
  beforeEach(() => {
    cap = null
    liveBy = new Map()
    over = new Map()
    holds = []
    allowed = []
    runner.stop()
    runner = capped()
  })

  it("a run that reaches its cap starts nothing more, waits, and Continue allows one more cap's worth", async () => {
    cap = 0.015
    const w = flow([L('a', 'One'), L('b', 'Two'), L('c', 'Three')], [e('t', 'a'), e('a', 'b'), e('b', 'c')])
    const { id } = await runner.run(w, 'manual')
    await held_(id)
    let r = await getRun(id)
    // a then b ran (0.01 each): 0.02 reached the 0.015 cap, so c never started.
    expect(r.visits.map((v) => v.stepId)).toEqual(['t', 'a', 'b'])
    expect(r).toMatchObject({ status: 'waiting', capHold: { kind: 'run', limitUsd: 0.015, capUsd: 0.015, at: NOW } })
    expect(r.capHold!.spentUsd).toBeCloseTo(0.02)
    expect(holds.map((h) => h.id)).toEqual([id])
    expect(summarize(r).capHold).toEqual(r.capHold)
    await runner.continueCap(id)
    await ended(id)
    r = await getRun(id)
    expect(r.status).toBe('done')
    expect(r.capLimitUsd).toBeCloseTo(0.035)
    expect(r.capHold).toBeUndefined()
    expect(only(r, 'c').status).toBe('done')
    expect(holds).toHaveLength(1)
  })

  it('a run with nothing left to start just ends, holding nothing', async () => {
    cap = 0.005
    const { id } = await runner.run(flow([L('a', 'One')], [e('t', 'a')]), 'manual')
    await ended(id)
    expect(await getRun(id)).toMatchObject({ status: 'done' })
    expect((await getRun(id)).capHold).toBeUndefined()
    expect(holds).toEqual([])
  })

  it('the live estimate of its running turns counts, and a mid-turn check holds the run', async () => {
    cap = 1
    turns.push({ hold: true, tail: () => [said('Done')] })
    const { id } = await runner.run(flow([A('g', 'Long job'), L('n', 'Next')], [e('t', 'g'), e('g', 'n')]), 'manual')
    await waitFor(() => held.size === 1, 'the turn')
    const message = only(await getRun(id), 'g').messageId!
    liveBy.set(message, 0.5)
    // A turn in its chat that answers another message (the user's own) is not the run's.
    liveBy.set('someone-elses-message', 5)
    await runner.checkCap(id)
    expect((await getRun(id)).capHold).toBeUndefined()
    liveBy.set(message, 1.2)
    await runner.checkCap(id)
    expect(await getRun(id)).toMatchObject({ status: 'waiting', capHold: { kind: 'run', spentUsd: 1.2, limitUsd: 1 } })
    expect(holds).toHaveLength(1)
    // A second check does not hold it again.
    await runner.checkCap(id)
    expect(holds).toHaveLength(1)
    // The turn ends: its step is done, the next one waits for Continue.
    liveBy.clear()
    const chatId = only(await getRun(id), 'g').chatId!
    await held.get(chatId)!()
    await waitFor(async () => only(await getRun(id), 'g').status === 'done', 'the step')
    expect(visitsOf(await getRun(id), 'n')).toEqual([])
    expect((await getRun(id)).status).toBe('waiting')
  })

  it('an Agent step on an agent past its daily cap holds the run; Continue allows that agent more first', async () => {
    over.set('alpha', { spentUsd: 6, limitUsd: 5, capUsd: 5 })
    const { id } = await runner.run(flow([A('g', 'Job')], [e('t', 'g')]), 'manual')
    await held_(id)
    expect(await getRun(id)).toMatchObject({
      status: 'waiting',
      capHold: { kind: 'agent', agent: 'alpha', spentUsd: 6, limitUsd: 5, capUsd: 5 }
    })
    expect(sends).toEqual([])
    await runner.continueCap(id)
    expect(allowed).toEqual(['alpha'])
    await ended(id)
    expect(only(await getRun(id), 'g').status).toBe('done')
    // An agent's hold raises no limit on the run itself.
    expect((await getRun(id)).capLimitUsd).toBeUndefined()
  })

  it('a Chat step on a chat whose agent is past its daily cap holds the run, and so does a room with such a member', async () => {
    const K = (id: string, chat: string): Step => ({ ...base(id, 'Chat'), kind: 'chat', chat, prompt: 'Go' })
    over.set('helper', { spentUsd: 6, limitUsd: 5, capUsd: 5 })
    agentList = [agent, helper]
    const single = await chats.create('helper', '/work')
    let { id } = await runner.run(flow([K('c', single.id)], [e('t', 'c')]), 'manual')
    await held_(id)
    expect(await getRun(id)).toMatchObject({
      status: 'waiting',
      capHold: { kind: 'agent', agent: 'helper', spentUsd: 6, limitUsd: 5, capUsd: 5 }
    })
    expect(sends).toEqual([])

    const room = await chats.createGroup(['alpha', 'helper'], '/work')
    ;({ id } = await runner.run(flow([K('c', room.id)], [e('t', 'c')], { id: 'w2' }), 'manual'))
    await held_(id)
    expect((await getRun(id)).capHold).toMatchObject({ kind: 'agent', agent: 'helper' })
    expect(sends).toEqual([])

    // An agent that is not over its cap holds nothing.
    const fine = await chats.create('alpha', '/work')
    ;({ id } = await runner.run(flow([K('c', fine.id)], [e('t', 'c')], { id: 'w3' }), 'manual'))
    await ended(id)
    expect(only(await getRun(id), 'c').status).toBe('done')
  })

  it('a For each list stops starting items at the cap and fills its slots again on Continue', async () => {
    agentList = [agent, helper]
    cap = 0.4
    turns.push({ hold: true, tail: () => [said('one')] }, { tail: () => [said('two')] }, { tail: () => [said('three')] })
    const { id } = await runner.run(flow([FE('fe', 'Do {{item}}')], [e('t', 'fe')]), 'manual', { input: 'a\nb\nc' })
    await waitFor(() => held.size === 1, 'the first item')
    const first = only(await getRun(id), 'fe').items![0]!
    runner.chatCost(first.chatId!, 0.5)
    await waitFor(async () => (only(await getRun(id), 'fe').costUsd ?? 0) === 0.5, 'its cost')
    await held.get(first.chatId!)!()
    await held_(id)
    let v = only(await getRun(id), 'fe')
    expect(v.items!.map((i) => i.status)).toEqual(['done', 'pending', 'pending'])
    expect(v.status).toBe('running')
    expect((await getRun(id)).status).toBe('waiting')
    expect(sends).toHaveLength(1)
    await runner.continueCap(id)
    await ended(id)
    v = only(await getRun(id), 'fe')
    expect(v.items!.map((i) => i.status)).toEqual(['done', 'done', 'done'])
    expect(sends).toHaveLength(3)
  })

  it('Continue on a run no cap holds is refused', async () => {
    const { id } = await runner.run(flow([L('a', 'One')], [e('t', 'a')]), 'manual')
    await ended(id)
    await expect(runner.continueCap(id)).rejects.toThrow('This run is not held by a spend cap')
  })
})

describe('step commands', () => {
  const check: AgentCommand = { name: 'check', description: 'c', prompt: 'Use check on $ARGUMENTS' }
  const helper: AgentSummary = { ...agent, filePath: '/agents/helper.md', name: 'helper' }
  const A = (prompt: string, command?: CommandPick): Step => ({
    ...base('a', 'Agent'),
    kind: 'agent',
    agent: 'alpha',
    prompt,
    cwd: '/tmp',
    ...(command ? { command } : {})
  })
  const real = () => new CommandResolver({ store: chats, commandsOf: async () => [check] })
  const recording = () => {
    const calls: { chatId: string; saved: string; text: string; pick?: CommandPick }[] = []
    const resolver = real()
    const commands = {
      forRoutine: async (chatId: string, saved: string, text: string, pick?: CommandPick) => {
        calls.push({ chatId, saved, text, ...(pick ? { pick } : {}) })
        return resolver.forRoutine(chatId, saved, text, pick)
      }
    }
    return { calls, commands }
  }
  const use = (commands: Pick<CommandResolver, 'forRoutine'>) => {
    runner.stop()
    runner = makeRunner({ commands })
  }

  it('resolves a leading command from the saved prompt', async () => {
    const { calls, commands } = recording()
    use(commands)
    const pick = { agent: 'alpha', name: 'check' }
    const { id } = await runner.run(flow([A('/check {{input}}', pick)], [e('t', 'a')]), 'manual', { input: 'go' })
    await ended(id)
    const v = only(await getRun(id), 'a')
    const text = '/check <input from="Start">\ngo\n</input>'
    expect(calls).toEqual([{ chatId: v.chatId, saved: '/check {{input}}', text, pick }])
    expect(sends).toHaveLength(1)
    expect(sends[0]).toMatchObject({
      text,
      from: 'routine',
      command: { agent: 'alpha', name: 'check', prompt: `Use check on <input from="Start">\ngo\n</input>` }
    })
  })

  it('never makes a command from a filled value', async () => {
    const { calls, commands } = recording()
    use(commands)
    const { id } = await runner.run(flow([A('{{trigger.text}}')], [e('t', 'a')]), 'manual', { input: '/check now' })
    await ended(id)
    expect(sends[0]!.text.startsWith('/check now')).toBe(true) // it does lead the text, but the saved prompt does not
    expect(calls).toHaveLength(1)
    expect(sends[0]!.command).toBeUndefined()
  })

  it('fails the visit with the resolver’s sentence when the name is ambiguous in a room', async () => {
    use({
      forRoutine: async () => {
        throw new Error('Several members have /check (A, B): pick one from the / menu')
      }
    })
    const R: Step = { ...base('r', 'R'), kind: 'room', room: 'tpl', prompt: '/check {{input}}' }
    const { id } = await runner.run(flow([R], [e('t', 'r')]), 'manual', { input: 'go' })
    await ended(id)
    expect(only(await getRun(id), 'r')).toMatchObject({
      status: 'failed',
      error: 'Several members have /check (A, B): pick one from the / menu'
    })
    expect(sends).toEqual([])
  })

  it('sends a chat step and a room step with their command', async () => {
    const { calls, commands } = recording()
    use(commands)
    const chat = await chats.create('alpha', '/work')
    const K: Step = { ...base('c', 'C'), kind: 'chat', chat: chat.id, prompt: '/check {{input}}' }
    const R: Step = { ...base('r', 'R'), kind: 'room', room: 'tpl', prompt: '/check {{input}}' }
    const { id } = await runner.run(flow([K, R], [e('t', 'c'), e('t', 'r')]), 'manual', { input: 'go' })
    await ended(id)
    expect(calls.map((c) => c.saved)).toEqual(['/check {{input}}', '/check {{input}}'])
    expect(sends.map((s) => s.command?.name)).toEqual(['check', 'check'])
    // The material rule follows the blocks, so the name still leads a chat step's message.
    expect(sends.find((s) => s.chatId === chat.id)!.text).toBe(`/check <input from="Start">\ngo\n</input>\n\n${MATERIAL_RULE}`)
  })

  it('sends each For each item with the command', async () => {
    agentList = [agent, helper]
    const { calls, commands } = recording()
    use(commands)
    const FE: Step = {
      ...base('fe', 'FE'),
      kind: 'foreach',
      agent: 'helper',
      prompt: '/check {{item}}',
      cwd: '/tmp',
      command: { agent: 'helper', name: 'check' }
    }
    const { id } = await runner.run(flow([FE], [e('t', 'fe')]), 'manual', { input: 'a\nb' })
    await ended(id)
    expect(calls.map((c) => [c.saved, c.pick])).toEqual(Array(2).fill(['/check {{item}}', { agent: 'helper', name: 'check' }]))
    expect(sends.map((s) => [s.text, s.command?.name])).toEqual([
      ['/check <input from="item">\na\n</input>', 'check'],
      ['/check <input from="item">\nb\n</input>', 'check']
    ])
  })
})

describe('run settings', () => {
  const helper: AgentSummary = { ...agent, filePath: '/agents/helper.md', name: 'helper' }
  const call: WebhookCall = { method: 'POST', query: {}, body: { action: 'opened' }, receivedAt: 1 }
  const hook = (condition: string, sample: WebhookCall | null = null): Extract<Workflow['trigger'], { kind: 'webhook' }> => ({
    kind: 'webhook',
    sample,
    filters: [],
    condition
  })

  it('skips a late schedule run when missed runs are skipped, and runs it otherwise', async () => {
    const w = flow([L('a', 'Late')], [e('t', 'a')], { missedPolicy: 'skip' })
    const skipped = await runner.run(w, 'schedule', { late: true })
    expect(skipped).toMatchObject({ status: 'skipped', error: MISSED_TEXT })
    expect(await getRun(skipped.id)).toMatchObject({ status: 'skipped', visits: [] })
    expect(llmPrompts).toEqual([])
    // On time, or without the setting: it runs.
    await ended((await runner.run(w, 'schedule')).id)
    await ended((await runner.run({ ...w, missedPolicy: undefined }, 'schedule', { late: true })).id)
    expect(llmPrompts).toHaveLength(2)
    expect(kinds('failed')).toEqual([])
  })

  it('skips the run at the usage limit, stopping the other items, with no failure push', async () => {
    agentList = [agent, helper]
    turns.push(
      { hold: true, tail: () => [said('Working'), failure('Usage limit reached', NOW + 1000)] },
      { hold: true, tail: () => [said('Never')] }
    )
    const FE: Step = { ...base('fe', 'FE'), kind: 'foreach', agent: 'helper', prompt: 'Do {{item}}', cwd: '/tmp', concurrency: 2 } as Step
    const w = flow([FE], [e('t', 'fe')], { limitPolicy: 'skip' })
    const { id } = await runner.run(w, 'manual', { input: 'a\nb' })
    await waitFor(() => held.size === 2, 'both items to run')
    const items = only(await getRun(id), 'fe').items!
    await held.get(items[0]!.chatId!)!()
    await ended(id)
    const r = await getRun(id)
    expect(r).toMatchObject({ status: 'skipped', error: LIMIT_SKIP_TEXT })
    expect(only(r, 'fe').items!.map((i) => i.status)).toEqual(['stopped', 'stopped'])
    expect(only(r, 'fe').status).toBe('stopped')
    expect(kinds('failed')).toEqual([])
    expect(live(timers)).toEqual([])
    expect(stoppedChats).toContain(items[1]!.chatId)
  })

  it('skips at an Agent step usage limit too, and an unknown reset skips as well', async () => {
    turns.push({ tail: () => [said('Working'), failure('Usage limit reached', null)] })
    const A: Step = { ...base('g', 'G'), kind: 'agent', agent: 'alpha', prompt: 'Go', cwd: '/tmp' }
    const { id } = await runner.run(flow([A], [e('t', 'g')], { limitPolicy: 'skip' }), 'manual')
    await ended(id)
    expect(await getRun(id)).toMatchObject({ status: 'skipped', error: LIMIT_SKIP_TEXT })
    expect(kinds('failed')).toEqual([])
  })

  it('skips at a bare call limit too', async () => {
    const w = flow([L('a', 'Busy #LIMIT')], [e('t', 'a')], { limitPolicy: 'skip' })
    const { id } = await runner.run(w, 'manual')
    await ended(id)
    const r = await getRun(id)
    expect(r).toMatchObject({ status: 'skipped', error: LIMIT_SKIP_TEXT })
    expect(only(r, 'a').status).toBe('stopped')
    expect(live(timers)).toEqual([])
    expect(kinds('failed')).toEqual([])
  })

  it('a restart keeps honouring the setting', async () => {
    await store.put(flow([L('a', 'Busy #LIMIT')], [e('t', 'a')], { limitPolicy: 'skip' }))
    const w = (await store.get('w1'))!
    const visit: Visit = {
      id: 'va',
      stepId: 'a',
      n: 1,
      status: 'running',
      input: 'in',
      inputs: [{ edgeId: 't-out-a', from: 't', text: 'in' }],
      startedAt: NOW - 1000
    }
    const trigger: Visit = {
      id: 'vt',
      stepId: 't',
      n: 1,
      status: 'done',
      input: '',
      inputs: [],
      output: 'in',
      port: 'out',
      startedAt: NOW - 1000,
      endedAt: NOW - 1000
    }
    await store.addRun({
      id: 'run-r',
      workflowId: 'w1',
      via: 'manual',
      late: false,
      status: 'running',
      snapshot: { steps: w.steps, edges: w.edges },
      visits: [trigger, visit],
      inbox: {},
      allowance: { perStep: {}, total: 200 },
      halted: false,
      startedAt: NOW - 1000
    })
    const fresh = makeRunner()
    runner = fresh
    await fresh.recover()
    await ended('run-r')
    expect(await getRun('run-r')).toMatchObject({ status: 'skipped', error: LIMIT_SKIP_TEXT })
  })

  it('waits as before without the setting', async () => {
    const { id } = await runner.run(flow([L('a', 'Busy #LIMIT')], [e('t', 'a')]), 'manual')
    await waitFor(() => live(timers).length === 1, 'the limit wait')
    expect((await getRun(id)).status).toBe('running')
  })

  describe('the Jev condition', () => {
    const withCondition = (check: (c: string, call: WebhookCall) => Promise<{ met: boolean | null; p?: number } | null>) => {
      const dep = vi.fn(check)
      runner.stop()
      runner = makeRunner({ condition: dep })
      return dep
    }

    it('skips a real call whose condition is not met, after the filters', async () => {
      const dep = withCondition(async () => ({ met: false, p: 0.1 }))
      const filtered = flow([L('a', 'Triage')], [e('t', 'a')], {
        trigger: { ...hook('Only urgent ones'), filters: [{ field: 'body.action', equals: 'closed' }] }
      })
      // The filter fails first: Jev is never asked.
      expect(await runner.run(filtered, 'webhook', { call })).toMatchObject({ status: 'skipped', error: 'Filter did not match' })
      expect(dep).not.toHaveBeenCalled()
      const w = flow([L('a', 'Triage')], [e('t', 'a')], { trigger: hook('Only urgent ones') })
      const skipped = await runner.run(w, 'webhook', { call })
      expect(dep).toHaveBeenCalledWith('Only urgent ones', call)
      expect(skipped).toMatchObject({ status: 'skipped', error: CONDITION_TEXT })
      expect(await getRun(skipped.id)).toMatchObject({ status: 'skipped', visits: [], condition: { met: false, p: 0.1 } })
      expect(llmPrompts).toEqual([])
      expect(kinds('failed')).toEqual([])
    })

    it('runs when the condition is met, unknown, or Jev fails, and never for Run with the sample', async () => {
      const answers: ({ met: boolean | null; p?: number } | null | Error)[] = [
        { met: true, p: 0.9 },
        { met: null },
        null,
        new Error('jev down')
      ]
      const dep = withCondition(async () => {
        const a = answers.shift()!
        if (a instanceof Error) throw a
        return a
      })
      const w = flow([L('a', 'Triage')], [e('t', 'a')], { trigger: hook('Only urgent ones', call) })
      for (let i = 0; i < 4; i++) {
        const { id } = await runner.run(w, 'webhook', { call })
        await ended(id)
        expect((await getRun(id)).status).toBe('done')
      }
      expect(dep).toHaveBeenCalledTimes(4)
      // Run workflow on the saved sample is the user asking for it.
      await ended((await runner.run(w, 'manual')).id)
      expect(dep).toHaveBeenCalledTimes(4)
    })

    it('ignores a blank condition, and asks nothing without the dep', async () => {
      const dep = withCondition(async () => ({ met: false }))
      await ended((await runner.run(flow([L('a', 'Triage')], [e('t', 'a')], { trigger: hook('   ') }), 'webhook', { call })).id)
      expect(dep).not.toHaveBeenCalled()
      runner.stop()
      runner = makeRunner()
      const { id } = await runner.run(flow([L('a', 'Triage')], [e('t', 'a')], { trigger: hook('Only urgent ones') }), 'webhook', { call })
      await ended(id)
      expect((await getRun(id)).status).toBe('done')
    })
  })
})

describe('spend cap and the agent engine', () => {
  const gem: AgentSummary = { ...agent, filePath: '/agents/gem.md', name: 'gem', provider: 'acp' }
  const step = (agentName: string): Step => ({ ...base('a', 'A'), kind: 'agent', agent: agentName, prompt: 'Go', cwd: '/work' })
  const checked = (): WorkflowRunner => makeRunner({ capEngines: capEngines({ agents: async () => [agent, gem], chats }) })
  beforeEach(() => {
    agentList = [agent, gem]
    runner.stop()
    runner = checked()
  })

  it('a capped workflow whose Agent step is now on an engine without cost is refused at its start: a manual run throws, the rest are stored failed', async () => {
    const w = flow([step('gem')], [e('t', 'a')], { spendCap: 5 })
    await expect(runner.run(w, 'manual')).rejects.toThrow(spendCapRefusal('acp', 'gem'))
    expect(await store.runs()).toEqual({})
    const r = await runner.run(w, 'schedule')
    expect(r).toMatchObject({ status: 'failed', error: spendCapRefusal('acp', 'gem') })
    expect(sends).toEqual([])
  })

  it("an event workflow whose cap can't hold pushes its failure once per streak, not on every event", async () => {
    const trigger = { kind: 'file' as const, path: '/here', pattern: '', changes: ['added' as const], filters: [] }
    const w = flow([step('gem')], [e('t', 'a')], { trigger, spendCap: 5 })
    const ev = () => runner.run(w, 'event', { event: { kind: 'file', depth: 1 }, input: '/here/a' })
    expect(await ev()).toMatchObject({ status: 'failed', error: spendCapRefusal('acp', 'gem') })
    expect(await ev()).toMatchObject({ status: 'failed', error: spendCapRefusal('acp', 'gem') })
    expect(await ev()).toMatchObject({ status: 'failed', error: spendCapRefusal('acp', 'gem') })
    expect(notes.filter((n) => n.kind === 'failed')).toHaveLength(1)
    // A schedule run is not an event: it still tells.
    await runner.run(w, 'schedule')
    expect(notes.filter((n) => n.kind === 'failed')).toHaveLength(2)
  })

  it('a lookup that throws refuses the capped run with the fixed sentence, never runs it uncapped', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    runner.stop()
    runner = makeRunner({
      capEngines: {
        workflow: async () => {
          throw Object.assign(new Error('secret /path'), { code: 'EIO' })
        }
      }
    })
    const w = flow([step('alpha')], [e('t', 'a')], { spendCap: 5 })
    await expect(runner.run(w, 'manual')).rejects.toThrow(SPEND_CAP_UNCHECKED)
    expect(await runner.run(w, 'schedule')).toMatchObject({ status: 'failed', error: SPEND_CAP_UNCHECKED })
    expect(sends).toEqual([])
    expect(err.mock.calls.flat().join(' ')).toContain('EIO')
    expect(err.mock.calls.flat().join(' ')).not.toContain('secret')
    err.mockRestore()
  })

  it('without a cap, or with a cap and only agents that report a cost, it starts as before', async () => {
    turns.push({ tail: () => [said('ok')] }, { tail: () => [said('ok')] })
    const { id } = await runner.run(flow([step('gem')], [e('t', 'a')]), 'manual')
    await ended(id)
    expect((await getRun(id)).status).toBe('done')
    const { id: id2 } = await runner.run(flow([step('alpha')], [e('t', 'a')], { id: 'w2', spendCap: 5 }), 'manual')
    await ended(id2)
    expect((await getRun(id2)).status).toBe('done')
  })
})
