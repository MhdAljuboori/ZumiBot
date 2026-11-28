import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { DEFAULT_POPOUT_SIZE, loadPopoutSize, parsePopoutSize, popoutBounds, savePopoutSize } from '../src/main/popoutLayout'

const area = { x: 0, y: 0, width: 1920, height: 1050 }

describe('parsePopoutSize', () => {
  it('reads a whole-pixel size', () => {
    expect(parsePopoutSize({ width: 1000.4, height: 650.6 })).toEqual({ width: 1000, height: 651 })
  })
  it('clamps a tiny size to the minimum', () => {
    expect(parsePopoutSize({ width: 100, height: 50 })).toEqual({ width: 480, height: 360 })
  })
  it('falls back to the default for anything broken', () => {
    expect(DEFAULT_POPOUT_SIZE).toEqual({ width: 900, height: 700 })
    expect(parsePopoutSize(null)).toEqual(DEFAULT_POPOUT_SIZE)
    expect(parsePopoutSize({ width: 'wide', height: 600 })).toEqual(DEFAULT_POPOUT_SIZE)
    expect(parsePopoutSize({ width: Infinity, height: 600 })).toEqual(DEFAULT_POPOUT_SIZE)
  })
})

describe('loadPopoutSize / savePopoutSize', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(os.tmpdir(), 'popout-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })
  it('round-trips the size', () => {
    const file = join(dir, 'popout-state.json')
    savePopoutSize(file, { width: 1100, height: 720 })
    expect(loadPopoutSize(file)).toEqual({ width: 1100, height: 720 })
  })
  it('gives the default for a missing or broken file', async () => {
    const file = join(dir, 'popout-state.json')
    expect(loadPopoutSize(file)).toEqual(DEFAULT_POPOUT_SIZE)
    await fs.writeFile(file, '{not json')
    expect(loadPopoutSize(file)).toEqual(DEFAULT_POPOUT_SIZE)
  })
})

describe('popoutBounds', () => {
  const size = { width: 900, height: 700 }
  it('cascades from the anchor window by 32 px per popout already open', () => {
    const anchor = { x: 100, y: 80, width: 1200, height: 800 }
    expect(popoutBounds(size, anchor, 0, area)).toEqual({ x: 132, y: 112, width: 900, height: 700 })
    expect(popoutBounds(size, anchor, 2, area)).toEqual({ x: 196, y: 176, width: 900, height: 700 })
  })
  it('centres in the work area with no anchor', () => {
    expect(popoutBounds(size, null, 0, area)).toEqual({ x: 510, y: 175, width: 900, height: 700 })
  })
  it('starts the cascade again at the anchor when it would leave the work area', () => {
    const anchor = { x: 900, y: 300, width: 1000, height: 700 }
    // 900 + 32 * 4 + 900 > 1920: wraps to the anchor's own corner plus one step, then fits inside the area.
    const b = popoutBounds(size, anchor, 4, area)
    expect(b.x + b.width).toBeLessThanOrEqual(area.x + area.width)
    expect(b.y + b.height).toBeLessThanOrEqual(area.y + area.height)
    expect(b.x).toBeGreaterThanOrEqual(area.x)
    expect(b.y).toBeGreaterThanOrEqual(area.y)
  })
  it('shrinks to the work area on a small screen', () => {
    const small = { x: 0, y: 0, width: 800, height: 600 }
    expect(popoutBounds(size, null, 0, small)).toEqual({ x: 0, y: 0, width: 800, height: 600 })
  })
})
