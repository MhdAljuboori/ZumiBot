import { LATER_GONE, LATER_MAX, laterFullText, type LaterSend } from '@zumibot/shared/later'
import type { ChatMeta, ChatPush } from '@zumibot/shared/types'
import type { ChatStore } from '../store/chatStore'

export interface LaterSendsDeps {
  store: Pick<ChatStore, 'get' | 'list' | 'patchInPlace'>
  /**
   * Sends the message into the chat as the user's own, written ahead of time (TaskQueue.submit from 'later', with `once`
   * under `messageId`). Resolves once it is stored, queued or found already there, not when its turn ends.
   */
  send(chatId: string, text: string, at: number, messageId: string): Promise<void>
  push(p: ChatPush): void
  now(): number
  newId(): string
  // A real timer when absent.
  setTimer?(fn: () => void, ms: number): { clear(): void }
  log?(line: string): void
}

const MAX_TIMER_MS = 2 ** 31 - 1
const key = (chatId: string, id: string): string => `${chatId}\n${id}`
const soonestFirst = (list: LaterSend[]): LaterSend[] => [...list].sort((a, b) => a.at - b.at || a.createdAt - b.createdAt)
const without = (cur: ChatMeta, id: string): Partial<ChatMeta> => {
  const left = (cur.later ?? []).filter((l) => l.id !== id)
  return { later: left.length > 0 ? left : undefined }
}

/**
 * `/later` (docs/architecture/agent-commands.md, /later): messages stored on the chat that go in at their time, as if the user typed them
 * then. Each is sent before it is removed, under its own id with `once`, so a crash between the two never sends it twice
 * (recover() finds it already in the chat) and never loses it. A message the chat gets meanwhile cancels nothing.
 */
export class LaterSends {
  private readonly timers = new Map<string, { clear(): void }>()
  private readonly queues = new Map<string, Promise<void>>()
  private stopped = false

  constructor(private readonly d: LaterSendsDeps) {}

  /** Stores a message to send at `at` and arms it. */
  add(chatId: string, at: number, text: string): Promise<LaterSend> {
    return this.serialize(chatId, async () => {
      if (this.stopped) throw new Error('Server is shutting down')
      const item: LaterSend = { id: this.d.newId(), at, text, createdAt: this.d.now() }
      let full = false
      // In place: a scheduled message is no news, so the sidebar order stays.
      const meta = await this.d.store.patchInPlace(chatId, (cur) => {
        if ((cur.later?.length ?? 0) >= LATER_MAX) {
          full = true
          return null
        }
        return { later: soonestFirst([...(cur.later ?? []), item]) }
      })
      if (full) throw new Error(laterFullText)
      if (!meta) throw new Error(`Chat not found: ${chatId}`)
      this.d.push({ chatId, kind: 'meta', meta })
      this.arm(chatId, item)
      return item
    })
  }

  /** The tray's ×: the message never goes. Rejects with LATER_GONE once it went or was cancelled. */
  cancel(chatId: string, id: string): Promise<void> {
    return this.serialize(chatId, async () => {
      this.disarm(chatId, id)
      const meta = await this.d.store.patchInPlace(chatId, (cur) => (cur.later?.some((l) => l.id === id) ? without(cur, id) : null))
      if (!meta) throw new Error(LATER_GONE)
      this.d.push({ chatId, kind: 'meta', meta })
    })
  }

  /** The tray's Send now: it goes in at once, as at its time. A refused send leaves it stored and armed, and rejects. */
  sendNow(chatId: string, id: string): Promise<void> {
    return this.serialize(chatId, async () => {
      if (this.stopped) throw new Error('Server is shutting down')
      const item = (await this.d.store.get(chatId))?.later?.find((l) => l.id === id)
      if (!item) throw new Error(LATER_GONE)
      await this.d.send(chatId, item.text, item.at, item.id)
      this.disarm(chatId, id)
      await this.remove(chatId, id)
    })
  }

  /** At start: arms every stored message; one whose time passed while the server was down goes at once. */
  async recover(): Promise<void> {
    for (const chat of await this.d.store.list()) for (const item of chat.later ?? []) this.arm(chat.id, item)
  }

  /** At shutdown: nothing goes while the chats stop. The messages stay stored, and recover() arms them again. */
  stop(): void {
    this.stopped = true
    for (const t of this.timers.values()) t.clear()
    this.timers.clear()
  }

  private async fire(chatId: string, id: string): Promise<void> {
    if (this.stopped) return
    const item = (await this.d.store.get(chatId))?.later?.find((l) => l.id === id)
    if (!item) return // cancelled or sent meanwhile
    try {
      await this.d.send(chatId, item.text, item.at, item.id)
    } catch (err) {
      // Kept for the next start; a send refused for good (a full queue, a command the agent lost) would only fail again.
      if (this.stopped) return
      this.log(`sending a /later message failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    await this.remove(chatId, id)
  }

  private async remove(chatId: string, id: string): Promise<void> {
    const meta = await this.d.store.patchInPlace(chatId, (cur) => (cur.later?.some((l) => l.id === id) ? without(cur, id) : null))
    if (meta) this.d.push({ chatId, kind: 'meta', meta })
  }

  private arm(chatId: string, item: LaterSend): void {
    this.disarm(chatId, item.id)
    if (this.stopped) return
    const k = key(chatId, item.id)
    const ms = Math.min(MAX_TIMER_MS, Math.max(0, item.at - this.d.now()))
    const set =
      this.d.setTimer ??
      ((fn: () => void, delay: number) => {
        const t = setTimeout(fn, delay)
        t.unref()
        return { clear: () => clearTimeout(t) }
      })
    const entry = set(() => {
      if (this.timers.get(k) !== entry) return
      this.timers.delete(k)
      if (ms === MAX_TIMER_MS)
        this.arm(chatId, item) // further out than one timer can hold
      else
        void this.serialize(chatId, () => this.fire(chatId, item.id)).catch((err: unknown) => {
          // A chat deleted meanwhile is no failure.
          if (!(err instanceof Error && err.message.startsWith('Chat not found')))
            this.log(`a /later message failed: ${err instanceof Error ? err.message : String(err)}`)
        })
    }, ms)
    this.timers.set(k, entry)
  }

  private disarm(chatId: string, id: string): void {
    const k = key(chatId, id)
    this.timers.get(k)?.clear()
    this.timers.delete(k)
  }

  // One step at a time per chat, so a Send now or × racing the timer acts on what the other left. Rejects with the
  // step's own error; the chain goes on either way.
  private serialize<T>(chatId: string, op: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(chatId) ?? Promise.resolve()).then(op)
    const tail = next.then(
      () => undefined,
      () => undefined
    )
    this.queues.set(chatId, tail)
    void tail.then(() => {
      if (this.queues.get(chatId) === tail) this.queues.delete(chatId)
    })
    return next
  }

  private log(line: string): void {
    try {
      ;(this.d.log ?? ((l: string) => console.error(l)))(line)
    } catch {
      /* logging must never fail a send */
    }
  }
}
