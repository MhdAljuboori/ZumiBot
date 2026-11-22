import type { ChatMeta } from './types'

/** A mark the user set that no open has cleared yet; a later seenAt (an open, maybe on the other machine) ends it. */
export function markOn(c: Pick<ChatMeta, 'seenAt' | 'mark'>): boolean {
  return c.mark !== undefined && c.mark.at > (c.seenAt ?? 0)
}

/** A chat is unread when an agent reply landed after the user last saw it (old chats with no `replyAt` never are), or while the user's mark is on. */
export function isUnread(c: Pick<ChatMeta, 'replyAt' | 'seenAt' | 'mark'>): boolean {
  return markOn(c) || (c.replyAt !== undefined && c.replyAt > (c.seenAt ?? 0))
}
