import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CHANNEL_TOGGLES,
  DEFAULT_TOGGLES,
  channelNotifyText,
  type ChannelNotifyToggles,
  type NotifyPayload,
  type NotifyToggles
} from '@zumibot/shared/notify'
import type { Routine, RoutineTarget } from '@zumibot/shared/routines'
import type { ChatMeta, ChatPush, ServerMode } from '@zumibot/shared/types'
import type { DeviceRecord, NotifyStore } from '../../src/core/notify/notifyStore'
import { Presence, type PresenceReport } from '../../src/core/notify/presence'
import type { PushOutcome } from '../../src/core/notify/pushSender'
import { NotifyService, type NotifyEvent, type NotifyTarget } from '../../src/core/notify/notifyService'

const OFF: NotifyToggles = { waiting: false, replied: false, error: false, routineFailed: false }

const pushDev = (id: string, o: { toggles?: NotifyToggles; sessionKey?: string; paused?: boolean; label?: string } = {}): DeviceRecord => ({
  id,
  channel: 'push',
  label: o.label ?? 'Phone',
  toggles: o.toggles ?? DEFAULT_TOGGLES,
  createdAt: 1,
  lastSeenAt: 1,
  push: { endpoint: `https://push.example/${id}`, p256dh: 'P', auth: 'A', sessionKey: o.sessionKey ?? 'k1', paused: o.paused ?? false }
})

const deskDev = (id: string, toggles: NotifyToggles = DEFAULT_TOGGLES): DeviceRecord => ({
  id,
  channel: 'desktop',
  label: 'ZumiBot desktop',
  toggles,
  createdAt: 1,
  lastSeenAt: 1
})

class FakeStore {
  vapidCalls = 0
  failDevices = false
  failGet = false
  constructor(public list: DeviceRecord[]) {}
  async devices() {
    if (this.failDevices) throw new Error('disk on fire')
    return this.list.map((d) => structuredClone(d))
  }
  async get(id: string) {
    if (this.failGet) throw new Error('disk on fire')
    const d = this.list.find((x) => x.id === id)
    return d ? structuredClone(d) : null
  }
  async patch(id: string, fn: (r: DeviceRecord) => DeviceRecord) {
    const i = this.list.findIndex((x) => x.id === id)
    if (i < 0) return null
    this.list[i] = { ...fn(structuredClone(this.list[i])), id }
    return this.list[i]
  }
  async vapid() {
    this.vapidCalls++
    return { publicKey: 'PUB', privateKey: 'PRIV' }
  }
}

const chat = (id: string, title: string, agentName: string): ChatMeta =>
  ({ id, title, agentName, sessionId: null, cwd: '/', createdAt: 1, updatedAt: 1, inFlight: false }) as ChatMeta

const routine = (id: string, name: string, target: RoutineTarget): Routine => ({
  id,
  name,
  target,
  enabled: true,
  timeZone: 'UTC',
  trigger: { kind: 'manual' },
  prompt: 'x',
  nextRunAt: null,
  createdAt: 1,
  updatedAt: 1
})

interface Opts {
  mode?: ServerMode
  devices?: DeviceRecord[]
  routines?: Record<string, Routine>
  routineOfChat?: Record<string, string>
  valid?: (key: string) => boolean
  outcome?: (store: FakeStore) => { outcome: PushOutcome; status: number | null }
  // The session check resolves a macrotask later, after anything that settles in microtasks.
  slowValid?: boolean
  sendThrows?: boolean
  chatsThrow?: boolean
  targets?: NotifyTarget[]
}

function harness(o: Opts = {}) {
  let t = 1000
  const timers: { fn: () => void; at: number; cleared: boolean }[] = []
  const store = new FakeStore(o.devices ?? [pushDev('p1')])
  const chats = new Map<string, ChatMeta>([
    ['c1', chat('c1', 'Fix login', 'news')],
    ['c2', chat('c2', 'Other', 'writer')]
  ])
  const sent: { endpoint: string; payload: NotifyPayload; subject: string }[] = []
  const shown: { connId: string; e: NotifyEvent }[] = []
  const broadcasts: NotifyEvent[] = []
  const logs: string[] = []
  let svc!: NotifyService
  const presence = new Presence({
    now: () => t,
    setTimer: (fn, ms) => {
      const e = { fn, at: t + ms, cleared: false }
      timers.push(e)
      return {
        clear: () => {
          e.cleared = true
        }
      }
    },
    onStarted: (c) => svc.started(c),
    onStopped: (c) => svc.stopped(c),
    onOpened: () => {}
  })
  svc = new NotifyService({
    store: store as unknown as NotifyStore,
    presence,
    mode: o.mode ?? 'vps',
    subject: () => 'https://bot.example',
    chats: {
      get: async (id) => {
        if (o.chatsThrow) throw new Error('boom')
        return chats.get(id) ?? null
      }
    },
    routines: { get: async (id) => o.routines?.[id] ?? null },
    routineOfChat: (id) => o.routineOfChat?.[id] ?? null,
    sessionValid: async (k) => {
      if (o.slowValid) await new Promise((r) => setTimeout(r, 0))
      return o.valid ? o.valid(k) : true
    },
    sendTo: (connId, e) => {
      shown.push({ connId, e })
      return true
    },
    broadcast: (e) => broadcasts.push(e),
    send: async (x) => {
      if (o.sendThrows) throw new Error(`fetch ${x.target.endpoint}`)
      sent.push({ endpoint: x.target.endpoint, payload: x.payload, subject: x.subject })
      return o.outcome ? o.outcome(store) : { outcome: 'sent', status: 201 }
    },
    now: () => t,
    log: (l) => logs.push(l),
    targets: () => o.targets ?? []
  })
  const report = (deviceId: string, chatId: string | null, looking: boolean, inputAgoMs = 0): PresenceReport => ({
    deviceId,
    chatId,
    looking,
    inputAgoMs
  })
  return {
    svc,
    presence,
    store,
    chats,
    sent,
    shown,
    broadcasts,
    logs,
    report,
    now: () => t,
    setNow: (n: number) => {
      t = n
    },
    advance: (ms: number) => {
      t += ms
      for (const e of timers.filter((x) => !x.cleared && x.at <= t)) {
        e.cleared = true
        e.fn()
      }
    },
    kinds: () => sent.map((s) => s.payload.kind)
  }
}

