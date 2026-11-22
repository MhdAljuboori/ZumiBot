import { describe, expect, it } from 'vitest'
import { nextCompact } from '../src/state/pickerRow'

describe('picker row fit', () => {
  it('goes compact when the full row is wider than the room it has', () => {
    expect(nextCompact(900, 800)).toBe(true)
  })

  it('stays full when the full row fits, within a pixel of rounding', () => {
    expect(nextCompact(800.5, 800)).toBe(false)
    expect(nextCompact(600, 800)).toBe(false)
  })

  it('stays compact until the room reaches the width the full row needed', () => {
    expect(nextCompact(900, 850)).toBe(true)
    expect(nextCompact(900, 900)).toBe(false)
  })

  it('tries the full row again when its width is not known (its content changed)', () => {
    expect(nextCompact(null, 300)).toBe(false)
  })
})
