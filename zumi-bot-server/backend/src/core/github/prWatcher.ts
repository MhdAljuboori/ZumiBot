import type { ChatMeta } from '@zumibot/shared/types'
import { watchable } from './pullRequests'

export const FIRST_MS = 15_000
export const BACKOFF = 1.5
export const MAX_MS = 120_000
/** After this long a PR stops being polled by itself; the row's Refresh still reads it on demand. */
export const GIVE_UP_MS = 2 * 60 * 60_000

export interface PrWatcherDeps {
  /** One read of a chat's PR (`PullRequests.refreshPr`); its own errors are the watcher's to swallow. */
  read(chatId: string): Promise<unknown>
  /** The chat as it is now, or null once it is gone. */
  chat(chatId: string): Promise<ChatMeta | null>
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(t: unknown): void
  now(): number
  log(msg: string): void
}

interface Watch {
  timer: unknown
  delay: number
  until: number
  reading: boolean
}

/**
 * Polls a pull request's checks, and only while there is something to poll: open, with checks still running, and the
 * chat not archived. The interval starts at 15 s and backs off by half each time nothing changed, up to 2 minutes, and
 * the watch gives up after two hours. An idle PR is never polled and a chat without one is never looked at.
 */
export class PrWatcher {
  private readonly watches = new Map<string, Watch>()

  constructor(private readonly d: PrWatcherDeps) {}

  /** Starts or restarts a watch when the chat's PR wants one, and stops it when it does not. Never throws. */
  watch(meta: ChatMeta): void {
    if (!watchable(meta)) return this.stop(meta.id)
    const cur = this.watches.get(meta.id)
    if (cur) {
      // Something changed, so the next read is worth doing soon again.
      cur.delay = FIRST_MS
      return
    }
    this.watches.set(meta.id, { timer: null, delay: FIRST_MS, until: this.d.now() + GIVE_UP_MS, reading: false })
    this.arm(meta.id)
  }

  stop(chatId: string): void {
    const w = this.watches.get(chatId)
    if (!w) return
    if (w.timer !== null) this.d.clearTimer(w.timer)
    this.watches.delete(chatId)
  }

  /** At shutdown: every timer goes, so nothing holds the process open. */
  stopAll(): void {
    for (const id of [...this.watches.keys()]) this.stop(id)
  }

  /** How many PRs are being polled now; the tests read it, and it keeps the map honest. */
  get size(): number {
    return this.watches.size
  }

  private arm(chatId: string): void {
    const w = this.watches.get(chatId)
    if (!w) return
    w.timer = this.d.setTimer(() => void this.tick(chatId), w.delay)
  }

  private async tick(chatId: string): Promise<void> {
    const w = this.watches.get(chatId)
    if (!w || w.reading) return
    w.timer = null
    if (this.d.now() >= w.until) return this.stop(chatId) // two hours is enough; Refresh still works
    const before = await this.d.chat(chatId)
    if (!before || !watchable(before)) return this.stop(chatId)
    w.reading = true
    try {
      await this.d.read(chatId)
    } catch (e) {
      // A failed read is kept on the meta by the service; here it only costs this round.
      this.d.log(`pr watch ${chatId}: ${(e as { code?: unknown })?.code ?? 'read failed'}`)
    } finally {
      w.reading = false
    }
    const after = await this.d.chat(chatId)
    if (!after || !watchable(after)) return this.stop(chatId)
    // Nothing moved, so ask less often; `watch` resets this whenever the state does change.
    const same = JSON.stringify(before.pr?.checks) === JSON.stringify(after.pr?.checks)
    const still = this.watches.get(chatId)
    if (!still) return
    still.delay = same ? Math.min(MAX_MS, Math.round(still.delay * BACKOFF)) : FIRST_MS
    this.arm(chatId)
  }
}
