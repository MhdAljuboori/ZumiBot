import { archivePatch, isArchived } from '@zumibot/shared/archive'
import type { CommandPick, SentCommand } from '@zumibot/shared/commands'
import { continueText, resumeTime } from '@zumibot/shared/limitResume'
import { ROUTINE_MAX_LIMIT_WAITS } from '@zumibot/shared/routines'
import { turnOutcome, type TurnOutcome } from '@zumibot/shared/turnReply'
import type { AgentSummary, ChatItem, ChatMeta, ChatPush, WorkflowLink, WorkflowSent } from '@zumibot/shared/types'
import {
  CHAT_NOT_FOUND,
  OUTPUT_MAX,
  type ItemStatus,
  type ModelAlias,
  type Step,
  type Visit,
  type WorkflowRun
} from '@zumibot/shared/workflows'
import { agentProblem, chatStepProblem } from '@zumibot/shared/workflowChat'
import { startFresh } from '../chat/freshStart'
import { hiddenItems } from '../chat/versions'
import type { RoomTarget } from './workflowRooms'
import type { Cause, StepTest, WorkflowRunnerDeps } from './workflowRunner'

export const STOPPED_TEXT = 'Stopped'
export const PAUSED_TEXT = 'Paused by you'
export const RESTART_TEXT = 'Interrupted by a restart'
export const REPLACED_TEXT = 'Replaced by an edit or resend'
export const DROPPED_TEXT = 'Removed from the queue'
export const CHAT_GONE = 'Chat was deleted'
export const BY_HAND = 'Continued by hand'
export const MESSAGE_GONE = 'The step’s message is no longer in its chat'
export const START_FAILED = 'The step could not start its chat'
const TURN_FAILED = 'The agent’s turn failed'
const NO_PROMPT = 'Write a prompt'

type AgentStep = Extract<Step, { kind: 'agent' }>
type AgentDeps = Pick<
  WorkflowRunnerDeps,
  | 'store'
  | 'chats'
  | 'tasks'
  | 'isRunning'
  | 'agents'
  | 'zumiBot'
  | 'builtInCwd'
  | 'pushMeta'
  | 'endProcesses'
  | 'now'
  | 'newId'
  | 'rooms'
  | 'commands'
>

/**
 * What one followed turn lives on (an Agent or Room step's visit, or a For each item): the only fields the Agent steps
 * read and change. `capped`: a room's turn stopped at its hop cap, so the slot waits for the user's own post in the copy.
 * `capPaused`: a spend cap asked the slot's pause, not the user.
 */
export type Slot = Pick<Visit, 'chatId' | 'messageId' | 'until' | 'paused' | 'capPaused' | 'resumes' | 'capped'> & { status: ItemStatus }
export type SlotEnd = { status: 'done'; output: string } | { status: 'failed'; error: string }

/** Where a slot's turn runs. The runner names the chat, so its title and link stay the runner's business. */
export interface AgentTarget {
  slotId: string
  agent: string
  cwd: string
  model?: ModelAlias
  title: string // the new chat's title, made by the runner
  earlierChat?: string // reused when that chat still exists
  link: WorkflowLink
}

/**
 * A Chat step's slot: the chat is the user's own, given by the step, so nothing is made, titled, linked or archived.
 * `sent` marks the posted message as the workflow's (its blocks are material, its @mentions never route).
 */
export interface ChatTarget {
  slotId: string
  chat: string
  session?: 'fresh'
  sent: WorkflowSent
}

/** What the runner lends the Agent steps: its per-run queue and writes, so every change to a run still goes through them. */
export interface AgentHost {
  serialize<T>(runId: string, op: () => Promise<T>): Promise<T>
  slotOf(r: WorkflowRun, slotId: string): Slot | null // the visit or item with that id, open or not
  // Changes one open slot of an unfinished run, in one write; false when it was not open.
  patchSlot(runId: string, slotId: string, fn: (s: Slot) => Slot): Promise<boolean>
  finishSlot(runId: string, slotId: string, end: SlotEnd, cause?: Cause): Promise<boolean>
  addCost(runId: string, slotId: string, usd: number): Promise<void> // to the slot's cost, open or not
  arm(runId: string, slotId: string, at: number, fire: () => Promise<unknown>): void
  waits(runId: string): Map<string, number> | null // usage-limit waits so far, keyed by slot id; null once the run is not live
  limitSkip(runId: string): boolean // the live run's limitPolicy is 'skip'
  // Ends the run skipped at the usage limit, stopping everything as Stop does. Runs inside the run's queue, so never through stopRun.
  skipRun(runId: string): Promise<void>
  stopped(): boolean
}

