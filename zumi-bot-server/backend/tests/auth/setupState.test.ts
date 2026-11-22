import { describe, expect, it } from 'vitest'
import { allowsSetupCall, setupNeeded, setupStep, type SetupCall } from '../../src/auth/setupState'

const CALLS: SetupCall[] = ['password', 'totp-start', 'totp-confirm', 'check', 'finish']

describe('setup state', () => {
  it('names the first unfinished step', () => {
    expect(setupStep({ password: false, totp: false })).toBe('password')
    expect(setupStep({ password: true, totp: false })).toBe('totp')
    expect(setupStep({ password: true, totp: true })).toBe('done')
    // A TOTP secret with no password is still the password step: sign-in needs both.
    expect(setupStep({ password: false, totp: true })).toBe('password')
  })

  it('is needed only in vps mode, and only until both are set', () => {
    expect(setupNeeded('vps', { password: false, totp: false })).toBe(true)
    expect(setupNeeded('vps', { password: true, totp: false })).toBe(true)
    expect(setupNeeded('vps', { password: true, totp: true })).toBe(false)
    // Local mode authenticates with its own secret and has no password at all.
    expect(setupNeeded('local', { password: false, totp: false })).toBe(false)
  })

  it('never lets a password that exists be replaced', () => {
    expect(allowsSetupCall('password', 'password')).toBe(true)
    expect(allowsSetupCall('totp', 'password')).toBe(false)
    expect(allowsSetupCall('done', 'password')).toBe(false)
  })

  it('never lets a stored TOTP secret be re-enrolled', () => {
    expect(allowsSetupCall('totp', 'totp-start')).toBe(true)
    expect(allowsSetupCall('totp', 'totp-confirm')).toBe(true)
    for (const call of ['totp-start', 'totp-confirm'] as const) {
      expect(allowsSetupCall('done', call)).toBe(false)
      expect(allowsSetupCall('password', call)).toBe(false)
    }
  })

  it('allows the read-only claude check at every step', () => {
    for (const step of ['password', 'totp', 'done'] as const) expect(allowsSetupCall(step, 'check')).toBe(true)
  })

  it('allows finish only once both are set, so a code can never strand a server', () => {
    expect(allowsSetupCall('password', 'finish')).toBe(false)
    expect(allowsSetupCall('totp', 'finish')).toBe(false)
    expect(allowsSetupCall('done', 'finish')).toBe(true)
  })

  it('answers for every call at every step', () => {
    for (const step of ['password', 'totp', 'done'] as const) {
      for (const call of CALLS) expect(typeof allowsSetupCall(step, call)).toBe('boolean')
    }
  })
})
