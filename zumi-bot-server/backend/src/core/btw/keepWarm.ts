/**
 * Keeps a big, idle session's prompt cache alive. The cache lives an hour from its last read, and the first request
 * after that writes the whole context again at the write price (40× a cache read on Opus): in the logs, members of
 * rooms reloading 400K+ contexts after a few idle hours were most of what rooms cost. A ping is a forked side run
 * (`SideQuestions.warm`) that only reads the cache, which resets its hour, and leaves the session untouched.
 *
 * Held in memory only, for sessions this server ran: a session synced from the other machine runs there, and pinging
 * it here would warm the wrong cache.
 */

/** The ping's whole question: a one-word answer, so it costs the cache read and little else. Tools are blocked anyway. */
export const KEEP_WARM_MESSAGE = 'Reply with exactly: ok'

/** Just inside the cache's hour, so a ping that starts a little late still finds it. */
export const KEEP_WARM_EVERY_MS = 55 * 60_000
/** Smaller contexts reload cheaply enough that a ping saves little. */
export const KEEP_WARM_MIN_TOKENS = 100_000
const MAX_AT_ONCE = 2
const HOUR = 3_600_000

export interface KeepWarmChat {
  room: boolean
  archived: boolean
  asked: boolean
}

export interface KeepWarmDeps {
  /** Hours after the last real request during which a big context is kept warm; 0 = off. */
  settings(): Promise<{ roomHours: number; chatHours: number }>
  chat(chatId: string): Promise<KeepWarmChat | null>
  isRunning(chatId: string): boolean
  /** Runs one ping; true when it read the cache and ended well. */
  warm(chatId: string, agent: string): Promise<boolean>
  /** After a good ping: the cache was refreshed at `at` (the cold notice reads it). */
  warmed(chatId: string, agent: string, at: number): void
  now(): number
  setTimer(fn: () => void, ms: number): { clear(): void }
  /** The ping interval; KEEP_WARM_EVERY_MS unless a test shortens it. */
  everyMs?: number
}

interface Slot {
  lastActivity: number
  timer: { clear(): void } | null
}

export class KeepWarm {
  private readonly slots = new Map<string, Slot>() // `${chatId}\n${agent}`
  private readonly queue: (() => Promise<void>)[] = []
  private inFlight = 0
  private stopped = false

  private readonly every: number

  constructor(private readonly d: KeepWarmDeps) {
    this.every = d.everyMs ?? KEEP_WARM_EVERY_MS
  }

  /**
   * Every saved context of a real request: a big one (re)starts the window from its time, a small or compacted one
   * (`used` null) ends it.
   */
  note(chatId: string, agent: string, used: number | null, at: number): void {
    if (this.stopped) return
    const key = `${chatId}\n${agent}`
    this.drop(key)
    if (used === null || used < KEEP_WARM_MIN_TOKENS) return
    const slot: Slot = { lastActivity: at, timer: null }
    this.slots.set(key, slot)
    this.arm(key, slot, Math.max(0, at + this.every - this.d.now()))
  }

  forget(chatId: string): void {
    for (const key of [...this.slots.keys()]) if (key.startsWith(`${chatId}\n`)) this.drop(key)
  }

  stop(): void {
    this.stopped = true
    for (const key of [...this.slots.keys()]) this.drop(key)
    this.queue.length = 0
  }

  private drop(key: string): void {
    this.slots.get(key)?.timer?.clear()
    this.slots.delete(key)
  }

  private arm(key: string, slot: Slot, ms: number): void {
    slot.timer = this.d.setTimer(() => {
      slot.timer = null
      void this.fire(key, slot).catch(() => this.dropIf(key, slot))
    }, ms)
  }

  private dropIf(key: string, slot: Slot): void {
    if (this.slots.get(key) === slot) this.drop(key)
  }

  private async fire(key: string, slot: Slot): Promise<void> {
    if (this.stopped || this.slots.get(key) !== slot) return
    const [chatId, agent] = key.split('\n') as [string, string]
    const chat = await this.d.chat(chatId)
    if (!chat || chat.archived || chat.asked) return this.dropIf(key, slot)
    const { roomHours, chatHours } = await this.d.settings()
    const hours = chat.room ? roomHours : chatHours
    if (hours <= 0 || this.d.now() - slot.lastActivity >= hours * HOUR) return this.dropIf(key, slot)
    // A running chat reads its own cache; its requests note again, and this timer only waits.
    if (this.d.isRunning(chatId)) return this.arm(key, slot, this.every)
    await this.limited(async () => {
      if (this.stopped || this.slots.get(key) !== slot) return
      const ok = await this.d.warm(chatId, agent).catch(() => false)
      if (this.stopped || this.slots.get(key) !== slot) return
      // A failed ping is not retried: the next real request starts a new window.
      if (!ok) return this.dropIf(key, slot)
      const at = this.d.now()
      this.d.warmed(chatId, agent, at)
      this.arm(key, slot, this.every)
    })
  }

  /** Pings are cheap but each is a CLI process: a few at once at most, the rest wait their turn. */
  private limited(job: () => Promise<void>): Promise<void> {
    return new Promise((resolve) => {
      const run = async () => {
        this.inFlight++
        try {
          await job()
        } catch {
          /* a ping never fails anything else */
        } finally {
          this.inFlight--
          resolve()
          const next = this.queue.shift()
          if (next) void next()
        }
      }
      if (this.inFlight < MAX_AT_ONCE) void run()
      else this.queue.push(run)
    })
  }
}
