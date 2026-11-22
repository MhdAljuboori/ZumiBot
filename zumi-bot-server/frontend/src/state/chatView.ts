import type { AgentRename, ChatItem, ItemsPage, WirePush } from '@zumibot/shared/types'

export type ItemsPush = Extract<WirePush, { kind: 'items' }>

export interface ChatViewState {
  items: ChatItem[] // the loaded end of the chat's history
  start: number | null // how many older items are not loaded; null: nothing loaded yet
  quoted: ChatItem[] // agent messages that loaded replies quote, from before the loaded items
  streaming: string // a single chat's live text
  streamingBy: Record<string, string> // a group's live text per member working now
  thought: string // a single chat's thinking as it streams
  thoughtBy: Record<string, string> // a group's per member working now
}

export const emptyChatView: ChatViewState = {
  items: [],
  start: null,
  quoted: [],
  streaming: '',
  streamingBy: {},
  thought: '',
  thoughtBy: {}
}

/** A chat just created: nothing to load. */
export const newChatView: ChatViewState = { ...emptyChatView, start: 0 }

// With an agent, clearStreaming clears only that agent's live text. A live thought goes with it: the push that ends it is
// either the kept thought or a later item of the turn.
function clearLive(s: ChatViewState, p: ItemsPush): ChatViewState {
  if (!p.clearStreaming) return s
  if (p.agent === undefined) return { ...s, streaming: '', streamingBy: {}, thought: '', thoughtBy: {} }
  const { [p.agent]: _done, ...rest } = s.streamingBy
  const { [p.agent]: _thought, ...thoughts } = s.thoughtBy
  return { ...s, streamingBy: rest, thoughtBy: thoughts }
}

/**
 * An items push must fit the list the view holds (see itemSync): a delta keeps the items before history index `from`
 * and adds its own; a fresh list replaces everything.
 */
export function applyPush(s: ChatViewState, p: WirePush): ChatViewState {
  switch (p.kind) {
    case 'delta':
      if (p.thought) {
        if (p.agent === undefined) return { ...s, thought: s.thought + p.text }
        return { ...s, thoughtBy: { ...s.thoughtBy, [p.agent]: (s.thoughtBy[p.agent] ?? '') + p.text } }
      }
      if (p.agent === undefined) return { ...s, streaming: s.streaming + p.text }
      return { ...s, streamingBy: { ...s.streamingBy, [p.agent]: (s.streamingBy[p.agent] ?? '') + p.text } }
    case 'items':
      if (p.base === null) return loadedPage(clearLive(s, p), { items: p.items, start: p.from, seq: p.seq, quoted: [] })
      return { ...clearLive(s, p), items: [...s.items.slice(0, p.from - (s.start ?? 0)), ...p.items] }
    case 'meta':
    case 'approvals':
      return s
  }
}

/** An items push that does not fit: the chat reloads its items, but the live text the push ends still goes. */
export const skipPush = (s: ChatViewState, p: ItemsPush): ChatViewState => clearLive(s, p)

/**
 * The chat's latest page replaces what the view held; its live text stays. When the page lines up with the held items
 * (a reload after a reconnect), the older ones above it stay too, so a reader scrolled up keeps their place.
 */
export function loadedPage(s: ChatViewState, page: ItemsPage): ChatViewState {
  const first = page.items[0]
  const at = first && s.start !== null ? s.items.findIndex((i) => i.id === first.id) : -1
  if (at > 0 && s.start !== null && s.start + at === page.start) {
    const known = new Set(page.quoted.map((i) => i.id))
    return { ...s, items: [...s.items.slice(0, at), ...page.items], quoted: [...page.quoted, ...s.quoted.filter((i) => !known.has(i.id))] }
  }
  return { ...s, items: page.items, start: page.start, quoted: page.quoted }
}

/**
 * An older page goes above the loaded items. Dropped when the view was reloaded since it was asked for (`before` is gone
 * from the top), or when it does not end where the loaded items start.
 */
export function prependPage(s: ChatViewState, page: ItemsPage, before: string): ChatViewState {
  if (s.items[0]?.id !== before || page.start + page.items.length !== s.start) return s
  const known = new Set(s.quoted.map((i) => i.id))
  return {
    ...s,
    items: [...page.items, ...s.items],
    start: page.start,
    quoted: [...s.quoted, ...page.quoted.filter((i) => !known.has(i.id))]
  }
}

/** Moves item authors to their agent's new name after a rename; untouched items, and a list with none, keep their identity. */
export function renameItemAuthors(items: ChatItem[], renamed: readonly AgentRename[]): ChatItem[] {
  const to = (i: ChatItem) => ('agent' in i && i.agent !== undefined ? renamed.find((r) => r.from === i.agent)?.to : undefined)
  if (!items.some((i) => to(i) !== undefined)) return items
  return items.map((i) => {
    const name = to(i)
    return name === undefined
      ? i
      : i.type === 'browser-action'
        ? { ...i, agent: name, handoff: { ...i.handoff, agent: name } }
        : { ...i, agent: name }
  })
}

/** renameItemAuthors over every loaded chat; views a rename does not touch, and the record when none is, keep their identity. */
export function renameViewAuthors(views: Record<string, ChatViewState>, renamed: readonly AgentRename[]): Record<string, ChatViewState> {
  let changed = false
  const next: Record<string, ChatViewState> = {}
  for (const [id, v] of Object.entries(views)) {
    const items = renameItemAuthors(v.items, renamed)
    if (items !== v.items) changed = true
    next[id] = items === v.items ? v : { ...v, items }
  }
  return changed ? next : views
}