// The message a slot waits on. A usage-limit continue gives the same slot a new one. `capMoved`: the slot follows a user's
// post made after a room's turn limit, so a later post moves it on again; only the room going quiet ends the visit.
interface Followed {
  runId: string
  messageId: string
  capMoved?: true
}

const unfinished = (r: WorkflowRun): boolean => r.status === 'running' || r.status === 'waiting'
const open = (s: Pick<Slot, 'status'>): boolean => s.status === 'running' || s.status === 'waiting'

export { agentProblem, chatStepProblem }

// Like the routines' settle: Stop is the user's own doing, so it fails silently; a restart is no news either. A pause
// fails only a Run step test, which has no run to hold open.
function endOf(turn: TurnOutcome): { error: string; cause: Cause } {
  switch (turn.kind) {
    case 'paused':
      return { error: PAUSED_TEXT, cause: 'user' }
    case 'stopped':
      return { error: STOPPED_TEXT, cause: 'user' }
    // stopAll interrupts a turn only when the server goes down.
    case 'interrupted':
      return { error: RESTART_TEXT, cause: 'restart' }
    default:
      return { error: turn.error ?? TURN_FAILED, cause: 'step' }
  }
}

// The user's pause landed in the turn (its kind says 'error' when an error came with it).
const pausedIn = (turn: TurnOutcome): boolean => turn.items.some((i) => i.type === 'notice' && i.kind === 'userPaused')

function logError(error: unknown): void {
  console.error(error instanceof Error ? error.message : String(error))
}

/**
 * Agent steps: each slot runs a turn in a normal single chat, sent through the task queue as a routine's is, and follows
 * that turn through the chat's events. The runner names an earlier chat for a loop's next visit and a Retry, so they go
 * on in it and the agent keeps its context.
 */
export class WorkflowAgentSteps {
  private readonly follows = new Map<string, Map<string, Followed>>() // by chat id, then slot id

  constructor(
    private readonly d: AgentDeps,
    private readonly h: AgentHost
  ) {}

  /** The runs that follow a message in this chat now (a Chat step's chat carries no workflow link, so this is how it is found). */
  runsIn(chatId: string): { runId: string; messageId: string }[] {
    return [...(this.follows.get(chatId)?.values() ?? [])].map((f) => ({ runId: f.runId, messageId: f.messageId }))
  }

  /** The messages followed in this chat, read at once: the chat's own limit wait must leave their turns alone. */
  messagesOf(chatId: string): Set<string> {
    return new Set([...(this.follows.get(chatId)?.values() ?? [])].map((f) => f.messageId))
  }

