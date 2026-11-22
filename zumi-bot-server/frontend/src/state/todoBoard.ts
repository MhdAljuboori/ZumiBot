import { displayName } from '@zumibot/shared/frontmatter'
import { TODO_STATUSES, agentAssignee, boardColumn, type TodoBoard, type TodoItem, type TodoStatus } from '@zumibot/shared/todos'
import type { ChatMeta } from '@zumibot/shared/types'
import { isTypingTarget } from './workflowEditor'

export const COLUMN_LABEL: Record<TodoStatus, string> = {
  new: 'New',
  todo: 'To do',
  blocked: 'Blocked',
  progress: 'In progress',
  review: 'In review',
  done: 'Done'
}

/** Who made a card: the user, or an agent (by handle). `all` shows every card. */
export type CreatorFilter = 'all' | 'user' | string
/** Who a card is for: the user, an agent, `none` for nobody; `all` shows every card. */
export type AssigneeFilter = 'all' | 'none' | 'user' | string

/** What both views show: words to find in a card's title or notes, its creator and its assignee. */
export interface BoardFilter {
  text: string
  creator: CreatorFilter
  assignee: AssigneeFilter
}
export const NO_FILTER: BoardFilter = { text: '', creator: 'all', assignee: 'all' }

export const filterActive = (f: BoardFilter): boolean => f.text.trim() !== '' || f.creator !== 'all' || f.assignee !== 'all'

/** How many filters are set: the phone's Filters button shows it while the filters are folded away. */
export const filterCount = (f: BoardFilter): number =>
  [f.text.trim() !== '', f.creator !== 'all', f.assignee !== 'all'].filter(Boolean).length

/** Whether a card passes the filter: every word of the text (any case) in its title or notes, and the creator and assignee. */
export function matchesFilter(i: TodoItem, f: BoardFilter): boolean {
  if (f.creator !== 'all' && i.addedBy !== f.creator) return false
  if (f.assignee === 'none' ? i.assignee !== undefined : f.assignee !== 'all' && i.assignee !== f.assignee) return false
  const words = f.text.toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const hay = `${i.text}\n${i.description ?? ''}`.toLocaleLowerCase()
  return words.every((w) => hay.includes(w))
}

type ChatState = Pick<ChatMeta, 'id' | 'inFlight'>

/** What the app knows of a card's task chat: running, waiting on approval cards, deleted. */
export function chatStateOf(
  item: TodoItem,
  chats: readonly ChatState[],
  approvals: Readonly<Record<string, number>>
): { running: boolean; cards: number; chatGone: boolean } {
  const task = item.task
  const chat = task ? chats.find((c) => c.id === task.chatId) : undefined
  return { running: chat?.inFlight === true, cards: task ? (approvals[task.chatId] ?? 0) : 0, chatGone: task !== undefined && !chat }
}

/** The column a card is in: its status, read with its task chat's state. */
export function columnOf(item: TodoItem, chats: readonly ChatState[], approvals: Readonly<Record<string, number>>): TodoStatus {
  return boardColumn(item, chatStateOf(item, chats, approvals))
}

/**
 * The board's columns, each card once. New and To do read oldest first (what waits longest on top), the working
 * columns by when an agent started, Done newest tick first as the board answer has it.
 */
export function boardColumns(
  board: TodoBoard,
  chats: readonly ChatState[],
  approvals: Readonly<Record<string, number>>,
  filter: BoardFilter = NO_FILTER
): Record<TodoStatus, TodoItem[]> {
  const cols = Object.fromEntries(TODO_STATUSES.map((c) => [c, [] as TodoItem[]])) as Record<TodoStatus, TodoItem[]>
  const keep = (i: TodoItem) => matchesFilter(i, filter)
  for (const item of board.open) if (keep(item)) cols[columnOf(item, chats, approvals)].push(item)
  const byAge = (a: TodoItem, b: TodoItem) => a.from.at - b.from.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const byStart = (a: TodoItem, b: TodoItem) => (a.task?.at ?? a.from.at) - (b.task?.at ?? b.from.at) || byAge(a, b)
  for (const c of ['new', 'todo'] as const) cols[c].sort(byAge)
  for (const c of ['blocked', 'progress', 'review'] as const) cols[c].sort(byStart)
  cols.done = board.done.filter(keep)
  return cols
}

/**
 * What a card dropped on a column does: a move, or, for To do and In progress with nobody assigned, the assignee picker
 * first (the move follows the pick). Nothing on its own column.
 */
export function dropAction(
  item: Pick<TodoItem, 'assignee'>,
  from: TodoStatus,
  to: TodoStatus
): { kind: 'move' | 'assign'; to: TodoStatus } | null {
  if (from === to) return null
  if ((to === 'todo' || to === 'progress') && !item.assignee) return { kind: 'assign', to }
  return { kind: 'move', to }
}

