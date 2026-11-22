const WINDOW_MS = 15 * 60_000
const LOCK_AT = 10
const SWEEP_EVERY = 100

type Entry = { fails: number[]; lockedUntil: number }

/** Per-IP login throttle: free for 2 failures, then 1s, 2s, 4s... capped at 60s, locked 15 min at the 10th failure. */
export function createLimiter(o: { now(): number }) {
  const state = new Map<string, Entry>()
  let calls = 0

  function live(e: Entry, now: number): boolean {
    e.fails = e.fails.filter((t) => now - t < WINDOW_MS)
    if (e.lockedUntil <= now) e.lockedUntil = 0
    return e.fails.length > 0 || e.lockedUntil > 0
  }

  function prune(ip: string): Entry | undefined {
    const e = state.get(ip)
    if (!e) return undefined
    if (!live(e, o.now())) {
      state.delete(ip)
      return undefined
    }
    return e
  }

  // Idle IPs would otherwise stay in the map forever.
  function sweep(): void {
    if (++calls % SWEEP_EVERY !== 0) return
    const now = o.now()
    for (const [ip, e] of state) if (!live(e, now)) state.delete(ip)
  }

  return {
    check(ip: string): { allowed: boolean; retryAfterMs: number } {
      sweep()
      const e = prune(ip)
      if (!e) return { allowed: true, retryAfterMs: 0 }
      const now = o.now()
      let until = e.lockedUntil
      const n = e.fails.length
      // At 10 or more failures in the window the IP stays blocked until fewer than 10 remain.
      if (n >= LOCK_AT) until = Math.max(until, e.fails[n - LOCK_AT] + WINDOW_MS)
      else if (n >= 3) until = Math.max(until, e.fails[n - 1] + Math.min(2 ** (n - 3), 60) * 1000)
      return until > now ? { allowed: false, retryAfterMs: until - now } : { allowed: true, retryAfterMs: 0 }
    },
    fail(ip: string): void {
      sweep()
      const e = prune(ip) ?? { fails: [], lockedUntil: 0 }
      const now = o.now()
      e.fails.push(now)
      // Only the newest 10 matter, which also bounds memory per IP.
      if (e.fails.length > LOCK_AT) e.fails.splice(0, e.fails.length - LOCK_AT)
      // The lock itself is remembered, since old failures aging out must not lift it early.
      if (e.fails.length >= LOCK_AT && e.lockedUntil <= now) e.lockedUntil = now + WINDOW_MS
      state.set(ip, e)
    },
    succeed(ip: string): void {
      state.delete(ip)
    },
    /** Tracked IPs; for tests. */
    size(): number {
      return state.size
    }
  }
}

export type Limiter = ReturnType<typeof createLimiter>
