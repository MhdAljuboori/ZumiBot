import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { base32Encode } from './totp'

/** 16 base32 characters: 80 bits, the only thing standing between a fresh server and its password. */
const LENGTH = 16
const SHAPE = /^[A-Z2-7]{16}$/

export function normalizeSetupCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '')
}

export function hashSetupCode(normalized: string): string {
  return createHash('sha256').update(normalized).digest('hex')
}

/** Groups of four, for reading off a terminal. */
export function formatSetupCode(normalized: string): string {
  return (normalized.match(/.{1,4}/g) ?? []).join('-')
}

/** The code to print once, and the hash to keep. The raw code is never stored, logged again or written to disk. */
export function newSetupCode(): { code: string; hash: string } {
  // Encoding whole bytes would overshoot; 10 bytes give exactly 16 characters.
  const normalized = base32Encode(randomBytes(10)).slice(0, LENGTH)
  return { code: formatSetupCode(normalized), hash: hashSetupCode(normalized) }
}

/** Constant-time, and a malformed guess never reaches the compare. */
export function setupCodeMatches(hash: string, given: string): boolean {
  const normalized = normalizeSetupCode(given)
  if (!SHAPE.test(normalized)) return false
  const a = Buffer.from(hashSetupCode(normalized))
  const b = Buffer.from(hash)
  return a.length === b.length && timingSafeEqual(a, b)
}
