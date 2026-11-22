// Every outbound call of a platform goes through here: one queue per conversation, at most one call per `gapMs` in it
// (Telegram asks for about one message a second per chat), a 429's retry_after honoured, and live previews coalesced so
// only the newest waits. A final message is retried, never dropped; a preview is dropped when it can't go.

export interface RetryInfo {
  code: number
  retryAfter: number | null
}
type Job = { key: string | null; final: boolean; run: () => Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void }

export interface OutboxDeps {
  gapMs: number
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** How a thrown error reads for retrying: a rate limit (429 + seconds), a network failure (code 0), or anything else. */
  retryOf: (err: unknown) => RetryInfo | null
}

const FINAL_TRIES = 5
const RETRY_AFTER_MAX_S = 300

export class Outbox {
  private queues = new Map<string, Job[]>()
  private busy = new Set<string>()
  private last = new Map<string, number>()
  private closed = false

  constructor(private readonly d: OutboxDeps) {}

  /**
   * Queues one call. `key`: a preview slot; a newer job with the same key replaces a queued one (which resolves undefined).
   * `final`: retried on a rate limit or a network failure until it goes; anything else rejects.
   */
  send<T>(conv: string, run: () => Promise<T>, o: { key?: string; final?: boolean } = {}): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve, reject) => {
      if (this.closed) return reject(new Error('channel stopped'))
      const q = this.queues.get(conv) ?? []
      const key = o.key ?? null
      if (key !== null) {
        const i = q.findIndex((j) => j.key === key)
        if (i >= 0) {
          q[i].resolve(undefined)
          q.splice(i, 1)
        }
      }
      q.push({ key, final: o.final ?? key === null, run, resolve: resolve as (v: unknown) => void, reject })
      this.queues.set(conv, q)
      void this.pump(conv)
    })
  }

  /** Stops for good: queued calls reject, and a call waiting to retry gives up. */
  close(): void {
    this.closed = true
    for (const q of this.queues.values())
      for (const j of q.splice(0)) (j.final ? j.reject : j.resolve)(j.final ? new Error('channel stopped') : undefined)
  }

  private async pump(conv: string): Promise<void> {
    if (this.busy.has(conv)) return
    this.busy.add(conv)
    try {
      for (;;) {
        const q = this.queues.get(conv)
        const job = q?.shift()
        if (!job) {
          this.queues.delete(conv)
          return
        }
        await this.runJob(conv, job)
      }
    } finally {
      this.busy.delete(conv)
    }
  }

  private async runJob(conv: string, job: Job): Promise<void> {
    for (let tries = 1; ; tries++) {
      if (this.closed) return job.final ? job.reject(new Error('channel stopped')) : job.resolve(undefined)
      const wait = (this.last.get(conv) ?? 0) + this.d.gapMs - this.d.now()
      if (wait > 0) await this.d.sleep(wait)
      this.last.set(conv, this.d.now())
      try {
        job.resolve(await job.run())
        return
      } catch (err) {
        const r = this.d.retryOf(err)
        const retryable = r !== null && (r.code === 429 || r.code === 0)
        if (!retryable || (!job.final && tries >= 2) || tries >= FINAL_TRIES) {
          // A preview that can't go is dropped quietly; the final message that follows carries the text.
          if (job.final) job.reject(err)
          else job.resolve(undefined)
          return
        }
        const ms = r.code === 429 ? Math.min(RETRY_AFTER_MAX_S, Math.max(1, r.retryAfter ?? 1)) * 1000 : 1000 * 2 ** (tries - 1)
        await this.d.sleep(ms)
      }
    }
  }
}
