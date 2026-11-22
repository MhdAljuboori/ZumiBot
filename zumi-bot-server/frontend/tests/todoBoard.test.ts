import { describe, expect, it } from 'vitest'
import {
  addTodos,
  askTodo,
  assignTodo,
  boardOf,
  checkTodos,
  emptyTodos,
  reviewTodo,
  setStatus,
  startTask,
  type TodoFile
} from '@zumibot/shared/todos'
import {
  COLUMN_LABEL,
  NO_FILTER,
  assigneeLabel,
  avatarInitials,
  boardAssignees,
  boardBadge,
  boardColumns,
  boardCreators,
  cardNeighbors,
  cardStepKey,
  columnOf,
  creatorLabel,
  dropAction,
  kanbanOrder,
  filterActive,
  filterCount,
  matchesFilter,
  parseCollapsed,
  toggleCollapsed
} from '../src/state/todoBoard'

let n = 0
const newId = () => `i${++n}`
const add = (f: TodoFile, text: string, by: string, at: number): TodoFile =>
  addTodos(f, [{ text }], by, { chatId: by === 'user' ? null : 'digest-chat', turn: 't', itemId: null, label: '', at }, at, newId).file
const idOf = (f: TodoFile, text: string) => f.items.find((i) => i.text === text)!.id
const start = (f: TodoFile, text: string, agent: string, chatId: string, at: number): TodoFile => {
  const id = idOf(f, text)
  return startTask(assignTodo(f, id, agent, '/w', at).file, id, { agent, chatId, at }, at).file
}

// One card in each column: New, To do (the user's), Blocked (a question), In progress (working), In review, Done.
function sample(): TodoFile {
  let f = emptyTodos()
  for (const [t, by, at] of [
    ['Book room', 'user', 5],
    ['Reply to Morjan', 'digest', 1],
    ['Call bank', 'digest', 2],
    ['Export', 'digest', 3],
    ['Fix login', 'user', 4],
    ['Old', 'user', 0]
  ] as const)
    f = add(f, t, by, at)
  f = assignTodo(f, idOf(f, 'Call bank'), 'user', null, 10).file
  f = setStatus(f, idOf(f, 'Call bank'), 'todo', 'user', 10).file
  f = start(f, 'Export', 'builder', 'task-1', 11)
  f = askTodo(f, idOf(f, 'Export'), 'task-1', 'builder', [{ text: 'CSV?' }], 12, newId).file
  f = start(f, 'Fix login', 'builder', 'task-2', 13)
  f = reviewTodo(f, idOf(f, 'Fix login'), 'task-2', 'done', 14).file
  f = start(f, 'Book room', 'writer', 'task-3', 15)
  f = setStatus(f, idOf(f, 'Book room'), 'progress', 'user', 15).file
  f = checkTodos(f, [idOf(f, 'Old')], true, 'user', 16).file
  return f
}
const chats = [
  { id: 'task-1', inFlight: false },
  { id: 'task-2', inFlight: false },
  { id: 'task-3', inFlight: true }
]

describe('boardColumns', () => {
  it('puts each card in the column of its status, New oldest first and Done as the board answer has it', () => {
    const cols = boardColumns(boardOf(sample()), chats, {})
    const texts = Object.fromEntries(Object.entries(cols).map(([c, items]) => [c, items.map((i) => i.text)]))
    expect(texts).toEqual({
      new: ['Reply to Morjan'],
      todo: ['Call bank'],
      blocked: ['Export'],
      progress: ['Book room'],
      review: ['Fix login'],
      done: ['Old']
    })
  })

  it("filters by creator; a task chat's approval cards show its card as Blocked, its deletion as New", () => {
    const board = boardOf(sample())
    const mine = boardColumns(board, chats, {}, { ...NO_FILTER, creator: 'user' })
    expect(
      Object.values(mine)
        .flat()
        .map((i) => i.text)
        .sort()
    ).toEqual(['Book room', 'Fix login', 'Old'])
    const book = board.open.find((i) => i.text === 'Book room')!
    expect(columnOf(book, chats, { 'task-3': 1 })).toBe('blocked')
    expect(columnOf(book, [], {})).toBe('new')
  })
})

