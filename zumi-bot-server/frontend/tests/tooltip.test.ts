import { describe, expect, it } from 'vitest'
import { describes, GAP, MARGIN, placeTip, repeats, SHOW_MS, showDelay, tipNeeded, WARM_MS } from '../src/state/tooltip'

const view = { width: 1000, height: 800 }
const tip = { width: 100, height: 30 }

describe('placeTip', () => {
  it('centers the tip above the target when it fits', () => {
    const p = placeTip({ left: 400, top: 300, width: 40, height: 20 }, tip, view)
    expect(p).toEqual({ left: 370, top: 300 - GAP - 30, side: 'top' })
  })

  it('goes below when above would leave the window', () => {
    const p = placeTip({ left: 400, top: 20, width: 40, height: 20 }, tip, view)
    expect(p).toEqual({ left: 370, top: 20 + 20 + GAP, side: 'bottom' })
  })

  it('keeps the margin at the window edges', () => {
    expect(placeTip({ left: 0, top: 300, width: 20, height: 20 }, tip, view).left).toBe(MARGIN)
    expect(placeTip({ left: 990, top: 300, width: 10, height: 20 }, tip, view).left).toBe(1000 - MARGIN - 100)
  })

  it('stays above when below would not fit either', () => {
    const p = placeTip({ left: 400, top: 30, width: 40, height: 760 }, tip, view)
    expect(p.side).toBe('top')
  })
})

describe('showDelay', () => {
  it('waits for a first tip', () => {
    expect(showDelay(10_000, false, null)).toBe(SHOW_MS)
    expect(showDelay(10_000, false, 10_000 - WARM_MS)).toBe(SHOW_MS)
  })

  it('shows at once while one is open or just closed', () => {
    expect(showDelay(10_000, true, null)).toBe(0)
    expect(showDelay(10_000, false, 10_000 - WARM_MS + 1)).toBe(0)
  })
})

describe('repeats', () => {
  it('finds the tip in the element or a part inside it', () => {
    expect(repeats('report.md', ['report.md12 KB', ' report.md ', '12 KB'])).toBe(true)
  })

  it('does not take a part of the text for the whole', () => {
    expect(repeats('/home/me/project', ['project', 'project/home'])).toBe(false)
  })
})

describe('tipNeeded', () => {
  it('skips a blank tip', () => {
    expect(tipNeeded('  ', false, true)).toBe(false)
  })

  it('shows a tip that repeats the text only when the text is cut off', () => {
    expect(tipNeeded('report.md', true, false)).toBe(false)
    expect(tipNeeded('report.md', true, true)).toBe(true)
  })

  it('always shows a tip that says something else', () => {
    expect(tipNeeded('Close (Esc)', false, false)).toBe(true)
  })
})

describe('describes', () => {
  it('skips a tip that only repeats the name', () => {
    expect(describes('Remove', ' Remove')).toBe(false)
  })

  it('describes with a tip that adds to the name', () => {
    expect(describes('Wait for the reply to finish', 'Send')).toBe(true)
  })
})
