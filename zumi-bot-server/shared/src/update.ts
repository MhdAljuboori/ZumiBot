// Self-update from the public showcase site, which re-publishes the latest release (see docs/architecture/updates.md).
export const UPDATE_SITE = 'https://zumibot.run'
export const RELEASE_MANIFEST_PATH = '/releases/latest.json'
// How often a server asks the site, and how old its last answer may be when a tab comes back before it asks again.
export const UPDATE_CHECK_MS = 60 * 60 * 1000
export const UPDATE_STALE_MS = 15 * 60 * 1000
// Local mode (the desktop shell): the folder the shell keeps downloaded server builds in, passed to its server by this
// env var, and the exit code that asks the shell to start the server again (on the build it now picks).
export const LOCAL_UPDATES_ENV = 'ZUMIBOT_LOCAL_UPDATES'
export const LOCAL_RESTART_EXIT = 75
/** `<dir>/current.json`: the downloaded build the shell runs, when it is newer than the one it bundles. */
export const LOCAL_CURRENT_FILE = 'current.json'
// In the data dir: the updater's output (an install.sh run), or why a Local mode build did not start (the shell writes it).
export const UPDATE_LOG_FILE = 'update-log.txt'
// The publisher's ed25519 public key (raw 32 bytes, base64), made by deploy/release-key.mjs. A release is installed only
// when its manifest carries this key's signature over releaseSignedText, so a site, DNS or CDN that serves a different
// tarball cannot get it run. The release job signs with the private half (secret RELEASE_SIGNING_KEY). install.sh pins the same key.
export const RELEASE_PUBLIC_KEY = '+3zc/fGHM0oDDgdo2kqzNtcYummsTNqGe1O/yarK+T0='

/** What the publisher signs: the version (no 'v') and the tarball's sha256. deploy/release-sign.mjs signs exactly this. */
export function releaseSignedText(version: string, sha256: string): string {
  return `zumibot-server\n${version}\n${sha256}\n`
}

/** The Docker bundle's own label, so a server tarball's signature can never pass for a bundle (or the reverse). */
export function dockerBundleSignedText(version: string, sha256: string): string {
  return `zumibot-docker\n${version}\n${sha256}\n`
}

// Error text of a second install while one runs; the UI matches on it.
export const ALREADY_UPDATING = 'ALREADY_UPDATING'

// ok: it can update itself (an install.sh install with a user unit, or the desktop shell's Local mode when the shell keeps
// updates); local: an older shell or a dev run that does not; container: no way to swap itself; notInstaller: not set up by install.sh.
export type UpdateAvailability = 'ok' | 'local' | 'container' | 'notInstaller'

export interface UpdateRelease {
  version: string // without the leading 'v'
  publishedAt: string
  notes: string
}

/** What the site writes at RELEASE_MANIFEST_PATH. `tarball` is a path on the same site. */
export interface ReleaseManifest {
  version: string
  publishedAt: string
  notes: string
  tarball: string
  sha256: string // 64 lowercase hex
  signature?: string // base64 ed25519 signature over releaseSignedText; the updater refuses a manifest without one
}

export interface UpdateResult {
  kind: 'updated' | 'failed' | 'rolledBack'
  from: string
  to: string
  at: number
  logTail?: string
}

export interface UpdateStatus {
  current: string
  availability: UpdateAvailability
  /** Local mode: an update restarts the desktop app's own server, and there is no server to log in to. */
  local: boolean
  latest: UpdateRelease | null
  newer: boolean
  checkedAt: number | null
  checking: boolean
  error: string | null
  installing: boolean
  lastResult: UpdateResult | null
  canRollBack: boolean
}

// Plain x.y.z with an optional leading 'v'; a pre-release or anything else is not a version we offer.
export function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** The version a Local mode `current.json` names, or null when it is missing, damaged or not a plain x.y.z. */
export function localCurrentVersion(text: string | null): string | null {
  if (text === null) return null
  try {
    const v = (JSON.parse(text) as { version?: unknown }).version
    return typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v) ? v : null
  } catch {
    return null
  }
}

export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate)
  const b = parseVersion(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

/** The manifest's shape only (whether the version is one we offer is `parseVersion`'s call); null for anything malformed. */
export function parseManifest(json: unknown): ReleaseManifest | null {
  if (typeof json !== 'object' || json === null) return null
  const j = json as Record<string, unknown>
  const { version, publishedAt, notes, tarball, sha256 } = j
  if (
    typeof version !== 'string' ||
    typeof publishedAt !== 'string' ||
    typeof notes !== 'string' ||
    typeof tarball !== 'string' ||
    typeof sha256 !== 'string'
  )
    return null
  if (version === '' || tarball === '' || !/^[0-9a-f]{64}$/.test(sha256)) return null
  const { signature } = j
  if (signature === undefined) return { version, publishedAt, notes, tarball, sha256 }
  // 64 bytes in base64 is 86 characters and '=='; anything else cannot be an ed25519 signature.
  if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) return null
  return { version, publishedAt, notes, tarball, sha256, signature }
}
