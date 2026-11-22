import { describe, expect, it } from 'vitest'
import { DesktopObservations } from '../../../src/core/desktop/desktopObservation'
import type { CuaResult } from '../../../src/core/desktop/types'

const win = (id: number) => ({
  window_id: id,
  pid: 1,
  app_name: 'App',
  title: 'Title',
  bounds: { x: 0, y: 0, width: 100, height: 100 },
  is_on_screen: true
})
const ok = (structuredContent: Record<string, unknown>): CuaResult => ({ content: [], isError: false, structuredContent })
const stamp = { generation: 'g', epoch: 1, observationId: 'o' }

describe('DesktopObservations', () => {
  it('launched windows add to the map until it would pass the list cap, then it starts over', () => {
    const seen = new DesktopObservations()
    seen.setWindows({ windows: [win(1)] })
    seen.learn({ op: 'launch', stamp, name: 'App' }, [ok({ windows: [win(2)] })])
    expect(seen.knowsWindow(1)).toBe(true)
    expect(seen.knowsWindow(2)).toBe(true)
    seen.learn({ op: 'launch', stamp, name: 'App' }, [ok({ windows: Array.from({ length: 99 }, (_, i) => win(100 + i)) })])
    expect(seen.knowsWindow(1)).toBe(false)
    expect(seen.knowsWindow(2)).toBe(false)
    expect(seen.knowsWindow(100)).toBe(true)
    expect(seen.knowsWindow(198)).toBe(true)
  })
  it('a stamp is current only for its observation, generation and lease epoch', () => {
    const seen = new DesktopObservations()
    const current = seen.observe('o1', 'g1', 3, null, false)
    expect(seen.isCurrent(current, 'g1', 3)).toBe(true)
    expect(seen.isCurrent(current, 'g1', 4)).toBe(false)
    expect(seen.isCurrent(current, 'g2', 3)).toBe(false)
    expect(seen.isCurrent({ ...current, observationId: 'o0' }, 'g1', 3)).toBe(false)
    seen.invalidate()
    expect(seen.isCurrent(current, 'g1', 3)).toBe(false)
  })
})
