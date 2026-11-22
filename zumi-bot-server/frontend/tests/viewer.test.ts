import { describe, expect, it, vi } from 'vitest'
import type { Attachment } from '@zumibot/shared/types'
import type { DraftFile } from '../src/state/draftFiles'
import {
  attachmentKind,
  createViewerStore,
  draftItems,
  fileNameOf,
  imageItem,
  savable,
  sentItems,
  stepIndex,
  viewerKey
} from '../src/state/viewer'

const att = (id: string, name: string, mime: string, size = 100): Attachment => ({ id, name, mime, size }) as Attachment
const ORIGIN = 'https://bot.example.com'

describe('attachmentKind', () => {
  it('shows images as images, small text as text, and the rest as a file card', () => {
    expect(attachmentKind(att('a', 'a.png', 'image/png'))).toBe('image')
    expect(attachmentKind(att('b', 'b.bmp', 'image/bmp'))).toBe('image')
    expect(attachmentKind(att('c', 'c.txt', 'text/plain'))).toBe('text')
    expect(attachmentKind(att('d', 'd.json', 'application/json'))).toBe('text')
    expect(attachmentKind(att('e', 'e.pdf', 'application/pdf'))).toBe('file')
    // As in the Files panel: an SVG shows its source as text, never as a picture that could run anything.
    expect(attachmentKind(att('f', 'f.svg', 'image/svg+xml'))).toBe('text')
    expect(attachmentKind(att('h', 'h.zip', 'application/zip'))).toBe('file')
    // How the server stages anything but an image.
    expect(attachmentKind(att('i', 'notes.md', 'application/octet-stream'))).toBe('text')
    expect(attachmentKind(att('j', 'x.html', 'application/octet-stream'))).toBe('text')
    expect(attachmentKind(att('k', 'blob.bin', 'application/octet-stream'))).toBe('file')
    // Over the text cap: no preview, only Open and Download.
    expect(attachmentKind(att('g', 'g.log', 'text/plain', 2 * 1024 * 1024))).toBe('file')
  })
})

describe('sentItems', () => {
  it('lists every file in order, with the chat address, a download link and the default-app open', () => {
    const items = sentItems('c1', [
      att('i1', 'pic.png', 'image/png'),
      att('t1', 'notes.txt', 'text/plain'),
      att('z1', 'a.zip', 'application/zip')
    ])
    expect(items.map((i) => [i.key, i.kind, i.url])).toEqual([
      ['i1', 'image', '/api/attachments/chat/c1/i1'],
      ['t1', 'text', '/api/attachments/chat/c1/t1'],
      ['z1', 'file', '/api/attachments/chat/c1/z1']
    ])
    expect(items[0]).toMatchObject({
      name: 'pic.png',
      size: 100,
      download: '/api/attachments/chat/c1/i1?download=1',
      external: { chatId: 'c1', id: 'i1' }
    })
  })

  it('shows an image picked on this page from memory, but reads text and saves from the server', () => {
    const local = (id: string): string | undefined => (id === 'i1' || id === 't1' ? `blob:${id}` : undefined)
    const items = sentItems('c1', [att('i1', 'pic.png', 'image/png'), att('t1', 'notes.txt', 'text/plain')], local)
    expect(items[0].url).toBe('blob:i1')
    expect(items[0].download).toBe('/api/attachments/chat/c1/i1?download=1')
    expect(items[1].url).toBe('/api/attachments/chat/c1/t1')
  })
})

describe('draftItems', () => {
  it('lists only staged files, from the staged route, with no default-app open', () => {
    const files: DraftFile[] = [
      { key: 'k1', name: 'shot.png', status: 'ready', attachment: att('s1', 'shot.png', 'image/png') },
      { key: 'k2', name: 'big.mov', status: 'staging' } as DraftFile,
      { key: 'k3', name: 'readme.md', status: 'ready', attachment: att('s3', 'readme.md', 'text/markdown') }
    ]
    const items = draftItems(files, (id) => (id === 's1' ? 'blob:s1' : undefined))
    expect(items.map((i) => [i.key, i.kind, i.url, i.download])).toEqual([
      ['s1', 'image', 'blob:s1', '/api/attachments/staged/s1?download=1'],
      ['s3', 'text', '/api/attachments/staged/s3', '/api/attachments/staged/s3?download=1']
    ])
    expect(items.every((i) => i.external === undefined)).toBe(true)
  })
})

