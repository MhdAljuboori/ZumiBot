import {
  defaultRunTitle,
  limitPolicyOf,
  missedPolicyOf,
  sessionPolicyOf,
  ROUTINE_MAX_ACTIVE_RUNS,
  ROUTINE_MAX_LIMIT_WAITS,
  type ConditionCheck,
  type Routine,
  type RoutineRun,
  type SkipReason,
  type WebhookCall
} from '@zumibot/shared/routines'
import { isAsked } from '@zumibot/shared/agentAsk'
import { continueText, resumeTime } from '@zumibot/shared/limitResume'
import { flattenCall, renderPrompt } from '@zumibot/shared/routineFields'
import { capSkipText } from '@zumibot/shared/spendCaps'
import type { RoutineFailure } from '@zumibot/shared/notify'
import { isGroup, type AgentSummary, type ChatItem, type ChatMeta, type ChatPush, type LimitHit } from '@zumibot/shared/types'
import type { Engine, EngineCaps } from '@zumibot/shared/engine'
import { refuseZumiBot, refuseCodexMembers } from '../groupMembers'
import type { ChatStore } from '../store/chatStore'
import type { TaskQueue } from '../chat/taskQueue'
import type { CommandResolver } from '../chat/commandResolver'
import { hiddenItems } from '../chat/versions'
import { startFresh } from '../chat/freshStart'
import { capRefusalAtRun, type CapEngines } from '../caps/capEngines'
import type { RoutineStore } from './routineStore'

export interface RoutineRunnerDeps {
  store: RoutineStore
  chats: Pick<ChatStore, 'get' | 'create' | 'createGroup' | 'update' | 'updateGroup' | 'loadItems' | 'loadVersions'>
  tasks: Pick<TaskQueue, 'submit'>
  // A leading `/name` in the saved prompt becomes the agent's command; absent, every prompt is sent as plain text.
  commands?: Pick<CommandResolver, 'forRoutine'>
  agents(): Promise<AgentSummary[]>
  isRunning(chatId: string): boolean
  builtInCwd(agentName: string): string | null
  changed(): void
  now(): number
  newId(): string
  // Jev's check of a webhook call against the routine's condition; null while Jev is off (the call runs, as before).
  condition?(condition: string, call: WebhookCall): Promise<ConditionCheck | null>
  // Once per run that ends failed, after its status is saved. A throw in it never reaches the run.
  onFailed?(e: RoutineFailure): void
  // For the wait until a usage limit lifts; a real timer when absent.
  setTimer?(fn: () => void, ms: number): { clear(): void }
  // Puts a new room at the top of a sidebar section, telling every tab. Absent: rooms stay outside the sections.
  placeRoom?(chatId: string, sectionId: string): Promise<void>
  // What each engine can do (default engineCaps): a new room takes a Codex member only while Codex rooms are on.
  caps?(engine: Engine): EngineCaps
  // Spend caps: the first of these agents that is past its daily cap, or null; a run that would start one is skipped.
  capGate?(agents: string[]): Promise<string | null>
  // Spend caps: whether the routine's cap can hold for its agents' engines now (they may have changed since the save).
  capEngines?: Pick<CapEngines, 'routine'>
}

export { LIMIT_RESUME_MARGIN_MS, LIMIT_RESUME_MIN_MS } from '@zumibot/shared/limitResume'
const MAX_TIMER_MS = 2 ** 31 - 1

// resumeAt: set while the run waits for the usage limit to lift. paused: the user paused its turn; Resume moves it on.
interface ActiveRun {
  routineId: string
  messageId: string
  waits?: number
  resumeAt?: number
  timer?: { clear(): void } | null
  paused?: true
  resumes?: number
}

export class RoutineRunner {
  private readonly active = new Map<string, Map<string, ActiveRun>>()
  private readonly eventQueues = new Map<string, Promise<void>>()
  private readonly starting = new Map<string, number>()
  private stopped = false

  constructor(private readonly d: RoutineRunnerDeps) {}

  /** At shutdown: no wait may resume while the chats stop. The waits stay stored, and recover() arms them again. */
  stop(): void {
    this.stopped = true
    for (const runs of this.active.values()) {
      for (const run of runs.values()) {
        run.timer?.clear()
        run.timer = null
      }
    }
  }

  activeCount(routineId: string): number {
    let count = this.starting.get(routineId) ?? 0
    for (const runs of this.active.values()) {
      for (const run of runs.values()) if (run.routineId === routineId) count++
    }
    return count
  }

