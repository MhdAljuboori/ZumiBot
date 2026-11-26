import { describe, expect, it } from 'vitest'
import { inView, placeMenu, visibleView } from '../src/state/menuPlace'

const button = (top: number, height = 30) => ({ left: 20, top, bottom: top + height, width: 120 })

describe('visibleView', () => {
  it('is the whole layout viewport when nothing covers it', () => {
    expect(visibleView({ innerHeight: 800, visualViewport: { offsetTop: 0, height: 800, scale: 1 } })).toEqual({
      top: 0,
      bottom: 800,
      layoutHeight: 800
    })
    expect(visibleView({ innerHeight: 800, visualViewport: null })).toEqual({ top: 0, bottom: 800, layoutHeight: 800 })
  })

  it('is the part left above a phone keyboard, panned or not', () => {
    expect(visibleView({ innerHeight: 800, visualViewport: { offsetTop: 0, height: 450, scale: 1 } })).toEqual({
      top: 0,
      bottom: 450,
      layoutHeight: 800
    })
    expect(visibleView({ innerHeight: 800, visualViewport: { offsetTop: 200, height: 450, scale: 1 } })).toEqual({
      top: 200,
      bottom: 650,
      layoutHeight: 800
    })
  })

  it('ignores a pinch zoom', () => {
    expect(visibleView({ innerHeight: 800, visualViewport: { offsetTop: 100, height: 400, scale: 2 } })).toEqual({
      top: 0,
      bottom: 800,
      layoutHeight: 800
    })
  })
})

describe('placeMenu', () => {
  const full = { top: 0, bottom: 800, layoutHeight: 800 }

  it('opens below a button with room under it', () => {
    expect(placeMenu(button(100), full)).toEqual({ left: 20, minWidth: 120, maxHeight: 320, top: 134 })
  })

  it('opens above when there is clearly more room there', () => {
    expect(placeMenu(button(700), full)).toEqual({ left: 20, minWidth: 120, maxHeight: 320, bottom: 104 })
  })

  it('measures the room against the part the keyboard leaves on screen', () => {
    // The button sits low in what is left above the keyboard: the list goes up, not under the keyboard.
    const kb = { top: 0, bottom: 450, layoutHeight: 800 }
    expect(placeMenu(button(380), kb)).toEqual({ left: 20, minWidth: 120, maxHeight: 320, bottom: 424 })
    // Panned: the room above starts at the pan, not the page's top.
    const panned = { top: 200, bottom: 650, layoutHeight: 800 }
    expect(placeMenu(button(300), panned)).toEqual({ left: 20, minWidth: 120, maxHeight: 308, top: 334 })
  })

  it('keeps the list on screen when the keyboard covers the button', () => {
    const kb = { top: 0, bottom: 450, layoutHeight: 800 }
    const place = placeMenu(button(500), kb)
    expect(place.top).toBeUndefined()
    // Anchored at the keyboard's top edge, so it sits in what is shown.
    expect(place.bottom).toBe(800 - 450 + 4)
    expect(place.maxHeight).toBe(320)
  })
})

describe('inView', () => {
  const kb = { top: 200, bottom: 650, layoutHeight: 800 }

  it('is true while any of the button is shown', () => {
    expect(inView(button(300), kb)).toBe(true)
    expect(inView(button(180), kb)).toBe(true)
    expect(inView(button(640), kb)).toBe(true)
  })

  it('is false once the button has left what is shown', () => {
    expect(inView(button(100), kb)).toBe(false)
    expect(inView(button(660), kb)).toBe(false)
  })
})