// Every push and store call in the fakes settles in microtasks; one macrotask drains them.
const flush = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0))
}

const approvals = (chatId: string, pending: number, agent?: string): ChatPush =>
  ({ chatId, kind: 'approvals', pending, ...(agent ? { agent } : {}) }) as ChatPush

describe('NotifyService: waiting', () => {
  it('pushes to each push device whose waiting toggle is on', async () => {
    const h = harness({ devices: [pushDev('p1'), pushDev('p2', { toggles: { ...DEFAULT_TOGGLES, waiting: false } })] })
    h.svc.chatPush(approvals('c1', 1, 'news'))
    await flush()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].endpoint).toBe('https://push.example/p1')
    expect(h.sent[0].subject).toBe('https://bot.example')
    expect(h.sent[0].payload).toEqual({
      v: 1,
      kind: 'waiting',
      tag: 'chat:c1:waiting',
      chatId: 'c1',
      title: 'Fix login',
      agent: 'news',
      at: 1000
    })
  })

  it('pushes again on a rise, not on a fall', async () => {
    const h = harness()
    h.svc.chatPush(approvals('c1', 1, 'news'))
    await flush()
    h.svc.chatPush(approvals('c1', 2, 'news'))
    await flush()
    expect(h.kinds()).toEqual(['waiting', 'waiting'])
    h.svc.chatPush(approvals('c1', 1, 'news'))
    await flush()
    expect(h.sent).toHaveLength(2)
    expect(h.broadcasts).toEqual([])
  })

  it('an asked chat never raises a waiting push, while the root chat still does', async () => {
    const h = harness()
    h.svc.chatPush({ chatId: 'b', kind: 'approvals', pending: 1, agent: 'b', asked: true })
    await flush()
    expect(h.sent).toEqual([])
    expect(h.svc.state().pending).toEqual({})
    h.svc.chatPush({ chatId: 'c1', kind: 'approvals', pending: 1, agent: 'news' })
    await flush()
    expect(h.kinds()).toEqual(['waiting'])
  })

  it('ignores every other chat push', async () => {
    const h = harness()
    h.svc.chatPush({ chatId: 'c1', kind: 'delta', text: 'secret reply text' })
    await flush()
    expect(h.sent).toEqual([])
    expect(h.svc.state().pending).toEqual({})
  })

  it('a fall to 0 broadcasts notify:clear for waiting only', async () => {
    const h = harness()
    h.svc.chatPush(approvals('c1', 2, 'news'))
    h.svc.chatPush(approvals('c1', 0))
    await flush()
    expect(h.broadcasts).toEqual([{ event: 'notify:clear', payload: { chatId: 'c1', waitingOnly: true } }])
  })

  it('an approval answered before the push is built sends nothing', async () => {
    const h = harness()
    h.svc.chatPush(approvals('c1', 1, 'news'))
    h.svc.chatPush(approvals('c1', 0))
    await flush()
    expect(h.sent).toEqual([])
  })

  it('without an agent on the push, falls back to the chat agent', async () => {
    const h = harness()
    h.svc.chatPush(approvals('c1', 1))
    await flush()
    expect(h.sent[0].payload.agent).toBe('news')
  })

  it("an empty chat title uses the agent's name as the UI shows it", async () => {
    const h = harness()
    h.chats.set('c1', chat('c1', '', 'work-assistant'))
    h.svc.chatPush(approvals('c1', 1, 'work-assistant'))
    await flush()
    expect(h.sent[0].payload.title).toBe('Work Assistant')
    // The handle stays on the payload: the text builder and the room merge compare handles.
    expect(h.sent[0].payload.agent).toBe('work-assistant')
  })
})

describe('NotifyService: desktop', () => {
  it('shows once, on the newest connection of the device', async () => {
    const h = harness({ devices: [deskDev('d1')] })
    h.presence.update('k1', h.report('d1', null, false))
    h.presence.update('k2', h.report('d1', null, false))
    h.svc.turnEnded({ chatId: 'c1', agent: 'news', outcome: 'ok' })
    await flush()
    expect(h.shown).toEqual([
      {
        connId: 'k2',
        e: {
          event: 'notify:show',
          payload: { v: 1, kind: 'replied', tag: 'chat:c1', chatId: 'c1', title: 'Fix login', agent: 'news', at: 1000 }
        }
      }
    ])
    expect(h.sent).toEqual([])
  })

  it('sends nothing to a desktop device with no connection', async () => {
    const h = harness({ devices: [deskDev('d1')] })
    h.svc.turnEnded({ chatId: 'c1', agent: 'news', outcome: 'ok' })
    await flush()
    expect(h.shown).toEqual([])
  })

  it('respects desktop toggles', async () => {
    const h = harness({ devices: [deskDev('d1', { ...DEFAULT_TOGGLES, replied: false })] })
    h.presence.update('k1', h.report('d1', null, false))
    h.svc.turnEnded({ chatId: 'c1', agent: 'news', outcome: 'ok' })
    await flush()
    expect(h.shown).toEqual([])
  })
})

