import type { CardAsk, TodoBoard, TodoStatus } from '@zumibot/shared/todos'
import type { ChatMeta } from '@zumibot/shared/types'
import { todosPath } from './route'
import { COLUMN_LABEL, columnOf } from './todoBoard'

/** What the inline card in a chat shows of the card a comment was written on. */
export interface CardAskView {
  title: string
  /** The column's label while the card is on the board; null when it is not (yet) known. */
  status: string | null
  column: TodoStatus | null
  /** Only when the card is certainly gone: the board is loaded whole and it is not in it. */
  removed: boolean
  path: string
}

// The handles a comment opens with, before its first word.
const LEAD = /^(?:\s*@[a-z0-9-]+)+/i
const HANDLE = /@[a-z0-9-]+/gi

/**
 * The comment as its card chat's bubble shows it: the chat agent's handle is dropped from the handles the comment opens
 * with, since it only said who the comment was for. Display only: the agent still reads the comment as written. A
 * mention inside the text stays (drawn as a chip); a comment that is only the handle stays as written.
 */
export function cardAskText(text: string, agent: string): string {
  const lead = LEAD.exec(text)?.[0]
  if (lead === undefined) return text
  const handles = lead.match(HANDLE) ?? []
  const kept = handles.filter((h) => h.slice(1).toLowerCase() !== agent.toLowerCase())
  if (kept.length === handles.length) return text
  let rest = text.slice(lead.length)
  if (kept.length === 0) {
    // "@agent, do this" and "@agent: do this" read as "do this".
    rest = rest.replace(/^[,:;]?\s*/, '')
    return rest.trimEnd() === '' ? text : rest
  }
  rest = rest.replace(/^[ \t]+/, '')
  return /^[\s,.;:!?]|^$/.test(rest) ? `${kept.join(' ')}${rest}` : `${kept.join(' ')} ${rest}`
}

/**
 * The card's live title and status from the board, else the title the message stored. The board holds only the newest
 * done cards, so a miss is "removed" only when it holds every done card (`doneTotal`): an older done card is not gone.
 */
export function cardAskView(
  ask: CardAsk,
  env: {
    board: TodoBoard | null | undefined
    chats: readonly Pick<ChatMeta, 'id' | 'inFlight'>[]
    approvals: Readonly<Record<string, number>>
  }
): CardAskView {
  const path = todosPath(ask.todoId)
  const { board } = env
  if (!board) return { title: ask.title, status: null, column: null, removed: false, path }
  const live = board.open.find((i) => i.id === ask.todoId) ?? board.done.find((i) => i.id === ask.todoId)
  if (live) {
    const column = columnOf(live, env.chats, env.approvals)
    return { title: live.text, status: COLUMN_LABEL[column], column, removed: false, path }
  }
  return { title: ask.title, status: null, column: null, removed: board.done.length >= board.doneTotal, path }
}
