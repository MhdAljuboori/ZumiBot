// Pure helpers for scripts/fetchRelease.mjs (erasable TS). The manifest's shape is the contract the server's updater
// reads (parseManifest in zumi-bot-server/shared/src/update.ts): change both together.
import type { ReleaseInfo } from './releaseInfo.ts'

export const TARBALL = 'zumibot-server.tar.gz'
export const SUMS = 'SHA256SUMS'
// The publisher's ed25519 signature over the version and the tarball hash (release-sign.mjs), base64 on one line.
export const SIG = `${TARBALL}.sig`
// The Docker bundle (release.yml attaches it) and the installer inside it. Literals, not imports from shared, so this
// build needs no workspace link; tests/publishRelease.test.ts checks they match shared/src/dockerBundle.ts.
export const DOCKER_BUNDLE = 'zumibot-docker.tar.gz'
export const DOCKER_SIG = `${DOCKER_BUNDLE}.sig`
export const DOCKER_INSTALLER = 'zumibot-docker/docker/install.sh'

export interface ReleaseManifest {
  version: string
  publishedAt: string
  notes: string
  tarball: string // a path on this site
  sha256: string
  signature?: string // the server refuses a manifest without one; this site only carries it
}

/** The base64 signature in a .sig file, or null when it is not 64 bytes of base64 (the server would refuse it). */
export function signatureOf(text: string): string | null {
  const s = text.trim()
  return /^[A-Za-z0-9+/]{86}==$/.test(s) ? s : null
}

/** The hash of one file in `sha256sum` output (`<hex>  name` or `<hex> *name`); null when it is not listed. */
export function sumOf(text: string, name: string): string | null {
  for (const line of text.split('\n')) {
    const m = /^([0-9a-fA-F]{64}) [ *](.+?)\r?$/.exec(line)
    if (m && m[2] === name) return m[1].toLowerCase()
  }
  return null
}

// A version becomes a folder name: only a plain x.y.z may.
export function manifestFor(info: ReleaseInfo, sha256: string, signature?: string): ReleaseManifest {
  if (!/^\d+\.\d+\.\d+$/.test(info.version)) throw new Error(`the release version ${info.version} is not x.y.z`)
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('the release checksum is not a sha256')
  if (signature !== undefined && signatureOf(signature) !== signature) throw new Error('the release signature is not 64 bytes of base64')
  const manifest: ReleaseManifest = {
    version: info.version,
    publishedAt: info.publishedAt,
    notes: info.notes,
    tarball: `/releases/${info.version}/${TARBALL}`,
    sha256
  }
  return signature === undefined ? manifest : { ...manifest, signature }
}
