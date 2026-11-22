import { describe, expect, it, vi } from 'vitest'
import { trayMenuTemplate } from '../src/main/tray'

describe('trayMenuTemplate', () => {
  it('is Open, a separator and Quit', () => {
    expect(trayMenuTemplate({ open() {}, quit() {} }).map((i) => i.label ?? i.type)).toEqual(['Open', 'separator', 'Quit'])
  })
  it('wires the clicks', () => {
    const open = vi.fn()
    const quit = vi.fn()
    const [o, , q] = trayMenuTemplate({ open, quit })
    ;(o.click as () => void)()
    expect(open).toHaveBeenCalledTimes(1)
    expect(quit).not.toHaveBeenCalled()
    ;(q.click as () => void)()
    expect(quit).toHaveBeenCalledTimes(1)
  })
})