describe('NotifyService: task card questions', () => {
  const meta = (chatId: string, inFlight: boolean): ChatPush =>
    ({ chatId, kind: 'meta', meta: { ...chat(chatId, 'Fix login', 'news'), inFlight } }) as ChatPush

  it('a reply that put questions on its card is one waiting notice that opens the Inbox, not a reply', async () => {
    const h = harness()
    h.svc.turnEnded({ chatId: 'c1', agent: 'news', outcome: 'ok', cardQuestions: true })
    await flush()
    expect(h.sent.map((s) => s.payload)).toEqual([
      { v: 1, kind: 'waiting', tag: 'chat:c1:waiting', chatId: 'c1', title: 'Fix login', agent: 'news', at: 1000, inbox: true }
    ])
    // Still waiting on a page load, as an approval card is.
    expect(h.svc.state().pending).toEqual({ c1: 1 })
  })

  it('goes with the waiting toggle, and an errored turn is still an error', async () => {
    const h = harness({ devices: [pushDev('p1', { toggles: { ...DEFAULT_TOGGLES, waiting: false } })] })
    h.svc.turnEnded({ chatId: 'c1', agent: 'news', outcome: 'ok', cardQuestions: true })
    h.svc.turnEnded({ chatId: 'c2', agent: 'writer', outcome: 'error', cardQuestions: true })
    await flush()
    expect(h.kinds()).toEqual(['error'])
  })

  it("clears once the task chat's next turn starts (the user answered), and not before", async () => {
    const h = harness()
    h.svc.turnEnded({ chatId: 'c1', agent: 'news', outcome: 'ok', cardQuestions: true })
    await flush()
    h.svc.chatPush(meta('c1', false))
    await flush()
    expect(h.broadcasts).toEqual([])
    h.svc.chatPush(meta('c1', true))
    await flush()
    expect(h.broadcasts).toEqual([{ event: 'notify:clear', payload: { chatId: 'c1', waitingOnly: true } }])
    expect(h.svc.state().pending).toEqual({})
  })

  it('held while the task chat is on screen, dropped when its next turn starts first', async () => {
    const h = harness({ devices: [pushDev('p1')] })
    h.presence.update('k1', h.report('p1', 'c1', true))
    h.svc.turnEnded({ chatId: 'c1', agent: 'news', outcome: 'ok', cardQuestions: true })
    await flush()
    expect(h.sent).toEqual([])
    h.svc.chatPush(meta('c1', true))
    h.presence.update('k1', h.report('p1', null, false))
    await flush()
    expect(h.sent).toEqual([])
  })
})

describe('NotifyService: asked chats', () => {
  it('a turn end in an asked chat notifies nothing', async () => {
    const h = harness()
    h.svc.turnEnded({ chatId: 'c1', agent: 'news', outcome: 'ok', asked: true })
    h.svc.turnEnded({ chatId: 'c1', agent: 'news', outcome: 'error', asked: true })
    await flush()
    expect(h.sent).toEqual([])
  })
})

describe('NotifyService: workflows', () => {
  const run = { workflowId: 'w1', runId: 'r1', name: 'Nightly sync' }

  it('workflow turn end is silent', async () => {
    const h = harness()
    h.svc.turnEnded({ chatId: 'c1', agent: 'news', outcome: 'ok', workflow: true })
    h.svc.turnEnded({ chatId: 'c1', agent: 'news', outcome: 'error', workflow: true })
    await flush()
    expect(h.sent).toEqual([])
  })

  it('workflowWaiting sends waiting with run and title', async () => {
    const h = harness({ devices: [pushDev('p1'), pushDev('p2', { toggles: { ...DEFAULT_TOGGLES, waiting: false } })] })
    h.svc.workflowWaiting(run)
    await flush()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].payload).toEqual({
      v: 1,
      kind: 'waiting',
      tag: 'workflow:r1:waiting',
      chatId: null,
      title: 'Nightly sync needs your approval',
      at: 1000,
      run: { workflowId: 'w1', runId: 'r1' }
    })
  })

  it('workflowWaitingCleared broadcasts a clear by tag', async () => {
    const h = harness()
    h.svc.workflowWaitingCleared('r1')
    await flush()
    expect(h.broadcasts).toEqual([{ event: 'notify:clear', payload: { chatId: null, waitingOnly: true, tag: 'workflow:r1:waiting' } }])
  })

  it('workflowFailed uses routineFailed toggle', async () => {
    const h = harness({ devices: [pushDev('p1'), pushDev('p2', { toggles: { ...DEFAULT_TOGGLES, routineFailed: false } })] })
    h.svc.workflowFailed(run)
    await flush()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].endpoint).toBe('https://push.example/p1')
    expect(h.sent[0].payload).toMatchObject({
      kind: 'routine-failed',
      tag: 'workflow:r1',
      chatId: null,
      title: 'Nightly sync',
      run: { workflowId: 'w1', runId: 'r1' }
    })
  })

  it('a Notify push carries the message id', async () => {
    const h = harness({ devices: [pushDev('p1')] })
    h.svc.workflowMessage({ workflowId: 'w1', runId: 'r1', title: 'Done', messageId: 'v1' })
    await flush()
    expect(h.sent[0].payload).toMatchObject({ kind: 'workflow', message: 'v1' })
  })

  it('a waiting workflow push carries no message', async () => {
    const h = harness({ devices: [pushDev('p1')] })
    h.svc.workflowWaiting(run)
    await flush()
    expect(h.sent[0].payload).not.toHaveProperty('message')
  })

  it('workflowMessage ignores toggles but keeps the rate cap', async () => {
    const h = harness({ devices: [pushDev('p1', { toggles: OFF }), deskDev('d1', OFF)] })
    h.presence.update('k1', h.report('d1', null, false))
    h.svc.workflowMessage({ workflowId: 'w1', runId: 'r1', title: 'Done', body: 'x'.repeat(500) })
    await flush()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].payload).toMatchObject({
      kind: 'workflow',
      tag: 'workflow:r1',
      chatId: null,
      title: 'Done',
      run: { workflowId: 'w1', runId: 'r1' }
    })
    expect(h.sent[0].payload.body).toHaveLength(200)
    for (let i = 0; i < 15; i++) h.svc.workflowMessage({ workflowId: 'w1', runId: 'r1', title: `m${i}` })
    await flush()
    expect(h.sent).toHaveLength(10)
    h.advance(60_001)
    h.svc.workflowMessage({ workflowId: 'w1', runId: 'r1', title: 'later' })
    await flush()
    expect(h.sent).toHaveLength(11)
  })
})

