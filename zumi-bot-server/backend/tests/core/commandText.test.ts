import { describe, expect, it } from 'vitest'
import { asksTodos, readAs, withCommands } from '../../src/core/chat/commandText'
import type { ChatItem } from '@zumibot/shared/types'
import { TODO_REQUEST } from '../../src/core/todos/todoPrompt'

type User = Extract<ChatItem, { type: 'user' }>
const cmd: User = { type: 'user', id: 'u1', text: '/check L', ts: 1, command: { agent: 'wk', name: 'check', prompt: 'Use check on L' } }
const plain: User = { type: 'user', id: 'u2', text: 'hello', ts: 2 }

describe('readAs', () => {
  it('gives the command prompt to its own agent and the short form to anyone else', () => {
    expect(readAs(cmd, 'wk')).toBe('Use check on L')
    expect(readAs(cmd, 'rv')).toBe('/check L')
    expect(readAs(plain, 'wk')).toBe('hello')
  })
})

describe('readAs with /todo', () => {
  const todo: User = { type: 'user', id: 'u3', text: '/todo plan my day', ts: 3, todo: true }
  const both: User = {
    type: 'user',
    id: 'u4',
    text: '/todo /check L',
    ts: 4,
    todo: true,
    command: { agent: 'wk', name: 'check', prompt: 'Use check on L' }
  }
  const flagged: User = {
    type: 'user',
    id: 'u5',
    text: '/day',
    ts: 5,
    todo: true,
    command: { agent: 'wk', name: 'day', prompt: 'Plan the day', todos: true }
  }

  it('strips /todo and appends the request for every reader', () => {
    for (const reader of ['wk', 'rv']) expect(readAs(todo, reader)).toBe(`plan my day\n\n${TODO_REQUEST}`)
  })

  it('a bare /todo reads as the request alone', () => {
    expect(readAs({ ...todo, text: '/todo' }, 'wk')).toBe(TODO_REQUEST)
  })

  it('the command owner reads its filled prompt, others the stripped short form, both with the request', () => {
    expect(readAs(both, 'wk')).toBe(`Use check on L\n\n${TODO_REQUEST}`)
    expect(readAs(both, 'rv')).toBe(`/check L\n\n${TODO_REQUEST}`)
  })

  it('a flagged command without /todo adds the request for its owner and for others', () => {
    expect(readAs(flagged, 'wk')).toBe(`Plan the day\n\n${TODO_REQUEST}`)
    expect(readAs(flagged, 'rv')).toBe(`/day\n\n${TODO_REQUEST}`)
  })

  it('a message without the flag is unchanged', () => {
    expect(readAs(plain, 'rv')).toBe('hello')
  })
})

describe('withCommands', () => {
  it('rewrites a /todo message for every reader and leaves the stored item alone', () => {
    const todo: User = { type: 'user', id: 'u3', text: '/todo plan', ts: 3, todo: true }
    const out = withCommands([todo, plain], 'rv')
    expect(out[0]).toMatchObject({ id: 'u3', text: `plan\n\n${TODO_REQUEST}`, todo: true })
    expect(out[1]).toBe(plain)
    expect(todo.text).toBe('/todo plan')
  })

  it('rewrites command messages and keeps every other item by identity', () => {
    const other: ChatItem = { type: 'assistant', id: 'a1', text: 'hi', ts: 3 }
    const out = withCommands([cmd, plain, other], 'wk')
    expect(out[0]).toMatchObject({ id: 'u1', text: 'Use check on L' })
    expect(out[1]).toBe(plain)
    expect(out[2]).toBe(other)
    expect(withCommands([cmd], 'rv')[0]).toBe(cmd)
  })
})

describe("asksTodos and readers without ZumiBot's to-do tools", () => {
  const todo: User = { type: 'user', id: 'u3', text: '/todo plan my day', ts: 3, todo: true }
  it('is true for the /todo flag or a command that makes to-dos, false for a plain message or command', () => {
    expect(asksTodos(todo)).toBe(true)
    expect(asksTodos({ ...cmd, command: { ...cmd.command!, todos: true } })).toBe(true)
    expect(asksTodos(cmd)).toBe(false)
    expect(asksTodos(plain)).toBe(false)
  })
  it('leaves the to-do request off for a reader without bridges, still dropping /todo', () => {
    expect(readAs(todo, 'wk', false)).toBe('plan my day')
    expect(readAs({ ...todo, text: '/todo' }, 'wk', false)).toBe('')
    expect(readAs(todo, 'wk')).toBe(`plan my day\n\n${TODO_REQUEST}`)
    expect(withCommands([todo], 'wk', false)).toEqual([{ ...todo, text: 'plan my day' }])
    expect(withCommands([todo], 'wk')[0]).toMatchObject({ text: `plan my day\n\n${TODO_REQUEST}` })
  })
})
