import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadRailMode, saveRailMode } from '../src/state/railMode'

afterEach(() => vi.unstubAllGlobals())

const store = (init: Record<string, string> = {}) => {
  const data = { ...init }
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => void (data[k] = v)
  })
  return data
}

describe('railMode', () => {
  it('defaults to agents and ignores unknown values', () => {
    store()
    expect(loadRailMode()).toBe('agents')
    store({ 'zumibot.railMode': 'bogus' })
    expect(loadRailMode()).toBe('agents')
  })
  it('round-trips routines', () => {
    const data = store()
    saveRailMode('routines')
    expect(data['zumibot.railMode']).toBe('routines')
    expect(loadRailMode()).toBe('routines')
  })
  it('round-trips workflows', () => {
    const data = store()
    saveRailMode('workflows')
    expect(data['zumibot.railMode']).toBe('workflows')
    expect(loadRailMode()).toBe('workflows')
  })
  it('falls back to agents when storage throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      }
    })
    expect(loadRailMode()).toBe('agents')
    expect(() => saveRailMode('routines')).not.toThrow()
  })
})
