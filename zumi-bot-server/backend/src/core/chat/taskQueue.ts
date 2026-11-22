import type { SentCommand } from '@zumibot/shared/commands'
import { RESUME_TEXT } from '@zumibot/shared/pause'
import type { CapPause } from '@zumibot/shared/spendCaps'
import {
  isGroup,
  type Attachment,
  type ChatMeta,
  type ChatPush,
  type GroupInfo,
  type QueuedTask,
  type SendResult,
  type WorkflowSent
} from '@zumibot/shared/types'
import type { AttachmentStore } from '../attachments/attachmentStore'
import type { ChatStore } from '../store/chatStore'
import type { ChatService } from './chatService'
import type { GroupService } from './groupService'

export const TASKS_MAX = 50

// A build without the hook could only wait for the reply's own end, which would look like a Pause that does nothing.
export const PAUSE_UNAVAILABLE = 'Pause is unavailable: the pause hook is missing from this build'

/**
 * Who sends a message: the user's own goes into a paused chat and ends the pause; a routine's (and a usage limit wait's
 * own `continue`) waits there for Resume.
 */
// 'process': a background process's wake-up (core/processes/processWakes.ts). Like a routine's, never the user's own message.
export type SendFrom = 'user' | 'routine' | 'process'

export interface TaskQueueDeps {
  store: Pick<ChatStore, 'get' | 'list' | 'loadItems' | 'addTask' | 'takeTask' | 'dropTask' | 'holdTasks' | 'patchInPlace'>
  chats: Pick<
    ChatService,
    'isRunning' | 'send' | 'rerun' | 'stop' | 'whenIdle' | 'switchVersion' | 'compact' | 'canPause' | 'setPauseFlag' | 'finishPause'
  >
  groups: Pick<GroupService, 'send' | 'rerun' | 'compact' | 'requestPause' | 'resume'>
  files: Pick<AttachmentStore, 'commit' | 'removeFiles'>
  push(p: ChatPush): void
  now(): number
  newId(): string
  // A message goes in, or the visible history changes (an edit, a version switch): a usage limit wait ends. Never a
  // compact, which adds no message. Awaited under the lock before the run starts; a failure only logs.
  onNewTurn?(chatId: string): Promise<void>
  // Resume is about to send its Continue under messageId: a routine run the pause stopped follows that turn. Called
  // before the send starts, so the run is moved on before any event of the new turn; a throw only logs.
  onResume?(chatId: string, messageId: string): void
  // A spend cap's pause ended by the user (Resume, or taking over the chat): the cap allows one more cap's worth. Awaited under
  // the lock before the turn starts, so the new turn is measured against the raised limit; a throw only logs.
  capOverride?(chatId: string, cap: CapPause): Promise<void>
  // Resolves once the usage limit wait has looked at the chat's last turn (the check its idle started): a wait it stores
  // holds the queued tasks. The pump awaits it under the lock, before it reads the chat; it never rejects.
  limitChecked?(chatId: string): Promise<void>
}

// The optional tail of a service call: no trailing undefined, so a send without them reaches the services as before.
// A to-do message without a command still passes the command slot (undefined) to reach its place.
type Tail = [command?: SentCommand, todo?: true]
const withTail = (call: (...tail: Tail) => Promise<void>, command?: SentCommand, todo?: true): Promise<void> =>
  todo ? call(command, true) : command ? call(command) : call()
// A room's post takes the workflow Chat step's sender in the slot after the to-do flag, then `auto` (a routine's or workflow's
// message, not typed by the user: the room stays unattended until the user types into it).
const withSent = (
  call: (...tail: [command?: SentCommand, todo?: true, sent?: WorkflowSent, auto?: true]) => Promise<void>,
  command?: SentCommand,
  todo?: true,
  sent?: WorkflowSent,
  auto?: true
): Promise<void> => (auto ? call(command, todo, sent, true) : sent ? call(command, todo, sent) : withTail(call, command, todo))
// A single chat's send takes `auto` in the slot after the to-do flag, and the sender after it.
const withAuto = (
  call: (...tail: [command?: SentCommand, todo?: true, auto?: true, sent?: WorkflowSent]) => Promise<void>,
  command?: SentCommand,
  todo?: true,
  auto?: true,
  sent?: WorkflowSent
): Promise<void> => (sent ? call(command, todo, auto, sent) : auto ? call(command, todo, true) : withTail(call, command, todo))

