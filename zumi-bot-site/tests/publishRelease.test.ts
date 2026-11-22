import { DOCKER_BUNDLE, DOCKER_BUNDLE_DIR } from '@zumibot/shared/dockerBundle'
import { describe, expect, it } from 'vitest'
import { DOCKER_BUNDLE as BUNDLE, DOCKER_INSTALLER, DOCKER_SIG, manifestFor, signatureOf, sumOf } from '../src/publishRelease.ts'

const HASH = 'a'.repeat(64)
const SIG = `${'A'.repeat(86)}==`
const info = { version: '0.1.2', publishedAt: '2026-11-18T00:00:00Z', notes: 'n' }

describe('sumOf', () => {
  it('finds a file in sha256sum output, text or binary mode', () => {
    expect(sumOf(`${'B'.repeat(64)}  other\n${HASH}  zumibot-server.tar.gz\n`, 'zumibot-server.tar.gz')).toBe(HASH)
    expect(sumOf(`${HASH} *zumibot-server.tar.gz\r\n`, 'zumibot-server.tar.gz')).toBe(HASH)
    expect(sumOf('nothing here', 'zumibot-server.tar.gz')).toBeNull()
  })
})

describe('manifestFor', () => {
  // The server's parseManifest reads exactly these five fields.
  it('points at the versioned package on this site', () => {
    expect(manifestFor(info, HASH)).toEqual({
      version: '0.1.2',
      publishedAt: info.publishedAt,
      notes: 'n',
      tarball: '/releases/0.1.2/zumibot-server.tar.gz',
      sha256: HASH
    })
  })

  it('refuses a version that is not a plain x.y.z, since it names a folder', () => {
    expect(() => manifestFor({ ...info, version: '../x' }, HASH)).toThrow()
    expect(() => manifestFor({ ...info, version: '1.0.0-rc1' }, HASH)).toThrow()
  })

  it('refuses a checksum that is not a sha256', () => {
    expect(() => manifestFor(info, 'xyz')).toThrow()
  })
})

describe('the signature', () => {
  it('reads a .sig file of 64 bytes in base64, trailing newline and all', () => {
    expect(signatureOf(`${SIG}\n`)).toBe(SIG)
    for (const bad of ['', 'x', `${'A'.repeat(88)}`, `${SIG}${SIG}`]) expect(signatureOf(bad)).toBeNull()
  })

  it('goes into the manifest as given, and only when there is one', () => {
    expect(manifestFor(info, HASH, SIG)).toMatchObject({ sha256: HASH, signature: SIG })
    expect(manifestFor(info, HASH)).not.toHaveProperty('signature')
    expect(() => manifestFor(info, HASH, 'nope')).toThrow()
  })
})

// The names fetchRelease.mjs publishes the Docker bundle under; the installer and the release workflow use the same ones.
describe('the Docker bundle names', () => {
  it('follow the shared bundle constants', () => {
    expect(BUNDLE).toBe(DOCKER_BUNDLE)
    expect(DOCKER_SIG).toBe(`${DOCKER_BUNDLE}.sig`)
    expect(DOCKER_INSTALLER).toBe(`${DOCKER_BUNDLE_DIR}/docker/install.sh`)
  })
})
