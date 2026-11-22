import { isAsked } from '@zumibot/shared/agentAsk'
import { displayName } from '@zumibot/shared/agentName'
import type { Routine, RoutineRun } from '@zumibot/shared/routines'
import {
  capNoticeBody,
  capUsd,
  dayOf,
  effectiveLimit,
  raisedLimit,
  reached,
  type AgentCapStatus,
  type CapHold,
  type CapPause
} from '@zumibot/shared/spendCaps'
import { isGroup, type AgentSummary, type ChatMeta } from '@zumibot/shared/types'
import { runMessages, type Workflow, type WorkflowRun } from '@zumibot/shared/workflows'
import type { LiveSpend } from '../chat/chatService'
import type { AgentOver, CapContext } from '../workflows/workflowRunner'
import type { CapStore } from './capStore'

/** A cap was reached: one notification, under the devices' "needs you" toggle. */
export interface CapNotice {
  title: string
  body: string
  chatId: string | null
  run?: { workflowId: string; runId: string }
  tag: string
}

export interface SpendCapsDeps {
  store: CapStore
  chats: { get(id: string): Promise<ChatMeta | null>; list(): Promise<readonly ChatMeta[]> }
  isRunning(chatId: string): boolean
  // TaskQueue's Pause with the cap as its cause, and its Resume (for the chats a workflow's Continue carries on).
  pause(chatId: string, cap: CapPause): Promise<void>
  resume(chatId: string): Promise<void>
  agents(): Promise<AgentSummary[]>
  // What an agent's exact records and log estimates add up to since `from` (UsageService.agentSpend); the log estimates of
  // `skipChats` are left out, since their running turns are counted live.
  agentSpend(agent: string, from: number, skipChats: ReadonlySet<string>): number
  // The day's zone: the page's (AppSettings.timeZone), else the server's.
  timeZone(): Promise<string>
  workflows: {
    get(id: string): Promise<Workflow | null>
    getRun(runId: string): Promise<WorkflowRun | null>
    checkCap(runId: string): Promise<void>
    continueCap(runId: string): Promise<WorkflowRun>
    // The runs whose steps follow a message in the chat now: a Chat step's chat has no workflow link of its own.
    runsIn(chatId: string): { workflowId: string; runId: string; messageId: string }[]
  }
  routines: {
    get(id: string): Promise<Routine | null>
    getRun(routineId: string, runId: string): Promise<RoutineRun | null>
    // The runs open in a chat, each with the message whose turn it follows now.
    runsIn(chatId: string): { routineId: string; runId: string; messageId: string }[]
    capMark(routineId: string, runId: string, mark: { capped: true } | { limit: number }): Promise<void>
  }
  notify(n: CapNotice): void
  // Settings › Usage's list changed (an agent tripped or was allowed more).
  changed(): void
  now(): number
}

// A running attempt's estimate: what its requests cost so far, and the message its turn answers.
interface Live {
  chatId: string
  agent: string
  usd: number
  message: string | null
}
type RunRef = { workflowId: string; runId: string }

export const NO_DAILY_CAP = 'This agent has no daily spend cap'

// Only the code: an fs error names the data folder.
const logCode = (what: string, e: unknown): void => {
  const code = (e as { code?: unknown } | null)?.code
  console.error(what, typeof code === 'string' ? code : e instanceof Error ? e.message : 'error')
}

const unfinished = (r: Pick<WorkflowRun, 'status'>): boolean => r.status === 'running' || r.status === 'waiting'

/**
 * Spend caps (see the spend caps design spec): prices each running turn as it streams, and pauses what a cap covers once
 * what it spent reaches the cap. A workflow run's own cap is judged by its runner (CapContext), which holds the run; the
 * rest is judged here. Nothing here throws back into a turn.
 */