describe('NotifyService: looking', () => {
  it('sends nothing to any device for the chat being looked at', async () => {
    const h = harness({ devices: [pushDev('p1'), deskDev('d1')] })
    h.presence.update('k1', h.report('d1', 'c1', true))
    h.svc.chatPush(approvals('c1', 1, 'news'))
    h.svc.turnEnded({ chatId: 'c1', agent: 'news', outcome: 'ok' })
    await flush()
    expect(h.sent).toEqual([])
    expect(h.shown).toEqual([])
    h.svc.turnEnded({ chatId: 'c2', agent: 'writer', outcome: 'ok' })
    await flush()
    expect(h.kinds()).toEqual(['replied'])
    expect(h.sent[0].payload.chatId).toBe('c2')
    expect(h.shown.map((s) => s.e.event)).toEqual(['notify:show'])
  })

  it('starting to look broadcasts notify:clear for every kind', () => {
    const h = harness()
    h.presence.update('k1', h.report('d1', 'c1', true))
    expect(h.broadcasts).toEqual([{ event: 'notify:clear', payload: { chatId: 'c1', waitingOnly: false } }])
  })
})

describe('NotifyService: held events', () => {
  async function held(o: Opts = {}) {
    const h = harness(o)
    h.presence.update('k1', h.report('d1', 'c1', true))
    h.setNow(2000)
    return h
  }

  it('sends a held event when looking stops with no input after it', async () => {
    const h = await held()
    h.svc.turnEnded({ chatId: 'c1', agent: 'news', outcome: 'ok' })
    await flush()
    expect(h.sent).toEqual([])
    h.setNow(3000)
    h.presence.update('k1', h.report('d1', 'c1', false, 1500))
    await flush()
    // Stamped when released: the chat's lookedAt is stamped then too, and an older at would read as already seen.
    expect(h.sent.map((s) => s.payload)).toEqual([
      { v: 1, kind: 'replied', tag: 'chat:c1', chatId: 'c1', title: 'Fix login', agent: 'news', at: 3000 }
    ])
    expect(h.sent[0].payload.at).toBeGreaterThan(2000)
    expect(h.sent[0].payload.at).toBeGreaterThanOrEqual(h.presence.lookedAt().c1)
  })

  it('keeps only the latest event per slot', async () => {
    const h = await held()
    h.svc.turnEnded({ chatId: 'c1', agent: 'news', outcome: 'ok' })
    h.setNow(2500)
    h.svc.turnEnded({ chatId: 'c1', agent: 'writer', outcome: 'error' })
    h.svc.chatPush(approvals('c1', 1, 'news'))
    h.setNow(3000)
    h.presence.update('k1', h.report('d1', null, false, 2000))
    await flush()
    expect(h.sent.map((s) => [s.payload.kind, s.payload.agent, s.payload.at]).sort()).toEqual([
      ['error', 'writer', 3000],
      ['waiting', 'news', 3000]
    ])
  })

  it('drops a held event when input came after it', async () => {
    const h = await held()
    h.svc.turnEnded({ chatId: 'c1', agent: 'news', outcome: 'ok' })
    h.setNow(3000)
    h.presence.update('k1', h.report('d1', 'c1', false, 0))
    await flush()
    expect(h.sent).toEqual([])
  })

  it('drops a held event when the user typed on the chat and then moved to another', async () => {
    const h = await held()
    h.svc.turnEnded({ chatId: 'c1', agent: 'news', outcome: 'ok' })
    h.setNow(2500)
    h.presence.update('k1', h.report('d1', 'c1', true, 0))
    h.setNow(3000)
    h.presence.update('k1', h.report('d1', 'c2', true, 0))
    await flush()
    expect(h.sent).toEqual([])
  })

  it('drops a held waiting once pending is 0', async () => {
    const h = await held()
    h.svc.chatPush(approvals('c1', 1, 'news'))
    h.svc.chatPush(approvals('c1', 0))
    h.setNow(3000)
    h.presence.update('k1', h.report('d1', 'c1', false, 1500))
    await flush()
    expect(h.sent).toEqual([])
  })

  it('still sends a held waiting while pending is above 0', async () => {
    const h = await held()
    h.svc.chatPush(approvals('c1', 2, 'news'))
    h.svc.chatPush(approvals('c1', 1))
    h.setNow(3000)
    h.presence.update('k1', h.report('d1', 'c1', false, 1500))
    await flush()
    expect(h.kinds()).toEqual(['waiting'])
  })

  it('drops a held event for a chat that is gone', async () => {
    const h = await held()
    h.svc.turnEnded({ chatId: 'c1', agent: 'news', outcome: 'ok' })
    h.chats.delete('c1')
    h.setNow(3000)
    h.presence.update('k1', h.report('d1', 'c1', false, 1500))
    await flush()
    expect(h.sent).toEqual([])
  })

  it('never pushes for a chat that is gone before the title is built', async () => {
    const h = harness()
    h.chats.delete('c1')
    h.svc.turnEnded({ chatId: 'c1', agent: 'news', outcome: 'ok' })
    await flush()
    expect(h.sent).toEqual([])
  })

  it('chatRemoved drops held events and pending, and clears every kind', async () => {
    const h = await held()
    h.svc.chatPush(approvals('c1', 1, 'news'))
    h.svc.turnEnded({ chatId: 'c1', agent: 'news', outcome: 'ok' })
    h.broadcasts.length = 0
    h.svc.chatRemoved('c1')
    expect(h.broadcasts).toEqual([{ event: 'notify:clear', payload: { chatId: 'c1', waitingOnly: false } }])
    expect(h.svc.state().pending).toEqual({})
    h.setNow(3000)
    h.presence.update('k1', h.report('d1', 'c1', false, 1500))
    await flush()
    expect(h.sent).toEqual([])
  })

  it('a socket drop sends held events only after the grace ends', async () => {
    const h = await held()
    h.svc.turnEnded({ chatId: 'c1', agent: 'news', outcome: 'ok' })
    h.presence.drop('k1')
    await flush()
    expect(h.sent).toEqual([])
    h.advance(10_000)
    await flush()
    expect(h.kinds()).toEqual(['replied'])
  })

  it('a reconnect within the grace that looks again sends nothing', async () => {
    const h = await held()
    h.svc.turnEnded({ chatId: 'c1', agent: 'news', outcome: 'ok' })
    h.presence.drop('k1')
    h.advance(5_000)
    h.presence.update('k9', h.report('d1', 'c1', true))
    h.advance(10_000)
    await flush()
    expect(h.sent).toEqual([])
  })
})