describe('moving cards', () => {
  it('moves to any other column, asking who first when nobody has a card that should start', () => {
    const nobody = {}
    const someone = { assignee: 'builder' }
    expect(dropAction(nobody, 'new', 'todo')).toEqual({ kind: 'assign', to: 'todo' })
    expect(dropAction(nobody, 'done', 'progress')).toEqual({ kind: 'assign', to: 'progress' })
    expect(dropAction(someone, 'new', 'todo')).toEqual({ kind: 'move', to: 'todo' })
    expect(dropAction(nobody, 'todo', 'review')).toEqual({ kind: 'move', to: 'review' })
    expect(dropAction(someone, 'progress', 'new')).toEqual({ kind: 'move', to: 'new' })
    expect(dropAction(someone, 'todo', 'todo')).toBeNull()
    expect([COLUMN_LABEL.blocked, COLUMN_LABEL.review]).toEqual(['Blocked', 'In review'])
  })
})

describe('badge, creators, labels', () => {
  it("counts the open cards on the user's side (not an agent's To do or In progress), capped at 99+", () => {
    // New, the user's To do, Blocked and In review; not the writer's In progress.
    expect(boardBadge(boardOf(sample()), chats, {})).toBe('4')
    expect(boardBadge(null, chats, {})).toBeNull()
    expect(boardBadge(boardOf(emptyTodos()), chats, {})).toBeNull()
    let f = emptyTodos()
    for (let k = 0; k < 120; k++) f = add(f, `t${k}`, 'user', k)
    expect(boardBadge(boardOf(f), [], {})).toBe('99+')
  })
  it('lists the user first, then agents by name; names a creator and an assignee as the UI does', () => {
    expect(boardCreators(boardOf(sample()))).toEqual(['user', 'digest'])
    expect(creatorLabel('user')).toBe('you')
    expect(creatorLabel('daily-digest')).toBe('@Daily Digest')
    expect([assigneeLabel(undefined), assigneeLabel('user'), assigneeLabel('builder')]).toEqual(['nobody', 'you', '@Builder'])
  })
})

describe('collapsed columns', () => {
  it('reads known statuses once each, in board order, and anything else as none', () => {
    expect(parseCollapsed(JSON.stringify(['done', 'new', 'done', 'mine', 3]))).toEqual(['new', 'done'])
    expect([parseCollapsed(null), parseCollapsed('{'), parseCollapsed('"done"'), parseCollapsed('{"done":1}')]).toEqual([[], [], [], []])
  })
  it('folds an open column and opens a folded one, keeping board order', () => {
    expect(toggleCollapsed(['done'], 'new')).toEqual(['new', 'done'])
    expect(toggleCollapsed(['new', 'done'], 'new')).toEqual(['done'])
    expect(toggleCollapsed([], 'review')).toEqual(['review'])
  })
})

