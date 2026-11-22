import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'
import { engineCaps, engineOfAgent, type Engine, type EngineCaps } from '@zumibot/shared/engine'
import {
  liveComments,
  taskState,
  unanswered,
  type TaskState,
  type TodoComment,
  type TodoItem,
  type TodoQuestion,
  type TodoStatus
} from '@zumibot/shared/todos'
import type { AgentSummary, ChatMeta } from '@zumibot/shared/types'
import { chatStateOf } from './todoBoard'

/** What a card's agent is doing beside its status, from the chat list and the approval counts the app already holds. */
export function cardState(
  item: TodoItem,
  chats: readonly Pick<ChatMeta, 'id' | 'inFlight'>[],
  approvals: Readonly<Record<string, number>>
): TaskState | null {
  return taskState(item, chatStateOf(item, chats, approvals))
}

export const STATE_LABEL: Record<TaskState, string> = {
  working: 'Working…',
  approval: 'Needs approval',
  gone: 'Chat deleted'
}

/** How loud a status is drawn: the user's turn, an agent's, or nothing to do. */
export function statusTone(s: TodoStatus | TaskState): 'you' | 'busy' | 'quiet' {
  return s === 'blocked' || s === 'review' || s === 'approval' ? 'you' : s === 'progress' || s === 'working' ? 'busy' : 'quiet'
}

/** The assignee picker's values beside the agents' names (which never start with an underscore). */
export const ASSIGN_ME = '__me__'
export const ASSIGN_NOBODY = '__nobody__'

/** The picker's value for a card's assignee, and back. */
export const assignValue = (assignee: string | undefined): string =>
  assignee === undefined ? ASSIGN_NOBODY : assignee === 'user' ? ASSIGN_ME : assignee
export const assigneeOf = (value: string): string | null => (value === ASSIGN_NOBODY ? null : value === ASSIGN_ME ? 'user' : value)

/**
 * The agents a card can go to: loadable, never Zumi Bot (it runs automations, not tasks), and only where the engine has
 * `bridges` (a task chat relies on the to-do bridge's `ask_user` and `ready_for_review`), by name.
 */
export function givableAgents(agents: readonly AgentSummary[], caps: (e: Engine) => EngineCaps = engineCaps): AgentSummary[] {
  return agents
    .filter((a) => a.error === null && a.name !== ZUMI_BOT_NAME && caps(engineOfAgent(a)).bridges)
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The folder an agent's chat for the card starts from: a card made in a chat starts where that chat works (a worktree's
 * checkout, not the worktree, which belongs to that chat); one made on the board, or whose chat is gone, has none, so the
 * server's new-chat folder for the agent is asked instead.
 */
export function giveFolder(creatorChat: Pick<ChatMeta, 'cwd' | 'worktree'> | null): string | null {
  if (!creatorChat) return null
  return creatorChat.worktree ? creatorChat.worktree.source : creatorChat.cwd
}

/**
 * The folder an inline assign (the board's or grid's assignee menu) gives an agent without asking: the card's own while
 * its agent stays, else where the creator chat works; null means ask the server for the agent's new-chat folder.
 */
export function quickFolder(
  item: Pick<TodoItem, 'assignee' | 'folder'>,
  agent: string,
  creatorChat: Pick<ChatMeta, 'cwd' | 'worktree'> | null
): string | null {
  if (agent === item.assignee && item.folder) return item.folder
  return giveFolder(creatorChat)
}

/** The answers to send: open questions whose draft is not blank, in the card's order. */
export function answersToSend(
  questions: readonly TodoQuestion[] | undefined,
  drafts: Readonly<Record<string, string>>
): { id: string; text: string }[] {
  return (questions ?? [])
    .filter((q) => q.answer === null && (drafts[q.id] ?? '').trim() !== '')
    .map((q) => ({ id: q.id, text: drafts[q.id]!.trim() }))
}

/** What the row hints at without opening the card: notes, the number of files, open questions. */
export function cardHints(item: TodoItem): { notes: boolean; files: number; questions: number; comments: number } {
  return {
    notes: (item.description ?? '') !== '',
    files: item.files?.length ?? 0,
    questions: unanswered(item).length,
    comments: liveComments(item).length
  }
}

export type CommentAskState = 'starting' | 'working' | 'answered' | 'unanswered'

/**
 * Each agent a comment mentioned, with its chat for the card and where its answer stands: no chat yet (starting), its
 * turn running, a reply from it in the thread since the comment, or none (stopped, failed, still queued).
 */
export function commentAsks(
  item: Pick<TodoItem, 'id' | 'comments'>,
  comment: Pick<TodoComment, 'id' | 'at' | 'asked' | 'replyTo'>,
  chats: readonly Pick<ChatMeta, 'id' | 'agentName' | 'inFlight' | 'cardComments'>[]
): { agent: string; chatId: string | null; state: CommentAskState }[] {
  const thread = comment.replyTo ?? comment.id
  return (comment.asked ?? []).map((agent) => {
    const chat = chats.find((c) => c.cardComments?.todoId === item.id && c.agentName === agent) ?? null
    const answered = liveComments(item).some((c) => c.by === agent && c.replyTo === thread && c.at >= comment.at)
    const state: CommentAskState = chat === null ? 'starting' : chat.inFlight ? 'working' : answered ? 'answered' : 'unanswered'
    return { agent, chatId: chat?.id ?? null, state }
  })
}
