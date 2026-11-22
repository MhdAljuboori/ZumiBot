import type { ChatItem } from '@zumibot/shared/types'
import type { ChatStore } from '../store/chatStore'
import {
  SEARCH_PAGE,
  SEARCH_TEXT_MAX,
  emptyResult,
  hasPhrases,
  parseQuery,
  phraseText,
  plainText,
  snippet,
  textTokens,
  type SearchHit,
  type SearchQuery,
  type SearchResult,
  type SearchRole
} from '@zumibot/shared/search'

/** A searchable message: a user message or an agent reply, as the chat shows it (hidden versions never get here). */
interface Doc {
  chatId: string
  itemId: string
  role: SearchRole
  agent: string | null
  ts: number
  text: string
}

type Meta = Omit<Doc, 'chatId' | 'itemId'>

/** How long a chat's saves settle before it is indexed again: a running turn saves about once a second. */
const SETTLE_MS = 2000
/** A phrase is checked against at most this many of the newest messages holding its words. */
const VERIFY_MAX = 2000
/** Dead entries stay in the token lists until there are more of them than live ones (and at least this many). */
const COMPACT_MIN = 5000

function metaOf(it: ChatItem): Meta | null {
  if (it.type === 'user') return it.text.trim() === '' ? null : { role: 'user', agent: it.from ?? null, ts: it.ts, text: it.text }
  if (it.type === 'assistant')
    return it.text.trim() === '' ? null : { role: 'assistant', agent: it.agent ?? null, ts: it.ts, text: it.text }
  return null
}

export interface SearchIndexDeps {
  store: Pick<ChatStore, 'list' | 'loadItems'>
  log(line: string): void
  /** Overrides SETTLE_MS (tests). */
  settleMs?: number
}

/**
 * A full-text index over every chat's messages, in memory: built once at start from `chats/*.json`, then kept by the
 * store's items listener (`note`, settled per chat) and its removal listener (`remove`). Words map to the messages
 * holding them; a message whose text changes gets a new number and the old one is dropped lazily, so a save never
 * walks the token lists. Message text is kept for snippets; nothing here is written to disk or logged.
 */
export class SearchIndex {
  private docs: Array<Doc | undefined> = []
  private chats = new Map<string, Map<string, number>>() // chat -> item id -> doc number
  private postings = new Map<string, number[]>() // token -> doc numbers, ascending; may hold dead ones
  private live = 0
  private dead = 0
  private readonly pending = new Map<string, { items: readonly ChatItem[]; timer: ReturnType<typeof setTimeout> }>()
  // Chats written or removed while build reads: what the listeners saw is newer than the read.
  private readonly touched = new Set<string>()
  private building = false
  private built = false
  private run: Promise<void> | null = null
  private stopped = false
  private readonly settleMs: number

  constructor(private readonly d: SearchIndexDeps) {
    this.settleMs = d.settleMs ?? SETTLE_MS
  }

  /** Builds the index in the background; searches meanwhile say `indexing`. */
  start(): void {
    this.run ??= this.build().catch(() => {
      // Never the error: its text could carry a path or message text.
      this.d.log('search index: build failed')
    })
  }