  /**
   * Inside the run's queue, once the slot is written: its chat, then its message. A Room target's chat is a copy of its
   * template room (the room rules' own checks run in the copy, not here), reused for a Retry or a loop's next visit. A Chat
   * target's chat is the user's own: checked now, since it may have changed since the run began.
   * `cmd`: the step's SAVED prompt and pick. Only the saved text can name a command (`forRoutine`), so a filled value never
   * does; it is resolved here, once the chat is known (a room's members are the copy's).
   */
  async start(
    r: WorkflowRun,
    t: AgentTarget | RoomTarget | ChatTarget,
    prompt: string,
    cmd?: { saved: string; pick?: CommandPick }
  ): Promise<void> {
    try {
      let chatId: string
      if ('chat' in t) {
        const chat = await this.d.chats.get(t.chat)
        const problem = chatStepProblem(chat, await this.d.agents(), this.d.zumiBot)
        if (problem || !chat) {
          await this.h.finishSlot(r.id, t.slotId, { status: 'failed', error: problem ?? CHAT_NOT_FOUND })
          return
        }
        // Not in a paused chat: the paused session and its subagent results must survive for Resume to continue.
        if (t.session === 'fresh' && chat.pause === undefined) await startFresh(this.d.chats, chat)
        chatId = chat.id
      } else if ('room' in t) {
        if (t.earlierChat && (await this.d.chats.get(t.earlierChat))) chatId = t.earlierChat
        else {
          const made = await this.d.rooms.copy(t)
          if ('error' in made) {
            await this.h.finishSlot(r.id, t.slotId, { status: 'failed', error: made.error })
            return
          }
          chatId = made.chatId
        }
      } else {
        const problem = agentProblem(t.agent, await this.d.agents(), this.d.zumiBot)
        if (problem) {
          await this.h.finishSlot(r.id, t.slotId, { status: 'failed', error: problem })
          return
        }
        chatId = await this.chatFor(t)
      }
      let command: SentCommand | undefined
      try {
        command = cmd ? await this.d.commands?.forRoutine(chatId, cmd.saved, prompt, cmd.pick) : undefined
      } catch (error) {
        // An ambiguous name (several room members) or the like: the resolver's own sentence, as a routine run's.
        await this.h.finishSlot(r.id, t.slotId, { status: 'failed', error: error instanceof Error ? error.message : String(error) }, 'step')
        return
      }
      const messageId = this.d.newId()
      // Written before the send, so the turn's end always finds the slot it belongs to.
      if (!(await this.h.patchSlot(r.id, t.slotId, (s) => ({ ...s, chatId, messageId })))) return
      this.send(r.id, t.slotId, chatId, messageId, prompt, 'chat' in t ? t.sent : undefined, command)
    } catch (error) {
      logError(error)
      await this.h.finishSlot(r.id, t.slotId, { status: 'failed', error: START_FAILED })
    }
  }

  chatIdle(chatId: string): void {
    this.each(chatId, (slotId, f) => this.check(chatId, slotId, f, null))
  }

  chatPush(push: ChatPush): void {
    if (push.kind !== 'approvals') return
    this.each(push.chatId, (slotId, f) => this.check(push.chatId, slotId, f, push.pending))
  }

  /**
   * A turn's own cost, reported before that turn ends. It counts for the slot whose message the turn answers: a turn of
   * the user's own, run while the step's message waits in the tray or after its turn, is not the step's.
   */
  chatCost(chatId: string, usd: number): void {
    if (!(usd > 0)) return
    this.each(chatId, async (slotId, f) => {
      const s = await this.current(chatId, slotId, f)
      if (!s) return
      const items = await this.d.chats.loadItems(chatId)
      let turn = turnOutcome(items, f.messageId)
      // Past a cap the room's turns answer the user's posts, the latest of which is the step's.
      if (turn?.over && (s.capped || f.capMoved)) {
        const latest = this.latestPost(items, f.messageId)
        if (latest) turn = turnOutcome(items, latest.id)
      }
      if (turn && !turn.over) await this.h.addCost(f.runId, slotId, usd)
    })
  }

  taskDropped(chatId: string, messageId: string): void {
    this.each(chatId, async (slotId, f) => {
      if (f.messageId === messageId) await this.end(chatId, slotId, f, DROPPED_TEXT, 'user')
    })
  }

  chatRemoved(chatId: string): void {
    this.each(chatId, (slotId, f) => this.end(chatId, slotId, f, CHAT_GONE, 'user'))
  }

  /**
   * Resume of a paused chat (TaskQueue, before its Continue goes in under messageId): a slot the pause held follows that
   * turn now, as after a usage limit's `continue`. In the run's queue behind the paused turn's own idle, which marks it.
   */
  chatResumed(chatId: string, messageId: string): void {
    this.each(chatId, async (slotId, f) => {
      const s = await this.current(chatId, slotId, f)
      if (!s?.paused) return
      const moved = await this.h.patchSlot(f.runId, slotId, (x) => {
        const next: Slot = { ...x, messageId, resumes: (x.resumes ?? 0) + 1 }
        delete next.paused
        delete next.capPaused
        return next
      })
      if (moved) this.follow(chatId, slotId, { runId: f.runId, messageId })
    })
  }

