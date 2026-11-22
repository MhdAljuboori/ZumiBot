import { describe, expect, it } from 'vitest'
import { REPLY_QUOTE_MAX, repliedItem, withReplies, withReply } from '../../src/core/chat/reply'
import type { ChatItem } from '@zumibot/shared/types'

const said = (id: string, text: string, agent?: string): Extract<ChatItem, { type: 'assistant' }> => ({
  type: 'assistant',
  id,
  text,
  ts: 1,
  ...(agent ? { agent } : {})
})

describe('reply quotes', () => {
  it('finds only agent messages', () => {
    const items: ChatItem[] = [{ type: 'user', id: 'u', text: 'hi', ts: 1 }, said('a', 'hello')]
    expect(repliedItem(items, 'a')?.text).toBe('hello')
    expect(repliedItem(items, 'u')).toBeUndefined()
    expect(repliedItem(items, 'gone')).toBeUndefined()
    expect(repliedItem(items, undefined)).toBeUndefined()
  })

  it('puts the quote before the text, naming a group member', () => {
    expect(withReply('why?', said('a', 'done'))).toBe('<reply_to>\ndone\n</reply_to>\n\nwhy?')
    expect(withReply('why?', said('a', 'done', 'ui'))).toBe('<reply_to from="ui">\ndone\n</reply_to>\n\nwhy?')
    expect(withReply('', said('a', 'done'))).toBe('<reply_to>\ndone\n</reply_to>')
    expect(withReply('why?', undefined)).toBe('why?')
  })

  it('cuts a long quote', () => {
    const quote = withReply('ok', said('a', 'x'.repeat(REPLY_QUOTE_MAX + 50)))
    expect(quote).toContain(`${'x'.repeat(REPLY_QUOTE_MAX)}…\n</reply_to>`)
    expect(quote).not.toContain('x'.repeat(REPLY_QUOTE_MAX + 1))
  })

  it('quotes each reply in a list and leaves the rest', () => {
    const items: ChatItem[] = [
      said('a', 'first', 'ui'),
      { type: 'user', id: 'u1', text: 'plain', ts: 2 },
      { type: 'user', id: 'u2', text: 'more', ts: 3, replyTo: 'a' },
      { type: 'user', id: 'u3', text: 'lost', ts: 4, replyTo: 'gone' }
    ]
    const out = withReplies(items)
    expect(out[0]).toBe(items[0])
    expect(out[1]).toBe(items[1])
    expect(out[2]).toMatchObject({ text: '<reply_to from="ui">\nfirst\n</reply_to>\n\nmore' })
    expect(out[3]).toMatchObject({ text: 'lost' })
  })
})
