import {
  buildPayload,
  slotTag,
  type ChannelNotifyToggles,
  type NotifyClear,
  type NotifyKind,
  type NotifyPayload,
  type NotifyState,
  type RoutineFailure,
  type TurnEnd
} from '@zumibot/shared/notify'
import { displayName } from '@zumibot/shared/agentName'
import type { RpcEvent } from '@zumibot/shared/rpc'
import type { Routine } from '@zumibot/shared/routines'
import type { ChatMeta, ChatPush, ServerMode } from '@zumibot/shared/types'
import { kindFor, RateCap } from './decide'
import type { DeviceRecord, NotifyStore } from './notifyStore'
import type { Presence } from './presence'
import type { PushOutcome, sendPush } from './pushSender'

export type NotifyEvent = Extract<RpcEvent, { event: 'notify:show' | 'notify:clear' }>

/**
 * A paired channel (Telegram, Slack) as one more place notifications go, beside the devices: its own toggles, and the same
 * presence holds, input drops and rate cap as a push.
 */
export interface NotifyTarget {
  id: string // 'channel:telegram': the rate cap's key
  label: string
  /** Its toggles, or null while it can't take one (not paired, or the bot does not run on this machine). */
  toggles(): Promise<ChannelNotifyToggles | null>
  /** A turn in this chat already talks to this channel: its reply, cards and notices went there, so it is not told again. */
  drives(chatId: string): boolean
  send(payload: NotifyPayload): Promise<boolean>
}

export interface NotifyServiceDeps {
  store: NotifyStore
  presence: Presence
  mode: ServerMode
  subject(): string
  chats: { get(id: string): Promise<ChatMeta | null> }
  routines: { get(id: string): Promise<Routine | null> }
  routineOfChat(chatId: string): string | null
  sessionValid(key: string): Promise<boolean>
  sendTo(connId: string, e: NotifyEvent): boolean
  broadcast(e: NotifyEvent): void
  send: (o: Omit<Parameters<typeof sendPush>[0], 'fetch' | 'now' | 'sleep'>) => Promise<{ outcome: PushOutcome; status: number | null }>
  now(): number
  log(line: string): void
  /** Paired channels; read per event, so pairing or a switch applies to the next one. */
  targets?(): NotifyTarget[]
}

// An event before it becomes each device's payload: the kind a device gets depends on its own toggles.
interface Ev {
  kind: NotifyKind
  chatId: string | null
  agent?: string
  // Taken when the event fires: a held event must keep the slot of the run that raised it.
  routineId: string | null
  cause: RoutineFailure['cause'] | null
  at: number
  inbox?: true // a task card's questions, not an approval card: news while `asking` holds the chat
}

interface View {
  title: string
  agent?: string
  slotRoutine: string | null
}

type Slot = 'waiting' | 'chat'
const slotOf = (k: NotifyKind): Slot => (k === 'waiting' ? 'waiting' : 'chat')

const APP_TITLE = 'ZumiBot'

const clear = (chatId: string, waitingOnly: boolean): NotifyEvent => ({ event: 'notify:clear', payload: { chatId, waitingOnly } })
const clearTag = (tag: string): NotifyEvent => ({
  event: 'notify:clear',
  payload: { chatId: null, waitingOnly: true, tag } satisfies NotifyClear
})

interface RunRef {
  workflowId: string
  runId: string
}

// An errno code is safe to log; a message could carry an endpoint or a title.
const codeOf = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^E[A-Z]+$/.test(code) ? ` (${code})` : ''
}

/** Turns chat, turn, routine and session events into notifications per device. Nothing here throws back to its caller. */
export class NotifyService {
  private readonly pending = new Map<string, number>()
  // Task chats whose agent's last turn put questions on its card: waiting on the user until the chat's next turn starts.
  private readonly asking = new Set<string>()
  // Events held back while someone looked at the chat: per chat and slot, latest only.
  private readonly held = new Map<string, Map<Slot, Ev>>()
  private readonly rate: RateCap
  // Concurrent events for one expired session must send one paused push, not one each.
  private readonly pausing = new Set<string>()

