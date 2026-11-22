import type { BrowserOwner } from './types'
export interface BrowserTimers {
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>
  clearTimeout(timer: ReturnType<typeof setTimeout>): void
}
export const browserTimers: BrowserTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer)
}
/** The queue limit passed; callers tell it from a cancellation by this class, not by its text. */
export class BrowserQueueTimeout extends Error {
  constructor() {
    super('Browser queue timed out')
  }
}
type Waiter = { owner: BrowserOwner; grant: () => void; reject: (error: Error) => void; untimed?: { arm(): void; disarm(): void } }
/** Releasing a command grant retains its ownership epoch until the turn relinquishes the lease. */
export interface BrowserLease {
  readonly epoch: number
  release(): void
}
type Lease = {
  id: string
  epoch: number
  owner: BrowserOwner | null
  active: boolean
  invalid: boolean
  protected: number
  paused: boolean
  idle?: ReturnType<typeof setTimeout>
  waiters: Waiter[]
  drained: (() => void)[]
}
const same = (a: BrowserOwner | null, b: BrowserOwner) => a?.turnId === b.turnId && a.chatId === b.chatId

/** A turn retains ownership between commands; only an idle turn can expire. */
export class BrowserLeases {
  private readonly entries = new Map<string, Lease>()
  private readonly ended = new Set<string>()
  private readonly timers: BrowserTimers
  /** `onRelease`: an owner's period ended (release, idle expiry, turn end, invalidation); the next grant starts a new epoch. */
  constructor(
    private readonly config: {
      leaseIdleMs: number
      queueMs: number
      timers?: BrowserTimers
      onIdle?: (profileId: string) => void
      onRelease?: (profileId: string) => void
    }
  ) {
    this.timers = config.timers ?? browserTimers
  }
  private entry(id: string): Lease {
    let lease = this.entries.get(id)
    if (!lease) {
      lease = { id, epoch: 0, owner: null, active: false, invalid: false, protected: 0, paused: false, waiters: [], drained: [] }
      this.entries.set(id, lease)
    }
    return lease
  }
  /**
   * `untimedWhilePaused`: a pause (a viewer in control) never counts toward the queue limit; the waiter
   * gets a fresh limit on resume. Only abort, turn end and invalidation end that wait.
   */
  acquire(owner: BrowserOwner, signal: AbortSignal, options: { untimedWhilePaused?: boolean } = {}): Promise<BrowserLease> {
    if (this.ended.has(owner.turnId)) return Promise.reject(new Error('Browser turn ended'))
    if (signal.aborted) return Promise.reject(new Error('Browser request cancelled'))
    const lease = this.entry(owner.profileId)
    if (lease.invalid) return Promise.reject(new Error('Browser profile invalidated'))
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const arm = () => {
        timer ??= this.timers.setTimeout(() => fail(new BrowserQueueTimeout()), this.config.queueMs)
      }
      const disarm = () => {
        if (timer) this.timers.clearTimeout(timer)
        timer = undefined
      }
      const cleanup = () => {
        disarm()
        signal.removeEventListener('abort', abort)
        lease.waiters = lease.waiters.filter((w) => w !== waiter)
      }
      const fail = (error: Error) => {
        cleanup()
        reject(error)
        this.pump(lease)
      }
      const abort = () => fail(new Error('Browser request cancelled'))
      const waiter: Waiter = {
        owner,
        reject: fail,
        ...(options.untimedWhilePaused ? { untimed: { arm, disarm } } : {}),
        grant: () => {
          cleanup()
          if (lease.idle) this.timers.clearTimeout(lease.idle)
          if (!lease.owner) lease.epoch++
          lease.owner = owner
          lease.active = true
          let released = false
          resolve({
            epoch: lease.epoch,
            release: () => {
              if (released) return
              released = true
              lease.active = false
              lease.drained.splice(0).forEach((fn) => fn())
              if (lease.invalid || this.ended.has(owner.turnId)) this.drop(lease)
              else if (!lease.protected)
                lease.idle = this.timers.setTimeout(() => {
                  this.drop(lease)
                  this.pump(lease)
                }, this.config.leaseIdleMs)
              this.pump(lease)
            }
          })
        }
      }
      if (!(waiter.untimed && lease.paused)) arm()
      signal.addEventListener('abort', abort, { once: true })
      lease.waiters.push(waiter)
      this.pump(lease)
    })
  }
  private drop(lease: Lease): void {
    if (!lease.owner) return
    lease.owner = null
    this.config.onRelease?.(lease.id)
  }
  hasDemand(profileId: string): boolean {
    const lease = this.entries.get(profileId)
    return !!lease && (!!lease.owner || lease.active || !!lease.waiters.length)
  }
  private pump(lease: Lease): void {
    if (lease.active || lease.paused) return
    const next = lease.owner ? lease.waiters.find((w) => same(lease.owner, w.owner)) : lease.waiters[0]
    next?.grant()
    if (!lease.owner && !lease.active && !lease.waiters.length) {
      for (const [id, entry] of this.entries) if (entry === lease) this.config.onIdle?.(id)
    }
  }
  release(owner: BrowserOwner): void {
    const lease = this.entry(owner.profileId)
    if (!same(lease.owner, owner) || lease.active || lease.protected) return
    if (lease.idle) this.timers.clearTimeout(lease.idle)
    this.drop(lease)
    this.pump(lease)
  }
  protect(owner: BrowserOwner): () => void {
    const lease = this.entry(owner.profileId)
    lease.protected++
    if (lease.idle) this.timers.clearTimeout(lease.idle)
    return () => {
      lease.protected--
      if (!lease.invalid && !lease.protected && !lease.active && same(lease.owner, owner)) {
        lease.idle = this.timers.setTimeout(() => {
          this.drop(lease)
          this.pump(lease)
        }, this.config.leaseIdleMs)
      }
    }
  }
  pause(profileId: string): Promise<void> {
    const lease = this.entry(profileId)
    lease.paused = true
    for (const waiter of lease.waiters) waiter.untimed?.disarm()
    return lease.active ? new Promise((resolve) => lease.drained.push(resolve)) : Promise.resolve()
  }
  resume(profileId: string): void {
    const lease = this.entry(profileId)
    lease.paused = false
    for (const waiter of lease.waiters) waiter.untimed?.arm()
    this.pump(lease)
  }
  endTurn(turnId: string): void {
    this.ended.add(turnId)
    for (const lease of this.entries.values()) {
      for (const waiter of [...lease.waiters]) if (waiter.owner.turnId === turnId) waiter.reject(new Error('Browser turn ended'))
      if (lease.owner?.turnId === turnId && !lease.active) {
        if (lease.idle) this.timers.clearTimeout(lease.idle)
        this.drop(lease)
        this.pump(lease)
      }
    }
  }
  invalidate(profileId: string): void {
    const lease = this.entry(profileId)
    lease.paused = true
    lease.invalid = true
    if (lease.idle) this.timers.clearTimeout(lease.idle)
    this.drop(lease)
    for (const waiter of [...lease.waiters]) waiter.reject(new Error('Browser profile invalidated'))
  }
  close(): void {
    for (const id of this.entries.keys()) this.invalidate(id)
  }
}
