import type { ChatMeta, ChatPush } from '@zumibot/shared/types'
import type { TurnEnd } from '@zumibot/shared/notify'
import { isUnread, markOn } from '@zumibot/shared/unread'
import type { ChatStore } from '../store/chatStore'

/** A room's turn end: `passed` is a member that took its turn but chose not to speak. */
export interface RoomTurnEnd extends TurnEnd {
  passed: boolean
}

export interface ReadMarksDeps {
  store: Pick<ChatStore, 'patchInPlace'>
  lookingAt(chatId: string): boolean
  push(p: ChatPush): void
  now(): number
  log(line: string): void
}

type Patch = Partial<Omit<ChatMeta, 'id' | 'updatedAt'>>

/** Sets `replyAt` / `seenAt` / `mark` on a chat's meta. Every hook resolves: a mark must never reach a chat's turn. */
export class ReadMarks {
  constructor(private readonly d: ReadMarksDeps) {}

  /** ChatService's hook. A room's turns end through `roomTurnEnded`, so they are skipped here. */
  turnEnded(e: TurnEnd): Promise<void> {
    if (e.outcome === 'stopped') return Promise.resolve()
    return this.mark('turn end', e.chatId, (cur) => (cur.group ? null : this.replied(e.chatId, cur, e.asked === true)))
  }

  /** GroupService's hook; a pass said nothing, so there is nothing to read. */
  roomTurnEnded(e: RoomTurnEnd): Promise<void> {
    if (e.outcome === 'stopped' || e.passed) return Promise.resolve()
    return this.mark('room turn end', e.chatId, (cur) => this.replied(e.chatId, cur))
  }

  /** Someone started looking at the chat: what it holds is seen. A look start can be a refocus, so a mark stays. */
  started(chatId: string): Promise<void> {
    return this.mark('look start', chatId, (cur) => (isUnread(cur) && !markOn(cur) ? { seenAt: this.seen(cur) } : null))
  }

  /** Someone looked away: only a running chat has anything they were watching arrive. */
  stopped(chatId: string): Promise<void> {
    return this.mark('look stop', chatId, (cur) => (cur.inFlight && !markOn(cur) ? { seenAt: this.seen(cur) } : null))
  }

  /** A page looking at the chat opened it at `openedAt`: only an open after the mark ends it. */
  opened(chatId: string, openedAt: number): Promise<void> {
    return this.mark('open', chatId, (cur) =>
      cur.mark && markOn(cur) && openedAt > cur.mark.at ? { seenAt: Math.max(this.seen(cur), cur.mark.at), mark: undefined } : null
    )
  }

  /** The user's "Mark unread" from a message at `from`. Unlike the hooks it rejects, so a failure reaches the user. */
  async markUnread(chatId: string, from: number): Promise<ChatMeta> {
    // Past seenAt even when that is ahead of the clock (synced from a faster one), or the mark would never be on.
    const meta = await this.d.store.patchInPlace(chatId, (cur) => ({ mark: { at: Math.max(this.d.now(), (cur.seenAt ?? 0) + 1), from } }))
    if (!meta) throw new Error('Chat not found')
    this.d.push({ chatId, kind: 'meta', meta })
    return meta
  }

  /** Never before replyAt: a synced chat's replyAt can come from a faster clock, and it would stay unread while looked at. */
  private seen(cur: ChatMeta): number {
    return Math.max(this.d.now(), cur.replyAt ?? 0)
  }

  private replied(chatId: string, cur: ChatMeta, asked = false): Patch {
    const at = this.d.now()
    // An asked chat is read-only and its reply went to the asker, so it is never left unread.
    if (asked) return { replyAt: at, seenAt: Math.max(at, cur.seenAt ?? 0) }
    // Only an open ends a mark, so a reply seen meanwhile is left unread with it.
    return this.d.lookingAt(chatId) && !markOn(cur) ? { replyAt: at, seenAt: at } : { replyAt: at }
  }

  private async mark(what: string, chatId: string, fn: (cur: ChatMeta) => Patch | null): Promise<void> {
    try {
      const meta = await this.d.store.patchInPlace(chatId, fn)
      if (meta) this.d.push({ chatId, kind: 'meta', meta })
    } catch {
      // The error can quote chat text, so only the step is logged.
      this.safeLog(`read marks: ${what} failed`)
    }
  }

  private safeLog(line: string): void {
    try {
      this.d.log(line)
    } catch {
      // A broken logger must not turn into an unhandled rejection.
    }
  }
}
