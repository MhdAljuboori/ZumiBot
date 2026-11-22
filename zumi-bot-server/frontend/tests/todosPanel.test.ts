import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import { describe, expect, it } from 'vitest'
import type { TodoItem } from '@zumibot/shared/todos'
import { TODO_USER_LABEL, TODO_USER_TURN } from '@zumibot/shared/todos'
import { doneShown, historyComplete, panelView, tickedByLabel } from '../src/state/todosPanel'
import { inlineMarkdownProps } from '../src/state/inlineMarkdown'

let n = 0
function todo(over: Partial<TodoItem> & { turn?: string; at?: number; itemId?: string | null; label?: string } = {}): TodoItem {
  const { turn = 't1', at = 1000, itemId = 'r1', label = '/my-day', ...rest } = over
  n += 1
  return {
    id: `i${n}`,
    text: `item ${n}`,
    group: null,
    from: { turn, itemId, label, at },
    addedBy: 'helper',
    done: null,
    removed: null,
    last: { action: 'added', by: 'helper', at },
    rev: 1,
    updatedAt: at,
    ...rest
  }
}

describe('panelView', () => {
  it('groups newest first, sections in first-seen order, items in add order', () => {
    const a1 = todo({ turn: 'old', at: 1000, group: 'Slack', itemId: 'r-old' })
    const b1 = todo({ turn: 'new', at: 2000, group: 'Invites', itemId: 'r-new' })
    const b2 = todo({ turn: 'new', at: 2000, group: 'Workiom', itemId: 'r-new' })
    const b3 = todo({ turn: 'new', at: 2000, group: 'Invites', itemId: 'r-new' })
    const b4 = todo({ turn: 'new', at: 2000, group: null, itemId: 'r-new' })
    const v = panelView([a1, b1, b2, b3, b4], new Set(), true)
    expect(v.open.map((g) => g.key)).toEqual(['new', 'old'])
    expect(v.open[0].sections.map((s) => s.heading)).toEqual(['Invites', 'Workiom', null])
    expect(v.open[0].sections[0].items).toEqual([b1, b3])
    expect(v.open[0]).toMatchObject({ label: '/my-day', at: 2000, itemId: 'r-new' })
    expect(v.left).toBe(5)
  })

  it('hand-added items share one Added by you group: no Show in chat, ordered by its newest item', () => {
    const mine = (at: number): TodoItem =>
      todo({
        turn: TODO_USER_TURN,
        at,
        itemId: null,
        label: 'whatever was stored',
        addedBy: 'user',
        last: { action: 'added', by: 'user', at }
      })
    const u1 = mine(1000)
    const agent = todo({ turn: 'mid', at: 2000, itemId: 'r-mid' })
    const u2 = mine(3000)
    const v = panelView([u1, agent, u2], new Set(['r-mid']), false)
    expect(v.open.map((g) => g.key)).toEqual([TODO_USER_TURN, 'mid']) // its newest item (3000) beats the agent's group
    expect(v.open[0]).toMatchObject({ label: TODO_USER_LABEL, at: 3000, itemId: null, showInChat: false })
    expect(v.open[0].sections[0].items).toEqual([u1, u2])
    expect(v.open[1].showInChat).toBe(true)
  })

  it('ticked items leave their group for done, newest done first', () => {
    const a = todo({ turn: 't1' })
    const b = todo({ turn: 't1', done: { at: 50, by: 'user' } })
    const c = todo({ turn: 't2', done: { at: 90, by: 'helper' } })
    const v = panelView([a, b, c], new Set(), true)
    expect(v.done).toEqual([c, b])
    expect(v.open).toHaveLength(1) // t2 has nothing open left, so no empty group
    expect(v.open[0].sections[0].items).toEqual([a])
    expect(v.left).toBe(1)
  })

  it('leaves removed items out', () => {
    const gone = todo({ removed: { at: 5, by: 'user' } })
    expect(panelView([gone], new Set(), true)).toEqual({ open: [], done: [], left: 0 })
  })

  it('showInChat is false when the reply is not visible or unknown', () => {
    const shown = todo({ turn: 'a', itemId: 'r1' })
    const hidden = todo({ turn: 'b', itemId: 'r2' })
    const unknown = todo({ turn: 'c', itemId: null })
    const v = panelView([shown, hidden, unknown], new Set(['r1']), true)
    const by = Object.fromEntries(v.open.map((g) => [g.key, g]))
    expect(by.a.showInChat).toBe(true)
    expect(by.b.showInChat).toBe(false)
    expect(by.c).toMatchObject({ showInChat: false, itemId: null })
  })

  it('while older pages are not loaded Show in chat stays for an absent reply, but never without an id', () => {
    const absent = todo({ turn: 'a', itemId: 'r-old' })
    const present = todo({ turn: 'b', itemId: 'r1' })
    const noId = todo({ turn: 'c', itemId: null })
    const partial = Object.fromEntries(panelView([absent, present, noId], new Set(['r1']), false).open.map((g) => [g.key, g.showInChat]))
    expect(partial).toEqual({ a: true, b: true, c: false })
    const full = Object.fromEntries(panelView([absent, present, noId], new Set(['r1']), true).open.map((g) => [g.key, g.showInChat]))
    expect(full).toEqual({ a: false, b: true, c: false })
  })

  it('takes the reply id from any item of the group once the settle filled it in', () => {
    const early = todo({ turn: 'a', itemId: null })
    const late = todo({ turn: 'a', itemId: 'r9' })
    const g = panelView([early, late], new Set(['r9']), true).open[0]
    expect(g.itemId).toBe('r9')
    expect(g.showInChat).toBe(true)
  })
})

