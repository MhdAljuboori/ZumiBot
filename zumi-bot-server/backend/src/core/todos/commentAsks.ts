import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'
import type { AgentCommand } from '@zumibot/shared/commands'
import { commentCommands } from '@zumibot/shared/commentCommands'
import { commentAskRefusal, engineCaps, engineOfAgent, type Engine, type EngineCaps } from '@zumibot/shared/engine'
import { findMentions } from '@zumibot/shared/mentions'
import { TODO_COMMENT_ASKS_MAX, TODO_COMMENT_MAX, TODO_FILES, threadAgents, type TodoComment, type TodoItem } from '@zumibot/shared/todos'
import type { AgentSummary, Attachment, ChatMeta, ChatPush, ChatWorktree } from '@zumibot/shared/types'
import type { AttachmentStore } from '../attachments/attachmentStore'
import type { ChatStore } from '../store/chatStore'
import type { TodoService } from './todoService'
import { logged, titleOf } from './taskCards'
import { commentAskMessage } from './taskPrompt'

export interface CommentAsksDeps {
  store: Pick<ChatStore, 'get' | 'list' | 'create' | 'loadItems'>
  todos: Pick<TodoService, 'card' | 'userComment' | 'agentReply'>
  files: Pick<AttachmentStore, 'pathOf' | 'stagePath'>
  /** The message into a chat through the queue, as the user's, under `messageId`, with staged files. Resolves when its turn ends. */
  submit(chatId: string, text: string, messageId: string, stagedIds: string[]): Promise<unknown>
  agents(): Promise<AgentSummary[]>
  /** The agent's valid commands, read fresh: a `/name` in the comment sends its saved prompt, as a chat's send does. */
  commandsOf(agent: string): Promise<AgentCommand[]>
  isFolder(path: string): Promise<boolean>
  /** Where a new chat of `agent` runs for the folder picked, as chats:create places it. */
  place(agent: string, cwd: string): Promise<{ cwd: string; worktree?: ChatWorktree }>
  /** The folder the agent's last new chat used, if any. */
  lastFolder(agent: string): Promise<string | null>
  home: string
  push(p: ChatPush): void
  newId(): string
  /** What each engine can do (default engineCaps): only an agent with `bridges` answers a comment, as only one gets a card. */
  caps?(engine: Engine): EngineCaps
}

const CUT_NOTE = '\n\n…(the rest is in the chat)'

/**
 * `@agent` in a user's comment on a card: the agent answers in its own chat for that card (one per card and agent, kept for
 * later mentions, so it remembers the thread), and its final message is posted under the comment. The comment is stored
 * first; the agents run after, so posting never waits on a chat or a worktree.
 */
export class CommentAsks {
  // One chat per card and agent, even when two comments mention it at once.
  private readonly making = new Map<string, Promise<ChatMeta>>()

  constructor(private readonly d: CommentAsksDeps) {}

  async comment(todoId: string, text: string, replyTo: string | null): Promise<void> {
    const asked = await this.asked(todoId, text, replyTo)
    const { item, comment } = await this.d.todos.userComment(todoId, text, {
      ...(replyTo ? { replyTo } : {}),
      ...(asked.length > 0 ? { asked } : {})
    })
    for (const agent of comment.asked ?? []) void this.ask(item, comment, agent).catch(logged('a mentioned agent did not answer:'))
  }

  /**
   * The loadable agents the text mentions, Zumi Bot aside, in the order written. A reply that mentions none goes on
   * with the agents already in its thread, so answering an agent needs no second @.
   * Only an agent with `bridges` answers: a mention of an ACP or remote agent refuses the comment before it is stored (its chat
   * for the card would lack the to-do tools the message points it at, and a remote agent would take the card off this machine),
   * and a thread agent that has lost the cap since (moved to ACP or a remote server) is left out, never asked.
   */
  private async asked(todoId: string, text: string, replyTo: string | null): Promise<string[]> {
    const loadable = (await this.d.agents()).filter((a) => a.error === null && a.name !== ZUMI_BOT_NAME)
    const names = loadable.map((a) => a.name)
    const engineOf = (name: string): Engine => engineOfAgent(loadable.find((a) => a.name === name))
    const answers = (name: string): boolean => (this.d.caps ?? engineCaps)(engineOf(name)).bridges
    const mentioned = findMentions(text, names)
    if (mentioned.length > 0 || replyTo === null) {
      const asked = mentioned.slice(0, TODO_COMMENT_ASKS_MAX)
      for (const name of asked) if (!answers(name)) throw new Error(commentAskRefusal(engineOf(name), name))
      return asked
    }
    return threadAgents(await this.d.todos.card(todoId), replyTo)
      .filter((a) => names.includes(a) && answers(a))
      .slice(0, TODO_COMMENT_ASKS_MAX)
  }