/** A run started under the lock. Wrapped so the lock's promise does not wait for it. */
interface Started {
  run: Promise<void>
}

// A chat deleted while its tasks wait is not an error.
const chatGone = (e: unknown) => e instanceof Error && e.message.startsWith('Chat not found')

const failed = (e: unknown) => {
  if (!chatGone(e)) console.error('sending a queued message failed:', e)
}

// Only the code: an fs error names the data folder.
const logCode = (what: string, e: unknown) => {
  const code = (e as { code?: unknown } | null)?.code
  console.error(what, typeof code === 'string' ? code : 'error')
}

const unpaused = ({ paused: _gone, ...g }: GroupInfo): GroupInfo => g

/**
 * The user took over a paused chat (a message of their own, Send now, an edit, a version switch): the pause is over, and
 * so are the turns a paused room saved for Resume. Queued tasks stay held, as in any held tray; an empty tray is not left
 * held, or what the user sends during the new reply would wait too. Null (no write) when the chat is not paused.
 */
const takeOverPatch = (cur: ChatMeta): Partial<Omit<ChatMeta, 'id' | 'updatedAt'>> | null =>
  cur.pause === undefined
    ? null
    : {
        pause: undefined,
        pauseCap: undefined,
        held: cur.tasks?.length ? true : undefined,
        ...(cur.group?.paused ? { group: unpaused(cur.group) } : {})
      }

/**
 * Messages sent while a chat runs wait here as tasks (in the chat's meta) and go in one per run, oldest first.
 * Every run of a chat starts through this queue, under its per-chat lock.
 */
/** once: drop a message whose id the chat already holds (a redelivered channel update). committed: called once the message is
 * stored, queued or dropped, before its turn ends (submit itself settles only when a started turn ends). */
export interface SubmitOptions {
  once?: true
  committed?: (r: SendResult | 'duplicate') => void
}

export class TaskQueue {
  private locks = new Map<string, Promise<unknown>>()
  // Chats whose run is started but may not have claimed yet: GroupService.post claims only after a few awaits.
  private dispatching = new Set<string>()
  // The run of each chat's latest launch, so a rerun can wait for a room's post still on its way.
  private launches = new Map<string, Promise<void>>()
  // Chats whose compaction this queue started: Pause refuses them before the service has stored `compacting`.
  private compacts = new Set<string>()
  private down = false

  constructor(private d: TaskQueueDeps) {}