describe('historyComplete', () => {
  it('is true only once nothing older is left to load', () => {
    expect(historyComplete(0)).toBe(true)
    expect(historyComplete(40)).toBe(false)
    expect(historyComplete(null)).toBe(false)
  })
})

describe('doneShown', () => {
  const many = Array.from({ length: 130 }, (_, i) => todo({ done: { at: 1000 - i, by: 'user' } }))
  it('caps at 100 until expanded', () => {
    expect(doneShown(many, false)).toHaveLength(100)
    expect(doneShown(many, true)).toHaveLength(130)
    expect(doneShown(many.slice(0, 5), false)).toHaveLength(5)
  })
})

describe('tickedByLabel', () => {
  it('user null, agent "by agent", room member name', () => {
    const byUser = todo({ done: { at: 1, by: 'user' } })
    const byAgent = todo({ done: { at: 1, by: 'code-helper' } })
    expect(tickedByLabel(byUser, false)).toBeNull()
    expect(tickedByLabel(byUser, true)).toBeNull()
    expect(tickedByLabel(byAgent, false)).toBe('by agent')
    expect(tickedByLabel(byAgent, true)).toBe('Code Helper')
    expect(tickedByLabel(todo(), true)).toBeNull()
  })
})

describe('inline markdown for item text', () => {
  const render = (text: string): string => renderToStaticMarkup(createElement(ReactMarkdown, { ...inlineMarkdownProps, children: text }))
  it('keeps links, emphasis and code', () => {
    expect(render('[a](https://b.example)')).toContain('<a href="https://b.example">a</a>')
    expect(render('**b** _i_ `c`')).toBe('<span><strong>b</strong> <em>i</em> <code>c</code></span>')
  })
  it('turns images, headings, html and lists into plain text', () => {
    expect(render('![x](https://y.example/p.png)')).toBe('<span>x</span>')
    expect(render('# h')).toBe('h')
    expect(render('<b>raw</b>')).not.toMatch(/<b>/)
    expect(render('> q')).not.toContain('blockquote')
    expect(render('- l')).not.toMatch(/<li|<ul/)
  })
  it('does not render javascript: links as links', () => {
    expect(render('[x](javascript:alert(1))')).not.toContain('javascript:')
  })
})