describe('NotifyService: turn ends', () => {
  it('ok is replied, error is error, stopped is nothing', async () => {
    const h = harness()
    h.svc.turnEnded({ chatId: 'c1', agent: 'news', outcome: 'ok' })
    h.svc.turnEnded({ chatId: 'c1', agent: 'news', outcome: 'error' })
    h.svc.turnEnded({ chatId: 'c1', agent: 'news', outcome: 'stopped' })
    await flush()
    expect(h.kinds()).toEqual(['replied', 'error'])
    expect(h.sent[1].payload).toEqual({ v: 1, kind: 'error', tag: 'chat:c1', chatId: 'c1', title: 'Fix login', agent: 'news', at: 1000 })
  })

  it("an error in a routine's chat is left to the routine failure", async () => {
    const h = harness({
      routineOfChat: { c1: 'r1' },
      routines: { r1: routine('r1', 'Nightly', { kind: 'new-chat', agent: 'news', cwd: '/' }) }
    })
    h.svc.turnEnded({ chatId: 'c1', agent: 'news', outcome: 'error' })
    await flush()
    expect(h.sent).toEqual([])
  })
})

describe('NotifyService: routine slots', () => {
  it('a routine that opens a new chat per run keys the slot by routine', async () => {
    const h = harness({
      routineOfChat: { c1: 'r1' },
      routines: { r1: routine('r1', 'Nightly', { kind: 'new-chat', agent: 'news', cwd: '/' }) }
    })
    h.svc.turnEnded({ chatId: 'c1', agent: 'news', outcome: 'ok' })
    h.svc.chatPush(approvals('c1', 1, 'news'))
    await flush()
    expect(h.sent.map((s) => s.payload.tag).sort()).toEqual(['routine:r1', 'routine:r1:waiting'])
    expect(h.sent.every((s) => s.payload.chatId === 'c1')).toBe(true)
  })

  it('a new-group routine keys the slot by routine too', async () => {
    const h = harness({
      routineOfChat: { c1: 'r1' },
      routines: { r1: routine('r1', 'Nightly', { kind: 'new-group', members: ['news'], role: '', cwd: '/' }) }
    })
    h.svc.turnEnded({ chatId: 'c1', agent: 'news', outcome: 'ok' })
    await flush()
    expect(h.sent[0].payload.tag).toBe('routine:r1')
  })

  it('a routine that runs in an existing chat keeps the chat slot', async () => {
    const h = harness({ routineOfChat: { c1: 'r1' }, routines: { r1: routine('r1', 'Nightly', { kind: 'chat', chatId: 'c1' }) } })
    h.svc.turnEnded({ chatId: 'c1', agent: 'news', outcome: 'ok' })
    await flush()
    expect(h.sent[0].payload.tag).toBe('chat:c1')
  })
})

describe('NotifyService: routine failures', () => {
  const r1 = routine('r1', 'Nightly digest', { kind: 'new-chat', agent: 'news', cwd: '/' })

  it('a failed turn gives error when only the error toggle is on', async () => {
    const h = harness({
      devices: [pushDev('p1', { toggles: { ...DEFAULT_TOGGLES, routineFailed: false } })],
      routines: { r1 },
      routineOfChat: { c1: 'r1' }
    })
    h.svc.routineFailed({ routineId: 'r1', chatId: 'c1', cause: 'turn' })
    await flush()
    expect(h.sent.map((s) => s.payload)).toEqual([
      { v: 1, kind: 'error', tag: 'routine:r1', chatId: 'c1', title: 'Fix login', agent: 'news', at: 1000 }
    ])
  })

  it('a failed turn gives routine-failed when that toggle is on', async () => {
    const h = harness({ routines: { r1 }, routineOfChat: { c1: 'r1' } })
    h.svc.routineFailed({ routineId: 'r1', chatId: 'c1', cause: 'turn' })
    await flush()
    expect(h.kinds()).toEqual(['routine-failed'])
  })

  it("the user's own action or a restart sends nothing", async () => {
    const h = harness({ routines: { r1 } })
    h.svc.routineFailed({ routineId: 'r1', chatId: 'c1', cause: 'user' })
    h.svc.routineFailed({ routineId: 'r1', chatId: null, cause: 'restart' })
    await flush()
    expect(h.sent).toEqual([])
  })

  it('with no chat, the title is the routine name and the slot is the routine', async () => {
    const h = harness({ routines: { r1 } })
    h.svc.routineFailed({ routineId: 'r1', chatId: null, cause: 'start' })
    await flush()
    expect(h.sent.map((s) => s.payload)).toEqual([
      { v: 1, kind: 'routine-failed', tag: 'routine:r1', chatId: null, title: 'Nightly digest', at: 1000 }
    ])
  })
})

