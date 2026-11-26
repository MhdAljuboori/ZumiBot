import { describe, expect, it } from 'vitest'
import { browserKeyEvent } from '../../src/core/browser/browserKeyboard'

const at = { generation: 'g1', tabId: 't1' }
describe('browserKeyEvent', () => {
  it('names a phone keyboard key that came without a code', () => {
    expect(browserKeyEvent({ ...at, type: 'keyDown', key: 'Backspace', code: '' })).toMatchObject({
      type: 'rawKeyDown',
      key: 'Backspace',
      code: 'Backspace',
      windowsVirtualKeyCode: 8
    })
    expect(browserKeyEvent({ ...at, type: 'keyDown', key: 'a', code: '' })).toMatchObject({ code: 'KeyA', windowsVirtualKeyCode: 65 })
  })
  it('gives Enter its character, which is what submits a form or breaks a line', () => {
    expect(browserKeyEvent({ ...at, type: 'keyDown', key: 'Enter', code: 'Enter' })).toMatchObject({
      type: 'keyDown',
      windowsVirtualKeyCode: 13,
      text: '\r',
      unmodifiedText: '\r'
    })
    expect(browserKeyEvent({ ...at, type: 'keyDown', key: 'Enter', code: '' })).toMatchObject({ type: 'keyDown', text: '\r' })
    expect(browserKeyEvent({ ...at, type: 'keyDown', key: 'Enter', code: 'Enter', modifiers: ['Shift'] })).toMatchObject({ text: '\r' })
  })
  it('keeps Enter with a shortcut modifier, its release and other keys free of text', () => {
    for (const event of [
      browserKeyEvent({ ...at, type: 'keyDown', key: 'Enter', code: 'Enter', modifiers: ['Control'] }),
      browserKeyEvent({ ...at, type: 'keyUp', key: 'Enter', code: 'Enter' }),
      browserKeyEvent({ ...at, type: 'keyDown', key: 'b', code: 'KeyB' })
    ])
      expect(event).not.toHaveProperty('text')
    expect(browserKeyEvent({ ...at, type: 'keyDown', key: 'Enter', code: 'Enter', modifiers: ['Control'] }).type).toBe('rawKeyDown')
  })
})
