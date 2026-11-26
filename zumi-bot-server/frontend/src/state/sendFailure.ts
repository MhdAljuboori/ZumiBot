import type { ChatItem, QueuedTask } from '@zumibot/shared/types'

const MAX_QUOTED = 200

/**
 * Whether a rejected send's text should go back into the draft box. Not when the reply already carries
 * that message (a late rejection after the turn ran: restoring would invite a duplicate send), and not
 * over text the user has typed since.
 */
export function shouldRestoreDraft(items: ChatItem[], startIndex: number, text: string, currentDraft: string): boolean {
  // The box still showing the text is not new typing: a quick rejection can land before the render that cleared it.
  if (currentDraft !== '' && currentDraft !== text) return false
  return !items.slice(startIndex).some((i) => i.type === 'user' && i.text === text)
}

/**
 * Where a rejected send's message is, by the id it was sent under: in the chat (the turn failed after it went in),
 * waiting as a task (it was queued and only the reply was lost, e.g. the socket dropped), or nowhere. A steer still waiting
 * in the running reply (`steering`) is as good as queued: the reply reads it, or it goes back to the tray.
 */
export function rejectedSendState(
  items: readonly ChatItem[],
  id: string,
  tasks: readonly QueuedTask[] = [],
  steering: readonly QueuedTask[] = []
): 'stored' | 'queued' | 'lost' {
  if (items.some((i) => i.id === id)) return 'stored'
  return tasks.some((t) => t.id === id) || steering.some((t) => t.id === id) ? 'queued' : 'lost'
}

/**
 * Whether a rejected send needs no report: a queued one's task row holds it, and a stored one whose socket dropped
 * did not fail. chats:send stays open for the whole turn, so closing a phone app while the reply waits on a card
 * rejects it; the turn runs on, and its reply (or its error item) reaches the chat after the reconnect.
 */
export function quietRejection(where: 'stored' | 'queued' | 'lost', notConnected: boolean): boolean {
  return where === 'queued' || (where === 'stored' && notConnected)
}

/** The error shown for a rejected send; quotes the message when it could not be put back in the draft box. */
export function failureMessage(error: string, text: string, restored: boolean): string {
  if (restored) return error
  const cps = [...text]
  const quoted = cps.length > MAX_QUOTED ? cps.slice(0, MAX_QUOTED).join('') + '…' : text
  return `${error}\nYour message was: ${quoted}`
}
