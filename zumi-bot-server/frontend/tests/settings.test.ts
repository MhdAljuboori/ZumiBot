import { describe, expect, it } from 'vitest'
import { keepWarmLabel, mobileDevice, settingsLabel, shownSection, visibleSections } from '../src/state/settings'

describe('settings', () => {
  it('lists Account only on a server with a sign-in', () => {
    expect(visibleSections(true, false)).toContain('account')
    expect(visibleSections(false, false)).not.toContain('account')
    expect(visibleSections(false, false)[0]).toBe('general')
  })

  it('lists Island & startup only in a shell that has the island', () => {
    expect(visibleSections(false, false)).not.toContain('island')
    expect(visibleSections(false, true)).toContain('island')
    expect(settingsLabel('island', true)).toBe('Island & startup')
  })

  it('shows General for a section this UI does not list, only for the island', () => {
    expect(shownSection('island', false)).toBe('general')
    expect(shownSection('island', true)).toBe('island')
    expect(shownSection('account', false)).toBe('account')
  })

  it('names Sync for the server too in the desktop app, which can also switch server', () => {
    expect(settingsLabel('sync', false)).toBe('Sync')
    expect(settingsLabel('sync', true)).toBe('Sync & server')
    expect(settingsLabel('jev', false)).toBe('Jev decisions')
  })

  it('lists Claude Code right after Vault, and names it the same in the desktop app', () => {
    for (const vps of [true, false]) {
      const list = visibleSections(vps)
      expect(list[list.indexOf('vault') + 1]).toBe('claude-code')
    }
    expect(settingsLabel('claude-code', false)).toBe('Claude Code')
    expect(settingsLabel('claude-code', true)).toBe('Claude Code')
  })

  it('lists Connectors right after Claude Code', () => {
    for (const vps of [true, false]) {
      const list = visibleSections(vps)
      expect(list[list.indexOf('claude-code') + 1]).toBe('connectors')
    }
    expect(settingsLabel('connectors', false)).toBe('Connectors')
    expect(settingsLabel('connectors', true)).toBe('Connectors')
  })

  it('tells a phone or tablet, which has no desktop app for the Sync link, from a PC', () => {
    const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'
    const iphone =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
    const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
    const linux = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
    expect(mobileDevice(android, 5)).toBe(true)
    expect(mobileDevice(iphone, 5)).toBe(true)
    // iPadOS asks for the desktop site and says Macintosh; only its touch screen gives it away.
    expect(mobileDevice(mac, 5)).toBe(true)
    expect(mobileDevice(mac, 0)).toBe(false)
    expect(mobileDevice(linux, 0)).toBe(false)
    expect(mobileDevice(linux, 10)).toBe(false)
  })

  it('names a keep-warm window: off, or its hours', () => {
    expect(keepWarmLabel(0)).toBe('Off')
    expect(keepWarmLabel(2)).toBe('2 hours')
    expect(keepWarmLabel(12)).toBe('12 hours')
  })
})