  /**
   * Queues while the chat runs or older tasks wait (a paused group's held tasks don't count), else sends as today.
   * A paused (or pausing) chat starts nothing by itself: a routine's message waits there, held, for Resume, while the
   * user's own goes straight into the idle chat and ends the pause. 'sent' resolves when a single chat's turn ends / a
   * group message is posted.
   */
  async submit(
    chatId: string,
    text: string,
    stagedIds: string[],
    replyTo?: string,
    messageId?: string,
    command?: SentCommand,
    todo?: true,
    from: SendFrom = 'user',
    workflowSent?: WorkflowSent,
    opts?: SubmitOptions
  ): Promise<SendResult | 'duplicate'> {
    const { store, files, push, now, newId } = this.d
    if (text.trim() === '' && stagedIds.length === 0) throw new Error('Message is empty')
    // Late triggers (a webhook, a scheduler tick) must not start a run after stopAll has finished.
    if (this.down) throw new Error('Server is shutting down')
    const out = await this.serial(chatId, async (): Promise<Started | { idle: boolean } | { duplicate: true }> => {
      const meta = await store.get(chatId)
      if (!meta) throw new Error(`Chat not found: ${chatId}`) // before any commit: no orphan attachment folder
      // Under the lock, so a redelivered channel update racing its first delivery is still seen.
      if (opts?.once && messageId !== undefined && (await this.holds(meta, messageId))) return { duplicate: true }
      const paused = meta.pause !== undefined
      // Older tasks go first (a send racing a run's end lands here), except while they are held (an Edit or Resend
      // stopped the reply), wait out a usage limit, in a paused chat, or in a group the hop cap paused: there the new
      // message goes straight in and the tasks stay where they are.
      const waiting =
        !paused &&
        (meta.tasks?.length ?? 0) > 0 &&
        !meta.held &&
        meta.resume === undefined &&
        !(isGroup(meta) && (await this.paused(chatId)))
      const idle = !this.busy(chatId)
      if (this.down) throw new Error('Server is shutting down') // closed while this waited for the lock or the store
      // A new message, sent or queued, ends a usage limit wait.
      await this.newTurn(chatId)
      if (idle && !waiting && (!paused || from === 'user')) {
        const attachments = await files.commit(chatId, stagedIds)
        if (paused) {
          const over = await this.takeOver(chatId)
          if (over) this.pushMeta(over)
        }
        if (opts?.once && messageId !== undefined) this.recent.add(messageId)
        return this.launch(meta, text, attachments, replyTo, messageId, command, todo, from !== 'user' ? true : undefined, workflowSent)
      }
      // Before commit, so a send that is bound to fail moves no files.
      if ((meta.tasks?.length ?? 0) >= TASKS_MAX) throw new Error(`A chat can hold at most ${TASKS_MAX} queued messages`)
      // Committed now: staged files are cleared on server start, so they can't wait in staging.
      const attachments = await files.commit(chatId, stagedIds)
      const task: QueuedTask = {
        id: messageId ?? newId(),
        text,
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(replyTo !== undefined ? { replyTo } : {}),
        ...(command ? { command } : {}),
        ...(todo ? { todo } : {}),
        ...(from !== 'user' ? { auto: true as const } : {}),
        ...(workflowSent ? { workflowSent } : {}),
        ts: now()
      }
      // A paused chat's tray is held in the same write, also after the user emptied it (the last task out clears held).
      push({ chatId, kind: 'meta', meta: await store.addTask(chatId, task, paused) })
      return { idle }
    })
    if ('duplicate' in out) {
      opts?.committed?.('duplicate')
      return 'duplicate'
    }
    if (!('run' in out)) {
      opts?.committed?.('queued')
      // Queued on an idle chat: no run's end will pump it, so pump now. After the lock, since pump takes it too.
      if (out.idle) void this.pump(chatId)
      return 'queued'
    }
    opts?.committed?.('sent')
    // Outside the lock: a single chat's turn lasts until it ends, and sends meanwhile must still queue.
    await out.run
    return 'sent'
  }

  // Ids of once-only messages launched by this process: a turn writes its user item a moment after launch, and a
  // redelivery in that moment must still be seen. Bounded; the items cover anything older.
  private recent = new Set<string>()

  /** The chat already holds this message: stored, queued, or just launched. */
  private async holds(meta: ChatMeta, messageId: string): Promise<boolean> {
    if (this.recent.has(messageId) || meta.tasks?.some((t) => t.id === messageId)) return true
    if (this.recent.size > 1000) this.recent.delete(this.recent.values().next().value as string)
    return (await this.d.store.loadItems(meta.id)).some((i) => i.id === messageId)
  }

  /** Sends one chosen task now (the task's Enter button); the UI offers it only while the chat is idle. */
  async sendTask(chatId: string, taskId: string): Promise<SendResult> {
    const started = await this.serial(chatId, async (): Promise<Started> => {
      if (this.busy(chatId)) throw new Error('Chat is busy')
      const before = await this.d.store.get(chatId)
      if (!before) throw new Error(`Chat not found: ${chatId}`)
      // Send now is the user's own message: it ends a usage limit wait, and in a paused chat the pause, as one they type
      // does. Before the task is taken, so a crash in between loses no task.
      if (before.tasks?.some((t) => t.id === taskId)) {
        await this.newTurn(chatId)
        if (before.pause !== undefined) await this.takeOver(chatId)
      }
      const { task, meta } = await this.d.store.dropTask(chatId, taskId)
      if (!task) throw new Error('Queued message not found')
      // Its files stay: they go with the sent message. Launched before the push, so a failed push can't lose it.
      const started = this.launchTask(meta, task)
      this.pushMeta(meta)
      return started
    })
    await started.run
    return 'sent'
  }

