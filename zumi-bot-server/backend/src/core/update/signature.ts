import { createPublicKey, verify } from 'node:crypto'
import { releaseSignedText } from '@zumibot/shared/update'

// The DER header of an ed25519 SubjectPublicKeyInfo: with it, the pinned raw 32 bytes become a key node:crypto takes.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

/**
 * Whether `signature` (base64) is the publisher's ed25519 signature over this version and tarball hash. Anything
 * malformed, a key included, is false: the caller refuses the release, never installs it on a doubt.
 */
export function verifyReleaseSignature(version: string, sha256: string, signature: string | undefined, publicKey: string): boolean {
  if (!signature) return false
  try {
    const raw = Buffer.from(publicKey, 'base64')
    const sig = Buffer.from(signature, 'base64')
    if (raw.length !== 32 || sig.length !== 64) return false
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' })
    return verify(null, Buffer.from(releaseSignedText(version, sha256), 'utf8'), key, sig)
  } catch {
    return false
  }
}
