import { describe, expect, it } from 'vitest'
import { RELEASE_PUBLIC_KEY, isNewer, parseManifest, parseVersion, releaseSignedText, dockerBundleSignedText } from '@zumibot/shared/update'

describe('parseVersion', () => {
  it('reads a plain or v-prefixed x.y.z', () => {
    expect(parseVersion('v0.1.0')).toEqual([0, 1, 0])
    expect(parseVersion('10.6.4')).toEqual([10, 6, 4])
  })

  it('refuses anything else', () => {
    for (const v of ['0.1.0-rc1', 'latest', '', '1.2']) expect(parseVersion(v)).toBeNull()
  })
})

describe('isNewer', () => {
  it('compares number by number, not as text', () => {
    expect(isNewer('v0.1.1', '0.1.0')).toBe(true)
    expect(isNewer('0.2.0', '0.10.0')).toBe(false)
  })

  it('is false for the same version', () => {
    expect(isNewer('0.1.0', '0.1.0')).toBe(false)
  })

  it('never offers a pre-release or an unreadable version', () => {
    expect(isNewer('v0.1.0-rc1', '0.0.9')).toBe(false)
    expect(isNewer('1.0.0', 'garbage')).toBe(false)
  })
})

// 64 bytes of base64, the shape of an ed25519 signature.
const SIG = `${'A'.repeat(86)}==`

describe('parseManifest', () => {
  const good = {
    version: '0.1.2',
    publishedAt: '2026-11-18T20:31:12Z',
    notes: '### New',
    tarball: '/releases/0.1.2/zumibot-server.tar.gz',
    sha256: 'a'.repeat(64)
  }

  it('reads the five fields and drops anything extra', () => {
    expect(parseManifest({ ...good, extra: 1 })).toEqual(good)
    expect(parseManifest({ ...good, signature: SIG })).toEqual({ ...good, signature: SIG })
    expect(parseManifest({ ...good, notes: '' })).toMatchObject({ notes: '' })
  })

  it('refuses anything that is not an object', () => {
    for (const v of [null, undefined, 'x', 7, []]) expect(parseManifest(v)).toBeNull()
  })

  it('refuses a missing or mistyped field', () => {
    for (const k of Object.keys(good)) {
      expect(parseManifest({ ...good, [k]: undefined })).toBeNull()
      expect(parseManifest({ ...good, [k]: 5 })).toBeNull()
    }
    expect(parseManifest({ ...good, version: '' })).toBeNull()
    expect(parseManifest({ ...good, tarball: '' })).toBeNull()
  })

  it('wants a sha256 of exactly 64 lowercase hex characters', () => {
    for (const sha256 of ['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), ` ${'a'.repeat(64)}`])
      expect(parseManifest({ ...good, sha256 })).toBeNull()
  })

  // Unsigned is left to the updater, which refuses it with its own message; a signature of the wrong shape is not a manifest.
  it('keeps a missing signature out, and refuses one that is not 64 bytes of base64', () => {
    expect(parseManifest(good)).not.toHaveProperty('signature')
    for (const signature of [5, '', 'x', 'A'.repeat(88), `${SIG} `, SIG.slice(4)]) expect(parseManifest({ ...good, signature })).toBeNull()
  })
})

describe('release signing', () => {
  it('signs the version and the tarball hash, one per line, under a fixed label', () => {
    expect(releaseSignedText('0.1.4', 'a'.repeat(64))).toBe(`zumibot-server\n0.1.4\n${'a'.repeat(64)}\n`)
  })

  it('signs the Docker bundle under its own label, so a server signature never passes for it', () => {
    expect(dockerBundleSignedText('0.1.4', 'a'.repeat(64))).toBe(`zumibot-docker\n0.1.4\n${'a'.repeat(64)}\n`)
    expect(dockerBundleSignedText('V', 'S')).not.toBe(releaseSignedText('V', 'S'))
  })

  it('pins a raw 32-byte ed25519 public key in base64', () => {
    expect(Buffer.from(RELEASE_PUBLIC_KEY, 'base64')).toHaveLength(32)
    expect(Buffer.from(RELEASE_PUBLIC_KEY, 'base64').toString('base64')).toBe(RELEASE_PUBLIC_KEY)
  })
})
