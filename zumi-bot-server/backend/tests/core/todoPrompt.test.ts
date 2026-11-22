import { describe, expect, it } from 'vitest'
import type { ChatItem } from '@zumibot/shared/types'
import { TODO_REQUEST, TODO_SYSTEM, todoLabel, withTrailingText } from '../../src/core/todos/todoPrompt'
import type { ContentBlock } from '../../src/core/chat/controlProtocol'

describe('withTrailingText', () => {
  it('appends to a string after a blank line', () => {
    expect(withTrailingText('hello', 'NOTE')).toBe('hello\n\nNOTE')
    expect(withTrailingText('', 'NOTE')).toBe('NOTE')
  })

  it('adds a text block after the images of a block array, leaving the input as it was', () => {
    const image: ContentBlock = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
    const blocks: ContentBlock[] = [{ type: 'text', text: 'look at this' }, image]
    expect(withTrailingText(blocks, 'NOTE')).toEqual([{ type: 'text', text: 'look at this' }, image, { type: 'text', text: 'NOTE' }])
    expect(blocks).toHaveLength(2)
  })
})

describe('the fixed texts', () => {
  it('TODO_SYSTEM names the server and each tool, and keeps ids from the user', () => {
    expect(TODO_SYSTEM).toContain('zumibot_todos')
    for (const tool of ['list', 'add', 'check', 'remove']) expect(TODO_SYSTEM).toContain(`mcp__zumibot_todos__${tool}`)
    expect(TODO_SYSTEM).toMatch(/only when the user's message asks/i)
    expect(TODO_SYSTEM).toMatch(/worded differently/)
    expect(TODO_SYSTEM).toMatch(/headings/)
    expect(TODO_SYSTEM).toMatch(/never show/i)
  })

  it("TODO_REQUEST asks for the reply's action items on one line", () => {
    expect(TODO_REQUEST).toMatch(/action items/)
    expect(TODO_REQUEST).toContain('zumibot_todos')
    expect(TODO_REQUEST).not.toContain('\n')
  })
})

describe('todoLabel', () => {
  const user = (text: string, extra: Partial<Extract<ChatItem, { type: 'user' }>> = {}): ChatItem => ({
    type: 'user',
    id: text,
    text,
    ts: 1,
    ...extra
  })

  it('is the command of the latest user message', () => {
    const items = [
      user('older'),
      { type: 'assistant', id: 'a', text: 'hi', ts: 2 } as ChatItem,
      user('/todo /my-day', { command: { agent: 'wa', name: 'my-day', prompt: 'Build my day' } })
    ]
    expect(todoLabel(items)).toBe('/my-day')
  })

  it('is otherwise the start of the text after /todo, on one line and at most 40 characters', () => {
    expect(todoLabel([user('/todo   plan my\n\nday')])).toBe('plan my day')
    expect(todoLabel([user('/todo Reply to everyone in the launch thread about the date please')])).toBe(
      'Reply to everyone in the launch thread a'
    )
    expect(todoLabel([user('just text')])).toBe('just text')
  })

  it('never splits a character at the cut', () => {
    expect(todoLabel([user(`${'a'.repeat(39)}😀 tail`)])).toBe(`${'a'.repeat(39)}😀`)
  })

  it('is empty without a user message', () => {
    expect(todoLabel([])).toBe('')
  })
})
