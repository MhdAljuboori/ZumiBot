import { describe, expect, it, vi } from 'vitest'
import { macMenuTemplate } from '../src/main/appMenu'

describe('macMenuTemplate', () => {
  const quit = vi.fn()
  const menu = macMenuTemplate({ appName: 'ZumiBot', quit })
  const roles = menu.flatMap((m) => (m.submenu as { role?: string }[]).map((i) => i.role).filter(Boolean))

  it('has the Edit roles a Mac text field needs for Cmd+C/V/X/A/Z', () => {
    expect(roles).toEqual(expect.arrayContaining(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']))
  })

  it('has no reload or DevTools, and Cmd+Q runs the close checks instead of the plain quit role', () => {
    for (const r of ['reload', 'forceReload', 'toggleDevTools', 'quit']) expect(roles).not.toContain(r)
    const item = (menu[0]!.submenu as { label?: string; accelerator?: string; click?: () => void }[]).find((i) => i.accelerator === 'Command+Q')!
    item.click!()
    expect(quit).toHaveBeenCalledOnce()
  })
})
