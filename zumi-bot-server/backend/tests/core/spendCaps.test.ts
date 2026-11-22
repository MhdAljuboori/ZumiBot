import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Routine, RoutineRun } from '@zumibot/shared/routines'
import type { CapPause } from '@zumibot/shared/spendCaps'
import type { AgentSummary, ChatMeta } from '@zumibot/shared/types'
import type { Visit, Workflow, WorkflowRun } from '@zumibot/shared/workflows'
import type { LiveSpend } from '../../src/core/chat/chatService'
import { CapStore } from '../../src/core/caps/capStore'
import { NO_DAILY_CAP, SpendCaps, type CapNotice, type SpendCapsDeps } from '../../src/core/caps/spendCaps'

const NOW = Date.UTC(2026, 10, 12, 15)
const DAY = '2026-11-12'

const agent = (name: string, dailySpendCap?: number): AgentSummary => ({
  filePath: `/a/${name}.md`,
  name,
  description: '',
  color: null,
  icon: null,
  error: null,
  builtIn: false,
  ...(dailySpendCap !== undefined ? { dailySpendCap } : {})
})
const chat = (id: string, agentName: string, extra: Partial<ChatMeta> = {}): ChatMeta =>
  ({ id, agentName, sessionId: null, cwd: '/', title: id, createdAt: 1, updatedAt: 1, inFlight: true, ...extra }) as ChatMeta
const spend = (chatId: string, a: string, attempt: string, usd: number, message: string | null = `m-${attempt}`): LiveSpend => ({
  chatId,
  agent: a,
  attempt,
  usd,
  message
})

let dir: string
let store: CapStore
let chats: Map<string, ChatMeta>
let running: Set<string>
let paused: { chatId: string; cap: CapPause }[]
let resumed: string[]
let notices: CapNotice[]
let agents: AgentSummary[]
let spent: Map<string, number>
let skipped: ReadonlySet<string>[]
let routines: Map<string, Routine>
let runs: Map<string, RoutineRun>
let runsIn: Map<string, { routineId: string; runId: string; messageId: string }[]>
let wfRunsIn: Map<string, { workflowId: string; runId: string; messageId: string }[]>
let workflows: Map<string, Workflow>
let workflowRuns: Map<string, WorkflowRun>
let checked: string[]
let continued: string[]
let caps: SpendCaps

const make = (over: Partial<SpendCapsDeps> = {}): SpendCaps =>
  new SpendCaps({
    store,
    chats: { get: async (id) => chats.get(id) ?? null, list: async () => [...chats.values()] },
    isRunning: (id) => running.has(id),
    // As TaskQueue's: the chat is pausing at once.
    pause: async (chatId, cap) => {
      paused.push({ chatId, cap })
      chats.set(chatId, { ...chats.get(chatId)!, pause: 'pausing', pauseCap: cap })
    },
    resume: async (id) => {
      resumed.push(id)
    },
    agents: async () => agents,
    agentSpend: (a, _from, skip) => {
      skipped.push(skip)
      return spent.get(a) ?? 0
    },
    timeZone: async () => 'UTC',
    workflows: {
      get: async (id) => workflows.get(id) ?? null,
      getRun: async (id) => workflowRuns.get(id) ?? null,
      checkCap: async (runId) => {
        checked.push(runId)
      },
      continueCap: async (runId) => {
        continued.push(runId)
        const r = workflowRuns.get(runId)
        if (r) {
          const { capHold: _gone, ...rest } = r
          workflowRuns.set(runId, rest as WorkflowRun)
        }
        return {} as WorkflowRun
      },
      runsIn: (chatId) => wfRunsIn.get(chatId) ?? []
    },
    routines: {
      get: async (id) => routines.get(id) ?? null,
      getRun: async (_r, runId) => runs.get(runId) ?? null,
      runsIn: (chatId) => runsIn.get(chatId) ?? [],
      capMark: async (_r, runId, mark) => {
        const cur = runs.get(runId)!
        const next = { ...cur, ...('capped' in mark ? { capped: true as const } : { capLimitUsd: mark.limit }) }
        if (!('capped' in mark)) delete next.capped
        runs.set(runId, next)
      }
    },
    notify: (n) => notices.push(n),
    changed: () => undefined,
    now: () => NOW,
    ...over
  })

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'caps-'))
  store = new CapStore(join(dir, 'spend-caps.json'))
  await store.load()
  chats = new Map()
  running = new Set()
  paused = []
  resumed = []
  notices = []
  skipped = []
  agents = []
  spent = new Map()
  routines = new Map()
  runs = new Map()
  runsIn = new Map()
  wfRunsIn = new Map()
  workflows = new Map()
  workflowRuns = new Map()
  checked = []
  continued = []
  caps = make()
})

