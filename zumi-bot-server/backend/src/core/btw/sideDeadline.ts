/**
 * One side answer's deadline. Time spent paused (waiting on a side_question call) does not count toward `limitMs`,
 * so the asked agent gets its own full time; `capMs` bounds the wall time since start whatever the pauses.
 */
export class SideDeadline {
  private readonly start: number
  private used = 0 // counted time before the current running stretch
  private since: number | null // start of the current running stretch; null while paused
  private pauses = 0
  private ended = false
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private o: { limitMs: number; capMs: number; now(): number; onExpire(): void }) {
    this.start = this.since = o.now()
    this.schedule()
  }

  /** Stops the clock until the returned resume runs; nested pauses resume only when the last one ends. */
  pause(): () => void {
    if (this.ended) return () => {}
    if (this.pauses++ === 0) {
      this.used += this.o.now() - this.since!
      this.since = null
      this.schedule()
    }
    let resumed = false
    return () => {
      // Once only, so a double resume cannot end another caller's pause.
      if (resumed) return
      resumed = true
      if (this.ended || --this.pauses > 0) return
      this.since = this.o.now()
      this.schedule()
    }
  }

  clear(): void {
    this.ended = true
    clearTimeout(this.timer)
  }

  private schedule(): void {
    clearTimeout(this.timer)
    const now = this.o.now()
    const capLeft = this.o.capMs - (now - this.start)
    const left = this.since === null ? capLeft : Math.min(capLeft, this.o.limitMs - this.used - (now - this.since))
    this.timer = setTimeout(
      () => {
        if (this.ended) return
        this.ended = true
        this.o.onExpire()
      },
      Math.max(0, left)
    )
  }
}
