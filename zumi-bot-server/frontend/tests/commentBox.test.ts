import { describe, expect, it } from 'vitest'
import { popPlace } from '../src/state/commentBox'

describe('popPlace', () => {
  const box = { left: 20, top: 300, bottom: 360, width: 400 }
  it('floats under the box when the list fits there', () => {
    expect(popPlace(box, 800)).toEqual({ left: 20, width: 400, top: 364, maxHeight: 260 })
  })
  it('floats over the box when below is short and above has more room, capped by that room', () => {
    expect(popPlace(box, 420)).toEqual({ left: 20, width: 400, bottom: 124, maxHeight: 260 })
    expect(popPlace({ ...box, top: 100, bottom: 160 }, 200)).toEqual({ left: 20, width: 400, bottom: 104, maxHeight: 88 })
  })
})
