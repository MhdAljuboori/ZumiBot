import type { EngineCaps } from '@zumibot/shared/engine'
import type { ChatItem, ChatMeta } from '@zumibot/shared/types'

/**
 * The Pause button's state: null while it is not offered. The server refuses a pause while the CLI compacts (the chat's
 * own, or a room member's) and in an asked chat, whose reply belongs to another agent's turn.
 */
export function pauseControl(
  chat: Pick<ChatMeta, 'inFlight' | 'pause' | 'compacting' | 'asked'> & { group?: { active: readonly { compacting?: true }[] } },
  caps?: Pick<EngineCaps, 'pause'>
): 'pause' | 'pausing' | null {
  // An engine that cannot pause (Codex while its cap is off) gets no button at all.
  if (caps?.pause === false) return null
  if (!chat.inFlight || chat.compacting === true || chat.asked !== undefined) return null
  if (chat.group?.active.some((t) => t.compacting === true)) return null
  return chat.pause === 'pausing' ? 'pausing' : 'pause'
}

/** The id of the notice that gets the Resume pill: the latest "Paused" notice of a chat that waits for Resume. */
export function resumeRow(items: readonly ChatItem[], chat: Pick<ChatMeta, 'inFlight' | 'pause'>): string | null {
  if (chat.inFlight || chat.pause !== 'paused') return null
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.type === 'notice' && item.kind === 'userPaused') return item.id
  }
  return null
}

/** The line shown while a pause waits for the reply to wrap up; `running` is the dispatched agents still working. */
export const pausingLine = (running: number): string =>
  running <= 0 ? 'Pausing…' : `Pausing — waiting for ${running} subagent${running === 1 ? '' : 's'}`
