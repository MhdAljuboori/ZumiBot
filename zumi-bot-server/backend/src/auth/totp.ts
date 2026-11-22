import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const STEP_MS = 30_000

/** RFC 4648 base32, no padding on output. */
export function base32Encode(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
    value &= (1 << bits) - 1
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, '').toUpperCase()
  const bytes: number[] = []
  let bits = 0
  let value = 0
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch)
    if (idx < 0) throw new Error('Invalid base32')
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
    value &= (1 << bits) - 1
  }
  return Buffer.from(bytes)
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

function hotp(key: Buffer, counter: number): string {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const h = createHmac('sha1', key).update(msg).digest()
  const off = h[h.length - 1] & 15
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]
  return String(bin % 1_000_000).padStart(6, '0')
}

export function totpAt(secret: string, timeMs: number): string {
  return hotp(base32Decode(secret), Math.floor(timeMs / STEP_MS))
}

/** Returns the matched step (within ±1 of now and strictly after lastStep, so a code works once), else null. */
export function verifyTotp(secret: string, code: string, nowMs: number, lastStep: number): number | null {
  if (!/^\d{6}$/.test(code)) return null
  const key = base32Decode(secret)
  const cur = Math.floor(nowMs / STEP_MS)
  const given = Buffer.from(code)
  let matched: number | null = null
  // Check all three steps without early exit so timing does not reveal which one hit.
  for (const step of [cur - 1, cur, cur + 1]) {
    const ok = timingSafeEqual(given, Buffer.from(hotp(key, step)))
    if (ok && step > lastStep) matched = step
  }
  return matched
}

export function otpauthUri(secret: string): string {
  return `otpauth://totp/ZumiBot:zumibot?secret=${secret}&issuer=ZumiBot&algorithm=SHA1&digits=6&period=30`
}