describe('filters', () => {
  const card = {
    text: 'Export the **March** report',
    description: 'Use the sales sheet',
    addedBy: 'digest',
    assignee: 'builder'
  } as Parameters<typeof matchesFilter>[0]
  it('matches every word of the search in the title or notes, any case', () => {
    expect(matchesFilter(card, { ...NO_FILTER, text: '  march SALES ' })).toBe(true)
    expect(matchesFilter(card, { ...NO_FILTER, text: 'march budget' })).toBe(false)
  })
  it('matches the creator and the assignee, nobody as its own choice', () => {
    expect(matchesFilter(card, { ...NO_FILTER, creator: 'digest', assignee: 'builder' })).toBe(true)
    expect(matchesFilter(card, { ...NO_FILTER, creator: 'user' })).toBe(false)
    expect(matchesFilter(card, { ...NO_FILTER, assignee: 'none' })).toBe(false)
    expect(matchesFilter({ ...card, assignee: undefined }, { ...NO_FILTER, assignee: 'none' })).toBe(true)
    expect([filterActive(NO_FILTER), filterActive({ ...NO_FILTER, text: ' ' }), filterActive({ ...NO_FILTER, assignee: 'none' })]).toEqual([
      false,
      false,
      true
    ])
  })
  it('counts the filters set, for the phone Filters button', () => {
    expect(filterCount(NO_FILTER)).toBe(0)
    expect(filterCount({ ...NO_FILTER, text: '  ' })).toBe(0)
    expect(filterCount({ ...NO_FILTER, text: 'report' })).toBe(1)
    expect(filterCount({ text: 'report', creator: 'user', assignee: 'none' })).toBe(3)
  })
  it('lists the assignees on the board, you first, and filters the columns, Done included', () => {
    const board = boardOf(sample())
    expect(boardAssignees(board)).toEqual(['user', 'builder', 'writer'])
    const cols = boardColumns(board, chats, {}, { ...NO_FILTER, assignee: 'builder' })
    expect(
      Object.values(cols)
        .flat()
        .map((i) => i.text)
        .sort()
    ).toEqual(['Export', 'Fix login'])
  })
})

describe('avatarInitials', () => {
  it('reads the user as You and an agent as two letters', () => {
    expect(avatarInitials('user')).toBe('You')
    expect(avatarInitials('qa-digest')).toBe('QD')
    expect(avatarInitials('reviewer')).toBe('RE')
    expect(avatarInitials('')).toBe('?')
  })
})

describe('card stepping', () => {
  it('finds the cards either side, stopping at the ends', () => {
    expect(cardNeighbors(['a', 'b', 'c'], 'b')).toEqual({ prev: 'a', next: 'c', index: 1, total: 3 })
    expect(cardNeighbors(['a', 'b', 'c'], 'a')).toEqual({ prev: null, next: 'b', index: 0, total: 3 })
    expect(cardNeighbors(['a', 'b', 'c'], 'c')).toEqual({ prev: 'b', next: null, index: 2, total: 3 })
  })

  it('has no neighbours for a card the view does not show, or no card', () => {
    expect(cardNeighbors(['a', 'b'], 'z')).toEqual({ prev: null, next: null, index: -1, total: 2 })
    expect(cardNeighbors(['a', 'b'], null)).toEqual({ prev: null, next: null, index: -1, total: 2 })
  })

  it('reads the kanban column by column, left to right', () => {
    const card = (id: string) => ({ id }) as never
    expect(
      kanbanOrder({
        new: [card('n1'), card('n2')],
        todo: [],
        blocked: [card('b1')],
        progress: [],
        review: [card('r1')],
        done: [card('d1')]
      })
    ).toEqual(['n1', 'n2', 'b1', 'r1', 'd1'])
  })

  it('takes K and J, and the left and right arrows, but not while typing or with a modifier', () => {
    const k = (
      key: string,
      target: { tagName?: string; isContentEditable?: boolean; type?: string } | null = { tagName: 'DIV' },
      mods = {}
    ) => cardStepKey({ key, altKey: false, ctrlKey: false, metaKey: false, target, ...mods })
    expect(k('k')).toBe('prev')
    expect(k('J')).toBe('next')
    expect(k('ArrowLeft')).toBe('prev')
    expect(k('ArrowRight')).toBe('next')
    expect(k('ArrowRight', { tagName: 'TEXTAREA' })).toBeNull()
    expect(k('x')).toBeNull()
    expect(k('j', { tagName: 'TEXTAREA' })).toBeNull()
    expect(k('j', { tagName: 'INPUT', type: 'text' })).toBeNull()
    expect(k('j', { tagName: 'DIV', isContentEditable: true })).toBeNull()
    expect(k('j', { tagName: 'INPUT', type: 'checkbox' })).toBe('next')
    expect(k('j', null)).toBe('next')
    expect(k('j', undefined, { ctrlKey: true })).toBeNull()
    expect(k('k', undefined, { metaKey: true })).toBeNull()
  })
})
