import { isGroup, type ChatMeta } from '@zumibot/shared/types'
import type { ChatStore } from '../store/chatStore'

/**
 * Every agent session of the chat starts anew at its next turn, seeded from the chat's recent messages (the reseed
 * path), so the run never reloads a big idle context into the cache. The old meter goes with the session.
 */
export async function startFresh(chats: Pick<ChatStore, 'update' | 'updateGroup'>, chat: ChatMeta): Promise<void> {
  const fresh = { seed: true, fresh: true } as const
  if (!isGroup(chat)) {
    if (chat.sessionId !== null) await chats.update(chat.id, { next: fresh, context: undefined })
    return
  }
  await chats.updateGroup(chat.id, (g) => {
    const restart = Object.keys(g.sessions).filter((m) => g.sessions[m])
    if (restart.length === 0) return g
    const { context: old, ...rest } = g
    const context = Object.fromEntries(Object.entries(old ?? {}).filter(([m]) => !restart.includes(m)))
    return {
      ...rest,
      next: { ...g.next, ...Object.fromEntries(restart.map((m) => [m, fresh])) },
      ...(Object.keys(context).length ? { context } : {})
    }
  })
}
