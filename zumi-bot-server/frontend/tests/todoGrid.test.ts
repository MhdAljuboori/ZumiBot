import { describe, expect, it } from 'vitest'
import { addTodos, assignTodo, boardOf, checkTodos, emptyTodos, setStatus, type TodoFile } from '@zumibot/shared/todos'
import { NO_FILTER } from '../src/state/todoBoard'
import { GRID_SORT, batches, gridRows, nextSort, selectedRows, selectionState, toggleAll, toggleSelected } from '../src/state/todoGrid'

let n = 0
const newId = () => `g${++n}`
const add = (f: TodoFile, text: string, by: string, at: number): TodoFile =>
  addTodos(f, [{ text }], by, { chatId: null, turn: 't', itemId: null, label: '', at }, at, newId).file
const idOf = (f: TodoFile, text: string) => f.items.find((i) => i.text === text)!.id

function sample(): TodoFile {
  let f = emptyTodos()
  for (const [t, by, at] of [
    ['banana', 'user', 3],
    ['Apple', 'digest', 1],
    ['cherry', 'user', 2],
    ['date', 'user', 4]
  ] as const)
    f = add(f, t, by, at)
  f = assignTodo(f, idOf(f, 'banana'), 'user', null, 5).file
  f = setStatus(f, idOf(f, 'banana'), 'todo', 'user', 6).file
  f = assignTodo(f, idOf(f, 'cherry'), 'zed', '/w', 7).file
  f = setStatus(f, idOf(f, 'cherry'), 'review', 'user', 8).file
  f = checkTodos(f, [idOf(f, 'date')], true, 'user', 9).file
  return f
}
const texts = (rows: { item: { text: string } }[]) => rows.map((r) => r.item.text)

describe('gridRows', () => {
  it('lists open and loaded done cards with their column, in board order by default, oldest first inside', () => {
    const rows = gridRows(boardOf(sample()), [], {}, NO_FILTER, GRID_SORT)
    expect(rows.map((r) => [r.item.text, r.col])).toEqual([
      ['Apple', 'new'],
      ['banana', 'todo'],
      ['cherry', 'review'],
      ['date', 'done']
    ])
  })
  it('sorts by title without case, by assignee with nobody last both ways, and by date', () => {
    const board = boardOf(sample())
    expect(texts(gridRows(board, [], {}, NO_FILTER, { key: 'title', dir: 'desc' }))).toEqual(['date', 'cherry', 'banana', 'Apple'])
    expect(texts(gridRows(board, [], {}, NO_FILTER, { key: 'assignee', dir: 'asc' }))).toEqual(['cherry', 'banana', 'Apple', 'date'])
    expect(texts(gridRows(board, [], {}, NO_FILTER, { key: 'assignee', dir: 'desc' }))).toEqual(['banana', 'cherry', 'Apple', 'date'])
    expect(texts(gridRows(board, [], {}, NO_FILTER, { key: 'created', dir: 'desc' }))).toEqual(['date', 'banana', 'cherry', 'Apple'])
  })
  it("keeps one creator's cards under the filter", () => {
    expect(texts(gridRows(boardOf(sample()), [], {}, { ...NO_FILTER, creator: 'digest' }, GRID_SORT))).toEqual(['Apple'])
  })
})

describe('gridRows filters', () => {
  it('hides completed cards unless asked, and applies search and assignee', () => {
    const board = boardOf(sample())
    expect(texts(gridRows(board, [], {}, NO_FILTER, GRID_SORT, false))).toEqual(['Apple', 'banana', 'cherry'])
    expect(texts(gridRows(board, [], {}, { ...NO_FILTER, text: 'AN' }, GRID_SORT, true))).toEqual(['banana'])
    expect(texts(gridRows(board, [], {}, { ...NO_FILTER, assignee: 'none' }, GRID_SORT, true))).toEqual(['Apple', 'date'])
    expect(texts(gridRows(board, [], {}, { ...NO_FILTER, assignee: 'zed' }, GRID_SORT, false))).toEqual(['cherry'])
  })
})

describe('nextSort', () => {
  it('flips the same column, starts another ascending, and dates newest first', () => {
    expect(nextSort(GRID_SORT, 'status')).toEqual({ key: 'status', dir: 'desc' })
    expect(nextSort(GRID_SORT, 'title')).toEqual({ key: 'title', dir: 'asc' })
    expect(nextSort(GRID_SORT, 'updated')).toEqual({ key: 'updated', dir: 'desc' })
  })
})

describe('grid selection', () => {
  const rows = () => gridRows(boardOf(sample()), [], {}, NO_FILTER, GRID_SORT)
  it('toggles one row on and off', () => {
    const id = rows()[0]!.item.id
    const on = toggleSelected(new Set(), id)
    expect([...on]).toEqual([id])
    expect(toggleSelected(on, id).size).toBe(0)
  })
  it('selects every shown row, then none, and reads none, some or all', () => {
    const r = rows()
    expect(selectionState(r, new Set())).toBe('none')
    expect(selectionState(r, new Set([r[1]!.item.id]))).toBe('some')
    const all = toggleAll(r, new Set([r[1]!.item.id]))
    expect(all.size).toBe(r.length)
    expect(selectionState(r, all)).toBe('all')
    expect(toggleAll(r, all).size).toBe(0)
    expect(selectionState([], new Set())).toBe('none')
  })
  it('counts only checked rows still shown, in table order', () => {
    const board = boardOf(sample())
    const r = gridRows(board, [], {}, NO_FILTER, GRID_SORT)
    const sel = new Set([r[2]!.item.id, r[0]!.item.id, 'gone'])
    expect(texts(selectedRows(r, sel))).toEqual(['Apple', 'cherry'])
    const filtered = gridRows(board, [], {}, { ...NO_FILTER, creator: 'digest' }, GRID_SORT)
    expect(texts(selectedRows(filtered, sel))).toEqual(['Apple'])
  })
  it('splits ids into calls the server takes', () => {
    const ids = Array.from({ length: 450 }, (_, i) => `t${i}`)
    expect(batches(ids).map((b) => b.length)).toEqual([200, 200, 50])
    expect(batches([])).toEqual([])
  })
})