export class SpendCaps {
  private readonly live = new Map<string, Live>()
  // The checks waiting to run, by attempt, with what they check: kept when the attempt's estimate is dropped meanwhile.
  private readonly pending = new Map<string, Omit<Live, 'usd'>>()
  private readonly runOfChat = new Map<string, RunRef | null>() // a chat's workflow link never changes
  private readonly resumeOnLand = new Set<string>() // chats a Continue found still pausing: resumed once their pause lands
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly d: SpendCapsDeps) {}

  /** A request's price growth (ChatService). Checked in order, one attempt's checks coalesced while one waits. */
  liveSpend(e: LiveSpend): void {
    if (!(e.usd > 0)) return
    const entry = this.live.get(e.attempt)
    if (entry) entry.usd += e.usd
    else this.live.set(e.attempt, { chatId: e.chatId, agent: e.agent, usd: e.usd, message: e.message })
    if (this.pending.has(e.attempt)) return
    const what = { chatId: e.chatId, agent: e.agent, message: e.message }
    this.pending.set(e.attempt, what)
    this.enqueue(async () => {
      this.pending.delete(e.attempt)
      await this.check(what)
    })
  }

  /** The attempt's estimate goes: its exact cost (when it had one) is reported, and settled() checks again once it is stored. */
  ended(attempt: string): void {
    this.live.delete(attempt)
  }

  /**
   * A turn's exact cost is stored (Usage and the runs): its agent's day is judged again, since the request that crossed the cap
   * may have been its last, whose check ran without the estimate it had just dropped.
   */
  settled(chatId: string, agent: string): void {
    this.enqueue(() => this.checkAgent(agent, chatId, null))
  }

  /** Resolves once the checks queued so far are done (tests). */
  idle(): Promise<void> {
    return this.queue
  }

  private enqueue(op: () => Promise<void>): void {
    this.queue = this.queue.then(op).catch((err) => logCode('spend cap check failed:', err))
  }

  private liveWhere(pred: (l: Live) => boolean): number {
    let usd = 0
    for (const l of this.live.values()) if (pred(l)) usd += l.usd
    return usd
  }

  private async runOf(chatId: string): Promise<RunRef | null> {
    if (!this.runOfChat.has(chatId)) {
      const meta = await this.d.chats.get(chatId)
      this.runOfChat.set(chatId, meta?.workflow ? { workflowId: meta.workflow.workflowId, runId: meta.workflow.runId } : null)
    }
    return this.runOfChat.get(chatId) ?? null
  }

  // The runs a turn answering `message` in this chat belongs to: its linked workflow chat's run, and any run whose Chat
  // step follows that message (the user's own turn in such a chat follows none).
  private async refsFor(chatId: string, message: string | null): Promise<RunRef[]> {
    const refs: RunRef[] = []
    const linked = await this.runOf(chatId)
    if (linked) refs.push(linked)
    if (message !== null) {
      for (const r of this.d.workflows.runsIn(chatId)) {
        if (r.messageId === message && !refs.some((x) => x.runId === r.runId)) refs.push({ workflowId: r.workflowId, runId: r.runId })
      }
    }
    return refs
  }

  private async check(w: Omit<Live, 'usd'>): Promise<void> {
    let automated = false
    for (const ref of await this.refsFor(w.chatId, w.message)) {
      if ((await this.d.workflows.get(ref.workflowId))?.spendCap !== undefined) await this.d.workflows.checkCap(ref.runId)
      const run = await this.d.workflows.getRun(ref.runId)
      if (run && w.message !== null && runMessages(run).has(w.message)) {
        automated = true
        // A turn of a run a cap already holds (a usage limit's continue, a step sent as the hold began) pauses as it starts.
        if (unfinished(run) && run.capHold) await this.pauseHeldTurn(w.chatId, w.agent, run, run.capHold)
      }
    }
    for (const r of this.d.routines.runsIn(w.chatId)) {
      if (w.message === null || r.messageId !== w.message) continue // the user's own turn in the routine's chat is not the run's
      automated = true
      await this.checkRoutine(r.routineId, r.runId, w.chatId, r.messageId)
    }
    await this.checkAgent(w.agent, w.chatId, automated ? w.message : null)
  }

  // ---- Workflow runs: the runner holds the run; this pauses its chats and tells the user.

  /** What the runner reads before each write of a run: its estimates by the message each turn answers. */
  async context(workflowId: string, runId: string): Promise<CapContext> {
    const w = await this.d.workflows.get(workflowId)
    const liveBy = new Map<string, number>()
    for (const l of this.live.values()) {
      if (l.message === null || !(await this.refsFor(l.chatId, l.message)).some((r) => r.runId === runId)) continue
      liveBy.set(l.message, (liveBy.get(l.message) ?? 0) + l.usd)
    }
    return { cap: w?.spendCap ?? null, liveBy, agents: await this.agentsOver() }
  }

  private holdPause(run: WorkflowRun, hold: CapHold, name: string): CapPause {
    return hold.kind === 'agent' && hold.agent
      ? {
          scope: { kind: 'agent', agent: hold.agent, day: '' },
          label: hold.agent,
          spentUsd: hold.spentUsd,
          limitUsd: hold.limitUsd,
          capUsd: hold.capUsd
        }
      : {
          scope: { kind: 'workflow', workflowId: run.workflowId, runId: run.id },
          label: name,
          spentUsd: hold.spentUsd,
          limitUsd: hold.limitUsd,
          capUsd: hold.capUsd
        }
  }

  /** A cap began holding a run (WorkflowRunner, after its write): its chats pause on the run's own cap, and the user hears. */
  held(run: WorkflowRun, name: string): void {
    const hold = run.capHold
    if (!hold) return
    this.enqueue(async () => {
      const ref = { workflowId: run.workflowId, runId: run.id }
      if (hold.kind === 'agent') {
        const who = `@${displayName(hold.agent ?? '')}`
        this.d.notify({
          title: name,
          body: `Waiting: ${who} reached its daily spend cap (${capUsd(hold.spentUsd)} of ${capUsd(hold.limitUsd)}).`,
          chatId: null,
          run: ref,
          tag: `cap:workflow:${run.id}`
        })
        return
      }
      const cap = this.holdPause(run, hold, name)
      for (const chat of await this.d.chats.list()) {
        // A Chat step's chat is the user's: paused only while a turn answering this run's message runs in it.
        if (chat.workflow?.runId === run.id || this.runsTurnOf(chat.id, run.id)) await this.pauseChat(chat, cap)
      }
      this.d.notify({ title: name, body: capNoticeBody(cap), chatId: null, run: ref, tag: `cap:workflow:${run.id}` })
    })
  }

  // Whether a running turn in the chat answers a message a step of the run follows there (the user's own turn does not).
  private runsTurnOf(chatId: string, runId: string): boolean {
    const mine = new Set(
      this.d.workflows
        .runsIn(chatId)
        .filter((r) => r.runId === runId)
        .map((r) => r.messageId)
    )
    return [...this.live.values()].some((l) => l.chatId === chatId && l.message !== null && mine.has(l.message))
  }

  private async pauseHeldTurn(chatId: string, agent: string, run: WorkflowRun, hold: CapHold): Promise<void> {
    if (hold.kind === 'agent' && hold.agent !== agent) return // another agent's day: this turn may go on
    const chat = await this.d.chats.get(chatId)
    // A Chat step's chat has no workflow link, so the name comes from the workflow itself.
    if (chat)
      await this.pauseChat(
        chat,
        this.holdPause(run, hold, chat.workflow?.name ?? (await this.d.workflows.get(run.workflowId))?.name ?? run.workflowId)
      )
  }

  /**
   * Continue on a capped run (the run view, or Resume in one of its chats): one more cap's worth, then the chats this hold
   * paused go on, and those still wrapping up go on as their pause lands. `except`: the chat whose Resume asked it.
   */
  async continueWorkflow(runId: string, except?: string): Promise<void> {
    const hold = (await this.d.workflows.getRun(runId))?.capHold
    await this.d.workflows.continueCap(runId)
    // Only what this hold paused: a chat another cap paused (an agent's day) stays for its own Resume.
    const ours = (c: CapPause): boolean =>
      (c.scope.kind === 'workflow' && c.scope.runId === runId) ||
      (hold?.kind === 'agent' && c.scope.kind === 'agent' && c.scope.agent === hold.agent)
    for (const chat of await this.d.chats.list()) {
      // A Chat step's chat has no workflow link: its slot still follows the paused turn's message.
      const ofRun = chat.workflow?.runId === runId || this.d.workflows.runsIn(chat.id).some((r) => r.runId === runId)
      if (chat.id === except || !ofRun || !chat.pauseCap || !ours(chat.pauseCap)) continue
      if (chat.pause === 'pausing') this.resumeOnLand.add(chat.id)
      // Not awaited: a Resume resolves when its turn ends.
      else if (chat.pause === 'paused') void this.d.resume(chat.id).catch((err) => logCode('resuming a capped chat failed:', err))
    }
  }

  /** A chat's run ended (onIdle): one a Continue found still pausing is resumed now that its pause landed. */
  chatIdle(chatId: string): void {
    if (!this.resumeOnLand.delete(chatId)) return
    this.enqueue(async () => {
      const chat = await this.d.chats.get(chatId)
      if (chat?.pause !== 'paused' || !chat.pauseCap) return
      void this.d.resume(chatId).catch((err) => logCode('resuming a capped chat failed:', err))
    })
  }

  // ---- Routine runs

  private async checkRoutine(routineId: string, runId: string, chatId: string, messageId: string): Promise<void> {
    const r = await this.d.routines.get(routineId)
    const cap = r?.spendCap
    if (!r || cap === undefined) return
    const run = await this.d.routines.getRun(routineId, runId)
    if (!run || run.capped || run.endedAt !== undefined) return
    const spent = (run.costUsd ?? 0) + this.liveWhere((l) => l.chatId === chatId && l.message === messageId)
    const limit = effectiveLimit(cap, run.capLimitUsd)
    if (!reached(spent, limit)) return
    const pause: CapPause = { scope: { kind: 'routine', routineId, runId }, label: r.name, spentUsd: spent, limitUsd: limit, capUsd: cap }
    const chat = await this.d.chats.get(chatId)
    // Marked only once paused: a chat the user already paused, or one that just ended, is judged again at its next turn.
    if (!chat || !(await this.pauseChat(chat, pause))) return
    await this.d.routines.capMark(routineId, runId, { capped: true })
    this.d.notify({ title: r.name, body: capNoticeBody(pause), chatId, tag: `cap:routine:${runId}` })
  }

  // ---- Agents' days

  private async day(): Promise<{ day: string; start: number }> {
    return dayOf(this.d.now(), await this.d.timeZone())
  }

  private statusOf(a: AgentSummary, day: { day: string; start: number }): AgentCapStatus | null {
    const cap = a.dailySpendCap
    if (cap === undefined) return null
    const mine = [...this.live.values()].filter((l) => l.agent === a.name)
    // A running turn's lines already in its log would be estimated too: its chat's log estimates wait for its exact cost.
    const spentUsd = this.d.agentSpend(a.name, day.start, new Set(mine.map((l) => l.chatId))) + mine.reduce((s, l) => s + l.usd, 0)
    const limitUsd = effectiveLimit(cap, this.d.store.day(a.name, day.day)?.limitUsd)
    return { agent: a.name, capUsd: cap, limitUsd, spentUsd, over: reached(spentUsd, limitUsd) }
  }

  /** Every agent with a daily cap, for Settings › Usage. */
  async status(): Promise<AgentCapStatus[]> {
    const day = await this.day()
    return (await this.d.agents()).flatMap((a) => this.statusOf(a, day) ?? []).sort((x, y) => x.agent.localeCompare(y.agent))
  }

  private async agentsOver(): Promise<Map<string, AgentOver>> {
    const out = new Map<string, AgentOver>()
    for (const s of await this.status()) if (s.over) out.set(s.agent, { spentUsd: s.spentUsd, limitUsd: s.limitUsd, capUsd: s.capUsd })
    return out
  }

  /** The first of these agents past its daily cap, or null: an automatic start (a routine run) waits for the user. */
  async gate(agents: readonly string[]): Promise<string | null> {
    const over = await this.agentsOver()
    return agents.find((a) => over.has(a)) ?? null
  }

  /**
   * The agent's day, after a request of a turn in `chatId`. Crossing it pauses every running turn of the agent and tells the
   * user, once a day. `automated`: the message of a routine's or workflow's turn, which also pauses on a day already tripped
   * (a usage limit's continue), while the user's own turns run on.
   */
  private async checkAgent(agent: string, chatId: string, automated: string | null): Promise<void> {
    const a = (await this.d.agents()).find((x) => x.name === agent)
    if (!a) return
    const day = await this.day()
    const s = this.statusOf(a, day)
    if (!s?.over) return
    const pause: CapPause = {
      scope: { kind: 'agent', agent, day: day.day },
      label: agent,
      spentUsd: s.spentUsd,
      limitUsd: s.limitUsd,
      capUsd: s.capUsd
    }
    const stored = this.d.store.day(agent, day.day)
    if (stored?.tripped) {
      if (automated !== null) {
        const chat = await this.d.chats.get(chatId)
        if (chat) await this.pauseChat(chat, pause)
      }
      return
    }
    await this.d.store.set(agent, { day: day.day, ...(stored?.limitUsd !== undefined ? { limitUsd: stored.limitUsd } : {}), tripped: true })
    for (const chat of await this.d.chats.list()) {
      const runs = isGroup(chat) ? chat.group.active.some((t) => t.agent === agent) : chat.agentName === agent
      if (runs) await this.pauseChat(chat, pause)
    }
    this.d.notify({ title: `@${displayName(agent)}`, body: capNoticeBody(pause), chatId, tag: `cap:agent:${agent}` })
    this.d.changed()
  }

  /** Allow more today: one more cap's worth from what the agent spent so far; its turns are no longer held. */
  async allowMore(agent: string): Promise<AgentCapStatus> {
    const a = (await this.d.agents()).find((x) => x.name === agent)
    if (!a || a.dailySpendCap === undefined) throw new Error(NO_DAILY_CAP)
    const day = await this.day()
    const now = this.statusOf(a, day)!
    await this.d.store.set(agent, { day: day.day, limitUsd: raisedLimit(now.spentUsd, a.dailySpendCap) })
    this.d.changed()
    return this.statusOf(a, day)!
  }

  // ---- Going on past a cap (TaskQueue.capOverride: Resume, or the user taking over a capped chat)

  async override(chatId: string, cap: CapPause): Promise<void> {
    const s = cap.scope
    if (s.kind === 'agent') {
      // Its cap removed, or the agent renamed or gone since: nothing left to raise.
      await this.allowMore(s.agent).catch((err) => {
        if (!(err instanceof Error && err.message === NO_DAILY_CAP)) logCode('raising a daily cap failed:', err)
      })
    } else if (s.kind === 'routine') {
      const run = await this.d.routines.getRun(s.routineId, s.runId)
      const turn = this.d.routines.runsIn(chatId).find((r) => r.runId === s.runId)?.messageId
      const spent = (run?.costUsd ?? 0) + this.liveWhere((l) => l.chatId === chatId && l.message === turn)
      await this.d.routines.capMark(s.routineId, s.runId, { limit: raisedLimit(spent, cap.capUsd) })
    } else {
      // Not awaited: this runs under the chat's lock, and the run's queue may be waiting on that chat.
      void this.continueWorkflow(s.runId, chatId).catch(() => {
        /* the hold was already lifted */
      })
    }
  }

  // A cap's Pause on a chat that runs: never an A→B chat (it has no Pause), nor one already pausing or paused. True once asked.
  private async pauseChat(chat: ChatMeta, cap: CapPause): Promise<boolean> {
    if (!this.d.isRunning(chat.id) || chat.pause !== undefined || isAsked(chat)) return false
    return this.d.pause(chat.id, cap).then(
      () => true,
      () => false
    ) // it ended, compacts, or a Pause raced it
  }

  async renameAgent(from: string, to: string): Promise<void> {
    for (const l of this.live.values()) if (l.agent === from) l.agent = to
    await this.d.store.renameAgent(from, to)
  }
}