  private async build(): Promise<void> {
    this.building = true
    try {
      for (const chat of await this.d.store.list()) {
        if (this.stopped) return
        if (this.touched.has(chat.id)) continue
        let items: ChatItem[]
        try {
          items = await this.d.store.loadItems(chat.id)
        } catch {
          this.d.log(`search index: skipped ${chat.id}`)
          continue
        }
        // A save or a removal may have landed during the read.
        if (this.stopped) return
        if (this.touched.has(chat.id)) continue
        this.apply(chat.id, items)
        // A long history is many files: the server answers between them.
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      this.built = true
    } finally {
      this.building = false
      this.touched.clear()
    }
  }

  /** A chat's items were saved; indexed once its saves settle, so a running turn is not indexed on every save. */
  note(chatId: string, items: readonly ChatItem[]): void {
    if (this.stopped) return
    if (this.building) this.touched.add(chatId)
    const held = this.pending.get(chatId)
    if (held) {
      held.items = items
      return
    }
    const entry = {
      items,
      timer: setTimeout(() => {
        this.pending.delete(chatId)
        this.apply(chatId, entry.items)
      }, this.settleMs)
    }
    entry.timer.unref?.()
    this.pending.set(chatId, entry)
  }

  /** The chat is gone: its messages leave at once. */
  remove(chatId: string): void {
    if (this.building) this.touched.add(chatId)
    const held = this.pending.get(chatId)
    if (held) clearTimeout(held.timer)
    this.pending.delete(chatId)
    for (const n of this.chats.get(chatId)?.values() ?? []) this.kill(n)
    this.chats.delete(chatId)
    this.compactIfNeeded()
  }

  /** Indexes every settling chat now (tests, and a search right after a save in them). */
  flush(): void {
    for (const [chatId, held] of [...this.pending]) {
      clearTimeout(held.timer)
      this.pending.delete(chatId)
      this.apply(chatId, held.items)
    }
  }

  /** Resolves once the build started by `start` ended (done, failed or stopped). */
  whenBuilt(): Promise<void> {
    return this.run ?? Promise.resolve()
  }

  /** Stops the build and the settle timers; resolves once the build's current read is done. */
  async stop(): Promise<void> {
    this.stopped = true
    for (const held of this.pending.values()) clearTimeout(held.timer)
    this.pending.clear()
    await this.run
  }

  private apply(chatId: string, items: readonly ChatItem[]): void {
    const prev = this.chats.get(chatId)
    const next = new Map<string, number>()
    for (const it of items) {
      if (next.has(it.id)) continue
      const meta = metaOf(it)
      if (!meta) continue
      const old = prev?.get(it.id)
      const doc = old === undefined ? undefined : this.docs[old]
      if (old !== undefined && doc && doc.text === meta.text) {
        // Same words: an agent rename or a restamp changes only what the hit shows.
        if (doc.agent !== meta.agent || doc.ts !== meta.ts || doc.role !== meta.role) this.docs[old] = { ...doc, ...meta }
        next.set(it.id, old)
        continue
      }
      next.set(it.id, this.add({ chatId, itemId: it.id, ...meta }))
    }
    for (const [id, n] of prev ?? []) if (next.get(id) !== n) this.kill(n)
    if (next.size > 0) this.chats.set(chatId, next)
    else this.chats.delete(chatId)
    this.compactIfNeeded()
  }

  private add(doc: Doc): number {
    const n = this.docs.length
    this.docs.push(doc)
    this.live++
    for (const t of textTokens(doc.text)) {
      const list = this.postings.get(t)
      if (list) list.push(n)
      else this.postings.set(t, [n])
    }
    return n
  }

  private kill(n: number): void {
    if (!this.docs[n]) return
    this.docs[n] = undefined
    this.live--
    this.dead++
  }

  /** Renumbers the live messages and rebuilds the token lists, once dead entries outweigh live ones. */
  private compactIfNeeded(): void {
    if (this.dead < COMPACT_MIN || this.dead <= this.live) return
    const docs = this.docs.filter((d): d is Doc => d !== undefined)
    this.docs = []
    this.postings = new Map()
    this.chats = new Map()
    this.live = 0
    this.dead = 0
    for (const doc of docs) {
      const n = this.add(doc)
      const of = this.chats.get(doc.chatId) ?? new Map<string, number>()
      of.set(doc.itemId, n)
      this.chats.set(doc.chatId, of)
    }
  }

  /** How many messages are indexed (tests and the log). */
  size(): number {
    return this.live
  }

  /**
   * The messages matching `raw`, newest first, `offset` hits in. `listed`: whether a chat still exists (the index can
   * hold a chat a moment past its removal).
   */
  search(raw: string, offset: number, listed: (chatId: string) => boolean, limit = SEARCH_PAGE): SearchResult {
    const indexing = !this.built
    const q = parseQuery(raw)
    if (!q) return emptyResult(indexing)
    const found = this.matching(q, listed)
    let hits = found
    let capped = false
    if (q.phrases.length > 0) {
      capped = found.length > VERIFY_MAX
      hits = found.slice(0, VERIFY_MAX).filter((n) => hasPhrases(phraseText(this.docs[n]!.text), q))
    }
    const page = hits.slice(offset, offset + limit).map((n) => this.hit(this.docs[n]!, q))
    return { hits: page, total: hits.length, capped, more: offset + limit < hits.length || capped, indexing }
  }

  /** Every live message holding all the query's words, newest first. */
  private matching(q: SearchQuery, listed: (chatId: string) => boolean): number[] {
    const n = this.docs.length
    if (n === 0) return []
    // Each term's token lists: the word itself, or every token it starts (one pass over the words for all of them).
    const lists: number[][][] = q.terms.map(() => [])
    q.terms.forEach((t, i) => {
      if (t.prefix) return
      const list = this.postings.get(t.token)
      if (list) lists[i].push(list)
    })
    if (q.terms.some((t) => t.prefix)) {
      for (const [token, list] of this.postings) {
        q.terms.forEach((t, i) => {
          if (t.prefix && token.startsWith(t.token)) lists[i].push(list)
        })
      }
    }
    if (lists.some((l) => l.length === 0)) return []
    // The rarest term first: each later one only counts messages every earlier one matched, and counts each once (a
    // prefix reaches a message through several of its tokens), since a counted one no longer equals k.
    const order = lists.map((l, i) => ({ i, size: l.reduce((s, x) => s + x.length, 0) })).sort((a, b) => a.size - b.size)
    const count = new Uint8Array(n)
    order.forEach(({ i }, k) => {
      for (const list of lists[i]) {
        for (const doc of list) if (count[doc] === k) count[doc] = k + 1
      }
    })
    const all = q.terms.length
    const out: number[] = []
    for (let doc = 0; doc < n; doc++) {
      const d = this.docs[doc]
      if (count[doc] === all && d && listed(d.chatId)) out.push(doc)
    }
    return out.sort((a, b) => this.docs[b]!.ts - this.docs[a]!.ts || b - a)
  }

  private hit(d: Doc, q: SearchQuery): SearchHit {
    const text = d.text.length > SEARCH_TEXT_MAX ? d.text.slice(0, SEARCH_TEXT_MAX) : d.text
    return { chatId: d.chatId, itemId: d.itemId, role: d.role, agent: d.agent, ts: d.ts, ...snippet(plainText(text), q) }
  }
}
