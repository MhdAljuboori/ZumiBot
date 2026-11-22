import type { AuthStore } from './authStore'
import { hashPassword, passwordProblem } from './password'
import { newRecoveryCodes } from './recovery'
import { verifyTotp } from './totp'

/**
 * The two steps the CLI (`set-password`, `setup-2fa`) and the browser wizard share, so both save the same way.
 * Neither ever takes the raw secret out again: the password leaves only as a scrypt hash, and the recovery codes
 * are returned once, already saved.
 */

/** Resolves the problem to show, or null once the password is stored. Every stored session is signed out. */
export async function savePassword(auth: AuthStore, raw: string): Promise<string | null> {
  const problem = passwordProblem(raw)
  if (problem) return problem
  await auth.setPassword(await hashPassword(raw))
  return null
}

/**
 * Confirms one code against a pending secret and stores it with that code's step as `lastStep`, so the code just
 * typed cannot be replayed to sign in. The codes are saved before they are returned, so every code handed out works.
 */
export async function saveTotp(auth: AuthStore, secret: string, code: string, now: number): Promise<string[] | null> {
  const step = verifyTotp(secret, code.replace(/\s/g, ''), now, 0)
  if (step === null) return null
  const { codes, hashes } = newRecoveryCodes()
  await auth.setTotp(secret, hashes, step)
  return codes
}