  constructor(private readonly d: NotifyServiceDeps) {
    this.rate = new RateCap(() => d.now())
  }

  chatPush(p: ChatPush): void {
    this.run('approvals', async () => {
      // A task chat's next turn starts only once the user answered (or wrote back) from its card: no longer waiting.
      if (p.kind === 'meta' && p.meta.inFlight && this.asking.delete(p.chatId)) {
        this.held.get(p.chatId)?.delete('waiting')
        if (!this.pending.has(p.chatId)) this.d.broadcast(clear(p.chatId, true))
        return
      }
      // An asked chat's approval card shows on the asking chat's row; the user is not told twice.
      if (p.kind !== 'approvals' || p.asked) return
      const { chatId, pending } = p
      const prev = this.pending.get(chatId) ?? 0
      if (pending > 0) this.pending.set(chatId, pending)
      else this.pending.delete(chatId)
      if (pending > prev) {
        const agent = p.agent
        await this.emit({ kind: 'waiting', chatId, agent, routineId: this.d.routineOfChat(chatId), cause: null })
      } else if (pending <= 0 && prev > 0) {
        this.held.get(chatId)?.delete('waiting')
        this.d.broadcast(clear(chatId, true))
      }
    })
  }

  turnEnded(e: TurnEnd): void {
    this.run('turn end', async () => {
      // B's answer goes back to A; nobody is waiting on the asked chat itself.
      // An Agent step's reply goes to its workflow run, which reports for itself.
      if (e.outcome === 'stopped' || e.asked || e.workflow) return
      const routineId = this.d.routineOfChat(e.chatId)
      // A reply that ends on questions for the card is one waiting notice (its click opens the Inbox), not a reply.
      if (e.outcome === 'ok' && e.cardQuestions) {
        this.asking.add(e.chatId)
        await this.emit({ kind: 'waiting', chatId: e.chatId, agent: e.agent, routineId, cause: null, inbox: true })
        return
      }
      // A routine's errored turn is reported once, as the routine failure that follows.
      if (e.outcome === 'error' && routineId !== null) return
      await this.emit({ kind: e.outcome === 'ok' ? 'replied' : 'error', chatId: e.chatId, agent: e.agent, routineId, cause: null })
    })
  }

  routineFailed(e: RoutineFailure): void {
    this.run('routine failure', async () => {
      if (e.cause === 'user' || e.cause === 'restart') return
      await this.emit({ kind: 'routine-failed', chatId: e.chatId, routineId: e.routineId, cause: e.cause })
    })
  }

  workflowWaiting(o: RunRef & { name: string }): void {
    this.run('workflow waiting', () => this.toRun('waiting', o, `${o.name} needs your approval`))
  }

  workflowWaitingCleared(runId: string): void {
    this.run('workflow clear', async () => {
      this.d.broadcast(clearTag(slotTag({ kind: 'waiting', chatId: null, routineId: null, runId })))
    })
  }

  workflowFailed(o: RunRef & { name: string }): void {
    this.run('workflow failure', () => this.toRun('routine-failed', o, o.name))
  }

  // The Notify step is the one place a notification carries content, so it ignores the toggles; the rate cap still holds.
  workflowMessage(o: RunRef & { title: string; body?: string; messageId?: string }): void {
    this.run('workflow message', () => this.toRun('workflow', o, o.title, o.body, o.messageId))
  }

  /**
   * A spend cap was reached and paused what it covers. Under the "needs you" toggle, since going on is the user's call; not
   * while someone has the chat on screen, where its notice already says so. Its body carries amounts only.
   */
  spendCap(o: { title: string; body: string; chatId: string | null; run?: RunRef; tag: string }): void {
    this.run('spend cap', async () => {
      if (o.chatId !== null && this.d.presence.lookingAt(o.chatId)) return
      const at = this.d.now()
      const devices = await this.d.store.devices()
      await Promise.all(
        devices.map(async (dev) => {
          if (!dev.toggles.waiting) return
          const payload = buildPayload({
            kind: 'spend-cap',
            tag: o.tag,
            chatId: o.chatId,
            title: o.title,
            at,
            body: o.body,
            ...(o.run ? { run: o.run } : {})
          })
          await this.deliverTo(dev, payload, true).catch((err) => this.fail(dev, err))
        })
      )
      await this.toTargets('waiting', (t) =>
        o.chatId !== null && t.drives(o.chatId)
          ? null
          : buildPayload({
              kind: 'spend-cap',
              tag: o.tag,
              chatId: o.chatId,
              title: o.title,
              at,
              body: o.body,
              ...(o.run ? { run: o.run } : {})
            })
      )
    })
  }