  /**
   * Runs a message again as a new version (Edit's text, or null for Resend). A running reply is stopped first and the
   * queued tasks are held, so neither the stop nor the new version's end starts one. Resolves when a single chat's turn
   * ends / a room's message is posted.
   */
  async rerun(chatId: string, userId: string, text: string | null, command?: SentCommand, todo?: true): Promise<void> {
    const { store, chats, groups } = this.d
    if (this.down) throw new Error('Server is shutting down')
    const started = await this.serial(chatId, async (): Promise<Started> => {
      if (this.down) throw new Error('Server is shutting down')
      const meta = await store.get(chatId)
      if (!meta) throw new Error(`Chat not found: ${chatId}`)
      // Checked before the stop, so a stale id (another tab switched versions) or an empty edit can't cost the user the
      // reply that is running. The services check again once they have the chat.
      const old = (await store.loadItems(chatId)).find((i) => i.type === 'user' && i.id === userId)
      if (old?.type !== 'user') throw new Error('Message not found')
      if ((text ?? old.text).trim() === '' && !old.attachments?.length) throw new Error('Message is empty')
      await this.newTurn(chatId)
      // Only an edit that stops a reply holds the tray; on an idle chat the tasks are left as they are. Held BEFORE the
      // stop is sent, so even a stop that can't finish (or a shutdown) never lets its idle start the oldest task.
      if (this.busy(chatId)) {
        const held = await store.holdTasks(chatId)
        if (held.held && !meta.held) this.pushMeta(held)
        await this.stopAndWait(chatId)
        if (this.down) throw new Error('Server is shutting down') // closed while the stop settled
      }
      // An edit is the user taking over: a pause is over, also one the stop above just landed. Held tasks stay held.
      const over = await this.takeOver(chatId)
      if (over) this.pushMeta(over)
      return this.begin(chatId, () =>
        withTail(
          (...tail) => (isGroup(meta) ? groups.rerun(chatId, userId, text, ...tail) : chats.rerun(chatId, userId, text, ...tail)),
          command,
          todo
        )
      )
    })
    await started.run
  }

  /**
   * Shows another version of a message. Refused while the chat runs. Nothing is woken afterwards, on purpose: the lock
   * keeps every send out until the switch is over, so none queues behind it, and tasks that wait on an idle chat are held
   * or belong to a paused room, which the switch must not start (it holds them, see below).
   */
  switchVersion(chatId: string, userId: string, index: number): Promise<void> {
    return this.serial(chatId, async () => {
      if (this.busy(chatId)) throw new Error('Chat is busy')
      await this.newTurn(chatId)
      await this.d.chats.switchVersion(chatId, userId, index)
      const meta = await this.d.store.get(chatId)
      // The user moved the history the pause stopped in, so it is over, as after an edit (its tasks stay held).
      if (meta?.pause !== undefined) {
        const over = await this.takeOver(chatId)
        if (over) this.pushMeta(over)
        return
      }
      // The switch can move a paused room's `paused` notice into a hidden version, which would leave its tasks neither
      // paused nor held on an idle chat. Held, they wait for the user (a restart's resume() skips them too).
      if (meta?.tasks?.length && !meta.held) this.pushMeta(await this.d.store.holdTasks(chatId))
    })
  }

  /**
   * Pause (chats:pause): the agent's new tool calls are blocked while its running ones (subagents included) finish, the
   * reply wraps up, and nothing starts until Resume or a message of the user's own. ChatService, or the room, lands it
   * when the run ends, however it ends.
   */
  pause(chatId: string, cap?: CapPause): Promise<void> {
    const { store, chats, groups } = this.d
    return this.serial(chatId, async () => {
      if (!(await chats.canPause(chatId))) throw new Error(PAUSE_UNAVAILABLE)
      if (!this.busy(chatId)) throw new Error('Chat is not running')
      const meta = await store.get(chatId)
      if (!meta) throw new Error(`Chat not found: ${chatId}`)
      // A compaction has no pause hook and lands no pause.
      if (this.compacts.has(chatId) || meta.compacting || meta.group?.active.some((a) => a.compacting))
        throw new Error('Chat is compacting')
      if (meta.pause !== undefined) throw new Error('Chat is already paused')
      // Stored before the flag: before a spawn ChatService drops a flag the stored state does not back. Held at once,
      // even with an empty tray, so a restart mid-pause keeps the tray held and what is sent meanwhile waits too.
      // A spend cap's pause keeps why, for the notice it lands with and for the limit Resume raises.
      const set = await store.patchInPlace(chatId, (cur) =>
        cur.pause === undefined ? { pause: 'pausing', held: true, ...(cap ? { pauseCap: cap } : {}) } : null
      )
      if (!set) throw new Error(`Chat not found: ${chatId}`)
      try {
        // A cap's flag holds its word for the hook; the user's own Pause calls it as it always did.
        await (cap ? chats.setPauseFlag(chatId, true, true) : chats.setPauseFlag(chatId, true))
      } catch (e) {
        // The stored state still lands the pause when the reply ends; only the wrap-up isn't hurried.
        logCode('writing the pause flag failed:', e)
      }
      // False needs nothing: a room still opening reads the stored state, and one that settled its end lands it later.
      if (isGroup(meta)) groups.requestPause(chatId)
      // Read again: the run may have ended and pushed `paused` meanwhile, which a stale `pausing` must not cover up.
      const fresh = await store.get(chatId)
      if (fresh) this.pushMeta(fresh)
    })
  }

