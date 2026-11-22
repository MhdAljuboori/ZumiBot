import type { HistoryStore } from './historyStore'

// A history failure never reaches the user's save, which has already landed: it is logged by its code only, since a
// message could name a path.
export function logHistoryError(error: unknown): void {
  const code = (error as NodeJS.ErrnoException | null)?.code
  console.error(`history: could not keep a version${code ? ` (${code})` : ''}`)
}

/** Records a save's definition in its history, if the server keeps one; a save of a restored version says so. */
export async function keepHistory<D>(
  history: HistoryStore<D> | undefined,
  id: string,
  before: { def: D; at: number } | null,
  after: D,
  o: { source?: 'editor' | 'zumi-bot'; restoredFrom?: number }
): Promise<void> {
  if (!history) return
  try {
    await history.record(id, {
      before,
      after,
      ...(o.restoredFrom !== undefined ? { source: 'restore', restoredFrom: o.restoredFrom } : { source: o.source ?? 'editor' })
    })
  } catch (error) {
    logHistoryError(error)
  }
}