  chatRemoved(chatId: string): void {
    this.run('chat removal', async () => {
      this.pending.delete(chatId)
      this.asking.delete(chatId)
      this.held.delete(chatId)
      this.d.broadcast(clear(chatId, false))
    })
  }

  sessionEnded(key: string | 'all'): void {
    this.run('session end', async () => {
      if (this.d.mode !== 'vps') return
      const bound = (await this.d.store.devices()).filter((r) => r.push && !r.push.paused && (key === 'all' || r.push.sessionKey === key))
      await Promise.all(bound.map((r) => this.pause(r, r.push!).catch((err) => this.fail(r, err))))
    })
  }

  started(chatId: string): void {
    this.run('look start', async () => {
      this.held.delete(chatId)
      this.d.broadcast(clear(chatId, false))
    })
  }

  stopped(chatId: string): void {
    this.run('held events', async () => {
      const slots = this.held.get(chatId)
      if (!slots) return
      this.held.delete(chatId)
      // Input after the event means the user saw it on screen.
      const due = [...slots.values()].filter((ev) => !this.d.presence.inputSince(chatId, ev.at))
      // Stamped now: the chat's lookedAt was just stamped too, and an older at would read as already seen.
      const at = this.d.now()
      await Promise.all(due.map((ev) => this.deliver({ ...ev, at })))
    })
  }

  async test(deviceId: string): Promise<'sent' | 'none'> {
    try {
      const dev = await this.d.store.get(deviceId)
      if (!dev) return 'none'
      const payload = buildPayload({
        kind: 'test',
        tag: slotTag({ kind: 'test', chatId: null, routineId: null }),
        chatId: null,
        title: APP_TITLE,
        at: this.d.now()
      })
      return (await this.deliverTo(dev, payload, false)) ? 'sent' : 'none'
    } catch (err) {
      this.safeLog(`notify: test failed${codeOf(err)}`)
      return 'none'
    }
  }

  state(): NotifyState {
    // A card's questions keep its notification as an approval card would: a page load must not close it as settled.
    const pending = Object.fromEntries(this.pending)
    for (const chatId of this.asking) pending[chatId] = Math.max(pending[chatId] ?? 0, 1)
    try {
      return { pending, lookedAt: this.d.presence.lookedAt() }
    } catch {
      return { pending, lookedAt: {} }
    }
  }

  private run(what: string, work: () => Promise<void>): void {
    // The sync part of work (counts, held events) runs now; only the awaits come later.
    void (async () => work())().catch((err) => this.safeLog(`notify: ${what} failed${codeOf(err)}`))
  }

  private safeLog(line: string): void {
    try {
      this.d.log(line)
    } catch {
      // A broken logger must not turn into an unhandled rejection.
    }
  }

  private fail(dev: DeviceRecord, err: unknown): void {
    this.safeLog(
      dev.channel === 'push' ? `push to "${dev.label}" failed: error${codeOf(err)}` : `notify: "${dev.label}" failed${codeOf(err)}`
    )
  }

