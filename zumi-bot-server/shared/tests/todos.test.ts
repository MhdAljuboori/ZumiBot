import { describe, expect, it } from 'vitest'
import {
  TODO_TOOLS,
  addTodos,
  changesSince,
  checkTodos,
  emptyTodos,
  liveTodos,
  normalizeTodoText,
  openTodos,
  boardOf,
  cardAskPrompt,
  removeTodos,
  restoreTodos,
  splitTodo,
  withTodoTools
} from '@zumibot/shared/todos'

const from = { chatId: 'chat-1', turn: 't1', itemId: 'i1', label: '/my-day', at: 1 }
let n = 0
const newId = () => `id${++n}`
const add = (f = emptyTodos(), texts: string[] = ['a', 'b'], by = 'Work', now = 10) =>
  addTodos(
    f,
    texts.map((text) => ({ text })),
    by,
    from,
    now,
    newId
  )

describe('splitTodo', () => {
  it('reads /todo at index 0 only', () => {
    expect(splitTodo('/todo /my-day')).toEqual({ todo: true, rest: '/my-day' })
    expect(splitTodo('/todo')).toEqual({ todo: true, rest: '' })
    expect(splitTodo('/todo\n  hi')).toEqual({ todo: true, rest: 'hi' })
    expect(splitTodo('/todos x').todo).toBe(false)
    expect(splitTodo('x /todo').todo).toBe(false)
    expect(splitTodo(' /todo x').todo).toBe(false)
  })
  it('leaves other text untouched', () => expect(splitTodo(' hi ')).toEqual({ todo: false, rest: ' hi ' }))
})

describe('normalizeTodoText', () => {
  it('collapses whitespace to one line', () => expect(normalizeTodoText('  a\nb\r\n c ')).toBe('a b c'))
  it('caps at 300', () => expect(normalizeTodoText('x'.repeat(400))).toHaveLength(300))
})

describe('addTodos', () => {
  it('adds items and bumps rev once for the call', () => {
    const r = addTodos(emptyTodos(), [{ text: ' Reply to Morjan ', group: ' Slack\n ' }, { text: 'b' }], 'Work', from, 10, newId)
    expect(r.file.rev).toBe(1)
    expect(r.added).toHaveLength(2)
    expect(r.added.map((i) => i.rev)).toEqual([1, 1])
    expect(r.added[0]).toMatchObject({
      text: 'Reply to Morjan',
      group: 'Slack',
      from,
      addedBy: 'Work',
      done: null,
      removed: null,
      last: { action: 'added', by: 'Work', at: 10 },
      updatedAt: 10
    })
    expect(r.added[1].group).toBeNull()
    expect(r.file.items).toEqual(r.added)
  })
  it('caps the group at 60 characters', () => {
    const r = addTodos(emptyTodos(), [{ text: 'a', group: 'g'.repeat(100) }], 'u', from, 1, newId)
    expect(r.added[0].group).toHaveLength(60)
  })
  it('does not change the input file', () => {
    const f = emptyTodos()
    add(f)
    expect(f).toEqual(emptyTodos())
  })
  it('skips an open item with the same text, but a done one does not block', () => {
    const first = add(emptyTodos(), ['Reply to Morjan'])
    const second = addTodos(first.file, [{ text: ' Reply to Morjan ' }], 'Work', from, 11, newId)
    expect(second.added).toEqual([])
    expect(second.skipped).toEqual(['Reply to Morjan'])
    expect(second.file).toBe(first.file) // nothing changed, no rev bump
    const done = checkTodos(first.file, [first.added[0].id], true, 'user', 12).file
    const third = addTodos(done, [{ text: 'Reply to Morjan' }], 'Work', from, 13, newId)
    expect(third.added).toHaveLength(1)
    expect(third.skipped).toEqual([])
  })
  it('skips repeats inside one call and empty text', () => {
    const r = add(emptyTodos(), ['x', ' x ', '  '])
    expect(r.added).toHaveLength(1)
    expect(r.skipped).toEqual(['x'])
  })
  it('refuses more than 50 items per add', () => {
    expect(() =>
      add(
        emptyTodos(),
        Array.from({ length: 51 }, (_, i) => `t${i}`)
      )
    ).toThrow('At most 50 items per add')
    expect(
      add(
        emptyTodos(),
        Array.from({ length: 50 }, (_, i) => `t${i}`)
      ).added
    ).toHaveLength(50)
  })
  it('refuses to pass 500 open items on the board', () => {
    let f = emptyTodos()
    for (let b = 0; b < 10; b++)
      f = add(
        f,
        Array.from({ length: 50 }, (_, i) => `b${b}-${i}`)
      ).file
    expect(openTodos(f)).toHaveLength(500)
    expect(() => add(f, ['one more'])).toThrow('The board has 500 open to-dos')
    // a done or removed item frees a slot
    f = checkTodos(f, [f.items[0].id], true, 'user', 50).file
    expect(add(f, ['one more']).added).toHaveLength(1)
  })
})

