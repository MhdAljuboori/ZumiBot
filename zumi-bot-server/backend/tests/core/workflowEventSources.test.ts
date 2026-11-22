import { describe, expect, it } from 'vitest'
import type { ChatMeta } from '@zumibot/shared/types'
import type { TodoItem } from '@zumibot/shared/todos'
import { REPLY_TEXT_MAX } from '@zumibot/shared/workflowEvents'
import { inboxEvent, replyEvent, todoEvent } from '../../src/core/workflows/workflowEventSources'

const meta = (o: Partial<ChatMeta> = {}): ChatMeta => ({
  id: 'c1',
  agentName: 'helper',
  sessionId: null,
  cwd: '/proj',
  title: 'Report',
  createdAt: 1,
  updatedAt: 1,
  inFlight: false,
  ...o
})
const end = { chatId: 'c1', agent: 'helper', outcome: 'ok' as const, reply: 'Hi' }

describe('replyEvent', () => {
  it('maps a finished reply with the chat ref', () => {
    expect(replyEvent(end, meta(), false)).toEqual({
      kind: 'reply',
      body: { chat: { id: 'c1', title: 'Report', folder: '/proj' }, agent: 'helper', outcome: 'ok', room: false, reply: 'Hi' }
    })
  })

  it('keeps an error, and marks a room by the hook that fired', () => {
    const e = replyEvent({ ...end, outcome: 'error' }, meta({ group: {} as ChatMeta['group'] }), true)
    expect(e).toMatchObject({ kind: 'reply', body: { outcome: 'error', room: true } })
  })

  it('skips a stop, a workflow turn, an asked turn, a pass and a missing chat', () => {
    expect(replyEvent({ ...end, outcome: 'stopped' }, meta(), false)).toBeNull()
    expect(replyEvent({ ...end, workflow: true }, meta(), false)).toBeNull()
    expect(replyEvent({ ...end, asked: true }, meta(), false)).toBeNull()
    expect(replyEvent({ ...end, passed: true }, meta(), true)).toBeNull()
    expect(replyEvent(end, null, false)).toBeNull()
  })

  it("skips a room's turn seen by the single-chat hook, so it is reported once", () => {
    expect(replyEvent(end, meta({ group: {} as ChatMeta['group'] }), false)).toBeNull()
  })

  it('cuts the reply and treats a missing one as empty', () => {
    const long = replyEvent({ ...end, reply: 'x'.repeat(REPLY_TEXT_MAX + 5) }, meta(), false)
    expect(long?.kind === 'reply' && long.body.reply.length).toBe(REPLY_TEXT_MAX)
    const none = replyEvent({ chatId: 'c1', agent: 'helper', outcome: 'ok' }, meta(), false)
    expect(none?.kind === 'reply' && none.body.reply).toBe('')
  })
})

describe('todoEvent', () => {
  const item = (text: string, group: string | null): TodoItem => ({ text, group }) as TodoItem

  it('maps the added items', () => {
    expect(todoEvent(meta(), [item('a', null), item('b', 'G')], 'user')).toEqual({
      kind: 'todo',
      body: {
        chat: { id: 'c1', title: 'Report', folder: '/proj' },
        by: 'user',
        count: 2,
        todos: [
          { text: 'a', group: null },
          { text: 'b', group: 'G' }
        ]
      }
    })
  })

  it('is null for a missing chat or no items', () => {
    expect(todoEvent(null, [item('a', null)], 'user')).toBeNull()
    expect(todoEvent(meta(), [], 'user')).toBeNull()
  })
})

describe('inboxEvent', () => {
  it('maps a stored message, an absent body as empty', () => {
    expect(
      inboxEvent({
        id: 'm1',
        workflowId: 'w1',
        workflowName: 'Nightly',
        runId: 'r1',
        stepName: 'Notify',
        title: 'Done',
        at: 1,
        updatedAt: 1
      })
    ).toEqual({
      kind: 'inbox',
      body: { message: { id: 'm1', title: 'Done', body: '' }, workflow: { id: 'w1', name: 'Nightly' }, step: 'Notify', runId: 'r1' }
    })
  })
})