  /** At start, inside the run's queue: a message still queued (or running) is followed, a turn that ended is settled. */
  async recover(r: WorkflowRun, slotId: string, slot: Slot): Promise<void> {
    const { chatId, messageId } = slot
    if (!chatId || !messageId) {
      // The server went down before the message was sent.
      await this.h.finishSlot(r.id, slotId, { status: 'failed', error: RESTART_TEXT }, 'restart')
      return
    }
    const chat = await this.d.chats.get(chatId)
    if (!chat) {
      await this.h.finishSlot(r.id, slotId, { status: 'failed', error: CHAT_GONE }, 'user')
      return
    }
    // A room's visit that was moved past a cap before the restart: it has resumed and sits in a room.
    const f: Followed = { runId: r.id, messageId, ...(slot.resumes && chat.group ? { capMoved: true as const } : {}) }
    this.follow(chatId, slotId, f)
    if (slot.paused) return // waits for Resume, or the user's own message, as before the restart
    if (slot.capped) {
      // Waits for the user's post in the copy; one that came while the server was down is followed now.
      const turn = await this.read(chatId, messageId)
      if (turn) {
        if (turn.over) await this.moveOn(chatId, slotId, f, null)
        return
      }
    }
    if (slot.until !== undefined) {
      this.h.arm(r.id, slotId, slot.until, () => this.resume(chatId, slotId, f))
      return
    }
    if (chat.tasks?.some((t) => t.id === messageId)) return this.unwait(r.id, slotId, slot)
    const turn = await this.read(chatId, messageId)
    if (!turn) {
      const replaced = await this.replaced(chatId, messageId)
      return this.fail(chatId, r.id, slotId, replaced ? REPLACED_TEXT : RESTART_TEXT, replaced ? 'user' : 'restart')
    }
    if (!turn.over && turn.running) return this.unwait(r.id, slotId, slot) // the start-up pump already sent it
    if (!turn.over && turn.items.length === 0) return this.fail(chatId, r.id, slotId, RESTART_TEXT, 'restart')
    // It ended (with the restart's own notice, or before the server went down) and was never settled.
    await this.settle(chatId, slotId, f, turn)
  }

  /** The run ended or stopped: none of its slots are followed any more. */
  forgetRun(runId: string): void {
    for (const [chatId, slots] of this.follows) {
      for (const [slotId, f] of slots) if (f.runId === runId) slots.delete(slotId)
      if (slots.size === 0) this.follows.delete(chatId)
    }
  }

  /**
   * The editor's Run step: a real chat titled `<workflow> · <step> · test`, with no workflow link since there is no run.
   * Its input may be a real run's visit (a webhook body, an agent's output), so `workflowTest` gives its turns the same
   * workflow paragraph and material rule a step's chat gets.
   */
  async test(name: string, step: Pick<AgentStep, 'agent' | 'cwd' | 'model' | 'name'>, prompt: string): Promise<StepTest> {
    if (!prompt.trim()) return { error: NO_PROMPT }
    const problem = agentProblem(step.agent, await this.d.agents(), this.d.zumiBot)
    if (problem) return { error: problem }
    const chat = await this.d.chats.create(step.agent, this.d.builtInCwd(step.agent) ?? step.cwd)
    await this.d.chats.update(chat.id, {
      title: `${name} · ${step.name} · test`,
      workflowTest: name,
      ...(step.model ? { model: step.model } : {})
    })
    const messageId = this.d.newId()
    try {
      // A new chat is idle, so this resolves when the whole turn has ended.
      await this.d.tasks.submit(chat.id, prompt, [], undefined, messageId)
    } catch (error) {
      return { chatId: chat.id, error: error instanceof Error ? error.message : String(error) }
    }
    const turn = turnOutcome(await this.d.chats.loadItems(chat.id), messageId)
    if (!turn) return { chatId: chat.id, error: REPLACED_TEXT }
    if (turn.kind === 'ok') return { chatId: chat.id, output: (turn.reply ?? '').slice(0, OUTPUT_MAX) }
    return { chatId: chat.id, error: endOf(turn).error }
  }

