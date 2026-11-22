// openedAgoMs: how long ago that page opened the chat; absent from a page loaded before it was sent.
export interface PresenceReport {
  deviceId: string
  chatId: string | null
  looking: boolean
  inputAgoMs: number
  openedAgoMs?: number
}

// A socket blip must not look like "stopped looking": the page reconnects and re-reports.
export const DROP_GRACE_MS = 10_000
// Chats whose last looking input is kept after the connection leaves them; the oldest goes first.
export const INPUT_CHATS_KEPT = 500

interface Conn {
  deviceId: string
  chatId: string | null
  looking: boolean
  lastInputAt: number
  // Set while a dropped socket's last report is still held through the grace.
  drop: { clear(): void } | null
}

export interface PresenceOptions {
  now(): number
  setTimer(fn: () => void, ms: number): { clear(): void }
  onStopped(chatId: string): void
  onStarted(chatId: string): void
  /** Every looking report, not only a start: a reopen while another page looks starts nothing. */
  onOpened(chatId: string, openedAt: number): void
}

// In memory only, like the sockets it mirrors. The page ends "looking" itself after
// its idle window, so nothing here re-evaluates time.
export class Presence {
  // Map order is first-seen order, which connsOf relies on.
  private readonly conns = new Map<string, Conn>()
  private readonly looked = new Map<string, number>()
  // Input seen while looking, kept per chat: the tab that saw a held event may have moved on or closed by the release.
  private readonly lastInput = new Map<string, number>()

  constructor(private readonly o: PresenceOptions) {}

  update(connId: string, r: PresenceReport): void {
    const prev = this.conns.get(connId)
    const chats = this.watched(prev, r.chatId)
    const states = chats.map((c) => [c, this.isLooking(c)] as const)
    prev?.drop?.clear()
    const now = this.o.now()
    this.conns.set(connId, {
      deviceId: r.deviceId,
      chatId: r.chatId,
      looking: r.looking && r.chatId !== null,
      lastInputAt: now - r.inputAgoMs,
      drop: null
    })
    if (r.looking && r.chatId !== null) {
      this.looked.set(r.chatId, now)
      this.keepInput(r.chatId, now - r.inputAgoMs)
    }
    this.settle(states)
    if (r.looking && r.chatId !== null && r.openedAgoMs !== undefined) this.o.onOpened(r.chatId, now - r.openedAgoMs)
  }

  drop(connId: string): void {
    const c = this.conns.get(connId)
    if (!c || c.drop) return
    if (!c.looking || c.chatId === null) {
      this.conns.delete(connId)
      return
    }
    const chatId = c.chatId
    c.drop = this.o.setTimer(() => {
      if (this.conns.get(connId) !== c) return
      const wasLooking = this.isLooking(chatId)
      this.conns.delete(connId)
      if (wasLooking && !this.isLooking(chatId)) this.stopped(chatId)
    }, DROP_GRACE_MS)
  }

  lookingAt(chatId: string): boolean {
    return this.isLooking(chatId)
  }

  inputSince(chatId: string, t: number): boolean {
    if ((this.lastInput.get(chatId) ?? -Infinity) > t) return true
    for (const c of this.conns.values()) {
      if (!c.drop && c.chatId === chatId && c.lastInputAt > t) return true
    }
    return false
  }

  lookedAt(): Record<string, number> {
    return Object.fromEntries(this.looked)
  }

  connsOf(deviceId: string): string[] {
    const out: string[] = []
    for (const [id, c] of this.conns) if (!c.drop && c.deviceId === deviceId) out.push(id)
    return out
  }

  deviceOf(connId: string): string | null {
    const c = this.conns.get(connId)
    return c && !c.drop ? c.deviceId : null
  }

  private keepInput(chatId: string, at: number): void {
    // Re-insert so Map order is least recently reported first. Never lowered: a stale second tab can report older input.
    const kept = Math.max(this.lastInput.get(chatId) ?? -Infinity, at)
    this.lastInput.delete(chatId)
    this.lastInput.set(chatId, kept)
    if (this.lastInput.size > INPUT_CHATS_KEPT) this.lastInput.delete(this.lastInput.keys().next().value as string)
  }

  // A dropped connection still counts as looking until its grace ends.
  private isLooking(chatId: string): boolean {
    for (const c of this.conns.values()) if (c.looking && c.chatId === chatId) return true
    return false
  }

  // Chats an update can change: the one the connection was on and the one it reports.
  private watched(prev: Conn | undefined, next: string | null): string[] {
    const set = new Set<string>()
    if (prev?.chatId) set.add(prev.chatId)
    if (next) set.add(next)
    return [...set]
  }

  private settle(states: readonly (readonly [string, boolean])[]): void {
    for (const [chatId, was] of states) {
      const is = this.isLooking(chatId)
      if (was && !is) this.stopped(chatId)
      else if (!was && is) this.o.onStarted(chatId)
    }
  }

  private stopped(chatId: string): void {
    this.looked.set(chatId, this.o.now())
    this.o.onStopped(chatId)
  }
}
