import { isGroup, type AgentSummary, type ChatItem, type ChatMeta } from '@zumibot/shared/types'
import { isUnread, markOn } from '@zumibot/shared/unread'

type Marks = Pick<ChatMeta, 'replyAt' | 'seenAt' | 'mark'>

/**
 * The chats the sidebar has a row for: a group chat always, a single chat only while its agent exists (as buildTree).
 * A dot rolled up over any other chat could never be cleared.
 */
export function listedChats<T extends ChatMeta>(chats: readonly T[], agents: readonly Pick<AgentSummary, 'name'>[]): T[] {
  return chats.filter((c) => isGroup(c) || agents.some((a) => a.name === c.agentName))
}

/** Whether some chat of this agent holds a reply the user has not seen: the agent's sidebar row shows a dot then. */
export function agentHasUnread(chats: readonly (Marks & Pick<ChatMeta, 'agentName'>)[], agentName: string): boolean {
  return chats.some((c) => c.agentName === agentName && isUnread(c))
}

/** Whether a chat other than the open one is unread: the drawer's toggle shows a dot then. */
export function unreadElsewhere(chats: readonly (Marks & Pick<ChatMeta, 'id'>)[], openChatId: string | null): boolean {
  return chats.some((c) => c.id !== openChatId && isUnread(c))
}

export function anyUnread(chats: readonly Marks[]): boolean {
  return chats.some(isUnread)
}

/** Where the New line starts when a chat opens: the marked message or an earlier seenAt, else seenAt if unread and ever seen, else null (no line). */
export function sinceOnOpen(chat: Marks): number | null {
  if (chat.mark && markOn(chat)) return Math.min(chat.mark.from, chat.seenAt ?? chat.mark.from)
  return isUnread(chat) && chat.seenAt !== undefined ? chat.seenAt : null
}

/**
 * The open chat going unread -> read sets the line from the seenAt before the read, also over a held one: a later idle
 * round moves it (on first open the server's read lands with prev.seenAt equal to the held value, so nothing changes).
 * Still unread means the server's read has not landed yet, so nothing is set early.
 */
export function sinceOnChange(since: number | null, prev: Marks, next: Marks): number | null {
  // A mark set or moved while the chat is open shows its line at once.
  if (next.mark && markOn(next) && next.mark.at !== (markOn(prev) ? prev.mark?.at : undefined)) return sinceOnOpen(next)
  if (isUnread(next)) return since
  return sinceOnOpen(prev) ?? since
}

/** Id of the first item after `since` that is not the user's (and is shown: not a 'kept' notice); null = no line. */
export function newLineItem(items: readonly ChatItem[], since: number | null, hasOlder: boolean): string | null {
  if (since === null) return null
  // With older pages unloaded the first unseen item may be before this page, so a line here would sit mid-run.
  if (hasOlder && items.length > 0 && items[0].ts > since) return null
  // groupItems never shows a 'kept' notice, so a line cannot sit on one.
  const item = items.find((i) => i.ts > since && i.type !== 'user' && !(i.type === 'notice' && i.kind === 'kept'))
  return item?.id ?? null
}

/**
 * Where a list opening on its New line scrolls: the line at the top, just past the list's top padding, clamped to
 * what can scroll. It sticks to the bottom only when that lands there, so a short unread part still follows new output.
 */
export function lineScroll(box: { lineTop: number; padTop: number; scrollHeight: number; clientHeight: number; atBottomPx: number }): {
  scrollTop: number
  stick: boolean
} {
  const max = Math.max(0, box.scrollHeight - box.clientHeight)
  const scrollTop = Math.min(max, Math.max(0, box.lineTop - box.padTop))
  return { scrollTop, stick: max - scrollTop <= box.atBottomPx }
}