  private async chatFor(t: AgentTarget): Promise<string> {
    // A deleted chat is made anew, so a Retry after the delete still has somewhere to run.
    if (t.earlierChat && (await this.d.chats.get(t.earlierChat))) return t.earlierChat
    const chat = await this.d.chats.create(t.agent, this.d.builtInCwd(t.agent) ?? t.cwd)
    // The name is fixed here: the workflow paragraph in the chat's system prompt must never change, for the cache.
    await this.d.chats.update(chat.id, { title: t.title, workflow: t.link, ...(t.model ? { model: t.model } : {}) })
    return chat.id
  }

  private send(
    runId: string,
    slotId: string,
    chatId: string,
    messageId: string,
    text: string,
    sent?: WorkflowSent,
    command?: SentCommand
  ): void {
    this.follow(chatId, slotId, { runId, messageId })
    // submit resolves only after the whole turn, whose end comes through chatIdle: only a refusal is news here.
    // 'routine': a paused chat holds the message for Resume instead of starting the agent.
    void this.d.tasks.submit(chatId, text, [], undefined, messageId, command, undefined, 'routine', sent).catch((error: unknown) => {
      if (this.h.stopped()) return // shutdown: recover() settles the slot
      const reason = error instanceof Error ? error.message : String(error)
      void this.h.serialize(runId, () => this.end(chatId, slotId, { runId, messageId }, reason, 'step')).catch(logError)
    })
  }

  // Every change goes through the slot's run queue, like any change to a run. A copy: settling unfollows as it goes.
  private each(chatId: string, fn: (slotId: string, f: Followed) => Promise<void>): void {
    for (const [slotId, f] of [...(this.follows.get(chatId) ?? [])]) {
      void this.h.serialize(f.runId, () => fn(slotId, f)).catch(logError)
    }
  }

  /** Where the slot's turn stands now. pending: an approvals push's count of cards; null when the chat went idle. */
  private async check(chatId: string, slotId: string, f: Followed, pending: number | null): Promise<void> {
    const s = await this.current(chatId, slotId, f)
    if (!s) return
    const chat = await this.d.chats.get(chatId)
    if (!chat || chat.tasks?.some((t) => t.id === f.messageId)) return // gone (chatRemoved ends it), or still in the tray
    const turn = await this.read(chatId, f.messageId)
    if (!turn) {
      // Not written yet (another turn of the chat ended first) unless an edit or resend moved it away.
      if (await this.replaced(chatId, f.messageId)) await this.fail(chatId, f.runId, slotId, REPLACED_TEXT, 'user')
      return
    }
    // Capped: the room stopped at its turn limit, and only the user's own post goes on. That is no "by hand" failure.
    if (s.capped) {
      if (turn.over) await this.moveOn(chatId, slotId, f, pending)
      return
    }
    // Waiting for the usage limit to lift, or paused: only the user moving on ends it (Resume moves a paused slot on first).
    if (s.until !== undefined || s.paused) {
      if (turn.over) await this.fail(chatId, f.runId, slotId, BY_HAND, 'user')
      return
    }
    // A later post than the one followed (the room answers posts one by one): its turn is the step's now.
    if (f.capMoved && turn.over) return this.moveOn(chatId, slotId, f, pending)
    // The user's next post still waits in the tray: the room is not quiet yet.
    if (f.capMoved && (chat.tasks?.length ?? 0) > 0 && !chat.held) return
    if (pending !== null && !turn.over) {
      // A card waits on the user: the step, and so the run, show waiting until it is answered.
      const status = pending > 0 ? 'waiting' : 'running'
      if (s.status !== status) await this.h.patchSlot(f.runId, slotId, (x) => ({ ...x, status }))
      return
    }
    // A later message means this turn is over, even though the chat already runs the next one.
    if (!turn.over && turn.running) return
    await this.settle(chatId, slotId, f, turn)
  }

  /**
   * The message's turn as stored, and whether the chat ran around that read. Running is read on both sides: release()
   * clears it only after a turn's last save, and send() sets it before the message is saved, so a turn that ends or
   * starts while the items are read is never taken for a finished one with half its items.
   */
  private async read(chatId: string, messageId: string): Promise<(TurnOutcome & { running: boolean }) | null> {
    const before = this.d.isRunning(chatId)
    const turn = turnOutcome(await this.d.chats.loadItems(chatId), messageId)
    return turn && { ...turn, running: before || this.d.isRunning(chatId) }
  }

