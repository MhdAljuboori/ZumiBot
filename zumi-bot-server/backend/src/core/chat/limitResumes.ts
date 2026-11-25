import { isAsked } from '@zumibot/shared/agentAsk'
import { continueText, lastTurn, limitHit, limitStop, resumeTime, LIMIT_MAX_RESUMES, type LimitResume } from '@zumibot/shared/limitResume'
import { holdsVisibleTask } from '@zumibot/shared/runBlocks'
import type { ChatPush } from '@zumibot/shared/types'
import type { ChatStore } from '../store/chatStore'
import type { TaskQueue } from './taskQueue'

export interface LimitResumesDeps {
  store: Pick<ChatStore, 'get' | 'list' | 'loadItems' | 'patchInPlace' | 'holdTasks'>
  tasks: Pick<TaskQueue, 'continueLimit' | 'idle'>
  isRunning(chatId: string): boolean
  push(p: ChatPush): void
  now(): number
  newId(): string
  // A real timer when absent.
  setTimer?(fn: () => void, ms: number): { clear(): void }
  log?(line: string): void
}

const MAX_TIMER_MS = 2 ** 31 - 1

export const NOT_WAITING = 'This chat is not waiting to continue'

/**
 * A chat or room whose last turn the usage limit stopped continues by itself once the limit resets: the wait is stored
 * on the chat (`resume`, which the UI shows) and sends `continue` at its time, ahead of the queued tasks, which the task
 * queue holds while a wait stands and sends after the continue's turn. Any new message, edit or version switch ends the
 * wait (TaskQueue's onNewTurn); Continue now sends it at once and Don't continue drops it, holding the tasks for the user.
 * Routine runs keep their own limit policy, and an asked chat's limit goes back to the agent that asked.
 */
export class LimitResumes {
  private readonly timers = new Map<string, { at: number; clear(): void }>()
  // The continue each chat last sent by itself: a limit that stops that one again is one more wait in a row.
  private readonly sent = new Map<string, { messageId: string; waits: number }>()
  private readonly queues = new Map<string, Promise<void>>()
  private stopped = false

  constructor(private readonly d: LimitResumesDeps) {}

  /** The chat went idle. `routine`: its routine runs' messages, read before they settle (each run's policy decides those). */
  idle(chatId: string, routine: ReadonlySet<string> = new Set()): void {
    if (this.stopped) return
    void this.serialize(chatId, () => this.check(chatId, routine))
  }

  /**
   * Resolves once every step queued for the chat is done, the check its idle started included: the task queue reads the
   * wait after it, so it never sends a task past a limit this check is about to wait out. Never rejects.
   */
  settled(chatId: string): Promise<void> {
    return this.queues.get(chatId) ?? Promise.resolve()
  }

  /** A new message, an edit or a version switch: the chat waits no more. Never rejects. */
  cancel(chatId: string): Promise<void> {
    return this.serialize(chatId, async () => {
      this.disarm(chatId)
      const meta = await this.d.store.patchInPlace(chatId, (cur) => (cur.resume ? { resume: undefined } : null))
      if (meta) this.d.push({ chatId, kind: 'meta', meta })
    })
  }

  /**
   * The user's Don't continue: the chat waits no more, and its queued tasks, which the wait held, now wait for the user
   * (Send now, or a message of their own) instead of meeting the limit one after another. A Run result's task is never
   * held (the user cannot see it): the queue is woken for it. Never rejects.
   */
  dontContinue(chatId: string): Promise<void> {
    return this.serialize(chatId, async () => {
      this.disarm(chatId)
      const meta = await this.d.store.patchInPlace(chatId, (cur) =>
        cur.resume ? { resume: undefined, ...(holdsVisibleTask(cur.tasks) ? { held: true } : {}) } : null
      )
      if (!meta) return
      this.d.push({ chatId, kind: 'meta', meta })
      // No turn's end will wake the queue for it now.
      if (meta.tasks?.some((t) => t.run !== undefined)) this.d.tasks.idle(chatId)
    })
  }

  /**
   * The user's Continue now: the wait's continue goes in at once, ahead of the queued tasks, which follow its turn.
   * Outside the per-chat steps: the send takes the task queue's lock, whose pump waits on those steps (settled).
   */
  async continueNow(chatId: string): Promise<void> {
    if (this.stopped) throw new Error('Server is shutting down')
    const meta = await this.d.store.get(chatId)
    if (!meta) throw new Error(`Chat not found: ${chatId}`)
    const resume = meta.resume
    if (!resume || meta.pause !== undefined) throw new Error(NOT_WAITING)
    const turn = lastTurn(await this.d.store.loadItems(chatId))
    const limits = turn?.message.id === resume.after ? limitStop(turn.items) : null
    if (!limits) throw new Error(NOT_WAITING)
    // The user's own message: a limit that stops it again starts the count of continues in a row anew.
    const out = await this.d.tasks.continueLimit(chatId, continueText(limits), this.d.newId(), resume.after, 'user')
    if (out === 'busy') throw new Error('Chat is busy')
    if (out === 'gone') throw new Error(NOT_WAITING)
  }

  /** At start: arms every stored wait; one already due continues at once. */
  async recover(): Promise<void> {
    for (const chat of await this.d.store.list()) if (chat.resume) this.arm(chat.id, chat.resume.at)
  }

  /** At shutdown: nothing continues while the chats stop. The waits stay stored, and recover() arms them again. */
  stop(): void {
    this.stopped = true
    for (const id of [...this.timers.keys()]) this.disarm(id)
  }

