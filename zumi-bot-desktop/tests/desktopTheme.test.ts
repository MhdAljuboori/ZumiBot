import { describe, expect, it } from 'vitest'
import { createShowGate, parsePortalColorScheme } from '../src/main/desktopTheme'

describe('parsePortalColorScheme', () => {
  it('reads prefer-dark from Settings.Read and Settings.ReadOne replies', () => {
    expect(parsePortalColorScheme('(<<uint32 1>>,)\n')).toBe(true)
    expect(parsePortalColorScheme('(<uint32 1>,)\n')).toBe(true)
  })

  it('treats no preference and prefer-light as light', () => {
    expect(parsePortalColorScheme('(<<uint32 0>>,)\n')).toBe(false)
    expect(parsePortalColorScheme('(<<uint32 2>>,)\n')).toBe(false)
  })

  it('returns null for a reply without a color scheme', () => {
    expect(parsePortalColorScheme('')).toBeNull()
    expect(parsePortalColorScheme('Error: GDBus.Error:org.freedesktop.portal.Error.NotFound')).toBeNull()
  })
})

function setup(settled: boolean) {
  const s = { settled, shows: 0 }
  const gate = createShowGate({
    themeSettled: () => s.settled,
    show: () => s.shows++
  })
  return { s, gate }
}

describe('createShowGate', () => {
  it('shows on first paint when the theme is already settled', () => {
    const { s, gate } = setup(true)
    expect(s.shows).toBe(0)
    gate.painted()
    expect(s.shows).toBe(1)
  })

  it('holds a painted window until the theme settles', () => {
    const { s, gate } = setup(false)
    gate.painted()
    gate.themeUpdated()
    expect(s.shows).toBe(0)
    s.settled = true
    gate.themeUpdated()
    expect(s.shows).toBe(1)
  })

  it('does not show before the first paint', () => {
    const { s, gate } = setup(true)
    gate.themeUpdated()
    gate.giveUp()
    expect(s.shows).toBe(0)
  })

  it('shows anyway on give up', () => {
    const { s, gate } = setup(false)
    gate.painted()
    gate.giveUp()
    expect(s.shows).toBe(1)
  })

  it('shows only once', () => {
    const { s, gate } = setup(true)
    gate.painted()
    gate.themeUpdated()
    gate.giveUp()
    expect(s.shows).toBe(1)
  })
})
