import { expect, test } from 'vitest'
import { TODO_TOOLS } from '@zumibot/shared/todos'
import { pickedTools, visibleTools } from '../src/state/toolsPicker'

const [list, add] = TODO_TOOLS

test('visibleTools leaves the to-do tools out', () => {
  expect(visibleTools(['Read', list, 'mcp__x__y', add])).toEqual(['Read', 'mcp__x__y'])
})

test('pickedTools keeps the hidden to-do tools, so editing the visible ones never drops them', () => {
  expect(pickedTools(['Read', ...TODO_TOOLS], ['Grep'])).toEqual(['Grep', ...TODO_TOOLS])
})

test('pickedTools with nothing visible left means all tools (null), never a to-do-only list', () => {
  expect(pickedTools(['Read', ...TODO_TOOLS], [])).toBeNull()
  expect(pickedTools([], [])).toBeNull()
})

test('pickedTools adds nothing when the list had none; the server adds them on save', () => {
  expect(pickedTools([], ['Read'])).toEqual(['Read'])
})
