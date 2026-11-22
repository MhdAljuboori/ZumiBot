import type { ChatItem, QueuedTask } from '@zumibot/shared/types'

export type UserItem = Extract<ChatItem, { type: 'user' }>

/**
 * A message sent but not yet in its chat's items. It is drawn at once under the id the server stores it with, so the
 * stored copy takes its place without a change on screen. `error` says why it never reached the chat.
 */
export interface PendingSend {
  item: UserItem
  error: string | null
}

// New items land at the end, so the search starts there.
function holds(items: readonly ChatItem[], id: string): boolean {
  for (let i = items.length - 1; i >= 0; i--) if (items[i].id === id) return true
  return false
}

/** The pending messages the items do not hold yet: on their way, or failed. */
export const unconfirmed = (items: readonly ChatItem[], pending: readonly PendingSend[]): PendingSend[] =>
  pending.filter((p) => !holds(items, p.item.id))

export const isSending = (pending: readonly PendingSend[]): boolean => pending.some((p) => p.error === null)

export const failSend = (pending: readonly PendingSend[], id: string, error: string): PendingSend[] =>
  pending.map((p) => (p.item.id === id ? { ...p, error } : p))

/**
 * The pending messages the server did not queue. One drawn as sent can still land in the queue (a send racing a run's
 * start); its task row shows it from the meta push on, so it must not show twice until the send's reply drops it.
 */
export const unqueued = (pending: readonly PendingSend[], tasks: readonly QueuedTask[] = []): PendingSend[] =>
  pending.filter((p) => !tasks.some((t) => t.id === p.item.id))

/** Sending a failed message's text again is its retry: the failed copy goes. */
export const retried = (pending: readonly PendingSend[], text: string): PendingSend[] =>
  pending.filter((p) => p.error === null || p.item.text !== text)