describe('NotifyService: rate cap', () => {
  it('drops the 11th replied in a minute and logs the label, never the endpoint', async () => {
    const h = harness()
    for (let i = 0; i < 11; i++) h.svc.turnEnded({ chatId: 'c1', agent: 'news', outcome: 'ok' })
    await flush()
    expect(h.sent).toHaveLength(10)
    const capped = h.logs.filter((l) => l.includes('"Phone"'))
    expect(capped).toHaveLength(1)
    expect(h.logs.join('\n')).not.toContain('push.example')
  })

  it('never caps waiting', async () => {
    const h = harness()
    for (let i = 0; i < 11; i++) h.svc.turnEnded({ chatId: 'c1', agent: 'news', outcome: 'ok' })
    for (let i = 1; i <= 3; i++) h.svc.chatPush(approvals('c1', i, 'news'))
    await flush()
    expect(h.kinds().filter((k) => k === 'waiting')).toHaveLength(3)
  })
})

describe('NotifyService: push outcomes', () => {
  it('gone removes the binding, keeps the record and logs the label and status', async () => {
    const h = harness({ outcome: () => ({ outcome: 'gone', status: 410 }) })
    h.svc.turnEnded({ chatId: 'c1', agent: 'news', outcome: 'ok' })
    await flush()
    const rec = await h.store.get('p1')
    expect(rec).not.toBeNull()
    expect(rec?.push).toBeUndefined()
    expect(h.logs).toContain('push to "Phone" failed: 410')
    expect(h.logs.join('\n')).not.toContain('push.example')
    h.svc.turnEnded({ chatId: 'c1', agent: 'news', outcome: 'ok' })
    await flush()
    expect(h.sent).toHaveLength(1)
  })

  it('gone keeps a subscription that replaced the failed one meanwhile', async () => {
    const h = harness({
      outcome: (store) => {
        store.list[0] = { ...store.list[0], push: { ...store.list[0].push!, endpoint: 'https://push.example/new' } }
        return { outcome: 'gone', status: 410 }
      }
    })
    h.svc.turnEnded({ chatId: 'c1', agent: 'news', outcome: 'ok' })
    await flush()
    expect((await h.store.get('p1'))?.push?.endpoint).toBe('https://push.example/new')
  })

  it('a failure with no status logs error', async () => {
    const h = harness({ outcome: () => ({ outcome: 'failed', status: null }) })
    h.svc.turnEnded({ chatId: 'c1', agent: 'news', outcome: 'ok' })
    await flush()
    expect(h.logs).toEqual(['push to "Phone" failed: error'])
    expect((await h.store.get('p1'))?.push).toBeDefined()
  })

  it('a failure with a status logs it and never the title', async () => {
    const h = harness({ outcome: () => ({ outcome: 'failed', status: 503 }) })
    h.svc.turnEnded({ chatId: 'c1', agent: 'news', outcome: 'ok' })
    await flush()
    expect(h.logs).toEqual(['push to "Phone" failed: 503'])
  })
})

describe('NotifyService: sessions', () => {
  const PAUSED = { v: 1, kind: 'paused', tag: 'paused', chatId: null, title: 'ZumiBot', at: 1000 }

  it('sessionEnded pauses the devices bound to that session, once', async () => {
    const h = harness({ devices: [pushDev('p1', { sessionKey: 'k1' }), pushDev('p2', { sessionKey: 'k2' }), deskDev('d1')] })
    h.svc.sessionEnded('k1')
    await flush()
    expect(h.sent).toEqual([{ endpoint: 'https://push.example/p1', payload: PAUSED, subject: 'https://bot.example' }])
    expect((await h.store.get('p1'))?.push?.paused).toBe(true)
    expect((await h.store.get('p2'))?.push?.paused).toBe(false)
    h.sent.length = 0
    h.svc.turnEnded({ chatId: 'c1', agent: 'news', outcome: 'ok' })
    h.svc.sessionEnded('k1')
    await flush()
    expect(h.sent.map((s) => s.endpoint)).toEqual(['https://push.example/p2'])
  })

  it('two session ends at once send one paused push', async () => {
    const h = harness({ devices: [pushDev('p1', { sessionKey: 'k1' })] })
    h.svc.sessionEnded('k1')
    h.svc.sessionEnded('all')
    await flush()
    expect(h.kinds()).toEqual(['paused'])
  })

  it('an event that listed the devices before a pause sends no second paused push', async () => {
    const h = harness({ devices: [pushDev('p1', { sessionKey: 'k1' })], valid: () => false, slowValid: true })
    h.svc.turnEnded({ chatId: 'c1', agent: 'news', outcome: 'ok' })
    // Let the event get past its own checks and park on the session check before the pause starts.
    for (let i = 0; i < 20; i++) await Promise.resolve()
    h.svc.sessionEnded('k1')
    await flush()
    expect(h.kinds()).toEqual(['paused'])
  })

  it('a device rebound to a new session while its pause is sent stays unpaused', async () => {
    const h = harness({
      devices: [pushDev('p1', { sessionKey: 'k1' })],
      outcome: (store) => {
        store.list[0] = { ...store.list[0], push: { ...store.list[0].push!, sessionKey: 'k2' } }
        return { outcome: 'sent', status: 201 }
      }
    })
    h.svc.sessionEnded('k1')
    await flush()
    const rec = await h.store.get('p1')
    expect(rec?.push?.sessionKey).toBe('k2')
    expect(rec?.push?.paused).toBe(false)
  })

  it('an expired binding rebound before its pause starts is not paused at all', async () => {
    const h = harness({ devices: [pushDev('p1', { sessionKey: 'k1' })], valid: (k) => k !== 'k1', slowValid: true })
    h.svc.turnEnded({ chatId: 'c1', agent: 'news', outcome: 'ok' })
    for (let i = 0; i < 20; i++) await Promise.resolve()
    h.store.list[0] = { ...h.store.list[0], push: { ...h.store.list[0].push!, sessionKey: 'k2' } }
    await flush()
    expect(h.sent).toEqual([])
    expect((await h.store.get('p1'))?.push?.paused).toBe(false)
  })

  it("sessionEnded('all') pauses every push device", async () => {
    const h = harness({ devices: [pushDev('p1', { sessionKey: 'k1' }), pushDev('p2', { sessionKey: 'k2' })] })
    h.svc.sessionEnded('all')
    await flush()
    expect(h.kinds()).toEqual(['paused', 'paused'])
    expect((await h.store.get('p1'))?.push?.paused).toBe(true)
    expect((await h.store.get('p2'))?.push?.paused).toBe(true)
  })

  it('an expired session sends paused instead, once', async () => {
    const h = harness({ devices: [pushDev('p1', { sessionKey: 'old' }), pushDev('p2', { sessionKey: 'k2' })], valid: (k) => k !== 'old' })
    h.svc.turnEnded({ chatId: 'c1', agent: 'news', outcome: 'ok' })
    h.svc.chatPush(approvals('c1', 1, 'news'))
    await flush()
    h.svc.turnEnded({ chatId: 'c1', agent: 'news', outcome: 'ok' })
    await flush()
    const toP1 = h.sent.filter((s) => s.endpoint.endsWith('/p1')).map((s) => s.payload.kind)
    expect(toP1).toEqual(['paused'])
    expect(h.sent.filter((s) => s.endpoint.endsWith('/p2'))).toHaveLength(3)
    expect((await h.store.get('p1'))?.push?.paused).toBe(true)
  })
})

