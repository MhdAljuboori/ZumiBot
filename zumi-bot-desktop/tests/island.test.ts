import { describe, expect, it } from 'vitest'
import { dragStep, ISLAND_DESKTOP_NAME, islandWanted, needsIslandLoad, preventsIslandClose, withDesktopName } from '../src/main/island'

const origin = 'http://127.0.0.1:4318'

describe('islandWanted', () => {
  it('has no window without a connected origin or a picked agent', () => {
    expect(islandWanted({ origin: null, picked: 2, ready: true, icons: 2, voice: false, open: false })).toBe('none')
    expect(islandWanted({ origin, picked: 0, ready: true, icons: 0, voice: false, open: false })).toBe('none')
  })

  it('stays hidden until the page is ready and while it reports no icon', () => {
    expect(islandWanted({ origin, picked: 2, ready: false, icons: 2, voice: false, open: false })).toBe('hidden')
    expect(islandWanted({ origin, picked: 2, ready: true, icons: 0, voice: false, open: false })).toBe('hidden')
  })

  it('is shown once ready with at least one icon', () => {
    expect(islandWanted({ origin, picked: 2, ready: true, icons: 2, voice: false, open: false })).toBe('shown')
  })
})

describe('islandWanted with a voice conversation', () => {
  it('shows a voice-only island with no agent picked and no icon', () => {
    expect(islandWanted({ origin, picked: 0, ready: true, icons: 0, voice: true, open: false })).toBe('shown')
    expect(islandWanted({ origin, picked: 0, ready: true, icons: 0, voice: false, open: false })).toBe('none')
  })

  it('still waits for the page and for a server', () => {
    expect(islandWanted({ origin, picked: 0, ready: false, icons: 0, voice: true, open: false })).toBe('hidden')
    expect(islandWanted({ origin: null, picked: 0, ready: true, icons: 0, voice: true, open: false })).toBe('none')
  })

  it('with agents picked and no icon, only a voice conversation shows it', () => {
    expect(islandWanted({ origin, picked: 2, ready: true, icons: 0, voice: false, open: false })).toBe('hidden')
    expect(islandWanted({ origin, picked: 2, ready: true, icons: 0, voice: true, open: false })).toBe('shown')
  })
})

describe('needsIslandLoad', () => {
  const base = { hasWindow: true, loading: false, onIsland: true, failed: false }

  it('sends a settled window back from a login page or a failed load', () => {
    expect(needsIslandLoad({ ...base, onIsland: false })).toBe(true)
    expect(needsIslandLoad({ ...base, failed: true })).toBe(true)
  })

  it('leaves a window on its page, loading or missing alone', () => {
    expect(needsIslandLoad(base)).toBe(false)
    expect(needsIslandLoad({ ...base, onIsland: false, loading: true })).toBe(false)
    expect(needsIslandLoad({ ...base, hasWindow: false, onIsland: false })).toBe(false)
  })
})

describe('preventsIslandClose', () => {
  it('keeps the live window against a user close', () => {
    expect(preventsIslandClose({ current: true, quitting: false })).toBe(true)
  })
  it('lets a quit close it, and a window already replaced', () => {
    expect(preventsIslandClose({ current: true, quitting: true })).toBe(false)
    expect(preventsIslandClose({ current: false, quitting: false })).toBe(false)
  })
})

describe('dragStep', () => {
  it('saves only after a move changed the position', () => {
    let s = dragStep(null, 'start', 100, 300)
    expect(s.drag).toEqual({ top: 300, screenY: 100, moved: false })
    expect(dragStep(s.drag, 'end', 100, 300)).toEqual({ drag: null, place: 300, save: false }) // a plain click
    s = dragStep(s.drag, 'move', 100, 300)
    expect(s.place).toBe(300)
    expect(dragStep(s.drag, 'end', 100, 300).save).toBe(false) // a move that went nowhere
    s = dragStep(s.drag, 'move', 140, 300)
    expect(s.place).toBe(340)
    expect(dragStep(s.drag, 'end', 140, 340)).toEqual({ drag: null, place: 340, save: true })
  })
  it('ends where the page slid the strip, when it says, and saves only if that is somewhere new', () => {
    const s = dragStep(null, 'start', 100, 300)
    expect(dragStep(s.drag, 'end', 100, 300, 420)).toEqual({ drag: null, place: 420, save: true })
    expect(dragStep(s.drag, 'end', 180, 300, 300)).toEqual({ drag: null, place: 300, save: false }) // slid back to where it began
  })
  it('ignores moves and ends with no drag, and a start without a known top', () => {
    expect(dragStep(null, 'move', 5, 300)).toEqual({ drag: null, place: null, save: false })
    expect(dragStep(null, 'end', 5, 300, 400)).toEqual({ drag: null, place: null, save: false })
    expect(dragStep(null, 'start', 5, null).drag).toBeNull()
  })
})

describe('withDesktopName', () => {
  it('names the island its own desktop entry while the window is made, then puts the app name back', () => {
    const env: NodeJS.ProcessEnv = { CHROME_DESKTOP: 'zumibot.desktop' }
    const seen = withDesktopName(env, ISLAND_DESKTOP_NAME, () => env['CHROME_DESKTOP'])
    expect(seen).toBe('zumibot-island.desktop')
    expect(env['CHROME_DESKTOP']).toBe('zumibot.desktop')
  })
  it('leaves no variable behind when there was none', () => {
    const env: NodeJS.ProcessEnv = {}
    withDesktopName(env, ISLAND_DESKTOP_NAME, () => 1)
    expect('CHROME_DESKTOP' in env).toBe(false)
  })
  it('puts the app name back when making the window throws', () => {
    const env: NodeJS.ProcessEnv = { CHROME_DESKTOP: 'zumibot.desktop' }
    expect(() =>
      withDesktopName(env, ISLAND_DESKTOP_NAME, () => {
        throw new Error('boom')
      })
    ).toThrow('boom')
    expect(env['CHROME_DESKTOP']).toBe('zumibot.desktop')
  })
})

describe('islandWanted with a popup open', () => {
  it('keeps an island with no agent picked while its popup shows a chat (a voice request opened it), and drops it when it closes', () => {
    expect(islandWanted({ origin, picked: 0, ready: true, icons: 0, voice: false, open: true })).toBe('shown')
    expect(islandWanted({ origin, picked: 0, ready: true, icons: 0, voice: false, open: false })).toBe('none')
    expect(islandWanted({ origin: null, picked: 0, ready: true, icons: 0, voice: false, open: true })).toBe('none')
  })
})
