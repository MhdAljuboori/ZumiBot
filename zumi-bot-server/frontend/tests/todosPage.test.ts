import { describe, expect, it } from 'vitest'
import type { TodoItem } from '@zumibot/shared/todos'
import { ageLabel, isOld, openOldestFirst } from '../src/state/todosPage'

describe('ages', () => {
  const DAY = 86_400_000
  it('labels whole days', () => {
    expect(ageLabel(1000, 1000 + DAY - 1)).toBe('today')
    expect(ageLabel(0, DAY)).toBe('1 day')
    expect(ageLabel(0, 4 * DAY + 5)).toBe('4 days')
  })
  it('is old past 3 days', () => {
    expect(isOld(0, 3 * DAY)).toBe(false)
    expect(isOld(0, 3 * DAY + 1)).toBe(true)
  })
})

describe('openOldestFirst', () => {
  const todo = (id: string, at: number, extra: Partial<TodoItem> = {}): TodoItem => ({
    id,
    text: id,
    group: null,
    from: { chatId: null, turn: 't', itemId: null, label: 'l', at },
    addedBy: 'helper',
    done: null,
    removed: null,
    last: { action: 'added', by: 'helper', at },
    rev: 1,
    updatedAt: at,
    ...extra
  })
  it('drops ticked and removed, oldest first, ties by id', () => {
    const items = [
      todo('c', 300),
      todo('b', 100),
      todo('a', 100),
      todo('done', 50, { done: { at: 60, by: 'user' } }),
      todo('gone', 10, { removed: { at: 20, by: 'user' } })
    ]
    expect(openOldestFirst(items).map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })
})
