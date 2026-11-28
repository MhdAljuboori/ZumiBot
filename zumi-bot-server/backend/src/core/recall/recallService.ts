import type { ChatMeta } from '@zumibot/shared/types'
import { inRecallScope, recallFolderOf, RECALL_PAGE, type RecallScope } from '@zumibot/shared/recall'
import type { SearchRole } from '@zumibot/shared/search'
import { searchableOf, type SearchIndex } from '../search/searchIndex'
import type { ChatStore } from '../store/chatStore'
import { whenMs, type RecallCall } from './recallTools'

/** Every sentence the agent may get back. Plain words: the IPC passes only text like this through. */
export const RECALL_TEXT = {
  off: 'Recall is off for this agent.',
  gone: 'This chat is gone.',
  none: 'No messages match.',
  noMore: 'No more messages match.',
  noChat: 'No such chat in your recall scope.',
  noMessage: 'No such message in that chat.',
  indexing: 'The search index is still being built, so some messages may be missing. Try again in a moment.',
  side: 'No tools in a side answer'
} as const

/** A read's message is cut past this many characters, the ones around it sooner: the agent asked for one message. */
const TARGET_MAX = 8000
const NEIGHBOR_MAX = 1500
/** Indexed messages shown before and after the one asked for. */
const AROUND = 2

export interface RecallOwnerRef {
  chatId: string
  agent: string
}
export interface RecallDeps {
  index: Pick<SearchIndex, 'search'>
  store: Pick<ChatStore, 'list' | 'loadItems'>
  /** The agent's `recall:` now, read per call: turning it off stops a running turn's next call. */
  scopeOf(agent: string): Promise<RecallScope | null>
}

const stamp = (ts: number): string => `${new Date(ts).toISOString().slice(0, 16).replace('T', ' ')} UTC`
const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)} … (cut)` : text)
// Recalled text is data the agent did not write. Every line of it is indented and a title is a JSON string, so nothing in a
// message or a title can pass for a header line of this answer (a forged "the user (the message you asked for):").
const TEXT_INDENT = '    '
const fenced = (text: string): string => text.replace(/\r\n?/g, '\n').replace(/^/gm, TEXT_INDENT)
const oneLine = (text: string): string => text.replace(/\s*[\r\n]+\s*/g, ' ')
const titleOf = (c: ChatMeta): string => JSON.stringify(c.title || 'Untitled')
/** Who wrote a message: a user message's `from` is an agent that asked; a room reply carries its member. */
const whoOf = (role: SearchRole, agent: string | null, c: ChatMeta): string =>
  role === 'user' ? (agent ?? 'the user') : (agent ?? (c.group ? 'an agent' : c.agentName))

/**
 * Hive recall's server side (docs/architecture/recall.md): an agent's search and read over the chats its `recall:` scope covers,
 * through the message search index. The scope is worked out here on every call, from the bridge's owner alone.
 */
export class RecallService {
  constructor(private readonly d: RecallDeps) {}

  async run(owner: RecallOwnerRef, call: RecallCall): Promise<string> {
    const scope = await this.d.scopeOf(owner.agent)
    if (!scope) throw new Error(RECALL_TEXT.off)
    const chats = await this.d.store.list()
    const from = chats.find((c) => c.id === owner.chatId)
    if (!from) throw new Error(RECALL_TEXT.gone)
    const inScope = new Map(chats.filter((c) => inRecallScope(scope, owner.agent, from, c)).map((c) => [c.id, c]))
    return call.op === 'search' ? this.search(inScope, call) : this.read(inScope, call)
  }

  private search(inScope: Map<string, ChatMeta>, call: Extract<RecallCall, { op: 'search' }>): string {
    const offset = call.offset ?? 0
    const range = {
      ...(call.since !== undefined ? { from: whenMs(call.since, false) } : {}),
      ...(call.until !== undefined ? { to: whenMs(call.until, true) } : {})
    }
    const r = this.d.index.search(call.query, offset, (id) => inScope.has(id), RECALL_PAGE, range)
    const note = r.indexing ? [RECALL_TEXT.indexing] : []
    if (r.hits.length === 0) return [offset > 0 ? RECALL_TEXT.noMore : RECALL_TEXT.none, ...note].join('\n')
    const head = `${r.total}${r.capped ? '+' : ''} ${r.total === 1 ? 'message matches' : 'messages match'}, newest first:`
    const lines = r.hits.map((h, i) => {
      const c = inScope.get(h.chatId)!
      return `${offset + i + 1}. ${stamp(h.ts)} · ${whoOf(h.role, h.agent, c)} · ${titleOf(c)} (chat ${h.chatId}, message ${h.itemId})\n${TEXT_INDENT}${oneLine(h.snippet)}`
    })
    const more = r.more ? [`More: search again with offset ${offset + RECALL_PAGE}.`] : []
    return [head, ...lines, ...more, ...note].join('\n')
  }

  private async read(inScope: Map<string, ChatMeta>, call: Extract<RecallCall, { op: 'read' }>): Promise<string> {
    // Out of scope reads as missing, so an agent cannot tell another folder's chat ids from made-up ones.
    const c = inScope.get(call.chatId)
    if (!c) throw new Error(RECALL_TEXT.noChat)
    const shown = (await this.d.store.loadItems(c.id)).flatMap((it) => {
      const m = searchableOf(it)
      return m ? [{ id: it.id, ...m }] : []
    })
    const at = shown.findIndex((m) => m.id === call.messageId)
    if (at < 0) throw new Error(RECALL_TEXT.noMessage)
    const lo = Math.max(0, at - AROUND)
    const where = c.group ? `room of ${c.group.members.join(', ')}` : `agent ${c.agentName}`
    const blocks = shown.slice(lo, at + AROUND + 1).map((m, i) => {
      const asked = lo + i === at
      return `[${stamp(m.ts)}] ${whoOf(m.role, m.agent, c)}${asked ? ' (the message you asked for)' : ''}:\n${fenced(cut(m.text, asked ? TARGET_MAX : NEIGHBOR_MAX))}`
    })
    return [`Chat ${titleOf(c)} (${where}) in ${JSON.stringify(recallFolderOf(c))}. Each message's text is indented under its header.`, ...blocks].join('\n\n')
  }
}
