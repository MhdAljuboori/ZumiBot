import { describe, expect, it } from 'vitest'
import type { ChatMeta } from '@zumibot/shared/types'
import { agentColor, agentInk, agentIsWorking, bobTiming, isCustomIcon, nextTilt, shapeOf, shapeSelected } from '../src/state/bot'

const seq = (...values: number[]) => {
  let i = 0
  return () => values[i++]
}

describe('shapeOf', () => {
  it('returns known shapes', () => {
    expect(shapeOf('cat')).toBe('cat')
    expect(shapeOf('honeycomb')).toBe('honeycomb')
  })
  it('shows the faces from before 0.1.0 as their nearest shape', () => {
    expect(shapeOf('triangles')).toBe('robot')
    expect(shapeOf('wink')).toBe('cat')
    expect(shapeOf('circles')).toBe('chat')
  })
  it('falls back to robot', () => {
    for (const v of [null, 'Cat', 'Wink', 'zumi-z', '3', 'constructor', '__proto__', 'toString']) expect(shapeOf(v)).toBe('robot')
  })
})

describe('agentColor', () => {
  it('maps palette colors', () => expect(agentColor('green')).toBe('var(--agent-green)'))
  it('is null without a palette color', () => {
    expect(agentColor(null)).toBeNull()
    expect(agentColor('teal')).toBeNull()
  })
})

describe('agentInk', () => {
  it('maps palette colors to their text variant', () => expect(agentInk('yellow')).toBe('var(--agent-yellow-ink)'))
  it('is null without a palette color', () => {
    expect(agentInk(null)).toBeNull()
    expect(agentInk('constructor')).toBeNull()
  })
})

describe('agentIsWorking', () => {
  const agent = { name: 'rev', error: null }
  it('is false with no chats', () => expect(agentIsWorking(agent, [], {})).toBe(false))
  it('is true with a running chat', () => {
    expect(agentIsWorking(agent, [{ id: 'c1', agentName: 'rev', inFlight: true }], {})).toBe(true)
  })
  it('is false when the running chat awaits approval', () => {
    expect(agentIsWorking(agent, [{ id: 'c1', agentName: 'rev', inFlight: true }], { c1: 1 })).toBe(false)
  })
  it('is true when another chat runs without approval pending', () => {
    const chats = [
      { id: 'c1', agentName: 'rev', inFlight: true },
      { id: 'c2', agentName: 'rev', inFlight: true }
    ]
    expect(agentIsWorking(agent, chats, { c1: 1 })).toBe(true)
  })
  it('ignores other agents', () => {
    expect(agentIsWorking(agent, [{ id: 'c1', agentName: 'rev-2', inFlight: true }], {})).toBe(false)
  })
  it('is false for an agent with an error', () => {
    const bad = { name: 'rev', error: 'Duplicate name rev' }
    expect(agentIsWorking(bad, [{ id: 'c1', agentName: 'rev', inFlight: true }], {})).toBe(false)
  })
})

describe('nextTilt', () => {
  it('keeps current when chance fails', () => expect(nextTilt(5, seq(0.9))).toBe(5))
  it('picks from the angle table', () => {
    expect(nextTilt(5, seq(0.1, 0))).toBe(-14)
    expect(nextTilt(5, seq(0.1, 0.99))).toBe(14)
  })
})

describe('bobTiming', () => {
  it('derives duration and delay', () => {
    expect(bobTiming(seq(0.5, 0.25))).toEqual({ duration: '1.20s', delay: '-0.25s' })
    expect(bobTiming(seq(0, 0))).toEqual({ duration: '0.90s', delay: '-0.00s' })
  })
})

describe('shapeSelected', () => {
  it('treats a missing icon as robot', () => {
    expect(shapeSelected(null, 'robot')).toBe(true)
    expect(shapeSelected(null, 'cat')).toBe(false)
  })
  it('matches an explicit icon exactly', () => {
    expect(shapeSelected('cat', 'cat')).toBe(true)
    expect(shapeSelected('cat', 'robot')).toBe(false)
  })
  it("selects an old face's nearest shape", () => {
    expect(shapeSelected('wink', 'cat')).toBe(true)
    expect(shapeSelected('wink', 'robot')).toBe(false)
  })
  it('selects nothing for a custom icon, though it is drawn as robot', () => {
    expect(shapeSelected('zumi-z', 'robot')).toBe(false)
    expect(shapeSelected('Cat', 'cat')).toBe(false)
  })
})

describe('isCustomIcon', () => {
  it('is false for null, known shapes and old faces', () => {
    expect(isCustomIcon(null)).toBe(false)
    expect(isCustomIcon('robot')).toBe(false)
    expect(isCustomIcon('wink')).toBe(false)
  })
  it("is true for unknown values and Zumi Bot's own shape", () => {
    expect(isCustomIcon('zumi-z')).toBe(true)
    expect(isCustomIcon('Wink')).toBe(true)
    expect(isCustomIcon('constructor')).toBe(true)
  })
})

describe('agentIsWorking for group members', () => {
  const group = (activeAgent: string | null, inFlight: boolean): Pick<ChatMeta, 'id' | 'agentName' | 'inFlight' | 'group'> => ({
    id: 'g',
    agentName: '',
    inFlight,
    group: {
      members: ['ui', 'wk'],
      sessions: {},
      seen: {},
      role: '',
      active: activeAgent === null ? [] : [{ agent: activeAgent, turn: 't', since: 1 }],
      queue: []
    }
  })
  const ui = { name: 'ui', error: null }

  it('is true for the active member of an in-flight group', () => {
    expect(agentIsWorking(ui, [group('ui', true)], {})).toBe(true)
  })
  it('is false for other members, idle groups and pending approvals', () => {
    expect(agentIsWorking(ui, [group('wk', true)], {})).toBe(false)
    expect(agentIsWorking(ui, [group('ui', false)], {})).toBe(false)
    expect(agentIsWorking(ui, [group('ui', true)], { g: 1 })).toBe(false)
  })
})
