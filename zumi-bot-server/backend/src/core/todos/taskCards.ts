import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'
import { bridgeRefusal, engineCaps, engineOfAgent, type Engine, type EngineCaps } from '@zumibot/shared/engine'
import { TODO_FILES, TODO_REPLY_MAX, agentAssignee, statusOf, type TodoItem, type TodoStatus } from '@zumibot/shared/todos'
import type { AgentSummary, ChatPush, ChatWorktree } from '@zumibot/shared/types'
import type { AttachmentStore } from '../attachments/attachmentStore'
import type { ChatStore } from '../store/chatStore'
import type { TodoService } from './todoService'
import { answersMessage, continueMessage, taskMessage } from './taskPrompt'

export interface TaskCardsDeps {
  store: Pick<ChatStore, 'get' | 'create'>
  todos: Pick<TodoService, 'card' | 'userAssign' | 'userStatus' | 'userStartTask' | 'userAnswer' | 'userReopen'>
  files: Pick<AttachmentStore, 'pathOf' | 'stagePath'>
  /** The user's message into a chat, through the queue (it waits there while the chat runs). Resolves when its turn ends. */
  submit(chatId: string, text: string, stagedIds: string[]): Promise<unknown>
  /** Whether a chat's turn runs now, and stopping it (as its Stop button does). */
  running(chatId: string): boolean
  stop(chatId: string): void
  agents(): Promise<AgentSummary[]>
  isFolder(path: string): Promise<boolean>
  /** Where a new chat of `agent` runs for the folder picked: a built-in's own folder, or a worktree when the folder isolates. */
  place(agent: string, cwd: string): Promise<{ cwd: string; worktree?: ChatWorktree }>
  /** The next new chat of `agent` starts from the same folder, as chats:create does. */
  rememberFolder(agent: string, cwd: string): Promise<void>
  push(p: ChatPush): void
  now(): number
  /** What each engine can do (default engineCaps): a card goes only to an engine with `bridges` (the to-do tools its task chat relies on). */
  caps?(engine: Engine): EngineCaps
}

const TITLE_MAX = 80
// Code points, so the cut never splits an emoji.
export const titleOf = (text: string): string => [...text].slice(0, TITLE_MAX).join('').trim()

// Only the code: a submit error can carry a path, and the message the user typed never goes to a log.
export const logged =
  (what: string) =>
  (e: unknown): void => {
    const code = (e as { code?: unknown } | null)?.code
    if (e instanceof Error && e.message.startsWith('Chat not found')) return // deleted meanwhile: nothing to send to
    console.error(what, typeof code === 'string' ? code : e instanceof Error ? e.message.slice(0, 120) : 'error')
  }

/**
 * The board's cards and the agents that work on them. Assigning starts nothing; To do does: an assigned agent starts at
 * once, in a new chat whose first message is the card, or goes on in the chat it already has. New and Done stop it.
 * What the user writes on the card (answers, a message) goes to that chat as their message.
 */
export class TaskCards {
  constructor(private readonly d: TaskCardsDeps) {}

  /** Who does the card: the user, an agent (with the folder its chat runs in), or nobody. */
  async assign(todoId: string, assignee: string | null, folder: string | null): Promise<void> {
    const { d } = this
    const before = await d.todos.card(todoId)
    let place = folder
    if (assignee !== null && assignee !== 'user') {
      const agent = (await d.agents()).find((a) => a.name === assignee)
      if (!agent) throw new Error(`No agent named ${assignee}`)
      if (agent.name === ZUMI_BOT_NAME) throw new Error('Zumi Bot cannot take a task card')
      if (agent.error !== null) throw new Error(`${assignee} cannot load: fix its file first`)
      this.needsBridges(agent)
      if (!place) throw new Error('Pick the folder its chat runs in.')
      if (!(await d.isFolder(place))) throw new Error('Folder not found')
      await d.rememberFolder(agent.name, place).catch(logged('remembering the task folder failed:'))
    } else place = null
    const item = await d.todos.userAssign(todoId, assignee, place)
    // The card is no longer the old agent's job: its running turn stops (the chat stays).
    const old = before.task
    if (old && agentAssignee(item) !== old.agent && d.running(old.chatId)) d.stop(old.chatId)
    // Given to an agent while it should be worked on: that agent starts now, as To do would.
    const s = item.done === null ? item.status : 'done'
    if (agentAssignee(item) && (s === 'todo' || s === 'progress')) await this.start(item)
  }