/**
 * The rail's badge: the open cards on the user's side, so every one but those an agent has in To do or In progress;
 * hidden at 0, capped at 99+.
 */
export function boardBadge(
  board: TodoBoard | null,
  chats: readonly ChatState[],
  approvals: Readonly<Record<string, number>>
): string | null {
  if (!board) return null
  const n = board.open.filter((i) => {
    const col = columnOf(i, chats, approvals)
    return !(agentAssignee(i) && (col === 'todo' || col === 'progress'))
  }).length
  return n === 0 ? null : n > 99 ? '99+' : String(n)
}

/** The creators present on the board, for its filter: the user first, then agents by name. */
export function boardCreators(board: TodoBoard | null): string[] {
  if (!board) return []
  const agents = new Set<string>()
  let user = false
  for (const i of [...board.open, ...board.done]) {
    if (i.addedBy === 'user') user = true
    else agents.add(i.addedBy)
  }
  return [...(user ? ['user'] : []), ...[...agents].sort((a, b) => a.localeCompare(b))]
}

/** The assignees on the board, for its filter: the user first, then agents by name (nobody is its own option). */
export function boardAssignees(board: TodoBoard | null): string[] {
  if (!board) return []
  const agents = new Set<string>()
  let user = false
  for (const i of [...board.open, ...board.done]) {
    if (i.assignee === 'user') user = true
    else if (i.assignee) agents.add(i.assignee)
  }
  return [...(user ? ['user'] : []), ...[...agents].sort((a, b) => a.localeCompare(b))]
}

/** How a card names its creator: "you", or the agent as the UI names it. */
export const creatorLabel = (addedBy: string): string => (addedBy === 'user' ? 'you' : `@${displayName(addedBy)}`)

/** How a card names its assignee: "you", the agent, or "nobody". */
export const assigneeLabel = (assignee: string | undefined): string => (assignee ? creatorLabel(assignee) : 'nobody')

/** Two letters for a card's avatar: "you" for the user, else the first letters of the agent's first two words. */
export function avatarInitials(who: string): string {
  if (who === 'user') return 'You'
  const words = displayName(who)
    .split(/[\s_-]+/)
    .filter(Boolean)
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? '?').slice(0, 2)
  return letters.toUpperCase()
}

/** Where this device keeps the board's collapsed columns (a viewing choice, never synced). */
export const COLLAPSED_KEY = 'zumibot.board.collapsed'
export const DRAWER_EXPANDED_KEY = 'zumibot.board.drawerExpanded'

/** The collapsed columns stored: known statuses only, once each, in board order; anything else reads as none. */
export function parseCollapsed(raw: string | null): TodoStatus[] {
  if (!raw) return []
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(v)) return []
  return TODO_STATUSES.filter((s) => v.includes(s))
}

/** Collapses an open column, or opens a collapsed one. */
export function toggleCollapsed(list: readonly TodoStatus[], col: TodoStatus): TodoStatus[] {
  return list.includes(col) ? list.filter((c) => c !== col) : TODO_STATUSES.filter((s) => s === col || list.includes(s))
}

/** The drawer's place in the shown cards: the ones either side (null at an end), and where it sits (`index` -1: not shown). */
export interface CardNeighbors {
  prev: string | null
  next: string | null
  index: number
  total: number
}

/** Where card `id` sits among `order` (the cards the view shows, top to bottom): no wrap, so an end stops. */
export function cardNeighbors(order: readonly string[], id: string | null): CardNeighbors {
  const index = id === null ? -1 : order.indexOf(id)
  if (index < 0) return { prev: null, next: null, index: -1, total: order.length }
  return { prev: order[index - 1] ?? null, next: order[index + 1] ?? null, index, total: order.length }
}

/** The kanban's reading order: column by column, left to right, each top to bottom (collapsed ones too: still there). */
export function kanbanOrder(cols: Readonly<Record<TodoStatus, readonly TodoItem[]>>): string[] {
  return TODO_STATUSES.flatMap((c) => cols[c].map((i) => i.id))
}

/**
 * The drawer's step key: K or ← the card before, J or → the one after (as a mail list), never while typing (a comment box takes
 * them as letters) or with a modifier (the browser's and the app's own shortcuts keep theirs).
 */
export function cardStepKey(e: {
  key: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  target: Parameters<typeof isTypingTarget>[0]
}): 'prev' | 'next' | null {
  if (e.altKey || e.ctrlKey || e.metaKey || isTypingTarget(e.target)) return null
  if (e.key === 'k' || e.key === 'K' || e.key === 'ArrowLeft') return 'prev'
  if (e.key === 'j' || e.key === 'J' || e.key === 'ArrowRight') return 'next'
  return null
}
