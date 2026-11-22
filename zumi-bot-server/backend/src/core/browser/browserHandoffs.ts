import { safeBrowserSite } from '@zumibot/shared/browser'
import type { BrowserHandoff, BrowserOwner, BrowserResult } from './types'
import { browserTimers, type BrowserTimers } from './browserLeases'
type Pending = {
  handoff: BrowserHandoff
  resolve: (result: BrowserResult) => void
  cleanup: () => void
  timer?: ReturnType<typeof setTimeout>
}
export interface BrowserHandoffDependencies {
  idleMs: number
  now: () => number
  newId: () => string
  agent: (profileId: string) => string
  onHandoff: (handoff: BrowserHandoff) => Promise<void>
  timers?: BrowserTimers
}
export class BrowserHandoffs {
  private readonly pending = new Map<string, Pending>()
  private readonly finishing = new Map<string, { handoff: BrowserHandoff; completion: Promise<void> }>()
  private readonly viewed = new Set<string>()
  private readonly callbacks = new Map<string, (handoff: BrowserHandoff) => Promise<void>>()
  private readonly timers: BrowserTimers
  constructor(private readonly deps: BrowserHandoffDependencies) {
    this.timers = deps.timers ?? browserTimers
  }
  registerTurn(turnId: string, callback: (handoff: BrowserHandoff) => Promise<void>): () => void {
    this.callbacks.set(turnId, callback)
    return () => {
      if (this.callbacks.get(turnId) === callback) this.callbacks.delete(turnId)
    }
  }
  private async publish(handoff: BrowserHandoff): Promise<void> {
    await this.deps.onHandoff({ ...handoff })
    await this.callbacks.get(handoff.turnId)?.({ ...handoff })
  }
  request(owner: BrowserOwner, generation: string, site: string, reason: string, signal: AbortSignal): Promise<BrowserResult> {
    if (signal.aborted) return Promise.resolve({ ok: false, code: 'handoff_interrupted', message: 'Browser request interrupted' })
    if (this.pendingId(owner.profileId))
      return Promise.resolve({ ok: false, code: 'handoff_pending', message: 'A browser request is already pending' })
    const handoff: BrowserHandoff = {
      ...owner,
      id: this.deps.newId(),
      generation,
      site: safeBrowserSite(site),
      reason,
      createdAt: this.deps.now(),
      agent: this.deps.agent(owner.profileId),
      status: 'pending'
    }
    return new Promise((resolve) => {
      const abort = () => {
        void this.finish(handoff.id, 'interrupted')
      }
      const entry: Pending = { handoff, resolve, cleanup: () => signal.removeEventListener('abort', abort) }
      this.pending.set(handoff.id, entry)
      signal.addEventListener('abort', abort, { once: true })
      this.arm(entry)
      // Persist pending before final updates even when cancellation arrives immediately.
      const publish = this.publish(handoff)
      entry.cleanup = () => signal.removeEventListener('abort', abort)
      this.publications.set(handoff.id, publish)
      void publish.catch(() => this.finish(handoff.id, 'interrupted'))
    })
  }
  private readonly publications = new Map<string, Promise<void>>()
  private arm(entry: Pending): void {
    if (entry.timer) this.timers.clearTimeout(entry.timer)
    entry.timer = undefined
    if (!this.viewed.has(entry.handoff.profileId))
      entry.timer = this.timers.setTimeout(() => {
        void this.finish(entry.handoff.id, 'expired')
      }, this.deps.idleMs)
  }
  setViewed(profileId: string, visible: boolean): void {
    if (this.viewed.has(profileId) === visible) return
    if (visible) this.viewed.add(profileId)
    else this.viewed.delete(profileId)
    for (const entry of this.pending.values()) if (entry.handoff.profileId === profileId) this.arm(entry)
  }
  pendingId(profileId: string): string | null {
    return [...this.pending.values()].find((p) => p.handoff.profileId === profileId)?.handoff.id ?? null
  }
  async answer(requestId: string, profileId: string, generation: string, decision: 'done' | 'cancel'): Promise<void> {
    const entry = this.pending.get(requestId)
    if (!entry || entry.handoff.profileId !== profileId || entry.handoff.generation !== generation)
      throw new Error('Stale browser action request')
    await this.finish(requestId, decision === 'done' ? 'done' : 'cancelled')
  }
  private finish(id: string, status: Exclude<BrowserHandoff['status'], 'pending'>): Promise<void> {
    const entry = this.pending.get(id)
    if (!entry) return this.finishing.get(id)?.completion ?? Promise.resolve()
    this.pending.delete(id)
    entry.cleanup()
    if (entry.timer) this.timers.clearTimeout(entry.timer)
    const initial = this.publications.get(id)
    this.publications.delete(id)
    const completion = (async () => {
      try {
        await initial
      } catch {
        /* Still release the waiter if persistence failed. */
      }
      entry.handoff.status = status
      try {
        await this.publish(entry.handoff)
      } catch {
        /* Persistence must not strand a turn. */
      }
      entry.resolve(
        status === 'done' ? { ok: true, data: { status } } : { ok: false, code: `handoff_${status}`, message: `Browser request ${status}` }
      )
    })()
    this.finishing.set(id, { handoff: entry.handoff, completion })
    void completion.then(() => this.finishing.delete(id))
    return completion
  }
  async endTurn(turnId: string): Promise<void> {
    for (const entry of this.pending.values()) if (entry.handoff.turnId === turnId) void this.finish(entry.handoff.id, 'interrupted')
    await Promise.all([...this.finishing.values()].filter((p) => p.handoff.turnId === turnId).map((p) => p.completion))
    this.callbacks.delete(turnId)
  }
  async invalidate(profileId: string): Promise<void> {
    for (const entry of this.pending.values()) if (entry.handoff.profileId === profileId) void this.finish(entry.handoff.id, 'interrupted')
    await Promise.all([...this.finishing.values()].filter((p) => p.handoff.profileId === profileId).map((p) => p.completion))
  }
  async renameAgent(profileId: string, agent: string): Promise<void> {
    for (const entry of this.pending.values())
      if (entry.handoff.profileId === profileId) {
        entry.handoff.agent = agent
        await this.publish(entry.handoff)
      }
  }
  async close(): Promise<void> {
    for (const id of this.pending.keys()) void this.finish(id, 'interrupted')
    await Promise.all([...this.finishing.values()].map((p) => p.completion))
  }
}