  /**
   * Resume (chats:resume) of a paused chat: the pause and the held tray end in one write, then Continue goes in (a room's
   * GroupService addresses the members the pause stopped and queues its saved turns again). Resolves when a single chat's
   * turn ends / a room's message is posted, like sendTask; the queued tasks go on after it.
   */
  async resumePaused(chatId: string): Promise<void> {
    const { store, chats, groups } = this.d
    if (this.down) throw new Error('Server is shutting down')
    const started = await this.serial(chatId, async (): Promise<Started> => {
      if (this.down) throw new Error('Server is shutting down')
      if (this.busy(chatId)) throw new Error('Chat is busy')
      const meta = await store.get(chatId)
      if (!meta) throw new Error(`Chat not found: ${chatId}`)
      if (meta.pause !== 'paused') throw new Error('Chat is not paused')
      // Continue is a new message: a usage limit wait stored as the pause landed ends with it.
      await this.newTurn(chatId)
      // A room's saved turns stay: GroupService.resume reads them.
      const cleared = await store.patchInPlace(chatId, (cur) =>
        cur.pause === 'paused' ? { pause: undefined, pauseCap: undefined, held: undefined } : null
      )
      if (!cleared) throw new Error('Chat is not paused')
      this.pushMeta(cleared)
      if (meta.pauseCap) await this.overrideCap(chatId, meta.pauseCap)
      const messageId = this.d.newId()
      try {
        this.d.onResume?.(chatId, messageId)
      } catch (e) {
        console.error('telling the routines about a Resume failed:', e instanceof Error ? e.message : e)
      }
      // Under the lock, right after the write: no pump starts a task first (a room's post of one drops the saved turns).
      return this.begin(chatId, () =>
        isGroup(meta) ? groups.resume(chatId, messageId) : chats.send(chatId, RESUME_TEXT, [], undefined, messageId)
      )
    })
    await started.run
  }

  /**
   * A usage limit wait's continue (at the reset, or the user's Continue now): goes in at once, ahead of the queued tasks,
   * which follow its turn. Only while the wait on `after`'s turn still stands in an idle chat that is not paused: 'gone'
   * when the wait ended meanwhile (a send got the lock first), 'busy' while a compaction runs (its end arms the wait
   * again). Resolves once the run is started, not when it ends.
   */
  async continueLimit(
    chatId: string,
    text: string,
    messageId: string,
    after: string,
    from: SendFrom
  ): Promise<'started' | 'gone' | 'busy'> {
    if (this.down) throw new Error('Server is shutting down')
    const out = await this.serial(chatId, async (): Promise<Started | 'gone' | 'busy'> => {
      if (this.down) throw new Error('Server is shutting down')
      const meta = await this.d.store.get(chatId)
      if (!meta) throw new Error(`Chat not found: ${chatId}`)
      if (meta.resume?.after !== after || meta.pause !== undefined) return 'gone'
      if (this.busy(chatId)) return 'busy'
      // The continue is a new message: the wait ends with it, so its own turn's end lets the tasks go.
      await this.newTurn(chatId)
      return this.launch(meta, text, [], undefined, messageId, undefined, undefined, from !== 'user' ? true : undefined)
    })
    if (typeof out === 'string') return out
    void out.run.catch(failed)
    return 'started'
  }

