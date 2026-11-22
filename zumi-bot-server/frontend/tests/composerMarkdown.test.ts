import { describe, expect, it } from 'vitest'
import type { JSONContent } from '@tiptap/core'
import { fromMarkdown, toMarkdown } from '../src/state/composerMarkdown'

const text = (t: string): JSONContent => ({ type: 'text', text: t })
const code = (t: string): JSONContent => ({ type: 'text', text: t, marks: [{ type: 'code' }] })
const p = (...content: JSONContent[]): JSONContent => (content.length ? { type: 'paragraph', content } : { type: 'paragraph' })
const li = (...content: JSONContent[]): JSONContent => ({ type: 'listItem', content })
const ul = (...items: JSONContent[]): JSONContent => ({ type: 'bulletList', content: items })
const ol = (start: number, ...items: JSONContent[]): JSONContent => ({ type: 'orderedList', attrs: { start }, content: items })
const doc = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content })

describe('toMarkdown', () => {
  it('writes one line per paragraph, empty ones included', () => {
    expect(toMarkdown(doc(p(text('a')), p(), p(text('b'))))).toBe('a\n\nb')
  })
  it('leaves markdown characters in plain text alone', () => {
    expect(toMarkdown(doc(p(text('snake_case *x* # 1'))))).toBe('snake_case *x* # 1')
  })
  it('is empty while the document has no text', () => {
    expect(toMarkdown(doc(p()))).toBe('')
    expect(toMarkdown(doc(ul(li(p()))))).toBe('')
  })
  it('wraps code in backticks, longer ones when the code holds some', () => {
    expect(toMarkdown(doc(p(text('run '), code('npm test'), text(' now'))))).toBe('run `npm test` now')
    expect(toMarkdown(doc(p(code('a`b'))))).toBe('``a`b``')
    expect(toMarkdown(doc(p(code('`x'))))).toBe('`` `x ``')
  })
  it('fences a code block, with its language', () => {
    expect(toMarkdown(doc({ type: 'codeBlock', attrs: { language: 'ts' }, content: [text('a\n\nb')] }))).toBe('```ts\na\n\nb\n```')
    expect(toMarkdown(doc({ type: 'codeBlock', attrs: { language: null }, content: [text('```')] }))).toBe('````\n```\n````')
  })
  it('indents nested lists to the parent marker', () => {
    const bullets = ul(li(p(text('a'))), li(p(text('b')), ul(li(p(text('c'))), li(p(text('d'))))), li(p(text('e'))))
    expect(toMarkdown(doc(bullets))).toBe('- a\n- b\n  - c\n  - d\n- e')
    const numbers = ol(1, li(p(text('a'))), li(p(text('b')), ol(1, li(p(text('c'))))), li(p(text('d'))))
    expect(toMarkdown(doc(numbers))).toBe('1. a\n2. b\n   1. c\n3. d')
  })
  it('prefixes each line of a quote with `> `, a blank one with `>`', () => {
    expect(toMarkdown(doc({ type: 'blockquote', content: [p(text('a')), p(), p(text('b'))] }))).toBe('> a\n>\n> b')
    expect(toMarkdown(doc({ type: 'blockquote', content: [ul(li(p(text('a'))))] }))).toBe('> - a')
  })
  it('numbers from the list start and keeps an empty item', () => {
    expect(toMarkdown(doc(ol(9, li(p(text('a'))), li(p()), li(p(text('b'))))))).toBe('9. a\n10.\n11. b')
  })
})

describe('fromMarkdown', () => {
  it('gives an empty draft one empty paragraph', () => {
    expect(fromMarkdown('')).toEqual(doc(p()))
  })
  it('reads lines as paragraphs and `spans` as code', () => {
    expect(fromMarkdown('a `b` c\n\nlone ` tick')).toEqual(doc(p(text('a '), code('b'), text(' c')), p(), p(text('lone ` tick'))))
    expect(fromMarkdown('``a`b`` and `` `x ``')).toEqual(doc(p(code('a`b'), text(' and '), code('`x'))))
  })
  it('reads fenced code, closed or not', () => {
    expect(fromMarkdown('```js\nx\n\ny\n```\nafter')).toEqual(
      doc({ type: 'codeBlock', attrs: { language: 'js' }, content: [text('x\n\ny')] }, p(text('after')))
    )
    expect(fromMarkdown('```\nopen')).toEqual(doc({ type: 'codeBlock', attrs: { language: null }, content: [text('open')] }))
  })
  it('reads nested bullet and numbered lists, and the text after them', () => {
    expect(fromMarkdown('- a\n  - b\n- c\nalso\n3. x\n   1. y')).toEqual(
      doc(ul(li(p(text('a')), ul(li(p(text('b'))))), li(p(text('c')))), p(text('also')), ol(3, li(p(text('x')), ol(1, li(p(text('y')))))))
    )
  })
  it('reads `>` lines as a quote, ended by the first line without one', () => {
    expect(fromMarkdown('> a\n>\n> b\nafter')).toEqual(
      doc({ type: 'blockquote', content: [p(text('a')), p(), p(text('b'))] }, p(text('after')))
    )
    expect(fromMarkdown('> - a\n>   b')).toEqual(doc({ type: 'blockquote', content: [ul(li(p(text('a')), p(text('b'))))] }))
  })
  it('splits a bullet list from a numbered one', () => {
    expect(fromMarkdown('- a\n1. b')).toEqual(doc(ul(li(p(text('a')))), ol(1, li(p(text('b'))))))
  })
})

describe('round trip', () => {
  const drafts = [
    'plain line\n\nanother',
    '- bullet\n- list with\n  - nested\n  - list\n- main bullet list\nalso\n1. ordered\n2. list, with\n   1. nested\n   2. list\n3. main ordered list\n`code` (inline)\n```\ncode block\n```',
    '- item\n  ```\n  code in an item\n\n  more\n  ```\n- next',
    '10. ten\n    - deep\n11. eleven',
    '> quoted\n>\n> - item\n> more\nafter the quote'
  ]
  it.each(drafts)('keeps %j', (draft) => {
    expect(toMarkdown(fromMarkdown(draft))).toBe(draft)
  })
})