describe("an agent's daily cap", () => {
  beforeEach(() => {
    agents = [agent('dev', 5), agent('other')]
    chats.set('c1', chat('c1', 'dev'))
    chats.set('c2', chat('c2', 'dev'))
    chats.set('c3', chat('c3', 'other'))
    chats.set('room', chat('room', '', { group: { members: ['dev', 'other'], active: [{ agent: 'dev' }], queue: [] } as never }))
    chats.set('asked', chat('asked', 'dev', { asked: { by: 'x', from: 'c3', fromTitle: 't', chain: [] } }))
    chats.set('idle', chat('idle', 'dev'))
    for (const id of ['c1', 'c2', 'c3', 'room', 'asked']) running.add(id)
  })

  it('under the cap nothing happens', async () => {
    spent.set('dev', 4)
    caps.liveSpend(spend('c1', 'dev', 'a1', 0.5))
    await caps.idle()
    expect(paused).toEqual([])
    expect(notices).toEqual([])
  })

  it('reached by its records plus the live turn: every running turn of the agent pauses once, never an A→B chat, and the user hears once', async () => {
    spent.set('dev', 4.8)
    caps.liveSpend(spend('c1', 'dev', 'a1', 0.3))
    await caps.idle()
    expect(paused.map((p) => p.chatId).sort()).toEqual(['c1', 'c2', 'room'])
    expect(paused[0]!.cap).toMatchObject({ scope: { kind: 'agent', agent: 'dev', day: DAY }, label: 'dev', limitUsd: 5, capUsd: 5 })
    expect(paused[0]!.cap.spentUsd).toBeCloseTo(5.1)
    expect(notices).toEqual([expect.objectContaining({ title: '@Dev', chatId: 'c1', tag: 'cap:agent:dev' })])
    // The running turn's chat is counted live: its log estimates are left out meanwhile.
    expect([...skipped.at(-1)!]).toEqual(['c1'])
    // Tripped: more spend the same day pauses nothing again, also after a restart.
    chats.set('c4', chat('c4', 'dev'))
    running.add('c4')
    caps.liveSpend(spend('c4', 'dev', 'a2', 1))
    await caps.idle()
    expect(paused).toHaveLength(3)
    await store.load()
    expect(store.day('dev', DAY)).toEqual({ day: DAY, tripped: true })
    expect(JSON.parse(await readFile(join(dir, 'spend-caps.json'), 'utf8')).agents.dev).toEqual({ day: DAY, tripped: true })
  })

  it("a crossing on a turn's last request trips once its exact cost is stored, though its estimate is gone", async () => {
    spent.set('dev', 4)
    caps.liveSpend(spend('c1', 'dev', 'a1', 0.5))
    caps.ended('a1') // the result came: the estimate goes before the queued check runs
    await caps.idle()
    expect(notices).toEqual([])
    spent.set('dev', 5.2) // the exact cost is stored
    caps.settled('c1', 'dev')
    await caps.idle()
    expect(notices).toHaveLength(1)
    expect(store.day('dev', DAY)?.tripped).toBe(true)
  })

  it("on a tripped day a routine or workflow turn of the agent pauses as it starts; the user's own turn runs on", async () => {
    spent.set('dev', 6)
    await store.set('dev', { day: DAY, tripped: true })
    chats.set('step', chat('step', 'dev', { workflow: { workflowId: 'w1', runId: 'run1', stepId: 's', name: 'Flow' } }))
    running.add('step')
    workflowRuns.set('run1', {
      id: 'run1',
      workflowId: 'w1',
      status: 'running',
      visits: [{ id: 'v', stepId: 's', messageId: 'm-step' } as Visit]
    } as WorkflowRun)
    caps.liveSpend(spend('c1', 'dev', 'a1', 0.1, 'm-user'))
    caps.liveSpend(spend('step', 'dev', 'a2', 0.1, 'm-step'))
    await caps.idle()
    expect(paused.map((p) => p.chatId)).toEqual(['step'])
  })

  it('while over, an automatic start for it is held: gate names it', async () => {
    spent.set('dev', 6)
    expect(await caps.gate(['other', 'dev'])).toBe('dev')
    expect(await caps.gate(['other'])).toBeNull()
  })

  it('Allow more today raises the limit to what was spent plus the cap and lifts the hold', async () => {
    spent.set('dev', 6)
    caps.liveSpend(spend('c1', 'dev', 'a1', 0.5))
    await caps.idle()
    const s = await caps.allowMore('dev')
    expect(s).toMatchObject({ agent: 'dev', capUsd: 5, limitUsd: 11.5, over: false })
    expect(await caps.gate(['dev'])).toBeNull()
    expect(store.day('dev', DAY)).toEqual({ day: DAY, limitUsd: 11.5 })
    await expect(caps.allowMore('other')).rejects.toThrow(NO_DAILY_CAP)
  })

  it("a Resume of a chat the agent's cap paused allows more the same way; one whose cap is gone raises nothing and does not fail", async () => {
    spent.set('dev', 5.2)
    const cap: CapPause = { scope: { kind: 'agent', agent: 'dev', day: DAY }, label: 'dev', spentUsd: 5.2, limitUsd: 5, capUsd: 5 }
    await caps.override('c1', cap)
    expect(store.day('dev', DAY)?.limitUsd).toBe(10.2)
    await expect(caps.override('c3', { ...cap, scope: { kind: 'agent', agent: 'other', day: DAY } })).resolves.toBeUndefined()
  })

  it("an attempt's estimate counts until it ends", async () => {
    spent.set('dev', 0)
    caps.liveSpend(spend('c1', 'dev', 'a1', 2))
    await caps.idle()
    expect((await caps.status()).find((s) => s.agent === 'dev')?.spentUsd).toBe(2)
    caps.ended('a1')
    expect((await caps.status()).find((s) => s.agent === 'dev')?.spentUsd).toBe(0)
  })

  it('status lists only agents with a cap, a day already raised kept', async () => {
    await store.set('dev', { day: DAY, limitUsd: 9 })
    spent.set('dev', 3)
    expect(await caps.status()).toEqual([{ agent: 'dev', capUsd: 5, limitUsd: 9, spentUsd: 3, over: false }])
    // A raise from another day is gone.
    await store.set('dev', { day: '2026-11-11', limitUsd: 9 })
    expect((await caps.status())[0]!.limitUsd).toBe(5)
  })
})

