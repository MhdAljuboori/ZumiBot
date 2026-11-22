import { pruneEntries, summaryOf, type DispatchEntry, type DispatchFile, type DispatchSummary } from '@zumibot/shared/dispatch'
import type { ChatItem } from '@zumibot/shared/types'
import { DispatchRecorder } from './dispatchRecorder'

export interface DispatchDeps {
  store: {
    loadDispatch(id: string): Promise<DispatchFile>
    updateDispatch(id: string, fn: (f: DispatchFile) => DispatchFile): Promise<DispatchFile>
    loadItems(id: string): Promise<ChatItem[]>
  }
  /** Every tab is told after each save; clients refetch on every event. */
  onChanged: (chatId: string) => void
  now: () => number
  privateTool: (name: string) => 'browser' | 'desktop' | 'vault' | null
  delayMs?: number
}

const DEFAULT_DELAY_MS = 1000
const HELD_CHATS = 20

/** Sets the key as the newest, dropping the oldest past the cap. */
function hold<T>(map: Map<string, T>, key: string, value: T): T {
  map.delete(key)
  map.set(key, value)
  if (map.size > HELD_CHATS) map.delete(map.keys().next().value!)
  return value
}

function held<T>(map: Map<string, T>, key: string): T | undefined {
  const v = map.get(key)
  if (v !== undefined) hold(map, key, v)
  return v
}

const toolIds = (items: readonly ChatItem[]): ReadonlySet<string> => new Set(items.flatMap((i) => (i.type === 'tool' ? [i.id] : [])))

/** Live entries replace stored ones with the same id; new ones go after them. */
function merged(stored: DispatchEntry[], live: DispatchEntry[]): DispatchEntry[] {
  const byId = new Map(live.map((e) => [e.id, e]))
  const out = stored.map((e) => byId.get(e.id) ?? e)
  const seen = new Set(stored.map((e) => e.id))
  return [...out, ...live.filter((e) => !seen.has(e.id))]
}

/**
 * The chats' dispatched agents: each running turn records into a DispatchRecorder; this keeps those live, saves them
 * coalesced (a burst of subagent lines is one write and one event), and serves the panel's reads.
 */
export class DispatchService {
  private readonly live = new Map<string, Set<DispatchRecorder>>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  // Each tab refetches the list on every event (about once a second while a turn runs), so neither the chat's items nor
  // its file are read from disk again: the items come from every save (noteItems), the entries from this service's own
  // writes. A disk read only fills an empty slot, so a read that started before a save never overwrites it. Only the
  // chats used last are held.
  private readonly tools = new Map<string, ReadonlySet<string>>()
  private readonly stored = new Map<string, DispatchEntry[]>()

  constructor(private readonly d: DispatchDeps) {}

  begin(chatId: string, o: { turn: string; member?: string }): DispatchRecorder {
    const rec = new DispatchRecorder({ ...o, now: this.d.now, privateTool: this.d.privateTool, onChange: () => this.schedule(chatId) })
    let set = this.live.get(chatId)
    if (!set) {
      set = new Set()
      this.live.set(chatId, set)
    }
    set.add(rec)
    return rec
  }

