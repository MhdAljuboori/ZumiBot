import type { ChatMeta } from './types'

type Times = Pick<ChatMeta, 'archivedAt' | 'unarchivedAt'>

/**
 * Archived while the last archive is later than the last unarchive. Both times are kept (never deleted), so a sync
 * can keep the later of each and still tell which came last.
 */
export const isArchived = (c: Times): boolean => c.archivedAt !== undefined && c.archivedAt > (c.unarchivedAt ?? 0)

/**
 * The times that archive (`on`) or unarchive a chat at `now`; empty when it already is that way. Past the other time
 * even when that is ahead of the clock (synced from a faster one), or the change would not show.
 */
export function archivePatch(c: Times, on: boolean, now: number): Times {
  if (isArchived(c) === on) return {}
  return on ? { archivedAt: Math.max(now, (c.unarchivedAt ?? 0) + 1) } : { unarchivedAt: Math.max(now, (c.archivedAt ?? 0) + 1) }
}

/** A running chat (a reply, a compact, a room's turn) may hold a card the user must answer, so it stays in sight. */
export const ARCHIVE_RUNNING = 'A chat can be archived once its reply ends'
