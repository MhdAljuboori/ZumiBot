import type { ChatPush, SuggestedReplies } from '@zumibot/shared/types'
import type { ChatStore } from '../store/chatStore'
import { replyInput, skipsChat, type ReplyOptionsAnswer, type ReplyOptionsInput } from './replyOptions'

export interface ReplyOptionsDeps {
  store: Pick<ChatStore, 'get' | 'loadItems' | 'patchInPlace'>
  push(p: ChatPush): void
  enabled(): Promise<boolean>
  // A run holds the chat: true from its claim on, before its meta is stored as inFlight.
  running(chatId: string): boolean
  // Null: no answer (claude missing, a failure, the timeout, an abort); nothing is stored then.
  read(chatId: string, input: ReplyOptionsInput, signal: AbortSignal): Promise<ReplyOptionsAnswer | null>
}

const same = (a: SuggestedReplies | undefined, b: SuggestedReplies): boolean =>
  a !== undefined &&
  a.after === b.after &&
  a.question === b.question &&
  a.summary === b.summary &&
  a.options.length === b.options.length &&
  a.options.every((o, i) => o === b.options[i])

/** Reads a chat's last reply once it goes idle and offers the user's next message (see docs/architecture/ui.md). */
export class ReplyOptions {
  private readonly reads = new Map<string, AbortController>()
  private closed = false

  constructor(private readonly d: ReplyOptionsDeps) {}

  async idle(chatId: string): Promise<void> {
    // Whatever this idle finds, the earlier read was for a reply that is no longer the one to offer for.
    this.reads.get(chatId)?.abort()
    this.reads.delete(chatId)
    try {
      if (this.closed || !(await this.d.enabled())) return
      const meta = await this.d.store.get(chatId)
      if (!meta || meta.inFlight || meta.pause || skipsChat(meta) || this.d.running(chatId)) return
      // A queued message starts on its own right after this idle, unless the tray is held: its run would refuse the write.
      if ((meta.tasks?.length ?? 0) > 0 && !meta.held) return
      const items = await this.d.store.loadItems(chatId)
      // Nothing new since the last read (a Compact adds no item): the same reply is never paid for twice.
      if (items.length === 0 || items[items.length - 1].id === meta.suggested?.after) return
      const read = replyInput(meta, items)
      // Checked again after the awaits: a turn that ends while the server stops must spawn no call.
      if (!read || this.closed) return
      const ctl = new AbortController()
      this.reads.set(chatId, ctl)
      let answer: ReplyOptionsAnswer | null
      try {
        answer = await this.d.read(chatId, read.input, ctl.signal)
      } finally {
        if (this.reads.get(chatId) === ctl) this.reads.delete(chatId)
      }
      if (answer === null || ctl.signal.aborted) return
      const { options, question, summary } = answer
      // The question and summary only frame options: with none to offer they are dropped.
      const framed = options.length > 0
      const next: SuggestedReplies = {
        after: read.after,
        options,
        ...(framed && question !== '' ? { question } : {}),
        ...(framed && summary !== '' ? { summary } : {})
      }
      // A turn that started meanwhile owns the chat now; the frontend also hides options whose reply is no longer last.
      const saved = await this.d.store.patchInPlace(chatId, (cur) =>
        cur.inFlight || cur.pause || this.d.running(chatId) || same(cur.suggested, next) ? null : { suggested: next }
      )
      if (saved) this.d.push({ chatId, kind: 'meta', meta: saved })
    } catch (err) {
      // Only the code: an fs error names the data folder, and chat text must never reach a log.
      const code = (err as { code?: unknown } | null)?.code
      console.error('reply options failed:', chatId, typeof code === 'string' ? code : 'error')
    }
  }

  close(): void {
    this.closed = true
    for (const ctl of this.reads.values()) ctl.abort()
    this.reads.clear()
  }
}
