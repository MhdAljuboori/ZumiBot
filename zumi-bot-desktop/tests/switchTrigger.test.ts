import { describe, expect, it } from 'vitest'
import { isSwitchShortcut, wantsSwitchServer } from '../src/main/switchTrigger'

const key = (
  o: Partial<{ type: string; key: string; control: boolean; shift: boolean; alt: boolean; meta: boolean; isAutoRepeat: boolean }>
) => ({
  type: 'keyDown',
  key: 'S',
  control: true,
  shift: true,
  alt: false,
  meta: false,
  isAutoRepeat: false,
  ...o
})

describe('isSwitchShortcut', () => {
  it('is Cmd+Shift+S on a Mac, and Ctrl+Shift+S is not', () => {
    expect(isSwitchShortcut(key({ control: false, meta: true }), true)).toBe(true)
    expect(isSwitchShortcut(key({}), true)).toBe(false)
    expect(isSwitchShortcut(key({ control: false, meta: true }))).toBe(false)
  })

  it('matches Ctrl+Shift+S, either letter case', () => {
    expect(isSwitchShortcut(key({}))).toBe(true)
    expect(isSwitchShortcut(key({ key: 's' }))).toBe(true)
  })
  it('ignores key-up, auto-repeat and other chords', () => {
    expect(isSwitchShortcut(key({ type: 'keyUp' }))).toBe(false)
    expect(isSwitchShortcut(key({ isAutoRepeat: true }))).toBe(false)
    expect(isSwitchShortcut(key({ shift: false }))).toBe(false)
    expect(isSwitchShortcut(key({ control: false }))).toBe(false)
    expect(isSwitchShortcut(key({ alt: true }))).toBe(false)
    expect(isSwitchShortcut(key({ key: 'D' }))).toBe(false)
  })
})

describe('wantsSwitchServer', () => {
  it('is true only for the exact flag', () => {
    expect(wantsSwitchServer(['zumibot', '--switch-server'])).toBe(true)
    expect(wantsSwitchServer(['electron', '.', '--no-sandbox', '--switch-server'])).toBe(true)
  })
  it('is false for no flag, a lookalike, or a value form', () => {
    expect(wantsSwitchServer(['zumibot'])).toBe(false)
    expect(wantsSwitchServer(['zumibot', '--switch-servers'])).toBe(false)
    expect(wantsSwitchServer(['zumibot', '--switch-server=1'])).toBe(false)
  })
})
