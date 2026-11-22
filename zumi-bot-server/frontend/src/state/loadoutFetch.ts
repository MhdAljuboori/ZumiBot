/**
 * The loadout's fetch order. A probe can take seconds, and a Refresh, a change push or another folder may start a second one
 * meanwhile, so an answer shows only when nothing newer already did (a slow older one never replaces a fresh list), and an
 * error shows only while its request is still the latest one. `reset()` drops every request still out: another folder or agent,
 * or an unmount.
 */
export interface Fetches {
  start(): number
  land(n: number): boolean
  fail(n: number): boolean
  busy(): boolean
  reset(): void
  /** Settles request `n` (answered or failed): whether its result shows, and the loading flag after it. Dropped answers still count. */
  settle(n: number, kind: 'land' | 'fail'): { show: boolean; loading: boolean }
}

export function loadoutFetches(): Fetches {
  let started = 0
  let shown = 0
  const out = new Set<number>()
  const api: Fetches = {
    start: () => {
      out.add(++started)
      return started
    },
    land: (n) => {
      if (!out.delete(n) || n <= shown) return false
      shown = n
      return true
    },
    fail: (n) => out.delete(n) && n === started,
    busy: () => out.size > 0,
    reset: () => {
      out.clear()
      shown = started
    },
    settle: (n, kind) => {
      const show = kind === 'land' ? api.land(n) : api.fail(n)
      return { show, loading: out.size > 0 }
    }
  }
  return api
}
