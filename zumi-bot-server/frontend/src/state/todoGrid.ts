import { TODO_STATUSES, type TodoBoard, type TodoItem, type TodoStatus } from '@zumibot/shared/todos'
import type { ChatMeta } from '@zumibot/shared/types'
import { assigneeLabel, columnOf, creatorLabel, matchesFilter, type BoardFilter } from './todoBoard'

/** The To-dos page's two views: the board's columns (the default each time the app starts) or one table. */
export type TodoView = 'kanban' | 'grid'

export type GridKey = 'title' | 'status' | 'assignee' | 'creator' | 'created' | 'updated'
export interface GridSort {
  key: GridKey
  dir: 'asc' | 'desc'
}
/** Status in board order, oldest first inside each: the table reads like the board, left to right. */
export const GRID_SORT: GridSort = { key: 'status', dir: 'asc' }

export interface GridRow {
  item: TodoItem
  col: TodoStatus
}

type ChatState = Pick<ChatMeta, 'id' | 'inFlight'>

const text = (s: string): string => s.toLocaleLowerCase()
// Nobody sorts after everyone, whichever way: an empty cell never leads the table.
const who = (assignee: string | undefined): string | null => (assignee ? text(assigneeLabel(assignee)) : null)

/** Where this device keeps whether the grid shows completed cards (hidden until asked for). */
export const SHOW_DONE_KEY = 'zumibot.grid.showDone'

/**
 * The cards the board holds that pass the filter, each with its column, sorted (ties fall back to age then id): the open
 * ones, and the done ones it loaded when `showDone`.
 */
export function gridRows(
  board: TodoBoard,
  chats: readonly ChatState[],
  approvals: Readonly<Record<string, number>>,
  filter: BoardFilter,
  sort: GridSort,
  showDone = true
): GridRow[] {
  const cards = showDone ? [...board.open, ...board.done] : board.open
  const rows = cards.filter((i) => matchesFilter(i, filter)).map((item) => ({ item, col: columnOf(item, chats, approvals) }))
  const sign = sort.dir === 'asc' ? 1 : -1
  const tie = (a: GridRow, b: GridRow) => a.item.from.at - b.item.from.at || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0)
  const by = (a: GridRow, b: GridRow): number => {
    switch (sort.key) {
      case 'title':
        return sign * text(a.item.text).localeCompare(text(b.item.text))
      case 'status':
        return sign * (TODO_STATUSES.indexOf(a.col) - TODO_STATUSES.indexOf(b.col))
      case 'creator':
        return sign * text(creatorLabel(a.item.addedBy)).localeCompare(text(creatorLabel(b.item.addedBy)))
      case 'created':
        return sign * (a.item.from.at - b.item.from.at)
      case 'updated':
        return sign * (a.item.updatedAt - b.item.updatedAt)
      case 'assignee': {
        const x = who(a.item.assignee),
          y = who(b.item.assignee)
        if (x === y) return 0
        if (x === null) return 1
        if (y === null) return -1
        return sign * x.localeCompare(y)
      }
    }
  }
  return rows.sort((a, b) => by(a, b) || tie(a, b))
}

/** A click on a column's head: the same column flips its direction, another starts ascending (dates newest first). */
export function nextSort(cur: GridSort, key: GridKey): GridSort {
  if (cur.key === key) return { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
  return { key, dir: key === 'created' || key === 'updated' ? 'desc' : 'asc' }
}

/** The ids the server takes in one `todos:remove` or `todos:restore` call (`TODO_IDS_MAX` in the handlers). */
export const REMOVE_BATCH = 200

/** The checked cards still on screen, in table order: a filter or a removal never deletes a card the user cannot see. */
export function selectedRows(rows: readonly GridRow[], selected: ReadonlySet<string>): GridRow[] {
  return rows.filter((r) => selected.has(r.item.id))
}

/** One row's checkbox: on adds it, off drops it. */
export function toggleSelected(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

/** The head's checkbox: every shown row when not all are checked, else none. Checked rows a filter hides are dropped. */
export function toggleAll(rows: readonly GridRow[], selected: ReadonlySet<string>): Set<string> {
  const all = rows.length > 0 && rows.every((r) => selected.has(r.item.id))
  return all ? new Set() : new Set(rows.map((r) => r.item.id))
}

/** The head checkbox's look: none, some (indeterminate) or all of the shown rows. */
export function selectionState(rows: readonly GridRow[], selected: ReadonlySet<string>): 'none' | 'some' | 'all' {
  const n = selectedRows(rows, selected).length
  return n === 0 ? 'none' : n === rows.length ? 'all' : 'some'
}

/** Ids split into calls the server takes. */
export function batches(ids: readonly string[], size = REMOVE_BATCH): string[][] {
  const out: string[][] = []
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size))
  return out
}
