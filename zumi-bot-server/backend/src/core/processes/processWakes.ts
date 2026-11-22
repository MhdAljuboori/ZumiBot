import { WAKE_NOTES, WAKE_PER_CHAT_HOUR, WAKE_PER_SERVER_HOUR, wakeMessage, type WakeEvent } from '@zumibot/shared/processes'

const HOUR = 3_600_000

export interface ProcessWakesDeps {
  /** Posts the wake message through the chat's task queue as `'process'`: its claim, queue, pause hold and limit wait. */
  submit(chatId: string, text: string, messageId: string): Promise<unknown>
  /** A turn runs in the chat now: the wake-up waits for its idle. */
  running(chatId: string): boolean
  /** null once the chat is gone. `taskIds`: its queued messages, so a wake-up still waiting there is joined, not doubled. */
  chat(chatId: string): Promise<{ archived: boolean; room: boolean; taskIds: readonly string[] } | null>
  /** The first of these agents past its daily spend cap, or null (SpendCaps.gate). */
  gate(agents: readonly string[]): Promise<string | null>
  /** Why an event woke nobody, on its process's row; and that one went out, which clears it. */
  note(processId: string, note: string): Promise<void>
  sent(processId: string): Promise<void>
  now(): number
  newId(): string
}

/**
 * Wake-ups (docs/architecture/processes.md, Phase 3). Events wait per chat while a turn runs or an earlier wake message is still
 * queued there, and go out joined in one message at the chat's next idle. Before anything is sent: a closed chat drops them,
 * an agent past its daily spend cap drops its own, and the hourly caps (per chat, per server) drop the rest, each noted on
 * its process so the user sees why nothing came. Nothing here survives a restart: the processes do not either.
 */
export class ProcessWakes {
  private readonly waiting = new Map<string, WakeEvent[]>()
  private readonly queued = new Map<string, string>()
  private readonly chatSent = new Map<string, number[]>()
  private serverSent: number[] = []
  private readonly locks = new Map<string, Promise<void>>()

  constructor(private readonly d: ProcessWakesDeps) {}

  /** A rule fired. */
  event(e: WakeEvent): void {
    const list = this.waiting.get(e.chatId) ?? []
    list.push(e)
    this.waiting.set(e.chatId, list)
    this.flush(e.chatId)
  }

  /** The chat's turn ended (ChatService's onIdle): what waited goes out now. */
  idle(chatId: string): void {
    if (this.waiting.has(chatId)) this.flush(chatId)
  }

  /** A deleted chat keeps nothing. */
  forget(chatId: string): void {
    this.waiting.delete(chatId)
    this.queued.delete(chatId)
    this.chatSent.delete(chatId)
  }

  /** For tests and the panel: events waiting in a chat. */
  pending(chatId: string): number {
    return this.waiting.get(chatId)?.length ?? 0
  }

  // One flush per chat at a time: an event during a flush is picked up by the next one.
  private flush(chatId: string): void {
    const prev = this.locks.get(chatId) ?? Promise.resolve()
    const next = prev
      .then(() => this.send(chatId))
      .catch((err: unknown) => {
        const code = (err as { code?: unknown } | null)?.code
        console.error('process wake-up failed:', typeof code === 'string' ? code : 'error')
      })
    this.locks.set(chatId, next)
    void next.then(() => {
      if (this.locks.get(chatId) === next) this.locks.delete(chatId)
    })
  }

  private async send(chatId: string): Promise<void> {
    let events = this.waiting.get(chatId)
    if (!events?.length) return
    // Never while a turn runs: its idle flushes.
    if (this.d.running(chatId)) return
    const chat = await this.d.chat(chatId)
    if (!chat || chat.archived) {
      this.waiting.delete(chatId)
      if (chat) await this.noteAll(events, WAKE_NOTES.closed)
      return
    }
    // An earlier wake message still queued (a paused chat, a limit wait): these join the next one, after it went.
    const earlier = this.queued.get(chatId)
    if (earlier !== undefined && chat.taskIds.includes(earlier)) return
    this.queued.delete(chatId)
    // Taken now: an event arriving while the awaits below run waits for the next flush.
    this.waiting.delete(chatId)
    // The spend cap of each starter: its own events are dropped, the others' still go.
    const over = new Set<string>()
    for (const agent of new Set(events.map((e) => e.startedBy))) if ((await this.d.gate([agent])) !== null) over.add(agent)
    if (over.size > 0) {
      await this.noteAll(
        events.filter((e) => over.has(e.startedBy)),
        WAKE_NOTES.spendCap
      )
      events = events.filter((e) => !over.has(e.startedBy))
      if (events.length === 0) return
    }
    const now = this.d.now()
    const mine = (this.chatSent.get(chatId) ?? []).filter((t) => now - t < HOUR)
    this.serverSent = this.serverSent.filter((t) => now - t < HOUR)
    if (mine.length >= WAKE_PER_CHAT_HOUR) {
      this.chatSent.set(chatId, mine)
      await this.noteAll(events, WAKE_NOTES.chatCap)
      return
    }
    if (this.serverSent.length >= WAKE_PER_SERVER_HOUR) {
      await this.noteAll(events, WAKE_NOTES.serverCap)
      return
    }
    mine.push(now)
    this.chatSent.set(chatId, mine)
    this.serverSent.push(now)
    const messageId = this.d.newId()
    this.queued.set(chatId, messageId)
    // In a room the starters are named, so the moderator hands it to them.
    const text = wakeMessage(events, chat.room ? [...new Set(events.map((e) => e.startedBy))] : [])
    for (const id of new Set(events.map((e) => e.id))) await this.d.sent(id).catch(() => {})
    // Not awaited: a single chat's submit settles only when the turn it starts ends.
    void this.d.submit(chatId, text, messageId).catch((err: unknown) => {
      const code = (err as { code?: unknown } | null)?.code
      console.error('process wake-up not sent:', typeof code === 'string' ? code : 'error')
    })
  }

  private async noteAll(events: readonly WakeEvent[], note: string): Promise<void> {
    for (const id of new Set(events.map((e) => e.id))) await this.d.note(id, note).catch(() => {})
  }
}