describe("a routine run's cap", () => {
  beforeEach(() => {
    agents = [agent('dev')]
    chats.set('c1', chat('c1', 'dev'))
    running.add('c1')
    routines.set('r1', { id: 'r1', name: 'Daily', spendCap: 2 } as Routine)
    runs.set('run1', { id: 'run1', routineId: 'r1', status: 'running', chatId: 'c1', costUsd: 1.5 } as RoutineRun)
    runsIn.set('c1', [{ routineId: 'r1', runId: 'run1', messageId: 'm-run' }])
  })

  it('its exact cost plus its own live turn reaching the cap pauses its chat, marks the run, and notifies once', async () => {
    caps.liveSpend(spend('c1', 'dev', 'a1', 0.4, 'm-run'))
    await caps.idle()
    expect(paused).toEqual([])
    caps.liveSpend(spend('c1', 'dev', 'a1', 0.2, 'm-run'))
    await caps.idle()
    expect(paused).toEqual([
      {
        chatId: 'c1',
        cap: expect.objectContaining({ scope: { kind: 'routine', routineId: 'r1', runId: 'run1' }, label: 'Daily', limitUsd: 2, capUsd: 2 })
      }
    ])
    expect(runs.get('run1')!.capped).toBe(true)
    expect(notices).toEqual([expect.objectContaining({ title: 'Daily', chatId: 'c1', tag: 'cap:routine:run1' })])
    caps.liveSpend(spend('c1', 'dev', 'a1', 1, 'm-run'))
    await caps.idle()
    expect(paused).toHaveLength(1)
  })

  it("the user's own turn in the routine's chat is neither counted nor paused", async () => {
    caps.liveSpend(spend('c1', 'dev', 'a1', 5, 'm-user'))
    await caps.idle()
    expect(paused).toEqual([])
    expect(runs.get('run1')!.capped).toBeUndefined()
  })

  it('a chat it could not pause (the user paused it, or it just ended) is not marked, so the cap is judged again', async () => {
    chats.set('c1', { ...chats.get('c1')!, pause: 'pausing' })
    caps.liveSpend(spend('c1', 'dev', 'a1', 1, 'm-run'))
    await caps.idle()
    expect(runs.get('run1')!.capped).toBeUndefined()
    expect(notices).toEqual([])
  })

  it('Resume allows one more cap from what the run spent', async () => {
    runs.set('run1', { ...runs.get('run1')!, capped: true, costUsd: 2.1 })
    await caps.override('c1', {
      scope: { kind: 'routine', routineId: 'r1', runId: 'run1' },
      label: 'Daily',
      spentUsd: 2.1,
      limitUsd: 2,
      capUsd: 2
    })
    expect(runs.get('run1')).toMatchObject({ capLimitUsd: 4.1 })
    expect(runs.get('run1')!.capped).toBeUndefined()
  })

  it('a routine without a cap is never checked against one', async () => {
    routines.set('r1', { id: 'r1', name: 'Daily' } as Routine)
    caps.liveSpend(spend('c1', 'dev', 'a1', 100, 'm-run'))
    await caps.idle()
    expect(paused).toEqual([])
  })
})

