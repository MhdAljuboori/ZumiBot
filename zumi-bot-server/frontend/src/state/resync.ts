import type { ChatItem } from '@zumibot/shared/types'
import { NOT_CONNECTED } from '../net/rpc'
import { vaultPending } from './vaultApproval'

/** Request counters, so a slow older response never overwrites a newer one. A key scopes the counter (e.g. per chat). */
export function createGate(): { next(key?: string): number; isCurrent(n: number, key?: string): boolean } {
  const counts = new Map<string, number>()
  return {
    next(key = '') {
      const n = (counts.get(key) ?? 0) + 1
      counts.set(key, n)
      return n
    },
    isCurrent: (n, key = '') => counts.get(key) === n
  }
}

/** A call made while the socket is down is expected during an outage and must not reach the error strip. */
export const isNotConnected = (e: unknown): boolean => (e instanceof Error ? e.message : String(e)) === NOT_CONNECTED

/**
 * What waits on the user while a turn runs: approval cards with status 'pending', pending desktop or browser handoffs,
 * as the server's own count has them (a reconnect would otherwise drop a waiting handoff until the next push), and
 * pending vault approval cards.
 */
export const pendingFromItems = (items: readonly ChatItem[]): number =>
  items.filter((i) => (i.type === 'approval' && i.status === 'pending') || (i.type === 'browser-action' && i.handoff.status === 'pending'))
    .length + vaultPending(items)