describe('NotifyService: test', () => {
  it('returns none when the push failed', async () => {
    const h = harness({ outcome: () => ({ outcome: 'failed', status: 500 }) })
    await expect(h.svc.test('p1')).resolves.toBe('none')
    expect(h.sent).toHaveLength(1)
  })

  it('returns none when the subscription is gone, and removes it', async () => {
    const h = harness({ outcome: () => ({ outcome: 'gone', status: 410 }) })
    await expect(h.svc.test('p1')).resolves.toBe('none')
    expect((await h.store.get('p1'))?.push).toBeUndefined()
  })

  it('returns sent when the push service took it', async () => {
    const h = harness()
    await expect(h.svc.test('p1')).resolves.toBe('sent')
  })

  it('ignores toggles and presence', async () => {
    const h = harness({ devices: [pushDev('p1', { toggles: OFF })] })
    h.presence.update('k1', h.report('p1', 'c1', true))
    await expect(h.svc.test('p1')).resolves.toBe('sent')
    expect(h.sent.map((s) => s.payload)).toEqual([{ v: 1, kind: 'test', tag: 'test', chatId: null, title: 'ZumiBot', at: 1000 }])
  })

  it('reaches a desktop device on its newest connection', async () => {
    const h = harness({ devices: [deskDev('d1', OFF)] })
    h.presence.update('k1', h.report('d1', null, false))
    h.presence.update('k2', h.report('d1', null, false))
    await expect(h.svc.test('d1')).resolves.toBe('sent')
    expect(h.shown.map((s) => s.connId)).toEqual(['k2'])
    expect(h.shown[0].e.event).toBe('notify:show')
  })

  it('returns none for an unknown, paused, unbound or unconnected device', async () => {
    const unbound = { ...pushDev('p3') }
    delete unbound.push
    const h = harness({ devices: [pushDev('p2', { paused: true }), unbound, deskDev('d1')] })
    await expect(h.svc.test('nope')).resolves.toBe('none')
    await expect(h.svc.test('p2')).resolves.toBe('none')
    await expect(h.svc.test('p3')).resolves.toBe('none')
    await expect(h.svc.test('d1')).resolves.toBe('none')
    expect(h.sent).toEqual([])
  })
})

describe('NotifyService: state', () => {
  it('returns pending counts per chat and when each chat was looked at', async () => {
    const h = harness()
    h.svc.chatPush(approvals('c1', 2, 'news'))
    h.svc.chatPush(approvals('c2', 1, 'writer'))
    h.presence.update('k1', h.report('d1', 'c2', true))
    const s = h.svc.state()
    expect(s.pending).toEqual({ c1: 2, c2: 1 })
    expect(s.lookedAt).toEqual(h.presence.lookedAt())
    expect(s.lookedAt).toEqual({ c2: 1000 })
    s.pending.c1 = 99
    expect(h.svc.state().pending.c1).toBe(2)
  })
})

describe('NotifyService: failures', () => {
  function everything(h: ReturnType<typeof harness>) {
    h.svc.chatPush(approvals('c1', 1, 'news'))
    h.svc.chatPush(approvals('c1', 0))
    h.svc.turnEnded({ chatId: 'c1', agent: 'news', outcome: 'ok' })
    h.svc.turnEnded({ chatId: 'c1', agent: 'news', outcome: 'error' })
    h.svc.routineFailed({ routineId: 'r1', chatId: null, cause: 'start' })
    h.svc.routineFailed({ routineId: 'r1', chatId: 'c1', cause: 'turn' })
    h.svc.sessionEnded('k1')
    h.svc.sessionEnded('all')
    h.svc.started('c1')
    h.svc.stopped('c1')
    h.svc.chatRemoved('c1')
    h.svc.state()
  }

  it('a throwing send never throws out, and the log has no endpoint', async () => {
    const h = harness({ sendThrows: true, routines: { r1: routine('r1', 'N', { kind: 'chat', chatId: 'c1' }) } })
    expect(() => everything(h)).not.toThrow()
    await expect(h.svc.test('p1')).resolves.toBe('none')
    await flush()
    expect(h.logs.length).toBeGreaterThan(0)
    expect(h.logs.join('\n')).not.toContain('push.example')
  })

  it('a throwing chats.get or store never throws out', async () => {
    const h = harness({ chatsThrow: true })
    h.store.failDevices = true
    h.store.failGet = true
    expect(() => everything(h)).not.toThrow()
    await expect(h.svc.test('p1')).resolves.toBe('none')
    await flush()
    expect(h.sent).toEqual([])
  })
})

