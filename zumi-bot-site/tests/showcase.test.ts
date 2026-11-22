import { describe, expect, it } from 'vitest'
import { ICON_OPTIONS } from '@zumibot/shared/frontmatter'
import { SHAPE_PATHS } from '../../zumi-bot-server/frontend/src/botShapes.ts'
import { AGENTS, AGENT_COLORS, CAST, SCENES, castState, formatDate, roomQueue, waveBars } from '../src/showcase.ts'

describe('the demo cast', () => {
  it('draws every demo agent with a shape and a color the app offers', () => {
    for (const a of Object.values(AGENTS)) {
      expect(ICON_OPTIONS, a.name).toContain(a.shape)
      expect(Object.keys(SHAPE_PATHS), a.name).toContain(a.shape)
      expect(AGENT_COLORS, a.name).toContain(a.color)
    }
  })

  it('gives the four in the header different shapes and colors', () => {
    expect(new Set(CAST.map((id) => AGENTS[id].shape)).size).toBe(CAST.length)
    expect(new Set(CAST.map((id) => AGENTS[id].color)).size).toBe(CAST.length)
  })
})

describe('castState', () => {
  it('names who is busy in the scene being read, and everyone else looks at them', () => {
    const s = castState('control')
    expect(s.label).toBe('Reviewer is waiting on you')
    expect(s.working).toBe('reviewer')
    // Reviewer is third: the two to its left look right, Ops to its right looks left, Reviewer looks ahead.
    expect(s.look).toEqual({ planner: 1, coder: 1, reviewer: 0, ops: -1 })
  })

  it('is all idle, eyes ahead, in a scene with no agent', () => {
    for (const scene of ['everywhere', 'release'] as const) {
      const s = castState(scene)
      expect(s.label).toBe('All idle')
      expect(s.working).toBeNull()
      expect(Object.values(s.look).every((l) => l === 0)).toBe(true)
    }
  })

  it('has a line for every scene that has a working agent', () => {
    for (const scene of SCENES) {
      const s = castState(scene)
      if (s.working) expect(s.label).not.toContain('undefined')
    }
  })
})

describe('roomQueue', () => {
  it('keeps the moderator order with no mention', () => {
    expect(roomQueue(null)).toEqual(['coder', 'reviewer', 'ops'])
  })

  it('puts a mentioned agent first, once', () => {
    expect(roomQueue('ops')).toEqual(['ops', 'coder', 'reviewer'])
    expect(roomQueue('planner')).toEqual(['planner', 'coder', 'reviewer', 'ops'])
  })
})

describe('waveBars', () => {
  it('is the same on every call, with heights inside the 48px row', () => {
    const bars = waveBars(40)
    expect(bars).toEqual(waveBars(40))
    expect(bars).toHaveLength(40)
    for (const b of bars) {
      expect(b.h).toBeGreaterThanOrEqual(14)
      expect(b.h).toBeLessThanOrEqual(48)
      expect(b.delay).toBeGreaterThanOrEqual(0)
      expect(b.delay).toBeLessThan(1.1)
    }
  })
})

describe('formatDate', () => {
  it('formats in UTC, so the day never shifts', () => {
    expect(formatDate('2026-11-18T23:30:00Z')).toBe('Nov 18, 2026')
  })

  it('is empty for a missing or broken date', () => {
    expect(formatDate('')).toBe('')
    expect(formatDate('not a date')).toBe('')
  })
})