  /** The turn is over: its entries are written now and it stops counting as live. Never throws. */
  async finish(chatId: string, rec: DispatchRecorder): Promise<void> {
    const timer = this.timers.get(chatId)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.timers.delete(chatId)
    }
    try {
      await this.flush(chatId, [...(this.live.get(chatId) ?? [])])
    } finally {
      const set = this.live.get(chatId)
      set?.delete(rec)
      if (set && set.size === 0) this.live.delete(chatId)
      // Another turn of the room may still be recording: its next change schedules its own save.
      if (set && set.size > 0) this.schedule(chatId)
    }
  }

  renameAgent(from: string, to: string): void {
    for (const set of this.live.values()) for (const rec of set) rec.rename(from, to)
    for (const [chatId, entries] of this.stored) {
      if (entries.some((e) => e.member === from))
        this.stored.set(
          chatId,
          entries.map((e) => (e.member === from ? { ...e, member: to } : e))
        )
    }
  }

  /** Every saved item list of a chat (ChatStore's items listener): which Agent rows are visible now. */
  noteItems(chatId: string, items: readonly ChatItem[]): void {
    hold(this.tools, chatId, toolIds(items))
  }

  async list(chatId: string): Promise<DispatchSummary[]> {
    const [entries, tools] = await Promise.all([this.read(chatId), this.visibleTools(chatId)])
    const liveIds = new Set(this.liveEntries(chatId).map((e) => e.id))
    const byId = new Map(entries.map((e) => [e.id, e]))
    // An edited or resent message's hidden version hides its agents with it; switching back shows them again.
    const rootOf = (e: DispatchEntry): DispatchEntry => {
      let cur = e
      const seen = new Set<string>()
      while (cur.parent !== null && !seen.has(cur.id)) {
        seen.add(cur.id)
        const up = byId.get(cur.parent)
        if (!up) break
        cur = up
      }
      return cur
    }
    return entries.filter((e) => liveIds.has(e.id) || tools.has(rootOf(e).id)).map(summaryOf)
  }

  /**
   * One entry. With `from`, only the steps from that index on, so an open conversation fetches what is new. An entry whose
   * middle was dropped has shifted indexes, so it always comes whole (`from` 0).
   */
  async get(chatId: string, id: string, from?: number): Promise<{ entry: DispatchEntry; from: number } | null> {
    const entry = (await this.read(chatId)).find((e) => e.id === id)
    if (!entry) return null
    const whole = from === undefined || from > entry.steps.length || entry.steps.some((s) => s.kind === 'gap')
    return whole ? { entry, from: 0 } : { entry: { ...entry, steps: entry.steps.slice(from) }, from }
  }

  private liveEntries(chatId: string): DispatchEntry[] {
    return [...(this.live.get(chatId) ?? [])].flatMap((rec) => rec.entries())
  }

  /** Stored entries under the live ones. A stored entry still running that no turn records was cut off by a restart. */
  private async read(chatId: string): Promise<DispatchEntry[]> {
    const live = this.liveEntries(chatId)
    const liveIds = new Set(live.map((e) => e.id))
    const stored = (await this.storedOf(chatId)).map((e) =>
      e.status === 'running' && !liveIds.has(e.id) ? { ...e, status: 'interrupted' as const, now: null } : e
    )
    return merged(stored, live)
  }

  private async storedOf(chatId: string): Promise<DispatchEntry[]> {
    const have = held(this.stored, chatId)
    if (have) return have
    const entries = (await this.d.store.loadDispatch(chatId)).entries
    return this.stored.get(chatId) ?? hold(this.stored, chatId, entries)
  }

  private async visibleTools(chatId: string): Promise<ReadonlySet<string>> {
    const have = held(this.tools, chatId)
    if (have) return have
    const ids = toolIds(await this.d.store.loadItems(chatId))
    return this.tools.get(chatId) ?? hold(this.tools, chatId, ids)
  }

  // While a turn runs its entries live in memory, where every read finds them: tabs are told, nothing is written. The
  // file is written once, when the turn finishes (a restart mid-turn loses that turn's entries, like its unsaved text).
  private schedule(chatId: string): void {
    if (this.timers.has(chatId)) return
    this.timers.set(
      chatId,
      setTimeout(() => {
        this.timers.delete(chatId)
        this.d.onChanged(chatId)
      }, this.d.delayMs ?? DEFAULT_DELAY_MS)
    )
  }

  private async flush(chatId: string, recs: DispatchRecorder[]): Promise<void> {
    const live = recs.flatMap((rec) => rec.entries())
    if (live.length === 0) return
    try {
      const next = await this.d.store.updateDispatch(chatId, (f) => ({ v: 1, entries: pruneEntries(merged(f.entries, live)) }))
      hold(this.stored, chatId, next.entries)
      this.d.onChanged(chatId)
    } catch (err) {
      // A chat deleted mid-turn has nothing left to record into.
      if (err instanceof Error && err.message.startsWith('Chat not found')) return
      // Only the code: an fs error names the data folder, and entries hold tool output.
      const code = (err as { code?: unknown } | null)?.code
      console.error('dispatched agents not saved:', chatId, typeof code === 'string' ? code : 'error')
    }
  }
}
