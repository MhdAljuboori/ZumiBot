import { describe, expect, it } from 'vitest'
import { isThemePref } from '@zumibot/shared/types'

describe('isThemePref', () => {
  it('accepts exactly the three prefs', () => {
    for (const t of ['system', 'light', 'dark']) expect(isThemePref(t)).toBe(true)
    for (const v of ['DARK', 'Dark', '', 5, null, undefined, {}, ['dark']]) expect(isThemePref(v)).toBe(false)
  })
})
