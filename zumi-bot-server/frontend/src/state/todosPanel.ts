import { displayName } from '@zumibot/shared/frontmatter'
import { TODO_DONE_SHOWN, TODO_USER_LABEL, TODO_USER_TURN, type TodoItem } from '@zumibot/shared/todos'

export interface TodoGroupView {
  key: string // the turn that made it
  label: string
  at: number
  /** The reply it came from, when known; the panel and the chip find the group by it. */
  itemId: string | null
  showInChat: boolean
  sections: { heading: string | null; items: TodoItem[] }[]
}

/**
 * The panel's lists: open items grouped by the reply (turn) that made them, newest first, with headings in the order
 * the agent gave them; ticked items in one list, newest tick first. A group with nothing open is not shown.
 * `visibleIds` are the chat's loaded items. Show in chat is offered for a reply among them, and also while older pages
 * are not loaded (`complete` false: the list pages back until it finds the reply, or the jump does nothing); it is
 * hidden only when the whole history is loaded and the reply is not in it (another version, or gone).
 */
export function panelView(
  items: TodoItem[],
  visibleIds: ReadonlySet<string>,
  complete: boolean
): { open: TodoGroupView[]; done: TodoItem[]; left: number } {
  const live = items.filter((i) => i.removed === null)
  const done = live.filter((i) => i.done !== null).sort((a, b) => b.done!.at - a.done!.at)
  const groups = new Map<string, TodoGroupView>()
  let left = 0
  for (const item of live) {
    if (item.done !== null) continue
    left += 1
    let g = groups.get(item.from.turn)
    if (!g) {
      g = {
        key: item.from.turn,
        label: item.from.turn === TODO_USER_TURN ? TODO_USER_LABEL : item.from.label,
        at: item.from.at,
        itemId: null,
        showInChat: false,
        sections: []
      }
      groups.set(g.key, g)
    }
    g.at = Math.max(g.at, item.from.at) // the hand-added group spans many times; its newest item places it
    // The settle after a turn fills in the reply id, so earlier items of the group may still carry null.
    if (g.itemId === null && item.from.itemId !== null) g.itemId = item.from.itemId
    const heading = item.group
    let s = g.sections.find((x) => x.heading === heading)
    if (!s) {
      s = { heading, items: [] }
      g.sections.push(s)
    }
    s.items.push(item)
  }
  const open = [...groups.values()]
  for (const g of open) g.showInChat = g.itemId !== null && (visibleIds.has(g.itemId) || !complete)
  open.sort((a, b) => b.at - a.at) // stable: groups made at the same time keep their first-seen order
  return { open, done, left }
}

/** The Done list: the newest TODO_DONE_SHOWN until the user asks for more. */
export function doneShown(done: TodoItem[], expanded: boolean): TodoItem[] {
  return expanded ? done : done.slice(0, TODO_DONE_SHOWN)
}

/** Who ticked it, when it was not the user: "by agent", or the member's name in a room. */
export function tickedByLabel(item: TodoItem, room: boolean): string | null {
  if (item.done === null || item.done.by === 'user') return null
  return room ? displayName(item.done.by) : 'by agent'
}

/** `ChatViewState.start`: nothing older is left to load only at 0 (null: the first page has not landed). */
export function historyComplete(start: number | null): boolean {
  return start === 0
}