describe('fileNameOf and imageItem', () => {
  it('names an image by its alt text, else its decoded file name, else Image', () => {
    expect(fileNameOf('/x/y/my%20chart.png?v=2#top')).toBe('my chart.png')
    expect(fileNameOf('/x/bad%E0.png')).toBe('bad%E0.png')
    expect(fileNameOf('data:image/png;base64,AAAA')).toBe('')
    expect(imageItem('/x/chart.png', ' Sales ', ORIGIN).name).toBe('Sales')
    expect(imageItem('/x/chart.png', '', ORIGIN).name).toBe('chart.png')
    expect(imageItem('data:image/png;base64,AAAA', '', ORIGIN).name).toBe('Image')
  })

  it('offers Download only where the download attribute can save the image', () => {
    expect(savable('/api/files/a/b', ORIGIN)).toBe(true)
    expect(savable(`${ORIGIN}/x.png`, ORIGIN)).toBe(true)
    expect(savable('data:image/png;base64,AAAA', ORIGIN)).toBe(true)
    expect(savable('blob:https://bot.example.com/1', ORIGIN)).toBe(true)
    expect(savable('https://other.example.com/x.png', ORIGIN)).toBe(false)
    expect(savable('data:text/html,<b>x</b>', ORIGIN)).toBe(false)
    expect(imageItem('https://other.example.com/x.png', 'x', ORIGIN).download).toBeUndefined()
    expect(imageItem('/x.png', 'x', ORIGIN).download).toBe('/x.png')
  })
})

describe('stepIndex', () => {
  it('goes round both ways', () => {
    expect(stepIndex(2, 1, 3)).toBe(0)
    expect(stepIndex(0, -1, 3)).toBe(2)
    expect(stepIndex(1, 1, 3)).toBe(2)
    expect(stepIndex(0, 1, 0)).toBe(0)
  })
})

describe('viewerKey', () => {
  const k = (key: string, extra: Partial<Parameters<typeof viewerKey>[0]> = {}) =>
    viewerKey({ key, altKey: false, ctrlKey: false, metaKey: false, ...extra })
  it('takes Esc and the arrows, never with a modifier or while composing', () => {
    expect(k('Escape')).toBe('close')
    expect(k('ArrowLeft')).toBe('prev')
    expect(k('ArrowRight')).toBe('next')
    expect(k('Enter')).toBeNull()
    expect(k('ArrowLeft', { altKey: true })).toBeNull()
    expect(k('ArrowRight', { ctrlKey: true })).toBeNull()
    expect(k('Escape', { isComposing: true })).toBeNull()
  })

  it('swaps the arrows right to left', () => {
    expect(viewerKey({ key: 'ArrowLeft', altKey: false, ctrlKey: false, metaKey: false }, true)).toBe('next')
  })
})

describe('createViewerStore', () => {
  const items = sentItems('c', [att('a', 'a.png', 'image/png'), att('b', 'b.png', 'image/png'), att('c', 'c.txt', 'text/plain')])

  it('opens at the clicked file, steps round, and closes, telling listeners each time', () => {
    const s = createViewerStore()
    const l = vi.fn()
    const off = s.subscribe(l)
    s.open(items, 2)
    expect(s.get()?.index).toBe(2)
    s.move(1)
    expect(s.get()?.index).toBe(0)
    s.move(-1)
    expect(s.get()?.index).toBe(2)
    s.close()
    expect(s.get()).toBeNull()
    expect(l).toHaveBeenCalledTimes(4)
    s.close() // already closed: nothing to tell
    expect(l).toHaveBeenCalledTimes(4)
    off()
    s.open(items, 0)
    expect(l).toHaveBeenCalledTimes(4)
  })

  it('opens nothing for an empty list, clamps a bad index, and never steps a lone file', () => {
    const s = createViewerStore()
    s.open([], 0)
    expect(s.get()).toBeNull()
    s.open(items, -1) // findIndex missed
    expect(s.get()?.index).toBe(0)
    s.open(items, 9)
    expect(s.get()?.index).toBe(2)
    s.open(items.slice(0, 1), 0)
    const before = s.get()
    s.move(1)
    expect(s.get()).toBe(before)
  })
})
