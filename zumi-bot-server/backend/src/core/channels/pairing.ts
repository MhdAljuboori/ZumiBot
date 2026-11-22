import { timingSafeEqual } from 'node:crypto'
import {
  PAIR_TRIES_PER_SENDER,
  PAIR_TRIES_TOTAL,
  PAIR_TRIES_WINDOW_MS,
  PAIR_TTL_MS,
  pairCodeIn,
  pairCodeOf
} from '@zumibot/shared/channels'

export type PairResult = 'paired' | 'wrong' | 'none' | 'limited'

/**
 * One open pairing code at a time, in memory only (never stored, logged or sent anywhere but the page that asked). It works
 * once, for 10 minutes; each sender gets 5 tries per 10 minutes, and 20 wrong tries in all void it.
 */
export class Pairing {
  private code: string | null = null
  private expiresAt = 0
  private wrong = 0
  private tries = new Map<string, number[]>()

  constructor(private readonly o: { random: (n: number) => Uint8Array; now: () => number }) {}

  start(): { code: string; expiresAt: number } {
    this.code = pairCodeOf(this.o.random(8))
    this.expiresAt = this.o.now() + PAIR_TTL_MS
    this.wrong = 0
    this.tries.clear()
    return { code: this.code, expiresAt: this.expiresAt }
  }

  cancel(): void {
    this.code = null
    this.tries.clear()
  }

  /** The open code's expiry, or null when none is open (an expired one is dropped here). */
  open(): { expiresAt: number } | null {
    if (this.code !== null && this.o.now() >= this.expiresAt) this.cancel()
    return this.code === null ? null : { expiresAt: this.expiresAt }
  }

  /**
   * A message from an unpaired sender. Only a message whose whole text is code-shaped is a try; `paired` closes the code.
   * `limited`: this sender used its tries (the caller still answers nothing, so a stranger learns nothing).
   */
  attempt(sender: string, text: string): PairResult {
    if (this.open() === null) return 'none'
    const guess = pairCodeIn(text)
    if (guess === null) return 'none'
    const now = this.o.now()
    const recent = (this.tries.get(sender) ?? []).filter((t) => now - t < PAIR_TRIES_WINDOW_MS)
    if (recent.length >= PAIR_TRIES_PER_SENDER) return 'limited'
    recent.push(now)
    this.tries.set(sender, recent)
    if (this.code !== null && timingSafeEqual(Buffer.from(guess), Buffer.from(this.code))) {
      this.cancel()
      return 'paired'
    }
    if (++this.wrong >= PAIR_TRIES_TOTAL) this.cancel()
    return 'wrong'
  }
}