  // A run has no chat to look at, so presence never holds these.
  private async toRun(kind: NotifyKind | 'workflow', o: RunRef, title: string, body?: string, messageId?: string): Promise<void> {
    const at = this.d.now()
    const devices = await this.d.store.devices()
    await Promise.all(
      devices.map(async (dev) => {
        const k = kind === 'workflow' ? kind : kindFor(dev.toggles, kind, null)
        if (!k) return
        const tag = slotTag({ kind: k, chatId: null, routineId: null, runId: o.runId })
        const payload = buildPayload({
          kind: k,
          tag,
          chatId: null,
          title,
          at,
          run: { workflowId: o.workflowId, runId: o.runId },
          ...(body !== undefined ? { body } : {}),
          ...(messageId !== undefined ? { message: messageId } : {})
        })
        await this.deliverTo(dev, payload, true).catch((err) => this.fail(dev, err))
      })
    )
    // A run has no chat that talks to a channel, so a channel is never skipped here; a Notify step obeys its own toggle there.
    await this.toTargets(kind === 'workflow' ? 'workflow' : kind, (_t, k) => {
      const tag = slotTag({ kind: k, chatId: null, routineId: null, runId: o.runId })
      return buildPayload({
        kind: k,
        tag,
        chatId: null,
        title,
        at,
        run: { workflowId: o.workflowId, runId: o.runId },
        ...(body !== undefined ? { body } : {}),
        ...(messageId !== undefined ? { message: messageId } : {})
      })
    })
  }

  /**
   * Each paired channel whose toggle allows `kind`: `make` builds its payload, or null to skip it. Never throws; a failed send
   * is logged with the channel's name only.
   */
  private async toTargets(
    kind: NotifyKind | 'workflow',
    make: (t: NotifyTarget, k: NotifyPayload['kind']) => NotifyPayload | null,
    cause: RoutineFailure['cause'] | null = null
  ): Promise<void> {
    const targets = this.d.targets?.() ?? []
    await Promise.all(
      targets.map(async (t) => {
        try {
          const toggles = await t.toggles()
          if (!toggles) return
          const k = kind === 'workflow' ? (toggles.workflow ? 'workflow' : null) : kindFor(toggles, kind, cause)
          if (!k) return
          const payload = make(t, k)
          if (!payload) return
          if (!this.rate.allow(t.id, payload.kind))
            return void this.safeLog(`notify: rate cap dropped a ${payload.kind} notification for "${t.label}"`)
          await t.send(payload)
        } catch (err) {
          this.safeLog(`notify: "${t.label}" failed${codeOf(err)}`)
        }
      })
    )
  }

  private async emit(e: Omit<Ev, 'at'>): Promise<void> {
    const ev: Ev = { ...e, at: this.d.now() }
    // Someone has the chat on screen: no device buzzes now; held until they look away.
    if (ev.chatId !== null && this.d.presence.lookingAt(ev.chatId)) {
      const slots = this.held.get(ev.chatId) ?? new Map<Slot, Ev>()
      slots.set(slotOf(ev.kind), ev)
      this.held.set(ev.chatId, slots)
      return
    }
    await this.deliver(ev)
  }

  private async deliver(ev: Ev): Promise<void> {
    const view = await this.view(ev)
    if (!view) return
    // Answered while the title was built (or while held): no longer news.
    if (ev.kind === 'waiting' && ev.chatId !== null && !(ev.inbox ? this.asking.has(ev.chatId) : this.pending.has(ev.chatId))) return
    const devices = await this.d.store.devices()
    await Promise.all(devices.map((dev) => this.toDevice(dev, ev, view).catch((err) => this.fail(dev, err))))
    // A chat whose turn talks to a channel already told it (the reply, the card, the error): not told twice.
    await this.toTargets(
      ev.kind,
      (t, k) => {
        if (ev.chatId !== null && t.drives(ev.chatId)) return null
        const tag = slotTag({ kind: k, chatId: ev.chatId, routineId: view.slotRoutine })
        return buildPayload({
          kind: k,
          tag,
          chatId: ev.chatId,
          title: view.title,
          agent: view.agent,
          at: ev.at,
          ...(ev.inbox ? { inbox: true as const } : {})
        })
      },
      ev.cause
    )
  }

  // Null drops the event: its chat (or, with no chat, its routine) is gone.
  private async view(ev: Ev): Promise<View | null> {
    const routine = ev.routineId !== null ? await this.d.routines.get(ev.routineId) : null
    if (ev.chatId === null) return routine ? { title: routine.name, slotRoutine: routine.id } : null
    const chat = await this.d.chats.get(ev.chatId)
    if (!chat) return null
    const agent = ev.agent || chat.agentName || undefined
    // A routine that opens a new chat per run owns the slot; one that runs in an existing chat does not.
    const perRun = routine !== null && (routine.target.kind === 'new-chat' || routine.target.kind === 'new-group')
    return {
      title: chat.title || (agent && displayName(agent)) || routine?.name || APP_TITLE,
      agent,
      slotRoutine: perRun ? routine.id : null
    }
  }