  /**
   * Compacts a single chat's agent, or one member of a room (`agent`), while the chat is idle. Messages sent meanwhile
   * queue as tasks, and go in once it ends. Resolves when the compaction ends.
   */
  async compact(chatId: string, note: string, agent?: string): Promise<void> {
    if (this.down) throw new Error('Server is shutting down')
    const started = await this.serial(chatId, async (): Promise<Started> => {
      if (this.down) throw new Error('Server is shutting down')
      if (this.busy(chatId)) throw new Error('Chat is busy')
      const meta = await this.d.store.get(chatId)
      if (!meta) throw new Error(`Chat not found: ${chatId}`)
      if (isGroup(meta) && agent === undefined) throw new Error('Pick the member to compact')
      this.compacts.add(chatId)
      return this.begin(chatId, async () => {
        try {
          await (isGroup(meta) ? this.d.groups.compact(chatId, agent!, note) : this.d.chats.compact(chatId, note))
        } finally {
          this.compacts.delete(chatId)
        }
      })
    })
    await started.run
  }

  /** Removes a queued task and its files; one already sent (the × raced its dispatch) is left alone. True when it removed one. */
  async drop(chatId: string, taskId: string): Promise<boolean> {
    const { task, meta } = await this.d.store.dropTask(chatId, taskId)
    if (!task) return false
    this.pushMeta(meta)
    const ids = (task.attachments ?? []).map((a) => a.id)
    // The task is gone either way: leftover files only cost disk, so the drop still succeeds.
    if (ids.length > 0)
      await this.d.files.removeFiles(chatId, ids).catch((e: unknown) => console.error("removing a queued message's files failed:", e))
    return true
  }

  /** Server closing: runs stopped from here on must not start the next task. Tasks stay saved; resume() sends them next start. */
  shutdown(): void {
    this.down = true
  }

  /** Wired to ChatServiceDeps.onIdle. Deferred and never throws: release calls it from a .finally of the user's send. */
  idle(chatId: string): void {
    queueMicrotask(() => void this.pump(chatId))
  }

  /**
   * Startup, after interrupted chats are recovered: sends the oldest task of every chat that holds tasks, except held or
   * paused ones, a paused group's and one waiting out a usage limit (its continue goes first).
   */
  async resume(): Promise<void> {
    const chats = await this.d.store.list()
    await Promise.all(chats.filter((c) => (c.tasks?.length ?? 0) > 0).map((c) => this.pump(c.id)))
  }

  private async newTurn(chatId: string): Promise<void> {
    try {
      await this.d.onNewTurn?.(chatId)
    } catch (e) {
      console.error('ending a usage limit wait failed:', e instanceof Error ? e.message : e)
    }
  }

  private busy(chatId: string): boolean {
    return this.d.chats.isRunning(chatId) || this.dispatching.has(chatId)
  }

  /** Sends the oldest task when the chat is idle. Resolves once the run is started, not when it ends. Never rejects. */
  private async pump(chatId: string): Promise<void> {
    if (this.down) return
    try {
      const started = await this.serial(chatId, async (): Promise<Started | null> => {
        if (this.down) return null // closed while this waited for the lock
        if (this.busy(chatId)) return null // its run's idle, or the dispatch's own pump, comes later
        // The idle that woke this pump also started the usage limit check: a wait it stores must stop the next task.
        await this.d.limitChecked?.(chatId)
        if (this.down || this.busy(chatId)) return null
        const meta = await this.d.store.get(chatId)
        if (!meta) return null
        // A Pause pressed as the reply ended, after the end looked for one: it lands here, on the idle chat.
        if (meta.pause === 'pausing') {
          await this.land(chatId)
          return null
        }
        if (meta.pause) return null // paused: nothing starts by itself, held or not, until Resume or the user's own message
        if (!meta.tasks?.length) return null
        if (meta.held) return null // waits for the user: Send now, or a message of their own; also after a restart
        // A usage limit wait: its continue goes first, at the reset (or on Continue now), and the tasks follow its turn.
        if (meta.resume) return null
        if (isGroup(meta) && (await this.paused(chatId))) return null
        const { task, meta: rest } = await this.d.store.takeTask(chatId)
        if (!task) return null // dropped meanwhile
        // Launched before the push, so a failed push can't lose the task it already took.
        const started = this.launchTask(rest, task)
        this.pushMeta(rest)
        return started
      })
      void started?.run.catch(failed)
    } catch (e) {
      failed(e)
    }
  }

