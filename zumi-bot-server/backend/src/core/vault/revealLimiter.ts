/** At most `max` reveals in any rolling window: a stolen session cannot read the whole vault out at once. */
export function createRevealLimiter(o: { now?(): number; max?: number; windowMs?: number } = {}): { take(): boolean } {
  const now = o.now ?? Date.now
  const max = o.max ?? 30
  const windowMs = o.windowMs ?? 60_000
  const times: number[] = []
  return {
    take(): boolean {
      const t = now()
      while (times.length > 0 && t - times[0] >= windowMs) times.shift()
      if (times.length >= max) return false
      times.push(t)
      return true
    }
  }
}
