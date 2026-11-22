import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_ISLAND_PREFS,
  agentsFor,
  loadIslandPrefs,
  parseIslandPrefs,
  renameAgentIn,
  saveIslandPrefs,
  withAgents
} from '../src/main/islandPrefs'

const O = 'http://127.0.0.1:4318'

describe('parseIslandPrefs', () => {
  it('falls back to the defaults for garbage', () => {
    expect(parseIslandPrefs(null)).toEqual(DEFAULT_ISLAND_PREFS)
    expect(parseIslandPrefs([])).toEqual(DEFAULT_ISLAND_PREFS)
    expect(DEFAULT_ISLAND_PREFS).toEqual({ v: 1, startAtLogin: true, top: null, agents: {}, voiceHotkey: 'Ctrl+Alt+Space' })
  })
  it('repairs each field on its own and cleans each origin list', () => {
    expect(parseIslandPrefs({ v: 1, startAtLogin: false, top: 'x', agents: { [O]: ['a', 'a'] } })).toEqual({
      v: 1,
      startAtLogin: false,
      top: null,
      agents: { [O]: ['a'] },
      voiceHotkey: 'Ctrl+Alt+Space'
    })
  })
  it('keeps a finite top and drops a bad origin list', () => {
    expect(parseIslandPrefs({ top: 120, agents: { [O]: 'a', 'http://b.test': ['x'] } })).toEqual({
      v: 1,
      startAtLogin: true,
      top: 120,
      agents: { 'http://b.test': ['x'] },
      voiceHotkey: 'Ctrl+Alt+Space'
    })
    expect(parseIslandPrefs({ top: Infinity }).top).toBeNull()
  })
})

describe('voiceHotkey', () => {
  it('defaults to Ctrl+Alt+Space', () => {
    expect(parseIslandPrefs({}).voiceHotkey).toBe('Ctrl+Alt+Space')
  })
  it('keeps a valid one, in its clean form, and null (turned off)', () => {
    expect(parseIslandPrefs({ voiceHotkey: 'shift+ctrl+k' }).voiceHotkey).toBe('Ctrl+Shift+K')
    expect(parseIslandPrefs({ voiceHotkey: null }).voiceHotkey).toBeNull()
  })
  it('a bad one falls back to the default', () => {
    expect(parseIslandPrefs({ voiceHotkey: 'Space' }).voiceHotkey).toBe('Ctrl+Alt+Space')
    expect(parseIslandPrefs({ voiceHotkey: 5 }).voiceHotkey).toBe('Ctrl+Alt+Space')
  })
})

describe('island.json', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cb-island-'))
    file = join(dir, 'island.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('round-trips with mode 0600', () => {
    const p = { v: 1 as const, startAtLogin: false, top: 80, agents: { [O]: ['a', 'b'] }, voiceHotkey: 'Ctrl+Shift+V' }
    saveIslandPrefs(file, p)
    expect(loadIslandPrefs(file)).toEqual(p)
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  })
  it('is the defaults when the file is missing or corrupt', () => {
    expect(loadIslandPrefs(file)).toEqual(DEFAULT_ISLAND_PREFS)
    writeFileSync(file, '{nope')
    expect(loadIslandPrefs(file)).toEqual(DEFAULT_ISLAND_PREFS)
  })
})

describe('agent lists', () => {
  it('agentsFor is empty for an unknown origin', () => {
    expect(agentsFor(DEFAULT_ISLAND_PREFS, O)).toEqual([])
  })
  it('withAgents sets one origin and leaves the rest', () => {
    const p = withAgents(withAgents(DEFAULT_ISLAND_PREFS, O, ['a']), 'http://b.test', ['x'])
    expect(agentsFor(p, O)).toEqual(['a'])
    expect(agentsFor(p, 'http://b.test')).toEqual(['x'])
    expect(DEFAULT_ISLAND_PREFS.agents).toEqual({})
  })
  it('renameAgentIn renames in place and drops the duplicate', () => {
    const p = withAgents(DEFAULT_ISLAND_PREFS, O, ['a', 'c'])
    expect(agentsFor(renameAgentIn(p, O, 'a', 'b'), O)).toEqual(['b', 'c'])
    expect(agentsFor(renameAgentIn(withAgents(p, O, ['a', 'b']), O, 'a', 'b'), O)).toEqual(['b'])
    expect(agentsFor(renameAgentIn(withAgents(p, O, ['b', 'a']), O, 'a', 'b'), O)).toEqual(['b'])
  })
  it('renameAgentIn keeps the first of two entries and the others in order', () => {
    const p = withAgents(DEFAULT_ISLAND_PREFS, O, ['x', 'a', 'b'])
    expect(agentsFor(renameAgentIn(p, O, 'a', 'b'), O)).toEqual(['x', 'b'])
    expect(agentsFor(renameAgentIn(withAgents(p, O, ['b', 'x', 'a']), O, 'a', 'b'), O)).toEqual(['b', 'x'])
  })
  it('renameAgentIn leaves other origins and unlisted names alone', () => {
    const p = withAgents(withAgents(DEFAULT_ISLAND_PREFS, O, ['a']), 'http://b.test', ['a'])
    const r = renameAgentIn(p, O, 'a', 'z')
    expect(agentsFor(r, 'http://b.test')).toEqual(['a'])
    expect(renameAgentIn(p, O, 'q', 'z')).toEqual(p)
  })
})
