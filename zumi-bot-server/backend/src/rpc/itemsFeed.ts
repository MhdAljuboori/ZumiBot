import { isDeepStrictEqual } from 'node:util'
import {
  ITEMS_JUMP_MAX,
  ITEMS_PAGE,
  type ChatItem,
  type ChatPush,
  type ItemsPage,
  type ItemsSnapshot,
  type WirePush
} from '@zumibot/shared/types'

export interface ItemsFeed {
  /** The push as the socket carries it; an items list goes as the items past what the chat's last list had. */
  wire(p: ChatPush): WirePush
  /** The chat's last pushed list, or its stored one (`load`), numbered so the next push builds on it. */
  snapshot(chatId: string, load: () => Promise<ChatItem[]>): Promise<ItemsSnapshot>
  /**
   * A page of that list: the one before the item `before`, else the latest. `until`: the page reaches back to that item
   * and a few above it (at most ITEMS_JUMP_MAX items), so a jump to an old message loads in one request; an unknown one
   * is ignored.
   */
  page(chatId: string, load: () => Promise<ChatItem[]>, before?: string, until?: string): Promise<ItemsPage>
  /** The chat is gone: its last list is dropped. */
  forget(chatId: string): void
  /** Stored items were rewritten without a push (an agent rename): every chat's next push goes whole. */
  reset(): void
}

// Items are never changed in place, so an unchanged one keeps its identity; one read again from disk is compared by content.
function sharedPrefix(a: readonly ChatItem[], b: readonly ChatItem[]): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && (a[i] === b[i] || isDeepStrictEqual(a[i], b[i]))) i++
  return i
}

// A jump's page reaches this many items above its target: the target can sit mid-screen, with what led to it above,
// and is not the top item, whose arrival near the top would load the next page while the list scrolls to it.
const JUMP_LEAD = 10

/** The page of `list` ending before `end` (reaching back to index `reach` when given), with the agent messages its replies quote from before it. */
function pageOf(list: readonly ChatItem[], end: number, reach = -1): Omit<ItemsPage, 'seq'> {
  const page = end - ITEMS_PAGE
  const start = Math.max(0, reach >= 0 && reach < page ? Math.max(reach - JUMP_LEAD, end - ITEMS_JUMP_MAX) : page)
  const items = list.slice(start, end)
  const wanted = new Set(items.flatMap((i) => (i.type === 'user' && i.replyTo !== undefined ? [i.replyTo] : [])))
  const quoted = list.slice(0, start).filter((i) => i.type === 'assistant' && wanted.has(i.id))
  return { items, start, quoted }
}

/**
 * Keeps each chat's last pushed list, so a long chat does not resend its whole history on every tool call.
 * maxChats bounds what is kept: a chat dropped from it only has its next push sent whole.
 */
export function createItemsFeed(maxChats = 20): ItemsFeed {
  let seq = 0
  const last = new Map<string, ItemsSnapshot>()
  // Most recently used last, so the first key is the one to drop.
  const keep = (chatId: string, entry: ItemsSnapshot): void => {
    last.delete(chatId)
    last.set(chatId, entry)
    if (last.size > maxChats) last.delete(last.keys().next().value as string)
  }

  const snapshot = async (chatId: string, load: () => Promise<ChatItem[]>): Promise<ItemsSnapshot> => {
    const held = last.get(chatId)
    if (held) return { ...held }
    const items = await load()
    // A push while it loaded is newer than the stored list.
    const pushed = last.get(chatId)
    if (pushed) return { ...pushed }
    const entry = { items, seq: ++seq }
    keep(chatId, entry)
    return { ...entry }
  }

  return {
    wire(p) {
      if (p.kind !== 'items') return p
      const prev = last.get(p.chatId)
      const from = prev ? sharedPrefix(prev.items, p.items) : 0
      const entry = { items: p.items, seq: ++seq }
      keep(p.chatId, entry)
      // Nothing to build on: the client starts over from the latest page.
      if (!prev || from === 0) {
        const start = Math.max(0, p.items.length - ITEMS_PAGE)
        return { ...p, seq: entry.seq, base: null, from: start, items: p.items.slice(start) }
      }
      return { ...p, seq: entry.seq, base: prev.seq, from, items: p.items.slice(from) }
    },
    snapshot,
    async page(chatId, load, before, until) {
      const { items, seq } = await snapshot(chatId, load)
      const end = before === undefined ? items.length : items.findIndex((i) => i.id === before)
      if (end < 0) throw new Error('Message not found')
      const reach = until === undefined ? -1 : items.findIndex((i) => i.id === until)
      return { ...pageOf(items, end, reach), seq }
    },
    forget: (chatId) => void last.delete(chatId),
    reset: () => last.clear()
  }
}
