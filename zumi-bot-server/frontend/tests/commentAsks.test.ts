import { describe, expect, it } from 'vitest'
import type { TodoComment } from '@zumibot/shared/todos'
import { commentAsks } from '../src/state/todoCard'

const ask: TodoComment = { id: 'c1', text: '@wa do it', by: 'user', at: 10, asked: ['wa'] }
const chat = (inFlight: boolean) => ({ id: 'ch', agentName: 'wa', inFlight, cardComments: { todoId: 't' } })

describe('commentAsks', () => {
  it('reads starting before the chat exists, working while it runs, then answered or not', () => {
    expect(commentAsks({ id: 't', comments: [ask] }, ask, [])).toEqual([{ agent: 'wa', chatId: null, state: 'starting' }])
    expect(commentAsks({ id: 't', comments: [ask] }, ask, [chat(true)])[0]!.state).toBe('working')
    expect(commentAsks({ id: 't', comments: [ask] }, ask, [chat(false)])[0]!.state).toBe('unanswered')
    const reply: TodoComment = { id: 'r', text: 'done', by: 'wa', at: 12, replyTo: 'c1' }
    expect(commentAsks({ id: 't', comments: [ask, reply] }, ask, [chat(false)])[0]).toEqual({
      agent: 'wa',
      chatId: 'ch',
      state: 'answered'
    })
  })

  it("ignores another card's chat for the same agent", () => {
    expect(commentAsks({ id: 't', comments: [ask] }, ask, [{ ...chat(true), cardComments: { todoId: 'other' } }])[0]!.state).toBe(
      'starting'
    )
  })
})