describe('check / remove / restore', () => {
  const base = add()
  const [a, b] = base.added
  it('ticks and unticks', () => {
    const t = checkTodos(base.file, [a.id], true, 'user', 20)
    expect(t.file.rev).toBe(2)
    expect(t.changed).toHaveLength(1)
    expect(t.changed[0]).toMatchObject({
      id: a.id,
      done: { at: 20, by: 'user' },
      last: { action: 'ticked', by: 'user', at: 20 },
      rev: 2,
      updatedAt: 20
    })
    expect(t.file.items.find((i) => i.id === b.id)).toBe(b)
    const u = checkTodos(t.file, [a.id], false, 'Work', 30)
    expect(u.changed[0]).toMatchObject({ done: null, last: { action: 'unticked', by: 'Work', at: 30 }, rev: 3 })
  })
  it('does nothing when already in that state or unknown', () => {
    const t = checkTodos(base.file, [a.id, 'nope'], false, 'user', 20)
    expect(t.changed).toEqual([])
    expect(t.file).toBe(base.file)
  })
  it('bumps rev once for many ids', () => {
    const t = checkTodos(base.file, [a.id, b.id], true, 'user', 20)
    expect(t.file.rev).toBe(2)
    expect(t.changed.map((i) => i.rev)).toEqual([2, 2])
  })
  it('removes (tombstone) and restores', () => {
    const r = removeTodos(base.file, [a.id], 'user', 20)
    expect(r.changed[0]).toMatchObject({ removed: { at: 20, by: 'user' }, last: { action: 'removed', by: 'user', at: 20 } })
    expect(r.file.items).toHaveLength(2)
    expect(liveTodos(r.file).map((i) => i.id)).toEqual([b.id])
    expect(openTodos(r.file).map((i) => i.id)).toEqual([b.id])
    expect(removeTodos(r.file, [a.id], 'user', 21).changed).toEqual([])
    expect(checkTodos(r.file, [a.id], true, 'user', 21).changed).toEqual([]) // removed items cannot be ticked
    const s = restoreTodos(r.file, [a.id], 'user', 30)
    expect(s.changed[0]).toMatchObject({ removed: null, last: { action: 'restored', by: 'user', at: 30 } })
    expect(liveTodos(s.file)).toHaveLength(2)
  })
  it('restore is a no-op on a live item', () => {
    const s = restoreTodos(base.file, [a.id], 'user', 30)
    expect(s.changed).toEqual([])
    expect(s.file.rev).toBe(base.file.rev)
  })
  it('openTodos leaves out done items', () => {
    const t = checkTodos(base.file, [a.id], true, 'user', 20).file
    expect(openTodos(t).map((i) => i.id)).toEqual([b.id])
    expect(liveTodos(t)).toHaveLength(2)
  })
})

describe('changesSince', () => {
  it("leaves out the reader's own changes and older ones", () => {
    const f1 = add(emptyTodos(), ['a', 'b'], 'Work').file // rev 1
    const f2 = checkTodos(f1, [f1.items[0].id], true, 'user', 20).file // rev 2
    const f3 = removeTodos(f2, [f2.items[1].id], 'Other', 30).file // rev 3
    expect(changesSince(f3, 0, 'Work').map((i) => i.last.action)).toEqual(['ticked', 'removed'])
    expect(changesSince(f3, 2, 'Work').map((i) => i.last.action)).toEqual(['removed'])
    expect(changesSince(f3, 3, 'Work')).toEqual([])
    expect(changesSince(f3, 0, 'user').map((i) => i.last.by)).toEqual(['Other'])
  })
})

describe('withTodoTools', () => {
  it('keeps null and adds the tools once', () => {
    expect(withTodoTools(null)).toBeNull()
    expect(withTodoTools(['Read', 'mcp__zumibot_todos__list'])).toEqual(['Read', ...TODO_TOOLS])
    expect(withTodoTools(['Read'])).toEqual(['Read', ...TODO_TOOLS])
    expect(withTodoTools(withTodoTools(['Read']))).toEqual(['Read', ...TODO_TOOLS])
  })
})

describe('boardOf', () => {
  const at = (n: number) => ({ ...from, at: n })
  const addAt = (f: ReturnType<typeof emptyTodos>, text: string, fromAt: number, now = 10) =>
    addTodos(f, [{ text }], 'Work', at(fromAt), now, () => `ov-${text}`).file

  it('lists open items, the newest done ones first and capped, and counts every done one', () => {
    let f = emptyTodos()
    for (const t of ['a', 'b', 'c', 'd', 'e']) f = addAt(f, t, 1)
    f = checkTodos(f, ['ov-c'], true, 'user', 20).file
    f = checkTodos(f, ['ov-d'], true, 'user', 30).file
    f = removeTodos(f, ['ov-e'], 'user', 31).file
    const b = boardOf(f, 1)
    expect(b.open.map((i) => i.text)).toEqual(['a', 'b'])
    expect(b.done.map((i) => i.text)).toEqual(['d'])
    expect(b.doneTotal).toBe(2)
    expect(b.rev).toBe(f.rev)
  })
})

describe('cardAskPrompt', () => {
  it('puts the quoted comment between the parts', () => {
    expect(cardAskPrompt({ before: 'B\n\n', after: '\n\nA' }, 'one\ntwo')).toBe('B\n\n> one\n> two\n\nA')
  })
})