describe("a workflow run's cap", () => {
  const visit = (id: string, messageId: string): Visit => ({ id, stepId: id, messageId }) as Visit
  beforeEach(() => {
    agents = [agent('dev')]
    chats.set('s1', chat('s1', 'dev', { workflow: { workflowId: 'w1', runId: 'run1', stepId: 'st', name: 'Flow' } }))
    chats.set('s2', chat('s2', 'dev', { workflow: { workflowId: 'w1', runId: 'run1', stepId: 'st2', name: 'Flow' } }))
    chats.set('other', chat('other', 'dev', { workflow: { workflowId: 'w1', runId: 'run2', stepId: 'st', name: 'Flow' } }))
    for (const id of ['s1', 's2', 'other']) running.add(id)
    workflows.set('w1', { id: 'w1', name: 'Flow', spendCap: 3 } as Workflow)
    workflowRuns.set('run1', {
      id: 'run1',
      workflowId: 'w1',
      status: 'running',
      visits: [visit('a', 'm1'), visit('b', 'm2')]
    } as WorkflowRun)
    workflowRuns.set('run2', { id: 'run2', workflowId: 'w1', status: 'running', visits: [visit('a', 'm3')] } as WorkflowRun)
  })

  it("a turn's spend asks the runner to judge the run, which reads its estimates by message", async () => {
    caps.liveSpend(spend('s1', 'dev', 'a1', 1, 'm1'))
    caps.liveSpend(spend('s2', 'dev', 'a2', 0.5, 'm2'))
    caps.liveSpend(spend('s1', 'dev', 'a3', 2, 'm-user'))
    caps.liveSpend(spend('other', 'dev', 'a4', 9, 'm3'))
    await caps.idle()
    expect(checked).toEqual(['run1', 'run1', 'run1', 'run2'])
    expect(await caps.context('w1', 'run1')).toEqual({
      cap: 3,
      liveBy: new Map([
        ['m1', 1],
        ['m2', 0.5],
        ['m-user', 2]
      ]),
      agents: new Map()
    })
  })

  it('a workflow without a cap is not judged on each request', async () => {
    workflows.set('w1', { id: 'w1', name: 'Flow' } as Workflow)
    caps.liveSpend(spend('s1', 'dev', 'a1', 1, 'm1'))
    await caps.idle()
    expect(checked).toEqual([])
  })

  it("a hold on the run's own cap pauses only that run's running chats and notifies with the run", async () => {
    caps.held({ ...workflowRuns.get('run1')!, capHold: { kind: 'run', at: NOW, spentUsd: 3.2, limitUsd: 3, capUsd: 3 } }, 'Flow')
    await caps.idle()
    expect(paused.map((p) => p.chatId).sort()).toEqual(['s1', 's2'])
    expect(paused[0]!.cap.scope).toEqual({ kind: 'workflow', workflowId: 'w1', runId: 'run1' })
    expect(notices).toEqual([expect.objectContaining({ title: 'Flow', chatId: null, run: { workflowId: 'w1', runId: 'run1' } })])
  })

  it("a hold on an agent's day pauses nothing more and says the run waits", async () => {
    caps.held(
      { ...workflowRuns.get('run1')!, capHold: { kind: 'agent', agent: 'dev', at: NOW, spentUsd: 5.5, limitUsd: 5, capUsd: 5 } },
      'Flow'
    )
    await caps.idle()
    expect(paused).toEqual([])
    expect(notices[0]!.body).toBe('Waiting: @Dev reached its daily spend cap ($5.50 of $5.00).')
  })

  it("a turn of a held run that starts later (a usage limit's continue) pauses as it starts; the user's own turn there does not", async () => {
    workflowRuns.set('run1', {
      ...workflowRuns.get('run1')!,
      status: 'waiting',
      capHold: { kind: 'run', at: NOW, spentUsd: 3.2, limitUsd: 3, capUsd: 3 }
    })
    caps.liveSpend(spend('s2', 'dev', 'a1', 0.1, 'm-user'))
    await caps.idle()
    expect(paused).toEqual([])
    caps.liveSpend(spend('s1', 'dev', 'a2', 0.1, 'm1'))
    await caps.idle()
    expect(paused).toEqual([
      { chatId: 's1', cap: expect.objectContaining({ scope: { kind: 'workflow', workflowId: 'w1', runId: 'run1' } }) }
    ])
  })

  it('Continue resumes what this hold paused, not the chat that asked nor one another cap paused, and a chat still pausing once it lands', async () => {
    const runCap = {
      scope: { kind: 'workflow', workflowId: 'w1', runId: 'run1' },
      label: 'Flow',
      spentUsd: 3.2,
      limitUsd: 3,
      capUsd: 3
    } as CapPause
    const dayCap = { scope: { kind: 'agent', agent: 'dev', day: DAY }, label: 'dev', spentUsd: 6, limitUsd: 5, capUsd: 5 } as CapPause
    workflowRuns.set('run1', { ...workflowRuns.get('run1')!, capHold: { kind: 'run', at: NOW, spentUsd: 3.2, limitUsd: 3, capUsd: 3 } })
    chats.set('s1', { ...chats.get('s1')!, pause: 'paused', pauseCap: runCap })
    chats.set('s2', { ...chats.get('s2')!, pause: 'pausing', pauseCap: runCap })
    chats.set(
      's3',
      chat('s3', 'dev', { workflow: { workflowId: 'w1', runId: 'run1', stepId: 'x', name: 'Flow' }, pause: 'paused', pauseCap: dayCap })
    )
    chats.set(
      's4',
      chat('s4', 'dev', { workflow: { workflowId: 'w1', runId: 'run1', stepId: 'y', name: 'Flow' }, pause: 'paused', pauseCap: runCap })
    )
    await caps.continueWorkflow('run1', 's4')
    expect(continued).toEqual(['run1'])
    expect(resumed).toEqual(['s1'])
    // s2's pause lands: its run ends, and it goes on then.
    chats.set('s2', { ...chats.get('s2')!, pause: 'paused' })
    caps.chatIdle('s2')
    caps.chatIdle('s1') // not waiting for anything
    await caps.idle()
    expect(resumed).toEqual(['s1', 's2'])
  })

  it('a chat already pausing or paused, or one that is not running, is left as it is', async () => {
    chats.set('s1', { ...chats.get('s1')!, pause: 'pausing' })
    running.delete('s2')
    caps.held({ ...workflowRuns.get('run1')!, capHold: { kind: 'run', at: NOW, spentUsd: 3.2, limitUsd: 3, capUsd: 3 } }, 'Flow')
    await caps.idle()
    expect(paused).toEqual([])
  })
})

