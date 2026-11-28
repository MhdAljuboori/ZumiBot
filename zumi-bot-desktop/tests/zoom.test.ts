import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadZoom, nextZoom, parseZoom, saveZoom, zoomKey, zoomStep, ZOOM_STEPS } from '../src/main/zoom'

const key = (o: Partial<{ type: string; key: string; control: boolean; alt: boolean; meta: boolean }>) => ({
  type: 'keyDown',
  key: '=',
  control: true,
  alt: false,
  meta: false,
  ...o
})

describe('zoomKey', () => {
  it('reads Ctrl with =, +, -, _ and 0', () => {
    expect(zoomKey(key({}), false)).toBe('in')
    expect(zoomKey(key({ key: '+' }), false)).toBe('in')
    expect(zoomKey(key({ key: '-' }), false)).toBe('out')
    expect(zoomKey(key({ key: '_' }), false)).toBe('out')
    expect(zoomKey(key({ key: '0' }), false)).toBe('reset')
  })
  it('takes Cmd, not Ctrl, on a Mac', () => {
    expect(zoomKey(key({ control: false, meta: true }), true)).toBe('in')
    expect(zoomKey(key({}), true)).toBeNull()
    expect(zoomKey(key({ control: false, meta: true }), false)).toBeNull()
  })
  it('ignores key-up, Alt, a bare key and other keys', () => {
    expect(zoomKey(key({ type: 'keyUp' }), false)).toBeNull()
    expect(zoomKey(key({ alt: true }), false)).toBeNull()
    expect(zoomKey(key({ control: false }), false)).toBeNull()
    expect(zoomKey(key({ key: '9' }), false)).toBeNull()
  })
})

describe('nextZoom', () => {
  it('steps through the list and stops at its ends', () => {
    expect(nextZoom(1, 'in')).toBe(1.1)
    expect(nextZoom(1, 'out')).toBe(0.9)
    expect(nextZoom(3, 'in')).toBe(3)
    expect(nextZoom(0.5, 'out')).toBe(0.5)
    expect(nextZoom(2, 'reset')).toBe(1)
  })
  it('reaches 200% from 100% in five presses', () => {
    let f = 1
    for (let i = 0; i < 5; i++) f = nextZoom(f, 'in')
    expect(f).toBe(2)
    expect(ZOOM_STEPS.at(-1)).toBe(3)
  })
  it('moves a factor between steps to the next step that way', () => {
    expect(nextZoom(1.3, 'in')).toBe(1.5)
    expect(nextZoom(1.3, 'out')).toBe(1.25)
  })
})

describe('parseZoom', () => {
  it('keeps a factor in range and falls back to 1 otherwise', () => {
    expect(parseZoom({ factor: 1.25 })).toBe(1.25)
    expect(parseZoom({ factor: 9 })).toBe(1)
    expect(parseZoom({ factor: 0.1 })).toBe(1)
    expect(parseZoom({ factor: '2' })).toBe(1)
    expect(parseZoom(null)).toBe(1)
    expect(parseZoom([])).toBe(1)
  })
})

describe('loadZoom and saveZoom', () => {
  let dir = ''
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))
  it('round-trips, and reads a missing or broken file as 1', () => {
    dir = mkdtempSync(join(tmpdir(), 'zoom-'))
    const file = join(dir, 'zoom.json')
    expect(loadZoom(file)).toBe(1)
    saveZoom(file, 1.5)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ factor: 1.5 })
    expect(loadZoom(file)).toBe(1.5)
    writeFileSync(file, '{not json')
    expect(loadZoom(file)).toBe(1)
  })
})

describe('zoomStep', () => {
  const key = (k: string, control = true) => ({ type: 'keyDown', key: k, control, alt: false, meta: false })
  it("steps from the page's current factor, which a popout and the main window share per origin", () => {
    expect(zoomStep(key('='), false, 1.25)).toBe(1.5)
    expect(zoomStep(key('-'), false, 1.25)).toBe(1.1)
    expect(zoomStep(key('0'), false, 2)).toBe(1)
  })
  it('is null for any other key', () => {
    expect(zoomStep(key('a'), false, 1)).toBeNull()
    expect(zoomStep(key('=', false), false, 1)).toBeNull()
  })
})
