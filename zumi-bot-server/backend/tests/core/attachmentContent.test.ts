import { describe, expect, it } from 'vitest'
import { addDirArgs, imageBlocks, refsOf, withImages, withNote, withNotes, type FileRef } from '../../src/core/attachments/content'
import type { Attachment, ChatItem } from '@zumibot/shared/types'

const img: Attachment = { id: 'i1', name: 'a.png', mime: 'image/png', size: 3, kind: 'image' }
const doc: Attachment = { id: 'f1', name: 'b.pdf', mime: 'application/pdf', size: 9, kind: 'file' }
const pathOf = (a: Attachment): string => `/x/${a.name}`

describe('attachment content', () => {
  it('withNote appends the exact note', () => {
    const refs = refsOf([img, doc], pathOf)
    expect(withNote('look', refs)).toBe(
      'look\n\n<attachments>\n- a.png (image, attached below): /x/a.png [file ID: i1]\n- b.pdf: /x/b.pdf [file ID: f1]\n</attachments>'
    )
  })

  it('withNote with empty text is the note alone', () => {
    expect(withNote('', refsOf([doc], pathOf))).toBe('<attachments>\n- b.pdf: /x/b.pdf [file ID: f1]\n</attachments>')
  })

  it('withNote leaves text unchanged without refs', () => {
    expect(withNote('hi', [])).toBe('hi')
    expect(refsOf(undefined, pathOf)).toEqual([])
  })

  it('withNotes leaves items without attachments identical (toBe)', () => {
    const plain: ChatItem = { type: 'user', id: 'u1', text: 'hi', ts: 1 }
    const asst: ChatItem = { type: 'assistant', id: 'a1', text: 'yo', ts: 2 }
    const withAtt: ChatItem = { type: 'user', id: 'u2', text: 'see', ts: 3, attachments: [doc] }
    const out = withNotes([plain, asst, withAtt], pathOf)
    expect(out[0]).toBe(plain)
    expect(out[1]).toBe(asst)
    expect(out[2]).toEqual({ ...withAtt, text: 'see\n\n<attachments>\n- b.pdf: /x/b.pdf [file ID: f1]\n</attachments>' })
  })

  it('imageBlocks reads base64 in order and ignores file refs', async () => {
    const refs: FileRef[] = [
      { name: 'a.png', path: '/x/a.png', mime: 'image/png', image: true },
      { name: 'b.pdf', path: '/x/b.pdf', mime: 'application/pdf', image: false },
      { name: 'c.jpg', path: '/x/c.jpg', mime: 'image/jpeg', image: true }
    ]
    const blocks = await imageBlocks(refs, async (p) => Buffer.from(p))
    expect(blocks).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('/x/a.png').toString('base64') } },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from('/x/c.jpg').toString('base64') } }
    ])
  })

  it('imageBlocks skips files that cannot be read', async () => {
    const refs: FileRef[] = [
      { name: 'a.png', path: '/x/a.png', mime: 'image/png', image: true },
      { name: 'c.jpg', path: '/x/c.jpg', mime: 'image/jpeg', image: true }
    ]
    const blocks = await imageBlocks(refs, async (p) => {
      if (p.endsWith('a.png')) throw new Error('ENOENT')
      return Buffer.from('z')
    })
    expect(blocks).toHaveLength(1)
    expect(blocks[0].source.media_type).toBe('image/jpeg')
  })

  it('withImages keeps a plain string without blocks', () => {
    expect(withImages('hi', [])).toBe('hi')
    const b = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'QQ==' } }
    expect(withImages('hi', [b])).toEqual([{ type: 'text', text: 'hi' }, b])
  })

  it('addDirArgs is empty for a chat without attachments', () => {
    const plain: ChatItem = { type: 'user', id: 'u1', text: 'hi', ts: 1 }
    expect(addDirArgs([plain], '/d')).toEqual([])
    expect(addDirArgs([plain, { ...plain, id: 'u2', attachments: [doc] }], '/d')).toEqual(['--add-dir', '/d'])
  })
})
