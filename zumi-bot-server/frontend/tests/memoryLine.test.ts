import { describe, expect, it } from 'vitest'
import { canViewMemory, memoryLine } from '../src/state/memoryLine'

describe('memoryLine', () => {
  it('is null without a touch or with a zero one', () => {
    expect(memoryLine(undefined, null)).toBeNull()
    expect(memoryLine({ saved: 0, updated: 0 }, null)).toBeNull()
  })
  it('names the agent only in a room', () => {
    expect(memoryLine({ saved: 1, updated: 0 }, null)).toBe('Memory: 1 saved')
    expect(memoryLine({ saved: 1, updated: 0 }, 'Ana')).toBe("Ana's memory: 1 saved")
  })
})

describe('canViewMemory', () => {
  const a = { builtIn: false, error: null, filePath: '/x/a.md' }
  it('allows a healthy agent only', () => {
    expect(canViewMemory(a)).toBe(true)
    expect(canViewMemory({ ...a, error: 'bad' })).toBe(false)
    expect(canViewMemory({ ...a, filePath: '' })).toBe(false)
    expect(canViewMemory({ ...a, builtIn: true })).toBe(false)
  })
})
