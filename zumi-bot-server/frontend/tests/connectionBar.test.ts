import { describe, expect, it } from 'vitest'
import { connectionBarLabel, CONNECTION_GRACE_MS } from '../src/state/connectionBar'

describe('connectionBarLabel', () => {
  it('is hidden while connected', () => {
    expect(connectionBarLabel('connected', true, true)).toBeNull()
    expect(connectionBarLabel('connected', false, true)).toBeNull()
  })
  it('stays hidden during the first-load grace so a normal load does not flash', () => {
    expect(connectionBarLabel('reconnecting', false, false)).toBeNull()
  })
  it('says Connecting… after the grace when the socket never opened', () => {
    expect(connectionBarLabel('reconnecting', false, true)).toBe('Connecting…')
  })
  it('says Reconnecting… after a drop, with no grace', () => {
    expect(connectionBarLabel('reconnecting', true, false)).toBe('Reconnecting…')
    expect(connectionBarLabel('reconnecting', true, true)).toBe('Reconnecting…')
  })
  it('grace is short', () => {
    expect(CONNECTION_GRACE_MS).toBeGreaterThanOrEqual(1000)
    expect(CONNECTION_GRACE_MS).toBeLessThanOrEqual(2000)
  })
})
