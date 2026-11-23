import { describe, expect, it } from 'vitest'
import type { CardAsk, TodoBoard, TodoItem } from '@zumibot/shared/todos'
import { cardAskText, cardAskView } from '../src/state/cardAsk'

describe('cardAskText', () => {
  it("drops the chat agent's handle the comment opens with, any case, and what joined it to the text", () => {
    expect(cardAskText('@work-assistant  Tell me more about this', 'work-assistant')).toBe('Tell me more about this')
    expect(cardAskText('@Work-Assistant, please look', 'work-assistant')).toBe('please look')
    expect(cardAskText('@work-assistant:\nline two', 'work-assistant')).toBe('line two')
    expect(cardAskText('@work-assistant first\n\n- one\n  - two', 'work-assistant')).toBe('first\n\n- one\n  - two')
  })

  it("keeps other agents' opening handles, and every mention inside the text", () => {
    expect(cardAskText('@work-assistant @writer /card fix it', 'work-assistant')).toBe('@writer /card fix it')
    expect(cardAskText('@writer @work-assistant, do it', 'work-assistant')).toBe('@writer, do it')
    expect(cardAskText('Hey @work-assistant create a card', 'work-assistant')).toBe('Hey @work-assistant create a card')
    expect(cardAskText('@writer draft it', 'work-assistant')).toBe('@writer draft it')
    expect(cardAskText('mail me@work-assistant.com', 'work-assistant')).toBe('mail me@work-assistant.com')
    expect(cardAskText('`@work-assistant` run', 'work-assistant')).toBe('`@work-assistant` run')
  })

  it('keeps the comment as written when the handle is all it holds', () => {
    expect(cardAskText('@work-assistant', 'work-assistant')).toBe('@work-assistant')
  })
})

const item = (id: string, text: string, over: Partial<TodoItem> = {}): TodoItem =>
  ({
    id,
    text,
    group: null,
    from: { chatId: null, turn: 't', itemId: null, label: '', at: 1 },
    addedBy: 'user',
    done: null,
    removed: null,
    last: { action: 'added', by: 'user', at: 1 },
    rev: 1,
    updatedAt: 1,
    ...over
  }) as TodoItem

const ask: CardAsk = { todoId: 'c1', title: 'Old title', before: '', after: '' }
const env = (board: TodoBoard | null | undefined) => ({ board, chats: [], approvals: {} })
const board = (open: TodoItem[], done: TodoItem[], doneTotal = done.length): TodoBoard => ({ rev: 1, open, done, doneTotal })

describe('cardAskView', () => {
  it('shows an open card with its live title and column', () => {
    const b = board([item('c1', 'Live title', { status: 'progress' })], [])
    expect(cardAskView(ask, env(b))).toMatchObject({
      title: 'Live title',
      status: 'In progress',
      removed: false,
      path: '/todos/c1'
    })
  })
  it('finds a done card in the done list', () => {
    const b = board([], [item('c1', 'Shipped', { status: 'done', done: { at: 2, by: 'user' } })])
    expect(cardAskView(ask, env(b))).toMatchObject({ title: 'Shipped', status: 'Done', removed: false })
  })
  it('says removed when the whole board is loaded and the card is not in it', () => {
    expect(cardAskView(ask, env(board([], [])))).toMatchObject({ title: 'Old title', status: null, removed: true })
  })
  it('is not removed while older done cards may hold it', () => {
    expect(cardAskView(ask, env(board([], [], 5)))).toMatchObject({ status: null, removed: false })
  })
  it('keeps the stored title and no status without a board', () => {
    for (const b of [null, undefined]) {
      expect(cardAskView(ask, env(b))).toMatchObject({ title: 'Old title', status: null, removed: false, path: '/todos/c1' })
    }
  })
})