  private async land(chatId: string): Promise<void> {
    try {
      await this.d.chats.finishPause(chatId)
    } catch (e) {
      if (!chatGone(e)) logCode('pause not landed:', e)
    }
  }

  // Ends a paused chat's pause for the user (takeOverPatch). Null, with no write, when it was not paused. A spend cap's pause
  // ended so is the user going on past it, as Resume is.
  private async takeOver(chatId: string): Promise<ChatMeta | null> {
    const cap = (await this.d.store.get(chatId))?.pauseCap
    const over = await this.d.store.patchInPlace(chatId, takeOverPatch)
    if (over && cap) await this.overrideCap(chatId, cap)
    return over
  }

  private async overrideCap(chatId: string, cap: CapPause): Promise<void> {
    try {
      await this.d.capOverride?.(chatId, cap)
    } catch (e) {
      console.error('raising a spend cap failed:', e instanceof Error ? e.message : e)
    }
  }

  // The hop cap paused the room for the user: its tasks wait for a new message or a task's Enter. Stop does not hold them.
  private async paused(chatId: string): Promise<boolean> {
    const items = await this.d.store.loadItems(chatId)
    const last = items[items.length - 1]
    return last?.type === 'notice' && last.kind === 'paused'
  }

  // The services push their own meta only after an await, so this one still reaches the tabs first.
  private pushMeta(meta: ChatMeta): void {
    try {
      this.d.push({ chatId: meta.id, kind: 'meta', meta })
    } catch (e) {
      console.error('pushing the queued messages failed:', e)
    }
  }

  private launchTask(meta: ChatMeta, task: QueuedTask): Started {
    return this.launch(
      meta,
      task.text,
      task.attachments ?? [],
      task.replyTo,
      task.id,
      task.command,
      task.todo,
      task.auto,
      task.workflowSent
    )
  }

  private launch(
    meta: ChatMeta,
    text: string,
    attachments: Attachment[],
    replyTo: string | undefined,
    messageId: string | undefined,
    command?: SentCommand,
    todo?: true,
    auto?: true,
    workflowSent?: WorkflowSent
  ): Started {
    const chatId = meta.id
    return this.begin(chatId, () =>
      isGroup(meta)
        ? withSent(
            (...tail) => this.d.groups.send(chatId, text, attachments, replyTo, messageId, ...tail),
            command,
            todo,
            workflowSent,
            auto
          )
        : withAuto(
            (...tail) => this.d.chats.send(chatId, text, attachments, replyTo, messageId, ...tail),
            command,
            todo,
            auto,
            workflowSent
          )
    )
  }

  /** Starts a run through the chat's service. Call it under the lock, so the flag is set before the next caller looks. */
  private begin(chatId: string, start: () => Promise<void>): Started {
    this.dispatching.add(chatId)
    // Called in this tick: ChatService.send claims at once. A throw becomes a rejection, so the flag is always cleared.
    const sent = (async () => start())()
    // A room can end before its send resolves; its idle found the flag set and left the next task to this pump.
    const run: Promise<void> = sent.finally(() => {
      this.dispatching.delete(chatId)
      if (this.launches.get(chatId) === run) this.launches.delete(chatId)
      void this.pump(chatId)
    })
    this.launches.set(chatId, run)
    return { run }
  }

  // Stops what runs and waits until the chat is free. A room claims only after its post lands, so after the launch in
  // flight settles the stop is sent again. Bounded: a claim nothing can end must not spin the lock forever.
  private async stopAndWait(chatId: string): Promise<void> {
    for (let i = 0; i < 3 && this.busy(chatId); i++) {
      this.d.chats.stop(chatId)
      await this.launches.get(chatId)?.catch(() => {})
      this.d.chats.stop(chatId)
      await this.d.chats.whenIdle(chatId)
    }
    if (this.busy(chatId)) throw new Error('Chat is busy')
  }

  // Busy checks and run starts of one chat go one at a time, so two sends can't both see it idle.
  private serial<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(chatId) ?? Promise.resolve()).then(fn)
    const tail = run.catch(() => {})
    this.locks.set(chatId, tail)
    void tail.then(() => {
      if (this.locks.get(chatId) === tail) this.locks.delete(chatId)
    })
    return run
  }
}