  private async settle(chatId: string, slotId: string, f: Followed, turn: TurnOutcome): Promise<void> {
    if (turn.kind === 'ok') {
      this.unfollow(chatId, slotId)
      const output = (turn.reply ?? '').slice(0, OUTPUT_MAX)
      if (await this.h.finishSlot(f.runId, slotId, { status: 'done', output })) await this.archive(chatId)
      return
    }
    // A room that hit its turn limit: waiting on the user's own post (maybe already there), which the slot then follows.
    if (turn.kind === 'capped') {
      await this.h.patchSlot(f.runId, slotId, (x) => ({ ...x, status: 'waiting', capped: true }))
      if (turn.over) await this.moveOn(chatId, slotId, f, null)
      return
    }
    // A paused chat sends nothing by itself, so a limit that ended a pausing turn is waited out by Resume, not the reset.
    if (turn.kind === 'paused' || (turn.limit.length > 0 && pausedIn(turn))) {
      // Whose pause it was, for the run view's words: a spend cap's stays on the chat until the pause ends.
      const byCap = (await this.d.chats.get(chatId))?.pauseCap !== undefined
      await this.h.patchSlot(f.runId, slotId, (x) => ({
        ...x,
        status: 'running',
        paused: true,
        ...(byCap ? { capPaused: true as const } : {})
      }))
      return
    }
    if (turn.kind === 'error' && (await this.waitForLimit(chatId, slotId, f, turn))) return
    const { error, cause } = endOf(turn)
    await this.fail(chatId, f.runId, slotId, error, cause)
  }

  /**
   * A capped slot's user posted: the slot follows the latest user message after its own (the room answers the posts
   * one by one, so the last one's turn is the room's last word), as a resumed pause follows its Continue.
   */
  private async moveOn(chatId: string, slotId: string, f: Followed, pending: number | null): Promise<void> {
    const latest = this.latestPost(await this.d.chats.loadItems(chatId), f.messageId)
    if (!latest) return
    const moved = await this.h.patchSlot(f.runId, slotId, (x) => {
      const next: Slot = { ...x, status: 'running', messageId: latest.id, resumes: (x.resumes ?? 0) + 1 }
      delete next.capped
      return next
    })
    if (!moved) return
    const next: Followed = { runId: f.runId, messageId: latest.id, capMoved: true }
    this.follow(chatId, slotId, next)
    // That turn may already be over (or still run), or a card may wait in it: read as for any followed message.
    await this.check(chatId, slotId, next, pending)
  }

  // The last user item after the message: the room's most recent post by the user.
  private latestPost(items: readonly ChatItem[], messageId: string): ChatItem | undefined {
    const at = items.findIndex((i) => i.type === 'user' && i.id === messageId)
    return at < 0
      ? undefined
      : items
          .slice(at + 1)
          .reverse()
          .find((i) => i.type === 'user')
  }

  /** Only when the limit is all that went wrong and every reset is known: waiting out another error would only hit it again. */
  private async waitForLimit(chatId: string, slotId: string, f: Followed, turn: TurnOutcome): Promise<boolean> {
    // Whatever the reset, the setting skips the run: a limit that names none (waiting is not on offer) skips too.
    if (turn.limit.length > 0 && this.h.limitSkip(f.runId)) {
      await this.h.skipRun(f.runId)
      return true
    }
    const waits = this.h.waits(f.runId)
    const n = (waits?.get(slotId) ?? 0) + 1
    if (!waits || turn.limit.length === 0 || turn.limit.some((l) => l.resetsAt === null) || n > ROUTINE_MAX_LIMIT_WAITS) return false
    // Stored, so a restart waits too.
    const until = resumeTime(turn.limit, this.d.now())
    if (!(await this.h.patchSlot(f.runId, slotId, (x) => ({ ...x, until })))) return true
    waits.set(slotId, n)
    this.h.arm(f.runId, slotId, until, () => this.resume(chatId, slotId, f))
    return true
  }

