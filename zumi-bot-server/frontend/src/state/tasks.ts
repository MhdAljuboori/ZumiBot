import type { ChatItem, ChatMeta, QueuedTask } from '@zumibot/shared/types'
import { pausedAtEnd } from './groupChat'
import { isSending, type PendingSend } from './pendingSends'

/** Where the collapsed trays are remembered. */
export const TRAYS_KEY = 'zumibot.collapsedTrays'
export type TrayName = 'tasks' | 'later'

// Held, paused, or waiting out a usage limit, whose continue goes before them: the queue sends no task by itself.
const holdsTasks = (chat: Pick<ChatMeta, 'held' | 'pause' | 'resume'>): boolean =>
  chat.held === true || chat.pause !== undefined || chat.resume !== undefined

/**
 * Whether a message written now joins the queue. Mirrors the server's busy rule: a running chat, a send still on its way
 * or held tasks queue it, except a held chat, one waiting out a usage limit, a user-paused chat or a paused group, which
 * take a written message straight away even with tasks held (a chat still pausing runs, so it queues).
 */
export const sendsAsTask = (
  chat: Pick<ChatMeta, 'inFlight' | 'tasks' | 'group' | 'held' | 'pause' | 'resume'>,
  items: readonly ChatItem[],
  pending: readonly PendingSend[]
): boolean =>
  chat.inFlight ||
  isSending(pending) ||
  ((chat.tasks?.length ?? 0) > 0 && !(holdsTasks(chat) || (chat.group !== undefined && pausedAtEnd(items))))

/** One line for a task row: its text on a single line, or the first attachment's name when it has no text. */
export const taskLabel = (task: QueuedTask): string => task.text.replace(/\s+/g, ' ').trim() || (task.attachments?.[0]?.name ?? '')

/**
 * Whether the rows offer Send now: only while the queue holds its tasks, in a chat an edit or resend held, one waiting
 * out a usage limit, or a group the hop cap paused that nobody wrote to since. Any other idle moment is the gap before
 * the queue sends the next one itself, where a tap meets "Chat is busy". A paused chat holds its tasks for Resume: Send
 * now ends the pause, as it ends a usage limit wait.
 */
export const tasksHeld = (chat: Pick<ChatMeta, 'inFlight' | 'group' | 'held' | 'pause' | 'resume'>, items: readonly ChatItem[]): boolean =>
  !chat.inFlight && (holdsTasks(chat) || (chat.group !== undefined && pausedAtEnd(items)))

/** A task's label for a button's accessible name: enough to tell the rows apart, never a whole long message. */
export function taskName(task: QueuedTask, max = 60): string {
  const cps = [...taskLabel(task)]
  return cps.length > max ? `${cps.slice(0, max).join('')}…` : cps.join('')
}

export type TaskFocus = { to: 'row'; id: string } | { to: 'head' }

/**
 * Where focus goes once the row the user removed or sent (`gone`, with `next` the row after it) has left the list: the
 * next row, else the tray's header. Null while the row is still listed.
 */
export function focusAfterRemoval(tasks: readonly QueuedTask[], gone: string, next: string | null): TaskFocus | null {
  if (tasks.some((t) => t.id === gone)) return null
  return next !== null && tasks.some((t) => t.id === next) ? { to: 'row', id: next } : { to: 'head' }
}