  /** A card moved by hand (a drop, the Move to menu or the card's status). */
  async move(todoId: string, status: TodoStatus): Promise<void> {
    const { d } = this
    const item = await d.todos.card(todoId)
    if (status === 'todo' || status === 'progress') {
      if (!item.assignee) throw new Error('Assign it to you or an agent first.')
      // An agent's card goes to To do and starts; its first turn moves it to In progress.
      if (agentAssignee(item)) {
        await this.start(item)
        return
      }
    }
    await d.todos.userStatus(todoId, status)
    // Back to New, or Done: whatever its agent was doing stops.
    if ((status === 'new' || status === 'done') && item.task && d.running(item.task.chatId)) d.stop(item.task.chatId)
  }

  /** Stores the answers on the card, then sends them to the task's chat as one message. */
  async answer(todoId: string, answers: { id: string; text: string }[]): Promise<void> {
    const chatId = await this.taskChat(todoId)
    const r = await this.d.todos.userAnswer(todoId, answers)
    void this.d.submit(chatId, answersMessage(r.answered), []).catch(logged('sending card answers failed:'))
  }

  /** A message from the card to the task's agent; it ends a review, since the user wants more. */
  async reply(todoId: string, text: string): Promise<void> {
    const body = text.trim()
    if (body === '') throw new Error('Message is empty')
    if (body.length > TODO_REPLY_MAX) throw new Error(`A message from the card is at most ${TODO_REPLY_MAX} characters`)
    const chatId = await this.taskChat(todoId)
    await this.d.todos.userReopen(todoId)
    void this.d.submit(chatId, body, []).catch(logged('sending a card message failed:'))
  }

  /**
   * The assigned agent works on the card: To do now, then a new chat with the card as its first message, or the chat it
   * already has told to go on (nothing is sent while its turn still runs). The turn moves the card on from there.
   */
  private async start(item: TodoItem): Promise<void> {
    const { d } = this
    const agent = agentAssignee(item)!
    // Before anything moves: the agent may have changed engine since it was assigned.
    const known = (await d.agents()).find((a) => a.name === agent)
    if (known) this.needsBridges(known)
    if (item.done !== null) await d.todos.userStatus(item.id, 'new') // out of Done first
    const chat = item.task && item.task.agent === agent ? await d.store.get(item.task.chatId) : null
    if (chat) {
      // A turn still running is the work going on: no message, and the card shows it as In progress.
      const running = d.running(chat.id)
      await d.todos.userStatus(item.id, running ? 'progress' : 'todo')
      if (!running)
        void d.submit(chat.id, continueMessage(item, agent, chat.replyAt ?? item.task!.at), []).catch(logged('resuming a task failed:'))
      return
    }
    if (!item.folder) throw new Error('Pick the folder its chat runs in.')
    // To do now: adding a worktree can take a while on a big repo, and the card must not sit in its old column meanwhile.
    // A card out of Done was already put in New above, so that is where a failure leaves it.
    const was = item.done !== null ? 'new' : statusOf(item)
    await d.todos.userStatus(item.id, 'todo')
    let meta
    try {
      const place = await d.place(agent, item.folder)
      meta = await d.store.create(agent, place.cwd, {
        title: titleOf(item.text),
        task: { todoId: item.id },
        ...(place.worktree ? { worktree: place.worktree } : {})
      })
    } catch (e) {
      await d.todos.userStatus(item.id, was).catch(logged('putting the card back failed:'))
      throw e
    }
    d.push({ chatId: meta.id, kind: 'meta', meta })
    await d.todos.userStartTask(item.id, { agent, chatId: meta.id, at: d.now() })
    // Copies, so the card and the chat each keep their own; a file gone from the card is skipped.
    const staged: string[] = []
    for (const f of item.files ?? []) {
      const r = await d.files.stagePath(d.files.pathOf(TODO_FILES, f))
      if (r.ok) staged.push(r.attachment.id)
    }
    // Not awaited: it resolves when the turn ends. The card follows the chat from here.
    void d.submit(meta.id, taskMessage(item), staged).catch(logged('starting a task failed:'))
  }

  private needsBridges(agent: AgentSummary): void {
    const engine = engineOfAgent(agent)
    if (!(this.d.caps ?? engineCaps)(engine).bridges) throw new Error(bridgeRefusal(engine, agent.name))
  }

  /** The chat the card's agent works in; refused before anything is stored when there is none or it is gone. */
  private async taskChat(todoId: string): Promise<string> {
    const item = await this.d.todos.card(todoId)
    if (!item.task) throw new Error('No agent has worked on this to-do yet.')
    if (!(await this.d.store.get(item.task.chatId))) throw new Error("The task's chat was deleted. Move the card to To do to start again.")
    return item.task.chatId
  }
}
