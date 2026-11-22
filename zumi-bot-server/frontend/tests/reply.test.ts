import { describe, expect, it } from 'vitest'
import { explainText, findReplied, quoteMarkdown, replySnippet, withQuote } from '../src/state/reply'
import { fromMarkdown } from '../src/state/composerMarkdown'
import type { ChatItem } from '@zumibot/shared/types'

describe('replySnippet', () => {
  it('drops markdown marks and collapses whitespace', () => {
    expect(replySnippet('## Done\n\n- **record-field-item.html**: has `uploadStyle`\n- see [the PR](https://x.y/1)')).toBe(
      'Done record-field-item.html: has uploadStyle see the PR'
    )
  })

  it('keeps snake_case and code fences content', () => {
    expect(replySnippet('```ts\nconst a_b = 1\n```\n> quoted')).toBe('const a_b = 1 quoted')
  })
})

describe('findReplied', () => {
  const items: ChatItem[] = [
    { type: 'user', id: 'u', text: 'hi', ts: 1 },
    { type: 'assistant', id: 'a', text: 'yo', ts: 2 }
  ]
  it('finds an agent message by id', () => {
    expect(findReplied(items, 'a')?.text).toBe('yo')
    expect(findReplied(items, 'u')).toBeUndefined()
    expect(findReplied(items, null)).toBeUndefined()
  })
})

describe('quoteMarkdown', () => {
  it('puts every line behind a quote mark, keeping blank lines inside the quote', () => {
    expect(quoteMarkdown('first line\r\n\r\nsecond')).toBe('> first line\n>\n> second')
  })

  it('trims the selection edges', () => {
    expect(quoteMarkdown('  one  \n')).toBe('> one')
  })
})

describe('explainText', () => {
  it('quotes the selection, then asks to explain it', () => {
    expect(explainText('Blocked only by a dependency')).toBe('> Blocked only by a dependency\nExplain this selected text')
  })
})

describe('withQuote', () => {
  // The composer reads each line as a paragraph, so one newline after the quote is the line typed into next.
  const blockTypes = (draft: string): (string | undefined)[] => (fromMarkdown(draft).content ?? []).map((n) => n.type)

  it('quotes into an empty draft, with one empty line after for what is typed next', () => {
    expect(withQuote('', 'a\nb')).toBe('> a\n> b\n')
    expect(blockTypes(withQuote('', 'a\nb'))).toEqual(['blockquote', 'paragraph'])
  })

  it('goes on the line after the typed text', () => {
    expect(withQuote('see this\n\n', 'a')).toBe('see this\n> a\n')
    expect(blockTypes(withQuote('see this', 'a'))).toEqual(['paragraph', 'blockquote', 'paragraph'])
  })

  it('keeps a blank line between two quotes, so they stay two', () => {
    expect(withQuote(withQuote('', 'a'), 'b')).toBe('> a\n\n> b\n')
    expect(blockTypes(withQuote(withQuote('', 'a'), 'b'))).toEqual(['blockquote', 'paragraph', 'blockquote', 'paragraph'])
  })
})
