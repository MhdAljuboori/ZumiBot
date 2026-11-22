import type { ServerMode } from '@zumibot/shared/types'

/** Where a half-set-up server stands. `done` means both a password and TOTP exist, so sign-in works. */
export type SetupStep = 'password' | 'totp' | 'done'

/** Every call the setup routes accept, named as the route names them. */
export type SetupCall = 'password' | 'totp-start' | 'totp-confirm' | 'check' | 'finish'

export function setupStep(configured: { password: boolean; totp: boolean }): SetupStep {
  if (!configured.password) return 'password'
  return configured.totp ? 'done' : 'totp'
}

/** Only vps mode has a sign-in to set up; local mode authenticates with its secret and has no password at all. */
export function setupNeeded(mode: ServerMode, configured: { password: boolean; totp: boolean }): boolean {
  return mode === 'vps' && setupStep(configured) !== 'done'
}

/**
 * What the current step allows. Two properties matter more than the ordering:
 * a password that exists is never replaced here, and neither is a TOTP secret, so a leaked setup code cannot take
 * the account over. `finish` needs both, so the code can never strand a server with no way in.
 */
const ALLOWED: Record<SetupStep, readonly SetupCall[]> = {
  // `check` is read-only (is the claude CLI there and signed in), so every step may run it.
  password: ['password', 'check'],
  totp: ['totp-start', 'totp-confirm', 'check'],
  done: ['check', 'finish']
}

export function allowsSetupCall(step: SetupStep, call: SetupCall): boolean {
  return ALLOWED[step].includes(call)
}