describe('NotifyService: local mode', () => {
  it('never pushes and never touches the VAPID keys, but desktop still works', async () => {
    const h = harness({ mode: 'local', devices: [pushDev('p1'), deskDev('d1')] })
    h.presence.update('k1', h.report('d1', null, false))
    h.svc.chatPush(approvals('c1', 1, 'news'))
    h.svc.turnEnded({ chatId: 'c1', agent: 'news', outcome: 'ok' })
    h.svc.sessionEnded('all')
    await expect(h.svc.test('p1')).resolves.toBe('none')
    await flush()
    expect(h.sent).toEqual([])
    expect(h.store.vapidCalls).toBe(0)
    expect(h.shown.map((s) => s.e.event)).toEqual(['notify:show', 'notify:show'])
  })
})

describe('NotifyService: channel targets', () => {
  const target = (o: { toggles?: Partial<ChannelNotifyToggles> | null; drives?: string[] } = {}) => {
    const got: NotifyPayload[] = []
    const t: NotifyTarget & { got: NotifyPayload[] } = {
      id: 'channel:telegram',
      label: 'Telegram',
      got,
      toggles: async () => (o.toggles === null ? null : { ...DEFAULT_CHANNEL_TOGGLES, ...o.toggles }),
      drives: (chatId) => (o.drives ?? []).includes(chatId),
      send: async (p) => {
        got.push(p)
        return true
      }
    }
    return t
  }
  const turnEnd = (chatId: string, outcome: 'ok' | 'error' = 'ok') => ({ chatId, agent: 'news', outcome })

  it('sends what its own toggles allow, off by default, beside the devices', async () => {
    const off = target()
    const on = target({ toggles: { replied: true, waiting: true } })
    const h = harness({ targets: [off, on] })
    h.svc.turnEnded(turnEnd('c1'))
    h.svc.chatPush(approvals('c1', 1, 'news'))
    h.svc.turnEnded(turnEnd('c2', 'error'))
    await flush()
    expect(off.got).toEqual([])
    expect(on.got.map((p) => [p.kind, p.chatId, p.title])).toEqual([
      ['replied', 'c1', 'Fix login'],
      ['waiting', 'c1', 'Fix login']
    ])
    expect(h.kinds()).toEqual(['replied', 'waiting', 'error'])
  })

  it('is never told about a chat whose turn already talks to it, while push devices still are', async () => {
    const t = target({ toggles: { replied: true, waiting: true, error: true }, drives: ['c1'] })
    const h = harness({ targets: [t] })
    h.svc.turnEnded(turnEnd('c1'))
    h.svc.chatPush(approvals('c1', 1, 'news'))
    h.svc.turnEnded(turnEnd('c2'))
    await flush()
    expect(t.got.map((p) => p.chatId)).toEqual(['c2'])
    expect(h.kinds()).toEqual(['replied', 'waiting', 'replied'])
  })

  it('follows presence: held while someone looks, dropped when input followed, sent when they look away', async () => {
    const t = target({ toggles: { replied: true } })
    const h = harness({ targets: [t] })
    h.presence.update('k1', h.report('d1', 'c1', true))
    h.advance(10)
    h.svc.turnEnded(turnEnd('c1'))
    await flush()
    expect(t.got).toEqual([])
    h.presence.update('k1', h.report('d1', null, false))
    await flush()
    expect(t.got.map((p) => p.kind)).toEqual(['replied'])
    // Input after the event: seen on screen, never sent.
    h.presence.update('k1', h.report('d1', 'c2', true))
    h.advance(10)
    h.svc.turnEnded(turnEnd('c2'))
    await flush()
    h.advance(10)
    h.presence.update('k1', h.report('d1', 'c2', true, 0))
    h.presence.update('k1', h.report('d1', null, false))
    await flush()
    expect(t.got.map((p) => p.chatId)).toEqual(['c1'])
  })

  it('takes a workflow Notify step only under its own toggle, and a failed run under routineFailed', async () => {
    const t = target({ toggles: { workflow: true, routineFailed: true } })
    const h = harness({ targets: [t] })
    h.svc.workflowMessage({ workflowId: 'w', runId: 'r', title: 'Daily report', body: 'secret numbers', messageId: 'm1' })
    h.svc.workflowFailed({ workflowId: 'w', runId: 'r2', name: 'Nightly' })
    await flush()
    expect(t.got.map((p) => [p.kind, p.title])).toEqual([
      ['workflow', 'Daily report'],
      ['routine-failed', 'Nightly']
    ])
    // The channel's words drop a Notify step's own text: it stays in the Inbox.
    expect(JSON.stringify(channelNotifyText(t.got[0]))).not.toContain('secret numbers')
    const quiet = target({ toggles: { routineFailed: true } })
    const h2 = harness({ targets: [quiet] })
    h2.svc.workflowMessage({ workflowId: 'w', runId: 'r', title: 'Daily report' })
    await flush()
    expect(quiet.got).toEqual([])
  })

  it('a target that cannot take one (not paired, not running here) gets nothing; a throwing one breaks nothing', async () => {
    const none = target({ toggles: null })
    const broken: NotifyTarget = {
      id: 'channel:slack',
      label: 'Slack',
      toggles: async () => {
        throw new Error('boom')
      },
      drives: () => false,
      send: async () => true
    }
    const h = harness({ targets: [none, broken] })
    h.svc.turnEnded(turnEnd('c1'))
    await flush()
    expect(none.got).toEqual([])
    expect(h.kinds()).toEqual(['replied'])
    expect(h.logs).toContain('notify: "Slack" failed')
  })

  it('caps a channel at 10 non-waiting notifications a minute, like a device', async () => {
    const t = target({ toggles: { replied: true } })
    const h = harness({ targets: [t], devices: [] })
    for (let i = 0; i < 12; i++) h.svc.turnEnded(turnEnd('c1'))
    await flush()
    expect(t.got).toHaveLength(10)
    expect(h.logs.filter((l) => l === 'notify: rate cap dropped a replied notification for "Telegram"')).toHaveLength(2)
  })
})