  private async check(chatId: string, routine: ReadonlySet<string>): Promise<void> {
    if (this.stopped || this.d.isRunning(chatId)) return
    const meta = await this.d.store.get(chatId)
    // An asked chat answers to the agent that asked: the limit already went back to it as the ask's result. A pausing or
    // paused chat starts nothing by itself (a limit that ended a pausing turn still lands it paused); Resume continues it.
    if (!meta || isAsked(meta) || meta.pause !== undefined) return
    if (meta.resume) {
      // Its time came while a compaction ran, which a continue must not interrupt: it goes now the chat is idle.
      if (!this.timers.has(chatId)) this.arm(chatId, meta.resume.at)
      return
    }
    const turn = lastTurn(await this.d.store.loadItems(chatId))
    if (!turn || !limitHit(turn.items)) return
    const limits = routine.has(turn.message.id) ? null : limitStop(turn.items)
    const last = this.sent.get(chatId)
    const waits = last?.messageId === turn.message.id ? last.waits + 1 : 1
    if (limits && waits <= LIMIT_MAX_RESUMES) {
      const resume: LimitResume = { at: resumeTime(limits, this.d.now()), after: turn.message.id, waits }
      // In place: a wait is no news, so the sidebar order stays. A run that started meanwhile ends any wait anyway.
      const saved = await this.d.store.patchInPlace(chatId, (cur) =>
        cur.resume || cur.inFlight || cur.pause !== undefined ? null : { resume }
      )
      if (!saved) return
      this.d.push({ chatId, kind: 'meta', meta: saved })
      this.arm(chatId, resume.at)
      return
    }
    // Nothing continues this turn by itself (a routine run's own policy decides it, the reset is unknown, another error
    // came too, or the continues in a row ran out): its queued tasks wait for the user rather than each meet the limit.
    if (!meta.tasks?.length || meta.held) return
    const held = await this.d.store.holdTasks(chatId)
    if (held.held) this.d.push({ chatId, kind: 'meta', meta: held })
  }

  private async fire(chatId: string, at: number): Promise<void> {
    if (this.stopped) return
    const meta = await this.d.store.get(chatId)
    if (meta?.resume?.at !== at) return // ended or replaced meanwhile
    const resume = meta.resume
    const turn = lastTurn(await this.d.store.loadItems(chatId))
    // A Pause that landed after the wait was stored wins: the send would end it, and Resume continues anyway.
    const limits = turn?.message.id === resume.after && meta.pause === undefined ? limitStop(turn.items) : null
    if (!limits) {
      // The chat moved on without a send (a version switch), or the user paused it: there is nothing to continue.
      const cleared = await this.d.store.patchInPlace(chatId, (cur) => (cur.resume?.at === at ? { resume: undefined } : null))
      if (cleared) {
        this.d.push({ chatId, kind: 'meta', meta: cleared })
        // The wait held the queued tasks, and no turn's end will wake the queue for them now.
        this.d.tasks.idle(chatId)
      }
      return
    }
    const messageId = this.d.newId()
    this.sent.set(chatId, { messageId, waits: resume.waits })
    // Ahead of the queued tasks, and the send ends the wait itself (onNewTurn). Not awaited: it takes the task queue's
    // lock, whose pump waits on this chat's steps (settled). A compaction running now leaves the wait standing, and its
    // end's idle arms it again. 'routine': not the user's own message.
    void this.d.tasks.continueLimit(chatId, continueText(limits), messageId, resume.after, 'routine').catch((err: unknown) => {
      this.log(`continuing after the usage limit failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  private arm(chatId: string, at: number): void {
    this.disarm(chatId)
    if (this.stopped) return
    const ms = Math.min(MAX_TIMER_MS, Math.max(0, at - this.d.now()))
    const set =
      this.d.setTimer ??
      ((fn: () => void, delay: number) => {
        const t = setTimeout(fn, delay)
        t.unref()
        return { clear: () => clearTimeout(t) }
      })
    const timer = set(() => {
      if (this.timers.get(chatId) !== entry) return
      this.timers.delete(chatId)
      if (ms === MAX_TIMER_MS)
        this.arm(chatId, at) // further out than one timer can hold
      else void this.serialize(chatId, () => this.fire(chatId, at))
    }, ms)
    const entry = { at, clear: () => timer.clear() }
    this.timers.set(chatId, entry)
  }

  private disarm(chatId: string): void {
    this.timers.get(chatId)?.clear()
    this.timers.delete(chatId)
  }

  // One step at a time per chat, so a send's cancel always lands after a wait being saved. Never rejects.
  private serialize(chatId: string, op: () => Promise<void>): Promise<void> {
    const next = (this.queues.get(chatId) ?? Promise.resolve()).then(op).catch((err: unknown) => {
      // A chat deleted meanwhile is no failure.
      if (!(err instanceof Error && err.message.startsWith('Chat not found')))
        this.log(`usage limit wait failed: ${err instanceof Error ? err.message : String(err)}`)
    })
    this.queues.set(chatId, next)
    void next.then(() => {
      if (this.queues.get(chatId) === next) this.queues.delete(chatId)
    })
    return next
  }

  private log(line: string): void {
    try {
      ;(this.d.log ?? ((l: string) => console.error(l)))(line)
    } catch {
      /* logging must never fail a wait */
    }
  }
}