describe("a Chat step's turn", () => {
  const visit = (id: string, messageId: string): Visit => ({ id, stepId: id, messageId }) as Visit
  const runCap = { kind: 'run', at: NOW, spentUsd: 3.2, limitUsd: 3, capUsd: 3 } as const
  beforeEach(() => {
    agents = [agent('dev')]
    // The user's own chat: no workflow link, but the run's step follows its message m1.
    chats.set('u1', chat('u1', 'dev'))
    running.add('u1')
    wfRunsIn.set('u1', [{ workflowId: 'w1', runId: 'run1', messageId: 'm1' }])
    workflows.set('w1', { id: 'w1', name: 'Flow', spendCap: 3 } as Workflow)
    workflowRuns.set('run1', { id: 'run1', workflowId: 'w1', status: 'running', visits: [visit('a', 'm1')] } as WorkflowRun)
  })

  it("is judged and estimated for its run like an Agent step's, the user's own turn there is not", async () => {
    caps.liveSpend(spend('u1', 'dev', 'a1', 1, 'm1'))
    caps.liveSpend(spend('u1', 'dev', 'a2', 9, 'm-user'))
    await caps.idle()
    expect(checked).toEqual(['run1'])
    expect((await caps.context('w1', 'run1')).liveBy).toEqual(new Map([['m1', 1]]))
  })

  it("a hold on the run pauses the chat only while the step's turn runs in it", async () => {
    caps.liveSpend(spend('u1', 'dev', 'a1', 0.1, 'm-user'))
    await caps.idle()
    caps.held({ ...workflowRuns.get('run1')!, capHold: runCap }, 'Flow')
    await caps.idle()
    expect(paused).toEqual([])
    caps.liveSpend(spend('u1', 'dev', 'a2', 0.1, 'm1'))
    await caps.idle()
    caps.held({ ...workflowRuns.get('run1')!, capHold: runCap }, 'Flow')
    await caps.idle()
    expect(paused.map((p) => p.chatId)).toContain('u1')
    expect(paused[0]!.cap.scope).toEqual({ kind: 'workflow', workflowId: 'w1', runId: 'run1' })
  })

  it("a step turn starting in a chat a cap already holds pauses as it starts; the user's own turn does not", async () => {
    workflowRuns.set('run1', { ...workflowRuns.get('run1')!, status: 'waiting', capHold: runCap })
    caps.liveSpend(spend('u1', 'dev', 'a1', 0.1, 'm-user'))
    await caps.idle()
    expect(paused).toEqual([])
    caps.liveSpend(spend('u1', 'dev', 'a2', 0.1, 'm1'))
    await caps.idle()
    // The label is the workflow's name (the chat has no link to read it from), never its id.
    expect(paused).toEqual([
      { chatId: 'u1', cap: expect.objectContaining({ scope: { kind: 'workflow', workflowId: 'w1', runId: 'run1' }, label: 'Flow' }) }
    ])
  })

  it('Continue resumes the chat the hold paused', async () => {
    const pauseCap = {
      scope: { kind: 'workflow', workflowId: 'w1', runId: 'run1' },
      label: 'Flow',
      spentUsd: 3.2,
      limitUsd: 3,
      capUsd: 3
    } as CapPause
    chats.set('u1', { ...chats.get('u1')!, pause: 'paused', pauseCap })
    workflowRuns.set('run1', { ...workflowRuns.get('run1')!, capHold: runCap })
    await caps.continueWorkflow('run1')
    expect(resumed).toEqual(['u1'])
  })
})

it('a rename carries the day and the running estimates', async () => {
  agents = [agent('dev', 5)]
  await store.set('dev', { day: DAY, limitUsd: 8 })
  caps.liveSpend(spend('c1', 'dev', 'a1', 1))
  await caps.idle()
  await caps.renameAgent('dev', 'web')
  agents = [agent('web', 5)]
  expect(await caps.status()).toEqual([{ agent: 'web', capUsd: 5, limitUsd: 8, spentUsd: 1, over: false }])
})