  private async toDevice(dev: DeviceRecord, ev: Ev, view: View): Promise<void> {
    const kind = kindFor(dev.toggles, ev.kind, ev.cause)
    if (!kind) return
    const tag = slotTag({ kind, chatId: ev.chatId, routineId: view.slotRoutine })
    await this.deliverTo(
      dev,
      buildPayload({
        kind,
        tag,
        chatId: ev.chatId,
        title: view.title,
        agent: view.agent,
        at: ev.at,
        ...(ev.inbox ? { inbox: true as const } : {})
      }),
      true
    )
  }

  // True only when the shell's socket or the push service took it.
  private async deliverTo(dev: DeviceRecord, payload: NotifyPayload, capped: boolean): Promise<boolean> {
    if (dev.channel === 'desktop') {
      const conns = this.d.presence.connsOf(dev.id)
      const newest = conns[conns.length - 1]
      // One notify:show per device: during a reconnect overlap the newest socket is the live one.
      if (newest === undefined || (capped && !this.allow(dev, payload))) return false
      return this.d.sendTo(newest, { event: 'notify:show', payload })
    }
    const push = dev.push
    if (this.d.mode !== 'vps' || !push || push.paused || this.pausing.has(dev.id)) return false
    // Expiry is noticed here, at the device's next event.
    if (!(await this.d.sessionValid(push.sessionKey))) {
      await this.pause(dev, push)
      return false
    }
    if (capped && !this.allow(dev, payload)) return false
    return (await this.push(dev, payload)) === 'sent'
  }

  private allow(dev: DeviceRecord, payload: NotifyPayload): boolean {
    if (this.rate.allow(dev.id, payload.kind)) return true
    this.safeLog(`notify: rate cap dropped a ${payload.kind} notification for "${dev.label}"`)
    return false
  }

  // One last push with no chat and no title, then nothing more until the device signs in again.
  // `was` is the binding whose session ended: a device signed in again meanwhile is left alone.
  private async pause(dev: DeviceRecord, was: { sessionKey: string; endpoint: string }): Promise<void> {
    if (this.d.mode !== 'vps' || this.pausing.has(dev.id)) return
    this.pausing.add(dev.id)
    const same = (p: DeviceRecord['push']): boolean => !!p && p.sessionKey === was.sessionKey && p.endpoint === was.endpoint
    try {
      // Re-read: another event may have paused or rebound it since this one listed the devices.
      const cur = await this.d.store.get(dev.id)
      if (!cur?.push || cur.push.paused || !same(cur.push)) return
      const at = this.d.now()
      await this.push(
        cur,
        buildPayload({
          kind: 'paused',
          tag: slotTag({ kind: 'paused', chatId: null, routineId: null }),
          chatId: null,
          title: APP_TITLE,
          at
        })
      )
      await this.d.store.patch(dev.id, (r) => (r.push && same(r.push) ? { ...r, push: { ...r.push, paused: true } } : r))
    } finally {
      this.pausing.delete(dev.id)
    }
  }

  private async push(dev: DeviceRecord, payload: NotifyPayload): Promise<PushOutcome> {
    const binding = dev.push
    if (!binding) return 'failed'
    const vapid = await this.d.store.vapid()
    const target = { endpoint: binding.endpoint, p256dh: binding.p256dh, auth: binding.auth }
    const { outcome, status } = await this.d.send({ target, payload, vapid, subject: this.d.subject() })
    if (outcome === 'sent') return outcome
    this.safeLog(`push to "${dev.label}" failed: ${status ?? 'error'}`)
    if (outcome !== 'gone') return outcome
    // Only the subscription that failed: the device may have subscribed again meanwhile.
    await this.d.store.patch(dev.id, (r) => {
      if (r.push?.endpoint !== binding.endpoint) return r
      const { push: _gone, ...rest } = r
      return rest
    })
    return outcome
  }
}