  private async ask(item: TodoItem, comment: TodoComment, agent: string): Promise<void> {
    const { d } = this
    const chat = await this.chatFor(item, agent)
    const messageId = d.newId()
    // A broken agent file just has no commands; it must not stop the answer.
    const owned = await d.commandsOf(agent).catch(() => [] as AgentCommand[])
    const names = (await d.agents()).map((a) => a.name)
    const staged = await this.stageUnsent(item, chat.id)
    await d.submit(chat.id, commentAskMessage(item, comment, commentCommands(comment.text, owned, names), staged.length), messageId, staged)
    const reply = finalReply(await d.store.loadItems(chat.id), messageId)
    if (reply === null) return // stopped or failed: the comment's link to the chat shows what happened
    await d.todos.agentReply(item.id, agent, comment.id, reply)
  }

  /**
   * Copies of the card's images the chat was not sent yet (matched by name and size, as a copy gets a new id): the card
   * chat lives on across mentions, so each image goes once, and one added to the card later goes with the next mention.
   */
  private async stageUnsent(item: TodoItem, chatId: string): Promise<string[]> {
    const { d } = this
    const sent = new Set((await d.store.loadItems(chatId)).flatMap((i) => (i.type === 'user' ? (i.attachments ?? []).map(fileKey) : [])))
    const staged: string[] = []
    for (const f of item.files ?? []) {
      if (sent.has(fileKey(f))) continue
      const r = await d.files.stagePath(d.files.pathOf(TODO_FILES, f))
      if (r.ok) staged.push(r.attachment.id)
    }
    return staged
  }

  private chatFor(item: TodoItem, agent: string): Promise<ChatMeta> {
    const key = `${item.id}\n${agent}`
    let p = this.making.get(key)
    if (!p) {
      p = this.findOrMake(item, agent).finally(() => this.making.delete(key))
      this.making.set(key, p)
    }
    return p
  }

  private async findOrMake(item: TodoItem, agent: string): Promise<ChatMeta> {
    const { d } = this
    const found = (await d.store.list()).find((c) => c.cardComments?.todoId === item.id && c.agentName === agent)
    if (found) return found
    const place = await d.place(agent, await this.folderFor(item, agent))
    const meta = await d.store.create(agent, place.cwd, {
      title: titleOf(`Comments · ${item.text}`),
      cardComments: { todoId: item.id },
      ...(place.worktree ? { worktree: place.worktree } : {})
    })
    d.push({ chatId: meta.id, kind: 'meta', meta })
    return meta
  }

  /** The card's own folder, else the folder of the chat it was made in, else the agent's last one, else home. */
  private async folderFor(item: TodoItem, agent: string): Promise<string> {
    const { d } = this
    const from = item.from.chatId ? await d.store.get(item.from.chatId) : null
    for (const dir of [item.folder, from?.worktree?.folder ?? from?.cwd, await d.lastFolder(agent)]) {
      if (dir && (await d.isFolder(dir))) return dir
    }
    return d.home
  }
}

const fileKey = (a: Pick<Attachment, 'name' | 'size'>): string => `${a.name}\n${a.size}`

/** The agent's last message of the turn that answered `messageId`, cut to fit a comment; null when it wrote none. */
export function finalReply(items: readonly { type: string; id: string; text?: string }[], messageId: string): string | null {
  const at = items.findIndex((i) => i.id === messageId)
  if (at < 0) return null
  let last: string | null = null
  for (const i of items.slice(at + 1)) {
    if (i.type === 'user') break
    if (i.type === 'assistant' && (i.text ?? '').trim() !== '') last = i.text!.trim()
  }
  if (last === null || last.length <= TODO_COMMENT_MAX) return last
  return `${last.slice(0, TODO_COMMENT_MAX - CUT_NOTE.length).trimEnd()}${CUT_NOTE}`
}
