import { describe, expect, it } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { RELEASE_PUBLIC_KEY, releaseSignedText } from '@zumibot/shared/update'
import { verifyReleaseSignature } from '../../../src/core/update/signature'

const pair = () => {
  const k = generateKeyPairSync('ed25519')
  return { priv: k.privateKey, pub: k.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64') }
}
const A = pair()
const B = pair()
const SHA = 'ab'.repeat(32)
const sig = (version: string, sha256: string, by = A) =>
  sign(null, Buffer.from(releaseSignedText(version, sha256)), by.priv).toString('base64')

describe('verifyReleaseSignature', () => {
  it('takes the signature of the pinned key over this version and hash', () => {
    expect(verifyReleaseSignature('0.2.0', SHA, sig('0.2.0', SHA), A.pub)).toBe(true)
  })

  it('refuses another key, another version, another hash, or no signature', () => {
    expect(verifyReleaseSignature('0.2.0', SHA, sig('0.2.0', SHA, B), A.pub)).toBe(false)
    expect(verifyReleaseSignature('0.2.1', SHA, sig('0.2.0', SHA), A.pub)).toBe(false)
    expect(verifyReleaseSignature('0.2.0', 'cd'.repeat(32), sig('0.2.0', SHA), A.pub)).toBe(false)
    expect(verifyReleaseSignature('0.2.0', SHA, undefined, A.pub)).toBe(false)
    expect(verifyReleaseSignature('0.2.0', SHA, '', A.pub)).toBe(false)
  })

  it('is false, not a throw, for a malformed signature or key', () => {
    expect(verifyReleaseSignature('0.2.0', SHA, 'not base64!!', A.pub)).toBe(false)
    expect(verifyReleaseSignature('0.2.0', SHA, sig('0.2.0', SHA), 'short')).toBe(false)
    expect(verifyReleaseSignature('0.2.0', SHA, `${'A'.repeat(86)}==`, A.pub)).toBe(false)
  })

  it('the pinned key loads, and nothing but its holder signs for it', () => {
    expect(verifyReleaseSignature('0.2.0', SHA, sig('0.2.0', SHA), RELEASE_PUBLIC_KEY)).toBe(false)
  })
})
