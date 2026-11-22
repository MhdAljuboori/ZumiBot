import { describe, expect, it } from 'vitest'
import { editMenuPlace } from '../src/state/editMenu'

const view = { width: 1000, height: 800 }

describe('editMenuPlace', () => {
  it('opens above the box when there is room', () => {
    expect(editMenuPlace({ top: 500, bottom: 600, left: 300 }, view)).toEqual({ left: 300, bottom: 306, maxHeight: 260 })
  })

  it('opens below a box near the top of the window', () => {
    expect(editMenuPlace({ top: 60, bottom: 160, left: 300 }, view)).toEqual({ left: 300, top: 166, maxHeight: 260 })
  })

  it('takes the roomier side and shrinks to it when neither fits', () => {
    expect(editMenuPlace({ top: 200, bottom: 650, left: 300 }, view)).toEqual({ left: 300, bottom: 606, maxHeight: 186 })
  })

  it('stays inside the window edges', () => {
    expect(editMenuPlace({ top: 500, bottom: 600, left: 900 }, view).left).toBe(752)
    expect(editMenuPlace({ top: 500, bottom: 600, left: -20 }, view).left).toBe(8)
  })
})
