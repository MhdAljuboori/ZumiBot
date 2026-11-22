import type { TodoItem } from '@zumibot/shared/todos'

// Ages on the board's cards and in a chat's to-do panel.

const DAY_MS = 86_400_000

const daysSince = (at: number, now: number): number => Math.max(0, Math.floor((now - at) / DAY_MS))

export function ageLabel(at: number, now: number): string {
  const d = daysSince(at, now)
  return d === 0 ? 'today' : d === 1 ? '1 day' : `${d} days`
}

/** Left over for more than 3 days: shown in the warning color. */
export function isOld(at: number, now: number): boolean {
  return now - at > 3 * DAY_MS
}

export function openOldestFirst(items: readonly TodoItem[]): TodoItem[] {
  return items.filter((i) => !i.done && !i.removed).sort((a, b) => a.from.at - b.from.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
