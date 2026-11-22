import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

export const PASSWORD_MIN = 16

/**
 * The one rule for a new password, shared by `set-password` and the browser wizard: the NFKC length, counted the
 * same way `derive` normalises it, so "16 characters" means the same on both sides. Null means it is usable.
 */
export function passwordProblem(raw: string): string | null {
  return raw.normalize('NFKC').length < PASSWORD_MIN ? `Use at least ${PASSWORD_MIN} characters.` : null
}

const N = 32768
const R = 8
const P = 1
const KEYLEN = 64
// scrypt needs 128 * N * r = 32 MiB, which is the default limit's edge, so raise it.
const MAXMEM = 64 * 1024 * 1024

// Passwords are NFKC-normalised on both hash and verify, so equivalent Unicode spellings match.
function derive(pw: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(pw.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key)))
  })
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await derive(pw, salt)
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$')
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false
    // Only our own parameters are accepted, so a tampered file cannot make us burn memory.
    if (parts[1] !== String(N) || parts[2] !== String(R) || parts[3] !== String(P)) return false
    const salt = Buffer.from(parts[4], 'base64')
    const expected = Buffer.from(parts[5], 'base64')
    if (salt.length !== 16 || expected.length !== KEYLEN) return false
    return timingSafeEqual(await derive(pw, salt), expected)
  } catch {
    return false
  }
}
