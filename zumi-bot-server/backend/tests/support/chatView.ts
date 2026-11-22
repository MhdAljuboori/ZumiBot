// Test helper mirroring the frontend state/chatView.ts reducer (shared has no chatView), kept as a copy so backend tests do not import the frontend.
import type { AgentRename, ChatItem, ChatPush } from '@zumibot/shared/types'

export interface ChatViewState {
  items: ChatItem[]
  streaming: string // a single chat's live text
  streamingBy: Record<string, string> // a group's live text per member working now
}

export const emptyChatView: ChatViewState = { items: [], streaming: '', streamingBy: {} }

export function applyPush(s: ChatViewState, p: ChatPush): ChatViewState {
  switch (p.kind) {
    case 'delta':
      if (p.agent === undefined) return { ...s, streaming: s.streaming + p.text }
      return { ...s, streamingBy: { ...s.streamingBy, [p.agent]: (s.streamingBy[p.agent] ?? '') + p.text } }
    case 'items': {
      if (!p.clearStreaming) return { ...s, items: p.items }
      if (p.agent === undefined) return { items: p.items, streaming: '', streamingBy: {} }
      const { [p.agent]: _done, ...rest } = s.streamingBy
      return { ...s, items: p.items, streamingBy: rest }
    }
    case 'meta':
    case 'approvals':
      return s
  }
}

/** Moves item authors to their agent's new name after a rename; untouched items, and a list with none, keep their identity. */
export function renameItemAuthors(items: ChatItem[], renamed: readonly AgentRename[]): ChatItem[] {
  const to = (i: ChatItem) => ('agent' in i && i.agent !== undefined ? renamed.find((r) => r.from === i.agent)?.to : undefined)
  if (!items.some((i) => to(i) !== undefined)) return items
  return items.map((i) => {
    const name = to(i)
    return name === undefined ? i : { ...i, agent: name }
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
