import type { NotifyKind, NotifyPayloadKind, NotifyToggles, RoutineFailure } from '@zumibot/shared/notify'

export const RATE_CAP = 10
export const RATE_WINDOW_MS = 60_000

/** What one device gets for an event, from its own toggles; null = nothing. */
export function kindFor(t: NotifyToggles, kind: NotifyKind, cause: RoutineFailure['cause'] | null): NotifyPayloadKind | null {
  if (kind !== 'routine-failed') return t[kind] ? kind : null
  // The user's own Stop/Remove/Replace, or a restart (usually a deploy or sync), is not news.
  if (cause === 'user' || cause === 'restart') return null
  if (t.routineFailed) return 'routine-failed'
  // A run failed by its turn's error is also a reply error: one notification, never both.
  return cause === 'turn' && t.error ? 'error' : null
}

/** At most RATE_CAP non-waiting notifications per device per minute; waiting is never capped. */
export class RateCap {
  private readonly sent = new Map<string, number[]>()

  constructor(private readonly now: () => number) {}

  allow(deviceId: string, kind: NotifyPayloadKind): boolean {
    if (kind === 'waiting') return true
    const now = this.now()
    const recent = (this.sent.get(deviceId) ?? []).filter((at) => now - at < RATE_WINDOW_MS)
    if (recent.length >= RATE_CAP) {
      this.sent.set(deviceId, recent)
      return false
    }
    recent.push(now)
    this.sent.set(deviceId, recent)
    return true
  }
}
