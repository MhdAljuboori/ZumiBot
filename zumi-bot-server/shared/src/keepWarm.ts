/**
 * How long a big, idle context is kept in the prompt cache after its last request (see backend core/btw/keepWarm.ts).
 * Rooms get longer: their members wait on each other and on the user for hours, and in the logs a 12 h window saved
 * about three times what its pings cost. Single chats come back sooner or not at all, so past 4 h pings cost more than
 * the reloads they save.
 */
export interface KeepWarmSettings {
  roomHours: number
  chatHours: number
}
export const KEEP_WARM_ROOM_HOURS = [0, 4, 8, 12] as const
export const KEEP_WARM_CHAT_HOURS = [0, 2, 4] as const
export const KEEP_WARM_DEFAULT: KeepWarmSettings = { roomHours: 12, chatHours: 2 }

const pick = (v: unknown, offered: readonly number[], fallback: number): number =>
  typeof v === 'number' && offered.includes(v) ? v : fallback

/** A stored or sent value, each field kept only when it is one of the offered hours. */
export function keepWarmOf(v: unknown): KeepWarmSettings {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  return {
    roomHours: pick(o.roomHours, KEEP_WARM_ROOM_HOURS, KEEP_WARM_DEFAULT.roomHours),
    chatHours: pick(o.chatHours, KEEP_WARM_CHAT_HOURS, KEEP_WARM_DEFAULT.chatHours)
  }
}
