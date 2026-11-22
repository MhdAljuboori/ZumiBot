import { describe, expect, it } from 'vitest'
import { ISLAND_AGENTS_MAX } from '@zumibot/shared/island'
import type { AgentSummary } from '@zumibot/shared/types'
import { hotkeyFromKey, livePicks, movePick, pickRows, togglePick } from '../src/state/islandSettings'

const agent = (name: string, error: string | null = null): AgentSummary => ({
  filePath: `/a/${name}.md`,
  name,
  description: '',
  color: null,
  icon: null,
  error,
  builtIn: false
})

describe('togglePick', () => {
  it('appends or removes', () => {
    expect(togglePick(['a'], 'b')).toEqual(['a', 'b'])
    expect(togglePick(['a', 'b'], 'a')).toEqual(['b'])
  })
  it('never grows past the maximum', () => {
    const full = Array.from({ length: ISLAND_AGENTS_MAX }, (_, i) => `a${i}`)
    expect(togglePick(full, 'z')).toEqual(full)
    expect(togglePick(full, 'a0')).toHaveLength(ISLAND_AGENTS_MAX - 1)
  })
})

describe('movePick', () => {
  it('swaps with the neighbour', () => {
    expect(movePick(['a', 'b', 'c'], 'c', -1)).toEqual(['a', 'c', 'b'])
    expect(movePick(['a', 'b', 'c'], 'a', 1)).toEqual(['b', 'a', 'c'])
  })
  it('stays put at an end or for an unknown name', () => {
    expect(movePick(['a', 'b'], 'a', -1)).toEqual(['a', 'b'])
    expect(movePick(['a', 'b'], 'b', 1)).toEqual(['a', 'b'])
    expect(movePick(['a', 'b'], 'x', 1)).toEqual(['a', 'b'])
  })
})

describe('pickRows', () => {
  it('lists picked first in pick order, then the rest by display name', () => {
    expect(pickRows(['b'], [agent('a'), agent('b')]).map((r) => r.agent.name)).toEqual(['b', 'a'])
    expect(pickRows([], [agent('zed'), agent('Alpha-x'), agent('beta')]).map((r) => r.agent.name)).toEqual(['Alpha-x', 'beta', 'zed'])
  })
  it('numbers picked rows and disables a broken unpicked one', () => {
    const rows = pickRows(['b', 'bad'], [agent('a'), agent('b'), agent('bad', 'x'), agent('worse', 'x')])
    expect(rows.map((r) => [r.agent.name, r.picked, r.index, r.disabled])).toEqual([
      ['b', true, 0, false],
      ['bad', true, 1, false],
      ['a', false, null, false],
      ['worse', false, null, true]
    ])
  })
  it('disables unpicked rows when the list is full', () => {
    const picks = Array.from({ length: ISLAND_AGENTS_MAX }, (_, i) => `a${i}`)
    const agents = [...picks.map((n) => agent(n)), agent('extra')]
    expect(pickRows(picks, agents).at(-1)).toMatchObject({ picked: false, disabled: true })
  })
})

describe('livePicks', () => {
  it('drops picks with no agent once the list is loaded', () => {
    expect(livePicks(['a', 'gone', 'b'], [agent('a'), agent('b')])).toEqual(['a', 'b'])
  })
  it('keeps every pick while the agent list is empty or not loaded', () => {
    expect(livePicks(['a', 'gone'], [])).toEqual(['a', 'gone'])
  })
  it('frees the ghost pick from the cap, so the next toggle saves without it', () => {
    const real = Array.from({ length: ISLAND_AGENTS_MAX - 1 }, (_, i) => `a${i}`)
    const agents = [...real.map((n) => agent(n)), agent('extra')]
    const picks = livePicks([...real, 'gone'], agents)
    expect(picks).toEqual(real)
    expect(togglePick(picks, 'extra')).toEqual([...real, 'extra'])
    expect(pickRows([...real, 'gone'], agents).at(-1)).toMatchObject({ agent: { name: 'extra' }, disabled: false })
  })
  it('keeps the ghosts while no agent is loaded: the cap still counts them', () => {
    const full = Array.from({ length: ISLAND_AGENTS_MAX }, (_, i) => `a${i}`)
    expect(pickRows(full, [])).toEqual([])
    expect(livePicks(full, [])).toEqual(full)
  })
})

describe('hotkeyFromKey', () => {
  const key = (code: string, mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}) => ({
    code,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...mods
  })
  it("spells the physical key with its modifiers in the shell's order", () => {
    expect(hotkeyFromKey(key('Space', { altKey: true, ctrlKey: true }))).toBe('Ctrl+Alt+Space')
    expect(hotkeyFromKey(key('KeyV', { shiftKey: true, ctrlKey: true }))).toBe('Ctrl+Shift+V')
    expect(hotkeyFromKey(key('Digit7', { metaKey: true }))).toBe('Super+7')
    expect(hotkeyFromKey(key('F12', { altKey: true }))).toBe('Alt+F12')
  })
  it('is null until it is a whole shortcut', () => {
    expect(hotkeyFromKey(key('Space'))).toBeNull()
    expect(hotkeyFromKey(key('ControlLeft', { ctrlKey: true }))).toBeNull()
    expect(hotkeyFromKey(key('Enter', { ctrlKey: true }))).toBeNull()
    expect(hotkeyFromKey(key('F13', { ctrlKey: true }))).toBeNull()
  })
})
