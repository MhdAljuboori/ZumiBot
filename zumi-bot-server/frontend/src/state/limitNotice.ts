import { displayName } from '@zumibot/shared/frontmatter'
import type { ChatItem, ChatMeta, LimitHit } from '@zumibot/shared/types'

const DAY_MS = 86_400_000
const dayKey = (t: number, tz: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t)

/** `today at 22:21`, `tomorrow at 06:00` or `Nov 9 at 06:00`, in the zone. */
export function dayAt(at: number, now: number, timeZone: string): string {
  const time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at)
  const day = dayKey(at, timeZone)
  const when =
    day === dayKey(now, timeZone)
      ? 'today'
      : day === dayKey(now + DAY_MS, timeZone)
        ? 'tomorrow'
        : new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric' }).format(at)
  return `${when} at ${time}`
}

/**
 * The limit errors the chat's wait continues: those of the turn after its message. None without a wait, nor in a pausing
 * or paused chat, whose wait the server drops instead of sending (Resume continues it).
 */
export function waitingErrors(chat: Pick<ChatMeta, 'resume' | 'pause'>, items: readonly ChatItem[]): Set<string> {
  const out = new Set<string>()
  const after = chat.pause === undefined ? chat.resume?.after : undefined
  const from = after === undefined ? -1 : items.findIndex((i) => i.type === 'user' && i.id === after)
  if (from < 0) return out
  for (const item of items.slice(from + 1)) {
    if (item.type === 'user') break
    if (item.type === 'error' && item.limit && !item.limit.compact) out.add(item.id)
  }
  return out
}

/** What a limit error reads as: who it stopped, then when the chat continues by itself or else when the limit resets. */
export function limitNoticeText(hit: LimitHit, waitAt: number | null, now: number, timeZone: string): string {
  const head = hit.agent ? `${displayName(hit.agent)} reached the usage limit` : 'Usage limit reached'
  if (waitAt !== null) return `${head} · continues ${dayAt(waitAt, now, timeZone)}`
  if (hit.resetsAt !== null && hit.resetsAt > now) return `${head} · resets ${dayAt(hit.resetsAt, now, timeZone)}`
  return head
}
