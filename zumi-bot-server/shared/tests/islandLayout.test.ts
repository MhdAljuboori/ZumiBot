import { describe, expect, it } from 'vitest'
import {
  ISLAND_WIDTH,
  POPUP_GAP,
  POPUP_HEIGHT,
  POPUP_WIDTH,
  STRIP_WIDTH,
  clampTop,
  islandBounds,
  slideLayout,
  stripHeight
} from '@zumibot/shared/islandLayout'

const area = { x: 0, y: 27, width: 1920, height: 1053 }
const whole = (r: { x: number; y: number; width: number; height: number }): boolean => Object.values(r).every(Number.isInteger)

describe('islandLayout', () => {
  it('stripHeight adds the curves, padding, icons and gaps', () => {
    expect(stripHeight(1)).toBe(2 * 22 + 2 * 12 + 38)
    expect(stripHeight(3)).toBe(2 * 22 + 2 * 12 + 3 * 38 + 2 * 12)
  })

  it('clampTop centres a null top and keeps the strip inside the area', () => {
    expect(clampTop(null, 100, area)).toBe(27 + (1053 - 100) / 2)
    expect(clampTop(-50, 100, area)).toBe(27)
    expect(clampTop(5000, 100, area)).toBe(27 + 1053 - 100)
    expect(clampTop(400, 100, area)).toBe(400)
  })

  it("the window is the work area's full-height right-hand column, whatever the strip, its top or the popup", () => {
    // Moving the window is what the drag must never do (Mutter applied each move up to a second late), and a resize
    // freezes this transparent window for about a second: so the window depends on the work area alone.
    const windows = new Set<string>()
    for (const top of [null, -50, 27, 400, 900, 5000]) {
      for (const icons of [1, 3, 10]) {
        for (const open of [false, true]) windows.add(JSON.stringify(islandBounds({ area, top, icons, open }).window))
      }
    }
    expect([...windows]).toEqual([JSON.stringify({ x: 1920 - ISLAND_WIDTH, y: 27, width: ISLAND_WIDTH, height: 1053 })])
    expect(ISLAND_WIDTH).toBe(POPUP_WIDTH + POPUP_GAP + STRIP_WIDTH)
  })

  it('places the strip at its top in window coordinates, in whole pixels, and returns the clamped screen top to save', () => {
    const b = islandBounds({ area, top: 400, icons: 3, open: false })
    expect(b.layout.strip).toEqual({ x: POPUP_WIDTH + POPUP_GAP, y: 400 - 27, width: STRIP_WIDTH, height: stripHeight(3) })
    expect(b.layout.popup).toBeNull()
    expect(b.top).toBe(400)
    expect(islandBounds({ area, top: 5000, icons: 3, open: false }).top).toBe(27 + 1053 - stripHeight(3))
    expect(islandBounds({ area, top: -50, icons: 3, open: false }).top).toBe(27)
    for (const icons of [1, 2, 3, 4]) {
      const c = islandBounds({ area, top: null, icons, open: true }) // centred: fractional before rounding
      expect(whole(c.window) && whole(c.layout.strip) && whole(c.layout.popup!)).toBe(true)
      expect(Number.isInteger(c.top)).toBe(true)
      expect(c.window.y + c.layout.strip.y).toBe(c.top)
    }
  })

  it('gives the strip its column as the track it slides in', () => {
    const b = islandBounds({ area, top: 400, icons: 3, open: false })
    expect(b.layout.track).toEqual({ x: POPUP_WIDTH + POPUP_GAP, y: 0, width: STRIP_WIDTH, height: 1053 })
  })

  it('open: the popup sits left of the strip, level with it, inside the window', () => {
    const open = islandBounds({ area, top: 400, icons: 3, open: true })
    const popup = open.layout.popup!
    expect(popup).toEqual({ x: 0, y: expect.any(Number), width: POPUP_WIDTH, height: POPUP_HEIGHT })
    expect(popup.y + popup.height / 2).toBe(open.layout.strip.y + stripHeight(3) / 2)
    expect(open.layout.strip).toEqual(islandBounds({ area, top: 400, icons: 3, open: false }).layout.strip)
  })

  it('open: a popup near either end is pulled into the window', () => {
    const low = islandBounds({ area, top: 1000, icons: 1, open: true }).layout.popup!
    expect(low.y + low.height).toBe(1053)
    const high = islandBounds({ area, top: 27, icons: 1, open: true }).layout.popup!
    expect(high.y).toBe(0)
  })

  it('no icon and open (a voice-only island): a popup and a zero-height strip', () => {
    const b = islandBounds({ area, top: null, icons: 0, open: true })
    expect(b.layout.strip.height).toBe(0)
    expect(b.layout.popup).toEqual({ x: 0, y: expect.any(Number), width: POPUP_WIDTH, height: POPUP_HEIGHT })
    expect(b.layout.popup!.y).toBeGreaterThanOrEqual(0)
    expect(b.layout.popup!.y + POPUP_HEIGHT).toBeLessThanOrEqual(b.window.height)
    expect(b.window).toEqual(islandBounds({ area, top: null, icons: 3, open: true }).window)
    expect(islandBounds({ area, top: null, icons: 0, open: false }).layout.popup).toBeNull()
  })

  it('open: a popup taller than the work area takes the whole height', () => {
    const o = islandBounds({ area: { x: 0, y: 0, width: 800, height: 400 }, top: 0, icons: 1, open: true })
    expect(o.layout.popup).toEqual({ x: 0, y: 0, width: POPUP_WIDTH, height: 400 })
    expect(o.window.height).toBe(400)
  })
})

describe('slideLayout', () => {
  it("lands on the very pixels the shell places the strip at, so the page's drag and the saved spot agree", () => {
    for (const open of [false, true]) {
      const start = islandBounds({ area, top: 300, icons: 3, open }).layout
      for (const top of [-80, 0, 123, 456.4, 700, 2000]) {
        expect(slideLayout(start, top)).toEqual(islandBounds({ area, top: area.y + top, icons: 3, open }).layout)
      }
    }
  })

  it('keeps the strip and the popup inside the track', () => {
    const start = islandBounds({ area, top: 300, icons: 3, open: true }).layout
    const down = slideLayout(start, 5000)
    expect(down.strip.y).toBe(1053 - stripHeight(3))
    expect(down.popup!.y + down.popup!.height).toBe(1053)
    const up = slideLayout(start, -5000)
    expect(up.strip.y).toBe(0)
    expect(up.popup!.y).toBe(0)
  })
})