  /** The limit lifted: `continue` goes into the same chat as a new message, which the slot follows from now on. */
  private async resume(chatId: string, slotId: string, f: Followed): Promise<void> {
    const s = await this.current(chatId, slotId, f)
    if (!s || s.until === undefined) return
    const chat = await this.d.chats.get(chatId)
    if (!chat) return this.fail(chatId, f.runId, slotId, CHAT_GONE, 'user')
    const turn = turnOutcome(await this.d.chats.loadItems(chatId), f.messageId)
    if (!turn) {
      const replaced = await this.replaced(chatId, f.messageId)
      return this.fail(chatId, f.runId, slotId, replaced ? REPLACED_TEXT : MESSAGE_GONE, replaced ? 'user' : 'step')
    }
    if (turn.over) return this.fail(chatId, f.runId, slotId, BY_HAND, 'user')
    // A paused chat sends nothing by itself, and a continue would end its pause: the user's hold wins.
    if (chat.pause !== undefined) return this.fail(chatId, f.runId, slotId, PAUSED_TEXT, 'user')
    const messageId = this.d.newId()
    const sent = await this.h.patchSlot(f.runId, slotId, (x) => {
      const next: Slot = { ...x, messageId }
      delete next.until
      return next
    })
    if (sent) this.send(f.runId, slotId, chatId, messageId, continueText(turn.limit))
  }

  /** Fails the slot when it still waits on f's message: a late refusal or event about an older message changes nothing. */
  private async end(chatId: string, slotId: string, f: Followed, error: string, cause: Cause): Promise<void> {
    if (await this.current(chatId, slotId, f)) await this.fail(chatId, f.runId, slotId, error, cause)
  }

  private async fail(chatId: string, runId: string, slotId: string, error: string, cause: Cause): Promise<void> {
    this.unfollow(chatId, slotId)
    await this.h.finishSlot(runId, slotId, { status: 'failed', error }, cause)
  }

  // The slot as stored when it is open and still waits on f's message in this chat. After a shutdown nothing is
  // written: the run stays as stored, and recover() settles it.
  private async current(chatId: string, slotId: string, f: Followed): Promise<Slot | null> {
    if (this.h.stopped()) return null
    const r = await this.d.store.getRun(f.runId)
    const s = r ? this.h.slotOf(r, slotId) : null
    if (r && s && unfinished(r) && open(s) && s.chatId === chatId && s.messageId === f.messageId) return s
    this.unfollow(chatId, slotId, f.messageId) // only this message's: a newer one of the same slot stays followed
    return null
  }

  // Cards die with the server: a slot followed again shows as running until a new card comes.
  private async unwait(runId: string, slotId: string, s: Slot): Promise<void> {
    if (s.status === 'waiting') await this.h.patchSlot(runId, slotId, (x) => ({ ...x, status: 'running' }))
  }

  // Out of the Agents sidebar once done; never after a failure, so a failed step's chat stays in sight. A turn running
  // there (the user's own message) keeps it, and any later send brings it back. Only a chat the workflow made: a Chat
  // step's is the user's, and one marked `keep` stays in sight.
  private async archive(chatId: string): Promise<void> {
    try {
      const meta = await this.d.chats.patchInPlace(chatId, (cur) => {
        if (!cur.workflow || cur.workflow.keep) return null
        const patch = cur.inFlight ? {} : archivePatch(cur, true, this.d.now())
        return Object.keys(patch).length > 0 ? patch : null
      })
      if (meta) this.d.pushMeta(meta)
      // As the sidebar's Archive: an archived chat keeps no process running.
      if (meta && isArchived(meta)) await this.d.endProcesses?.(chatId)
    } catch (error) {
      logError(error)
    }
  }

  // An edit or resend moves the message into the hidden versions, so its turn never shows again.
  private async replaced(chatId: string, messageId: string): Promise<boolean> {
    return hiddenItems(await this.d.chats.loadVersions(chatId)).some((i) => i.type === 'user' && i.id === messageId)
  }

  private follow(chatId: string, slotId: string, f: Followed): void {
    const slots = this.follows.get(chatId) ?? new Map<string, Followed>()
    slots.set(slotId, f)
    this.follows.set(chatId, slots)
  }

  private unfollow(chatId: string, slotId: string, messageId?: string): void {
    const slots = this.follows.get(chatId)
    const f = slots?.get(slotId)
    if (!slots || !f || (messageId !== undefined && f.messageId !== messageId)) return
    slots.delete(slotId)
    if (slots.size === 0) this.follows.delete(chatId)
  }
}
