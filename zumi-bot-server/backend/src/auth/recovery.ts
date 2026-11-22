import { createHash, randomBytes } from 'node:crypto'
import { base32Encode } from './totp'

export function normalizeRecovery(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '')
}

export function hashRecovery(normalized: string): string {
  return createHash('sha256').update(normalized).digest('hex')
}

/** 10 codes of 50 bits each; only the hashes are meant to be stored. */
export function newRecoveryCodes(): { codes: string[]; hashes: string[] } {
  const codes = new Set<string>()
  while (codes.size < 10) {
    const raw = base32Encode(randomBytes(7)).slice(0, 10)
    codes.add(`${raw.slice(0, 5)}-${raw.slice(5)}`)
  }
  const list = [...codes]
  return { codes: list, hashes: list.map((c) => hashRecovery(normalizeRecovery(c))) }
}
