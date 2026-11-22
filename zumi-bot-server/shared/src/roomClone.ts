import { copyTitle } from './copyTitle'
import type { ChatItem } from './types'

// Limits and naming for cloning a room.
export const HANDOFF_MAX_CHARS = 12_000 // a handoff is read by every member on each turn, so it stays short
export const CLONE_TITLE_MAX = 200
export const UNTITLED_ROOM = 'Room'

// "API room" -> "API room (2)"; a trailing "(n)" is bumped, not stacked.
export const nextCopyTitle = (title: string, taken: readonly string[]): string => copyTitle(title, taken, CLONE_TITLE_MAX, UNTITLED_ROOM)

/** A finished user or member message exists: a summary has something to write about. Here so the dialog and server agree. */
export function hasSummarizable(items: readonly ChatItem[]): boolean {
  return items.some((i) => (i.type === 'user' || (i.type === 'assistant' && !!i.agent)) && !('turn' in i && i.turn))
}
