import type { ChatItem, LimitHit } from './types'

/** A chat or room the usage limit stopped, waiting to continue by itself at `at` (epoch ms). */
export interface LimitResume {
  at: number
  after: string // the user message whose turn the limit stopped; any later message ends the wait
  waits: number // automatic continues in a row, the one this wait will send included
}

// The reset is when the window turns over: a request right at it may still be refused.
export const LIMIT_RESUME_MARGIN_MS = 60_000
export const LIMIT_RESUME_MIN_MS = 5_000
// A reset that keeps being wrong must not loop for ever: past this many continues in a row the chat just stops.
export const LIMIT_MAX_RESUMES = 5

type UserItem = Extract<ChatItem, { type: 'user' }>

/** The chat's last turn: its last user message and everything after it. Null when the chat has no user message. */
export function lastTurn(items: readonly ChatItem[]): { message: UserItem; items: ChatItem[] } | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (item.type === 'user') return { message: item, items: items.slice(i + 1) }
  }
  return null
}

/**
 * Whether the usage limit stopped this turn (a `/compact`'s aside): the queued tasks must not follow it at once, or each
 * one meets the limit in turn.
 */
export function limitHit(turn: readonly ChatItem[]): boolean {
  return turn.some((i) => i.type === 'error' && i.limit !== undefined && !i.limit.compact)
}

/**
 * The limits that stopped this turn, or null when it may not continue by itself: only when the limit is all that went
 * wrong (another error would just happen again) and every reset is known. A `/compact` that hit the limit is not the
 * turn's own work, so its error counts neither way.
 */
export function limitStop(turn: readonly ChatItem[]): LimitHit[] | null {
  const errors = turn.filter((i): i is Extract<ChatItem, { type: 'error' }> => i.type === 'error' && !i.limit?.compact)
  if (errors.length === 0) return null
  const limits: LimitHit[] = []
  for (const e of errors) {
    if (!e.limit || e.limit.resetsAt === null) return null
    limits.push(e.limit)
  }
  return limits
}

/** When to continue: a minute past the last reset (a room waits for its last member's), and never at once. */
export function resumeTime(limits: readonly LimitHit[], now: number): number {
  const last = Math.max(...limits.map((l) => l.resetsAt ?? now))
  return Math.max(last + LIMIT_RESUME_MARGIN_MS, now + LIMIT_RESUME_MIN_MS)
}

/** The message that continues: plain `continue`, or each room member the limit stopped asked by name. */
export function continueText(limits: readonly LimitHit[]): string {
  const members = [...new Set(limits.flatMap((l) => (l.agent ? [l.agent] : [])))]
  return [...members.map((m) => `@${m}`), 'continue'].join(' ')
}
