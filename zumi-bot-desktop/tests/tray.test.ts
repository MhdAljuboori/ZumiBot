import { describe, expect, it, vi } from 'vitest'
import { trayMenuTemplate } from '../src/main/tray'

describe('trayMenuTemplate', () => {
  it('is Open, Sponsor ZumiBot, a separator and Quit', () => {
    expect(trayMenuTemplate({ open() {}, sponsor() {}, quit() {} }).map((i) => i.label ?? i.type)).toEqual([
      'Open',
      'Sponsor ZumiBot',
      'separator',
      'Quit'
    ])
  })
  it('wires the clicks', () => {
    const open = vi.fn()
    const sponsor = vi.fn()
    const quit = vi.fn()
    const [o, s, , q] = trayMenuTemplate({ open, sponsor, quit })
    ;(o.click as () => void)()
    expect(open).toHaveBeenCalledTimes(1)
    expect(sponsor).not.toHaveBeenCalled()
    expect(quit).not.toHaveBeenCalled()
    ;(s.click as () => void)()
    expect(sponsor).toHaveBeenCalledTimes(1)
    ;(q.click as () => void)()
    expect(quit).toHaveBeenCalledTimes(1)
  })
})