  /**
   * The messages of this chat's active runs, read at once: a run's own usage-limit policy decides about its turn, so a
   * chat's limit wait (LimitResumes) leaves it alone. Synchronous, so it sees the runs before chatIdle settles them.
   */
  messagesOf(chatId: string): Set<string> {
    return new Set([...(this.active.get(chatId)?.values() ?? [])].map((run) => run.messageId))
  }

  /** The routine whose run is active in this chat, so a notification can tell a routine's turn from a person's. */
  routineOfChat(chatId: string): string | null {
    for (const run of this.active.get(chatId)?.values() ?? []) return run.routineId
    return null
  }

  async run(routine: Routine, via: RoutineRun['via'], o: { late?: boolean; call?: WebhookCall } = {}): Promise<RoutineRun> {
    const run: RoutineRun = {
      id: this.d.newId(),
      routineId: routine.id,
      via,
      status: 'running',
      late: o.late ?? false,
      chatId: null,
      messageId: null,
      startedAt: this.d.now()
    }
    // Late only when ZumiBot was off or asleep at the due time: the routine may want that run dropped.
    if (via === 'schedule' && run.late && missedPolicyOf(routine) === 'skip') {
      run.status = 'skipped'
      run.skipReason = 'missed'
      run.endedAt = this.d.now()
      await this.d.store.addRun(run)
      this.d.changed()
      return run
    }
    // Before the cap: a slow check must not hold one of the routine's start slots. Only real calls: Run now is the user
    // asking for this run.
    const condition = via === 'webhook' && routine.trigger.kind === 'webhook' ? routine.trigger.condition : undefined
    if (condition && o.call && this.d.condition) {
      const check = await this.d.condition(condition, o.call).catch((): ConditionCheck => ({ met: null }))
      if (check) run.condition = check
      if (check?.met === false) {
        run.status = 'skipped'
        run.endedAt = this.d.now()
        await this.d.store.addRun(run)
        this.d.changed()
        return run
      }
    }
    // An agent past its daily spend cap: no automatic start for it until the user allows more (or the day ends).
    const over = this.d.capGate ? await this.d.capGate(await this.agentsOf(routine)).catch((): string | null => null) : null
    if (over !== null) {
      run.status = 'skipped'
      run.skipReason = 'cap'
      run.error = capSkipText(over)
      run.endedAt = this.d.now()
      await this.d.store.addRun(run)
      this.d.changed()
      return run
    }
    // A cap that can't hold for an agent's engine (it may have changed since the save) fails the run, never runs it uncapped.
    const uncapped = await capRefusalAtRun(this.d.capEngines && (() => this.d.capEngines!.routine(routine)))
    if (uncapped !== null) {
      run.status = 'failed'
      run.error = uncapped
      run.endedAt = this.d.now()
      await this.d.store.addRun(run)
      this.d.changed()
      this.failed(run.routineId, null, 'start')
      return run
    }
    if (this.activeCount(routine.id) >= ROUTINE_MAX_ACTIVE_RUNS) {
      run.status = 'failed'
      run.error = 'Too many runs in progress'
      run.endedAt = this.d.now()
      await this.d.store.addRun(run)
      this.d.changed()
      this.failed(run.routineId, null, 'start')
      return run
    }

    this.starting.set(routine.id, (this.starting.get(routine.id) ?? 0) + 1)
    let reservationReleased = false
    const releaseReservation = () => {
      if (reservationReleased) return
      reservationReleased = true
      this.releaseStarting(routine.id)
    }
    try {
      await this.d.store.addRun(run)
      this.d.changed()
      const chat = await this.target(routine)
      // Not in a paused chat: the paused session and its subagent results must survive for Resume to continue.
      if (routine.target.kind === 'chat' && sessionPolicyOf(routine) === 'fresh' && chat.pause === undefined)
        await startFresh(this.d.chats, chat)
      run.chatId = chat.id
      const messageId = this.d.newId()
      run.messageId = messageId
      this.addActive(chat.id, run.id, { routineId: routine.id, messageId })
      releaseReservation()

      let text = routine.prompt
      if (via === 'webhook' || (via === 'manual' && routine.trigger.kind === 'webhook')) {
        const call = o.call ?? (routine.trigger.kind === 'webhook' ? routine.trigger.sample : null)
        const rendered = renderPrompt(text, call ? flattenCall(call) : {})
        text = rendered.text
        if (rendered.missing.length > 0) run.missingFields = rendered.missing
      }

      await this.d.store.updateRun(routine.id, run.id, {
        chatId: run.chatId,
        messageId: run.messageId,
        ...(run.missingFields ? { missingFields: run.missingFields } : {})
      })
      // Push it now: without this the UI keeps the chatless record until the run ends, so Open chat stays hidden.
      this.d.changed()
      // From the agent file as it is now, after the run names its chat; a refusal (a name several members have) fails the run.
      const command = await this.d.commands?.forRoutine(chat.id, routine.prompt, text, routine.command)
      // submit resolves after a single chat's whole turn, so only observe its rejection. 'routine': a paused chat holds
      // the message for Resume instead of starting the agent (a full tray rejects it, which fails the run below).
      // A command that makes to-dos asks for the list here too, as a send of it does; a leading `/todo` stays plain text.
      const sent = this.d.tasks.submit(
        chat.id,
        text,
        [],
        undefined,
        messageId,
        command,
        command?.todos === true ? true : undefined,
        'routine'
      )
      void sent.catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        void this.serialize(chat.id, () => this.finish(run, 'failed', message, 'start')).catch(logError)
      })
    } catch (error) {
      releaseReservation()
      // The record may not have been written if its initial persistence failed.
      const message = error instanceof Error ? error.message : String(error)
      await this.finish(run, 'failed', message, 'start')
    }
    return run
  }

  chatIdle(chatId: string): void {
    void this.serialize(chatId, async () => {
      const runs = [...(this.active.get(chatId)?.entries() ?? [])]
      if (runs.length === 0) return
      const chat = await this.d.chats.get(chatId)
      if (!chat) return
      const items = await this.d.chats.loadItems(chatId)
      for (const [runId, active] of runs) {
        if ((chat.tasks ?? []).some((task) => task.id === active.messageId)) continue
        const turn = turnOf(items, active.messageId)
        if (!turn) {
          await this.finishIfReplaced(chatId, runId, active.messageId)
          continue
        }
        // Waiting for the limit to lift, or paused: only the user moving on ends it (Resume moves a paused run on first).
        if (active.resumeAt !== undefined || active.paused) {
          if (turn.over) await this.continuedByHand(chatId, runId)
          continue
        }
        // A later message means this turn is over, even though the chat already runs the next one.
        if (!turn.over && this.d.isRunning(chatId)) continue
        await this.settle(chatId, runId, turn.items)
      }
    }).catch(logError)
  }

  chatPush(push: ChatPush): void {
    if (push.kind !== 'approvals') return
    void this.serialize(push.chatId, async () => {
      const runs = [...(this.active.get(push.chatId)?.entries() ?? [])]
      if (runs.length === 0) return
      const chat = await this.d.chats.get(push.chatId)
      if (!chat) return
      const items = await this.d.chats.loadItems(push.chatId)
      for (const [runId, active] of runs) {
        if ((chat.tasks ?? []).some((task) => task.id === active.messageId)) continue
        const turn = turnOf(items, active.messageId)
        if (!turn && (await this.finishIfReplaced(push.chatId, runId, active.messageId))) continue
        if (active.resumeAt !== undefined || active.paused) {
          if (turn?.over) await this.continuedByHand(push.chatId, runId)
          continue
        }
        // The cards belong to a later turn: this run is over, so it must not show as waiting.
        if (turn?.over) await this.settle(push.chatId, runId, turn.items)
        else await this.changeStatus(active.routineId, runId, push.pending > 0 ? 'waiting' : 'running')
      }
    }).catch(logError)
  }

  /** The agents a run of this routine would start: its new chat's, its new room's members, or its chat's now. */
  private async agentsOf(routine: Routine): Promise<string[]> {
    const t = routine.target
    if (t.kind === 'new-chat') return [t.agent]
    if (t.kind === 'new-group') return [...t.members]
    const chat = await this.d.chats.get(t.chatId)
    return !chat ? [] : isGroup(chat) ? [...chat.group.members] : [chat.agentName]
  }

  /** The runs open in this chat, each with the message whose turn it follows now, for the spend caps. */
  runsIn(chatId: string): { routineId: string; runId: string; messageId: string }[] {
    return [...(this.active.get(chatId)?.entries() ?? [])].map(([runId, a]) => ({ routineId: a.routineId, runId, messageId: a.messageId }))
  }

  /**
   * A turn's cost in this chat (ChatService's onRunCost, before the turn ends): a run counts it only while that turn answers the
   * run's own message, as a workflow's Agent step does, so the user's own turn in the chat is never the run's.
   */
  chatCost(chatId: string, usd: number): void {
    if (!(usd > 0)) return
    void this.serialize(chatId, async () => {
      const runs = this.runsIn(chatId)
      if (runs.length === 0) return
      const items = await this.d.chats.loadItems(chatId)
      let counted = false
      for (const { routineId, runId, messageId } of runs) {
        const turn = turnOf(items, messageId)
        if (!turn || turn.over) continue
        await this.d.store.changeRun(routineId, runId, (r) => ({ costUsd: (r.costUsd ?? 0) + usd }))
        counted = true
      }
      if (counted) this.d.changed()
    }).catch(logError)
  }

  /** Spend caps: its cap paused the run (not twice for one crossing), or Resume allows it up to `limit`. */
  async capMark(routineId: string, runId: string, mark: { capped: true } | { limit: number }): Promise<void> {
    const patch: Partial<RoutineRun> = 'capped' in mark ? { capped: true } : { capLimitUsd: mark.limit, capped: undefined }
    if (await this.d.store.changeRun(routineId, runId, () => patch)) this.d.changed()
  }

  /**
   * Resume of a paused chat (TaskQueue, before its Continue goes in under messageId): each run the pause stopped follows
   * that turn now, as after a usage limit's `continue`. Queued behind the paused turn's own idle, which marks the run.
   */
  chatResumed(chatId: string, messageId: string): void {
    void this.serialize(chatId, async () => {
      for (const [runId, active] of [...(this.active.get(chatId)?.entries() ?? [])]) {
        if (!active.paused) continue
        const resumes = (active.resumes ?? 0) + 1
        if (!(await this.d.store.updateRun(active.routineId, runId, { status: 'running', messageId, resumes }))) {
          this.removeActive(chatId, runId) // the routine was deleted
          continue
        }
        active.messageId = messageId
        active.resumes = resumes
        delete active.paused
        this.d.changed()
      }
    }).catch(logError)
  }

  taskDropped(chatId: string, messageId: string): void {
    void this.serialize(chatId, async () => {
      const runs = [...(this.active.get(chatId)?.entries() ?? [])]
      for (const [runId, active] of runs) {
        if (active.messageId === messageId) {
          await this.finishById(chatId, runId, 'failed', 'Removed from the queue', 'user')
        }
      }
    }).catch(logError)
  }

  chatRemoved(chatId: string): void {
    void this.serialize(chatId, async () => {
      const runs = [...(this.active.get(chatId)?.keys() ?? [])]
      for (const runId of runs) {
        await this.finishById(chatId, runId, 'failed', 'Chat was deleted', 'user')
      }
    }).catch(logError)
  }

  async recover(): Promise<void> {
    const all = await this.d.store.runs()
    for (const [routineId, runs] of Object.entries(all)) {
      for (const run of runs) {
        if (run.status !== 'running' && run.status !== 'waiting' && run.status !== 'limited' && run.status !== 'paused') continue
        // Untouched, not even failed: sync switches the local copy of a routine off, and the machine where it is on
        // resumes the wait. A write here would make this runs file the newer one and overwrite that machine's record.
        if (run.status === 'limited' && !(await this.d.store.get(routineId))?.enabled) continue
        const chat = run.chatId ? await this.d.chats.get(run.chatId) : null
        if (chat && run.messageId && run.status === 'limited') {
          const active: ActiveRun = { routineId, messageId: run.messageId, waits: run.waits ?? 0, resumes: run.resumes ?? 0 }
          this.addActive(chat.id, run.id, active)
          this.arm(chat.id, run.id, active, run.resumeAt ?? this.d.now())
          continue
        }
        if (chat && run.messageId && (chat.tasks ?? []).some((task) => task.id === run.messageId)) {
          this.addActive(chat.id, run.id, { routineId, messageId: run.messageId, resumes: run.resumes ?? 0 })
          continue
        }
        // It waits for Resume, also when a restart ended its pausing turn (recoverInterrupted landed the pause). Nothing is
        // written for one already paused: a synced copy of the VPS's runs stays as it came.
        if (chat && run.messageId && (run.status === 'paused' || (await this.landedPaused(chat, run.messageId)))) {
          this.addActive(chat.id, run.id, {
            routineId,
            messageId: run.messageId,
            waits: run.waits ?? 0,
            resumes: run.resumes ?? 0,
            paused: true
          })
          if (run.status !== 'paused') await this.changeStatus(routineId, run.id, 'paused')
          continue
        }
        await this.changeStatus(routineId, run.id, 'failed', 'Interrupted by a restart', true, 'restart', run.chatId)
      }
    }
  }

  /** The chat is paused, and the pause landed in this message's turn, the last one. */
  private async landedPaused(chat: ChatMeta, messageId: string): Promise<boolean> {
    if (chat.pause !== 'paused') return false
    const turn = turnOf(await this.d.chats.loadItems(chat.id), messageId)
    return turn !== null && !turn.over && pausedIn(turn.items)
  }

  private async target(routine: Routine): Promise<ChatMeta> {
    const target = routine.target
    const loadable = async (names: string[]): Promise<AgentSummary[]> => {
      const agents = await this.d.agents()
      for (const name of names) {
        const agent = agents.find((row) => row.name === name && row.error === null)
        if (!agent) throw new Error(`Agent "${name}" not found`)
      }
      return agents
    }
    if (target.kind === 'chat') {
      const chat = await this.d.chats.get(target.chatId)
      if (!chat) throw new Error('Chat not found')
      // An asked chat belongs to the agent that asked, so a routine saved before the rule must not write into it.
      if (isAsked(chat)) throw new Error('This chat is read-only')
      // A group room runs with the members it has left; a single chat has no one else to answer.
      if (!isGroup(chat)) await loadable([chat.agentName])
      return chat
    }

    if (target.kind === 'new-group') refuseZumiBot(target.members) // a routine saved before the rule, or edited by hand
    const agents = await loadable(target.kind === 'new-chat' ? [target.agent] : target.members)
    // Read at run time, so it covers the editor's and Zumi Bot's saves and a member switched to Codex after the save.
    if (target.kind === 'new-group') refuseCodexMembers(target.members, agents, this.d.caps)

    const chat =
      target.kind === 'new-chat'
        ? await this.d.chats.create(target.agent, this.d.builtInCwd(target.agent) ?? target.cwd)
        : await this.d.chats.createGroup(target.members, target.cwd, target.role)
    const title = target.title ?? defaultRunTitle(routine.name, routine.timeZone, this.d.now())
    const named = await this.d.chats.update(chat.id, { title })
    if (target.kind === 'new-group' && target.section && this.d.placeRoom) {
      // Only where it shows: a failed sidebar write must not fail the run, which goes on in the room either way.
      try {
        await this.d.placeRoom(named.id, target.section)
      } catch (err) {
        console.error('placing a routine room failed:', err instanceof Error ? err.message : err)
      }
    }
    return named
  }

  private addActive(chatId: string, runId: string, run: ActiveRun): void {
    const runs = this.active.get(chatId) ?? new Map<string, ActiveRun>()
    runs.set(runId, run)
    this.active.set(chatId, runs)
  }

  private releaseStarting(routineId: string): void {
    const count = (this.starting.get(routineId) ?? 1) - 1
    if (count > 0) this.starting.set(routineId, count)
    else this.starting.delete(routineId)
  }

  private removeActive(chatId: string | null, runId: string): void {
    if (!chatId) return
    const runs = this.active.get(chatId)
    runs?.get(runId)?.timer?.clear()
    runs?.delete(runId)
    if (runs?.size === 0) this.active.delete(chatId)
  }

  private async finish(run: RoutineRun, status: 'done' | 'failed', error?: string, cause?: RoutineFailure['cause']): Promise<void> {
    const updated = await this.d.store.updateRun(run.routineId, run.id, {
      status,
      ...(error !== undefined ? { error } : {}),
      endedAt: this.d.now()
    })
    if (updated) {
      run.status = status
      run.endedAt = updated.endedAt
      if (error !== undefined) run.error = error
      this.d.changed()
      if (status === 'failed' && cause) this.failed(run.routineId, run.chatId, cause)
    }
    this.removeActive(run.chatId, run.id)
  }

  /**
   * Ends the run from its own turn's items: a usage limit by the routine's policy, else the first error, else a stop or
   * a shutdown, else done. A turn the user paused (with no error but a limit) is not over: the run waits for Resume.
   */
  private async settle(chatId: string, runId: string, turn: ChatItem[]): Promise<void> {
    const errors = turn.filter((item): item is Extract<ChatItem, { type: 'error' }> => item.type === 'error')
    const limits = errors.flatMap((item) => (item.limit ? [item.limit] : []))
    // A paused chat sends nothing by itself, so a limit that ended a pausing turn is waited out by Resume, not the reset.
    if (limits.length === errors.length && pausedIn(turn)) return this.pauseRun(chatId, runId)
    // Only when the limit is all that went wrong: waiting out another error would only hit it again.
    if (errors.length > 0 && limits.length === errors.length && (await this.limitHit(chatId, runId, limits))) return
    const error = errors[0]
    if (error) await this.finishById(chatId, runId, 'failed', error.text, 'turn')
    else if (turn.some((item) => item.type === 'notice' && item.kind === 'stopped')) {
      await this.finishById(chatId, runId, 'failed', 'Stopped', 'user')
    } else if (turn.some((item) => item.type === 'notice' && item.kind === 'interrupted')) {
      // Same text as recover(): stopAll interrupts a turn only when the server goes down.
      await this.finishById(chatId, runId, 'failed', 'Interrupted by a restart', 'restart')
    } else await this.finishById(chatId, runId, 'done')
  }

  /** Silent: the user paused the run on purpose, and it is not over. Resume (chatResumed) carries it on. */
  private async pauseRun(chatId: string, runId: string): Promise<void> {
    const active = this.active.get(chatId)?.get(runId)
    if (!active) return
    if (!(await this.d.store.updateRun(active.routineId, runId, { status: 'paused' }))) {
      this.removeActive(chatId, runId) // the routine was deleted
      return
    }
    active.paused = true
    this.d.changed()
  }

  /** Skips the run, or makes it wait for the reset. False: it ends failed like any error (reset unknown, too many waits). */
  private async limitHit(chatId: string, runId: string, limits: LimitHit[]): Promise<boolean> {
    const active = this.active.get(chatId)?.get(runId)
    if (!active) return true
    if (limitPolicyOf(await this.d.store.get(active.routineId)) === 'skip') {
      await this.skipById(chatId, runId, 'limit')
      return true
    }
    const resets = limits.map((l) => l.resetsAt)
    const waits = (active.waits ?? 0) + 1
    if (resets.some((at) => at === null) || waits > ROUTINE_MAX_LIMIT_WAITS) return false
    // A room waits for the last member's reset: continuing earlier would stop that member again.
    const resumeAt = resumeTime(limits, this.d.now())
    if (!(await this.d.store.updateRun(active.routineId, runId, { status: 'limited', resumeAt, waits }))) {
      this.removeActive(chatId, runId) // the routine was deleted
      return true
    }
    active.waits = waits
    this.d.changed()
    this.arm(chatId, runId, active, resumeAt)
    return true
  }

  private arm(chatId: string, runId: string, active: ActiveRun, resumeAt: number): void {
    active.timer?.clear()
    active.resumeAt = resumeAt
    if (this.stopped) return
    const ms = Math.min(MAX_TIMER_MS, Math.max(0, resumeAt - this.d.now()))
    const set =
      this.d.setTimer ??
      ((fn: () => void, delay: number) => {
        const t = setTimeout(fn, delay)
        t.unref()
        return { clear: () => clearTimeout(t) }
      })
    active.timer = set(() => {
      active.timer = null
      if (this.stopped) return
      if (ms === MAX_TIMER_MS)
        this.arm(chatId, runId, active, resumeAt) // longer than one timer can hold
      else void this.serialize(chatId, () => this.resume(chatId, runId)).catch(logError)
    }, ms)
  }

  /** Sends `continue` into the run's chat (to each member the limit stopped, in a room); the run follows that turn. */
  private async resume(chatId: string, runId: string): Promise<void> {
    const active = this.active.get(chatId)?.get(runId)
    if (!active || active.resumeAt === undefined || this.stopped) return
    const turn = turnOf(await this.d.chats.loadItems(chatId), active.messageId)
    if (!turn) {
      if (!(await this.finishIfReplaced(chatId, runId, active.messageId)))
        await this.finishById(chatId, runId, 'failed', 'Chat not found', 'start')
      return
    }
    if (turn.over) return this.continuedByHand(chatId, runId)
    // A paused chat sends nothing by itself, and a `continue` here would end its pause: the user's hold wins.
    if ((await this.d.chats.get(chatId))?.pause !== undefined) return this.continuedByHand(chatId, runId)
    const messageId = this.d.newId()
    if (!(await this.d.store.updateRun(active.routineId, runId, { status: 'running', messageId, resumeAt: undefined }))) {
      this.removeActive(chatId, runId)
      return
    }
    active.messageId = messageId
    delete active.resumeAt
    this.d.changed()
    const limits = turn.items.flatMap((item) => (item.type === 'error' && item.limit ? [item.limit] : []))
    void this.d.tasks
      .submit(chatId, continueText(limits), [], undefined, messageId, undefined, undefined, 'routine')
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        void this.serialize(chatId, () => this.finishById(chatId, runId, 'failed', message, 'start')).catch(logError)
      })
  }

  // Silent like a stop: the user took the chat over, so nothing is left for the routine to report.
  private continuedByHand(chatId: string, runId: string): Promise<void> {
    return this.finishById(chatId, runId, 'failed', 'Continued by hand', 'user')
  }

  private async skipById(chatId: string, runId: string, skipReason: SkipReason): Promise<void> {
    const active = this.active.get(chatId)?.get(runId)
    if (!active) return
    if (await this.d.store.updateRun(active.routineId, runId, { status: 'skipped', skipReason, endedAt: this.d.now() })) this.d.changed()
    this.removeActive(chatId, runId)
  }

  /**
   * An edit or resend moves the run's message into the hidden versions, so its turn never shows again: the run would
   * stay unfinished (and count toward the cap). The hidden items only settle the status, never feed a prompt.
   */
  private async finishIfReplaced(chatId: string, runId: string, messageId: string): Promise<boolean> {
    const hidden = hiddenItems(await this.d.chats.loadVersions(chatId))
    if (!hidden.some((item) => item.type === 'user' && item.id === messageId)) return false
    await this.finishById(chatId, runId, 'failed', 'Replaced by an edit or resend', 'user')
    return true
  }

  private async finishById(
    chatId: string,
    runId: string,
    status: 'done' | 'failed',
    error?: string,
    cause?: RoutineFailure['cause']
  ): Promise<void> {
    const active = this.active.get(chatId)?.get(runId)
    if (!active) return
    await this.changeStatus(active.routineId, runId, status, error, true, cause, chatId)
    this.removeActive(chatId, runId)
  }

  private async changeStatus(
    routineId: string,
    runId: string,
    status: RoutineRun['status'],
    error?: string,
    ended = false,
    cause?: RoutineFailure['cause'],
    chatId: string | null = null
  ): Promise<void> {
    const patch: Partial<RoutineRun> = { status }
    if (error !== undefined) patch.error = error
    if (ended) patch.endedAt = this.d.now()
    const updated = await this.d.store.updateRun(routineId, runId, patch)
    if (updated) {
      this.d.changed()
      if (status === 'failed' && cause) this.failed(routineId, chatId, cause)
    }
  }

  // Fire and forget: a notification problem must never change how a run ends.
  private failed(routineId: string, chatId: string | null, cause: RoutineFailure['cause']): void {
    try {
      this.d.onFailed?.({ routineId, chatId, cause })
    } catch (error) {
      logError(error)
    }
  }

  private serialize(chatId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.eventQueues.get(chatId) ?? Promise.resolve()
    const next = previous.then(operation, operation)
    this.eventQueues.set(
      chatId,
      next.catch(() => undefined)
    )
    return next
  }
}

/**
 * A run's own turn: the items after its message up to the next user message. Only real sends add user items, and a
 * chat (a group room too) takes one send per run, so the next one starts a new turn and this one is over.
 */
function turnOf(items: ChatItem[], messageId: string): { items: ChatItem[]; over: boolean } | null {
  const index = items.findIndex((item) => item.id === messageId && item.type === 'user')
  if (index < 0) return null
  const next = items.findIndex((item, at) => at > index && item.type === 'user')
  return { items: items.slice(index + 1, next < 0 ? undefined : next), over: next >= 0 }
}

/** The user's pause landed in these items. */
function pausedIn(items: ChatItem[]): boolean {
  return items.some((item) => item.type === 'notice' && item.kind === 'userPaused')
}

function logError(error: unknown): void {
  console.error(error instanceof Error ? error.message : String(error))
}
