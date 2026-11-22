import type { VaultApprovalRequest } from '@zumibot/shared/vault'

/** `pending`: another card already waits on this browser; `unavailable`: the turn has no card to show. Neither is a Deny: nobody clicked. */
type Decision = 'allow' | 'deny' | 'interrupted' | 'pending' | 'unavailable'
type Final = Exclude<VaultApprovalRequest['status'], 'pending'>
type Pending = { request: VaultApprovalRequest; resolve: (d: Decision) => void; cleanup: () => void; published: Promise<void> }
type Card = (r: VaultApprovalRequest) => Promise<void>

// A card that could not be stored: logged by code only, never the error's text, which could hold a path. Only a code shaped like
// one (ENOSPC, VAULT_UNAVAILABLE) is printed; anything else, a path in a `code` property included, is the fixed word `error`.
const CODE = /^[A-Z0-9_]{1,40}$/
const storeFailed = (err?: unknown): void => {
  const code = (err as { code?: unknown } | null)?.code
  console.error('vault approval card not stored:', typeof code === 'string' && CODE.test(code) ? code : 'error')
}

/**
 * A card's first use on a site waits for the user, like a browser handoff: it has no timer of its own and ends on an answer, the
 * call's signal (Stop, the turn ending) or the server stopping. A request becomes a chat card through the callback its turn
 * registered; ids and statuses only ever pass here, never a value.
 */
export class VaultApprovals {
  private readonly pending = new Map<string, Pending>()
  private readonly finishing = new Map<string, { request: VaultApprovalRequest; completion: Promise<void> }>()
  private readonly cards = new Map<string, Card>()
  private closed = false
  constructor(private readonly o: { now: () => number; newId: () => string }) {}

  /** The turn's card callback; the returned function ends the turn's pending requests (`interrupted`), then forgets it. */
  registerTurn(turnId: string, cb: Card): () => void {
    this.cards.set(turnId, cb)
    return () => {
      const ends = this.interruptWhere((r) => r.turnId === turnId)
      const forget = () => {
        if (this.cards.get(turnId) === cb) this.cards.delete(turnId)
      }
      if (ends.length === 0) forget()
      else void Promise.all(ends).then(forget)
    }
  }

  // The final status is published through the callback before the waiter is released.
  private async publish(request: VaultApprovalRequest): Promise<void> {
    await this.cards.get(request.turnId)?.({ ...request })
  }

  request(o: Omit<VaultApprovalRequest, 'id' | 'status'>, signal: AbortSignal): Promise<Decision> {
    if (signal.aborted || this.closed) return Promise.resolve('interrupted')
    // One at a time per profile, and never one nobody can see: a turn without a card callback has no way to be answered.
    if (this.pendingId(o.profileId)) return Promise.resolve('pending')
    if (!this.cards.has(o.turnId)) return Promise.resolve('unavailable')
    const request: VaultApprovalRequest = { ...o, id: this.o.newId(), status: 'pending' }
    return new Promise((resolve) => {
      const abort = () => {
        void this.finish(request.id, 'interrupted')
      }
      const entry: Pending = { request, resolve, cleanup: () => signal.removeEventListener('abort', abort), published: Promise.resolve() }
      this.pending.set(request.id, entry)
      signal.addEventListener('abort', abort, { once: true })
      // The pending card is stored before any final update, even when the abort comes at once.
      entry.published = this.publish(request)
      void entry.published.catch((err: unknown) => {
        storeFailed(err)
        return this.finish(request.id, 'interrupted')
      })
    })
  }

  pendingId(profileId: string): string | null {
    return [...this.pending.values()].find((p) => p.request.profileId === profileId)?.request.id ?? null
  }

  async answer(chatId: string, requestId: string, decision: 'allow' | 'deny'): Promise<void> {
    const entry = this.pending.get(requestId)
    if (!entry || entry.request.chatId !== chatId) throw new Error('Stale vault request')
    await this.finish(requestId, decision === 'allow' ? 'allowed' : 'denied')
  }

  private finish(id: string, status: Final): Promise<void> {
    const entry = this.pending.get(id)
    if (!entry) return this.finishing.get(id)?.completion ?? Promise.resolve()
    this.pending.delete(id)
    entry.cleanup()
    const completion = (async () => {
      try {
        await entry.published
      } catch (err) {
        storeFailed(err) /* The waiter is released even when the card could not be stored. */
      }
      entry.request.status = status
      try {
        await this.publish(entry.request)
      } catch (err) {
        storeFailed(err) /* Same: a failed save never strands a turn. */
      }
      entry.resolve(status === 'allowed' ? 'allow' : status === 'denied' ? 'deny' : 'interrupted')
    })()
    this.finishing.set(id, { request: entry.request, completion })
    void completion.then(() => this.finishing.delete(id))
    return completion
  }

  private interruptWhere(match: (r: VaultApprovalRequest) => boolean): Promise<void>[] {
    for (const e of [...this.pending.values()]) if (match(e.request)) void this.finish(e.request.id, 'interrupted')
    return [...this.finishing.values()].filter((f) => match(f.request)).map((f) => f.completion)
  }

  /** Server stop: every waiting request ends `interrupted`, and nothing new waits. */
  async close(): Promise<void> {
    this.closed = true
    await Promise.all(this.interruptWhere(() => true))
  }
}
