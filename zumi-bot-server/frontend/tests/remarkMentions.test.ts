import { describe, expect, it } from 'vitest'
import type { Root } from 'mdast'
import { remarkMentions } from '../src/remarkMentions'

const run = (tree: Root, members: string[], agents: { name: string }[] = []): Root => {
  remarkMentions(members, agents)()(tree)
  return tree
}

const mention = (name: string, raw = `@${name}`) => ({
  type: 'mention',
  name,
  children: [{ type: 'text', value: raw }],
  data: { hName: 'mention', hProperties: { name } }
})

describe('remarkMentions', () => {
  it('turns member handles in text into mention nodes', () => {
    const tree = run(
      { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', value: 'ask @ui-ux and @nobody, then @Writer' }] }] },
      ['ui-ux', 'writer']
    )
    expect(tree.children[0]).toEqual({
      type: 'paragraph',
      children: [
        { type: 'text', value: 'ask ' },
        mention('ui-ux'),
        { type: 'text', value: ' and @nobody, then ' },
        mention('writer', '@Writer')
      ]
    })
  })

  it('reaches text nested in lists and emphasis', () => {
    const tree = run(
      {
        type: 'root',
        children: [
          {
            type: 'list',
            children: [
              {
                type: 'listItem',
                children: [{ type: 'paragraph', children: [{ type: 'strong', children: [{ type: 'text', value: '@ui-ux' }] }] }]
              }
            ]
          }
        ]
      },
      ['ui-ux']
    )
    expect(JSON.stringify(tree)).toContain('"type":"mention"')
  })

  it('never touches inline code or code blocks', () => {
    const before: Root = {
      type: 'root',
      children: [
        { type: 'paragraph', children: [{ type: 'inlineCode', value: '@ui-ux' }] },
        { type: 'code', lang: null, meta: null, value: '@ui-ux' }
      ]
    }
    const copy = structuredClone(before)
    expect(run(before, ['ui-ux'])).toEqual(copy)
  })

  it('turns a code span spelling an agent handle into a mention, in a paragraph or a list', () => {
    const tree = run(
      {
        type: 'root',
        children: [
          {
            type: 'paragraph',
            children: [
              { type: 'text', value: 'ask ' },
              { type: 'inlineCode', value: 'ui-ux-specialist' }
            ]
          },
          {
            type: 'list',
            children: [
              { type: 'listItem', children: [{ type: 'paragraph', children: [{ type: 'inlineCode', value: 'ui-ux-specialist' }] }] }
            ]
          }
        ]
      },
      [],
      [{ name: 'ui-ux-specialist' }]
    )
    expect(tree.children[0]).toEqual({
      type: 'paragraph',
      children: [{ type: 'text', value: 'ask ' }, mention('ui-ux-specialist', 'ui-ux-specialist')]
    })
    expect(JSON.stringify(tree.children[1])).toContain('"type":"mention"')
  })

  it('keeps other code spans and code blocks as code', () => {
    const before: Root = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'inlineCode', value: 'ui-ux-specialist.md' },
            { type: 'inlineCode', value: 'claude' }
          ]
        },
        { type: 'code', lang: null, meta: null, value: 'ui-ux-specialist' }
      ]
    }
    const copy = structuredClone(before)
    expect(run(before, [], [{ name: 'ui-ux-specialist' }, { name: 'claude' }])).toEqual(copy)
  })

  it('leaves text without member mentions as it was', () => {
    const text = { type: 'text' as const, value: 'mail me at a@ui-ux.dev' }
    const tree = run({ type: 'root', children: [{ type: 'paragraph', children: [text] }] }, ['ui-ux'])
    expect((tree.children[0] as { children: unknown[] }).children[0]).toBe(text)
  })
})
