import type { ClaudeAccount, UsageWindow } from '@zumibot/shared/types'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** A limit whose reset time has passed has started over since it was seen. */
const isReset = (w: UsageWindow, now: number): boolean => w.resetsAt !== null && w.resetsAt <= now

/** Whole percent used, 0–100; 0 once the limit has reset. */
export function percentUsed(w: UsageWindow, now: number): number {
  return isReset(w, now) ? 0 : Math.min(100, Math.max(0, Math.round(w.percent)))
}

/** Whole percent of the 5-hour session used, or null when the account has no session window. */
export function sessionPercent(account: ClaudeAccount | null, now: number): number | null {
  const w = account?.usage?.session
  return w ? percentUsed(w, now) : null
}

export interface CodexRow {
  key: 'session' | 'weekly'
  label: string
  window: UsageWindow
  style: 'in' | 'at'
}

/** The popover's Codex block: a row per known window, none until a Codex run reported a reading. */
export function codexRows(account: ClaudeAccount | null): CodexRow[] {
  const c = account?.codex
  if (!c) return []
  return [
    ...(c.session ? [{ key: 'session' as const, label: 'Session limit', window: c.session, style: 'in' as const }] : []),
    ...(c.weekly ? [{ key: 'weekly' as const, label: 'Weekly limit', window: c.weekly, style: 'at' as const }] : [])
  ]
}

/** '2 hr 31 min', '3 hr', '45 min'; never under a minute. */
export function duration(ms: number): string {
  const mins = Math.max(1, Math.ceil(ms / MIN))
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return [h > 0 ? `${h} hr` : '', m > 0 ? `${m} min` : ''].filter(Boolean).join(' ')
}

/**
 * When the limit starts over: 'Resets in 2 hr 31 min' (style 'in') or 'Resets Sat 10:00 AM' (style 'at').
 * '' when unknown. timeZone is for tests; the app uses the local one.
 */
export function resetLabel(w: UsageWindow, now: number, style: 'in' | 'at', timeZone?: string): string {
  if (w.resetsAt === null) return ''
  if (isReset(w, now)) return 'Reset'
  if (style === 'in') return `Resets in ${duration(w.resetsAt - now)}`
  const at = new Intl.DateTimeFormat('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone }).format(w.resetsAt)
  return `Resets ${at}`
}

/** How old the usage reading is: 'Updated just now', 'Updated 5 min ago', 'Updated 2 days ago'. */
export function updatedLabel(updatedAt: number, now: number): string {
  const ago = now - updatedAt
  if (ago < MIN) return 'Updated just now'
  if (ago < HOUR) return `Updated ${Math.floor(ago / MIN)} min ago`
  if (ago < DAY) return `Updated ${Math.floor(ago / HOUR)} hr ago`
  const days = Math.floor(ago / DAY)
  return `Updated ${days} ${days === 1 ? 'day' : 'days'} ago`
}
