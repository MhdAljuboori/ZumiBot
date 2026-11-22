import { describe, expect, it } from 'vitest'
import { canvasKey } from '../src/state/workflowKeys'

const k = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}, code?: string) => ({
  key,
  code,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods
})

describe('canvasKey', () => {
  it('saves on Ctrl+S or Cmd+S, even while typing', () => {
    expect(canvasKey(k('s', { ctrlKey: true }), true, false)).toBe('save')
    expect(canvasKey(k('S', { metaKey: true }), false, false)).toBe('save')
  })
  it('returns null for every other key while typing', () => {
    for (const e of [
      k('Delete'),
      k('Backspace'),
      k('n'),
      k('S', { shiftKey: true }),
      k('1'),
      k('+'),
      k('ArrowRight'),
      k('z', { ctrlKey: true }),
      k('d', { ctrlKey: true }),
      k('g', { ctrlKey: true }, 'KeyG'),
      k('F2'),
      k('Enter'),
      k('h'),
      k('a', { ctrlKey: true }),
      k('Enter', { ctrlKey: true })
    ])
      expect(canvasKey(e, true, true), e.key).toBeNull()
  })
  it('maps the zoom keys', () => {
    expect(canvasKey(k('+'), false, false)).toBe('zoomIn')
    expect(canvasKey(k('='), false, false)).toBe('zoomIn')
    expect(canvasKey(k('-'), false, false)).toBe('zoomOut')
    expect(canvasKey(k('_'), false, false)).toBe('zoomOut')
    expect(canvasKey(k('0'), false, false)).toBe('zoomReset')
    expect(canvasKey(k('1'), false, false)).toBe('fit')
  })
  it('maps adding, editing and history keys', () => {
    expect(canvasKey(k('S', { shiftKey: true }), false, false)).toBe('addNote')
    expect(canvasKey(k('n'), false, false)).toBe('addStep')
    expect(canvasKey(k('h'), false, false)).toBe('panMode')
    expect(canvasKey(k('d', { ctrlKey: true }), false, true)).toBe('duplicate')
    expect(canvasKey(k('z', { ctrlKey: true }), false, false)).toBe('undo')
    expect(canvasKey(k('Z', { ctrlKey: true, shiftKey: true }), false, false)).toBe('redo')
    expect(canvasKey(k('y', { metaKey: true }), false, false)).toBe('redo')
    expect(canvasKey(k('Enter', { ctrlKey: true }), false, false)).toBe('run')
  })
  it('maps the group keys by code, so Alt+G on a Mac (©) still works', () => {
    expect(canvasKey(k('g', { ctrlKey: true }, 'KeyG'), false, true)).toBe('group')
    expect(canvasKey(k('G', { ctrlKey: true, shiftKey: true }, 'KeyG'), false, true)).toBe('ungroup')
    expect(canvasKey(k('©', { altKey: true }, 'KeyG'), false, false)).toBe('expand')
    expect(canvasKey(k('˝', { altKey: true, shiftKey: true }, 'KeyG'), false, false)).toBe('collapse')
  })
  it('needs a selection for Delete, Esc, arrows, F2 and Enter', () => {
    for (const key of ['Delete', 'Backspace', 'Escape', 'F2', 'Enter']) expect(canvasKey(k(key), false, false), key).toBeNull()
    expect(canvasKey(k('Delete'), false, true)).toBe('delete')
    expect(canvasKey(k('Escape'), false, true)).toBe('clear')
    expect(canvasKey(k('F2'), false, true)).toBe('rename')
    expect(canvasKey(k('Enter'), false, true)).toBe('open')
    expect(canvasKey(k('ArrowRight'), false, true)).toBe('next')
    expect(canvasKey(k('ArrowLeft'), false, true)).toBe('prev')
    expect(canvasKey(k('ArrowUp'), false, true)).toBe('up')
    expect(canvasKey(k('ArrowDown'), false, true)).toBe('down')
    expect(canvasKey(k('ArrowRight', { shiftKey: true }), false, true)).toBe('allNext')
    expect(canvasKey(k('ArrowLeft', { shiftKey: true }), false, true)).toBe('allPrev')
  })
  it('lets the arrows pick the trigger with nothing selected', () => {
    expect(canvasKey(k('ArrowRight'), false, false)).toBe('next')
  })
  it('selects all on Ctrl+A or Cmd+A', () => {
    expect(canvasKey(k('a', { ctrlKey: true }), false, false)).toBe('selectAll')
  })
  it('lets Backspace delete like Delete, but not with a modifier', () => {
    expect(canvasKey(k('Backspace'), false, true)).toBe('delete')
    expect(canvasKey(k('Backspace', { ctrlKey: true }), false, true)).toBeNull()
  })
})
