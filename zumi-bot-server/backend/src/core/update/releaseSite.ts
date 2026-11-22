import { createWriteStream, promises as fs } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { RELEASE_MANIFEST_PATH, parseManifest, type ReleaseManifest } from '@zumibot/shared/update'

// Messages are fixed text: nothing from the request, the response or a thrown error goes in.
const MESSAGES = {
  network: 'Could not reach the update site',
  unusable: 'The site sent a release it cannot use',
  otherSite: 'The update site pointed to a download on another site',
  redirect: 'The update site redirected to another site',
  tooBig: 'The update site sent more than an update can be'
} as const

export class SiteError extends Error {
  constructor(
    readonly kind: 'network' | 'unusable' | 'otherSite' | 'redirect' | 'tooBig' | 'http',
    readonly status?: number
  ) {
    super(kind === 'http' ? (status ? `The update site answered ${status}` : 'The update site sent an unexpected answer') : MESSAGES[kind])
    this.name = 'SiteError'
  }
}

// Errors of our own disk, not of the connection; the stream and rename report these by code.
const DISK_CODES = new Set(['ENOSPC', 'EACCES', 'EPERM', 'EROFS', 'EDQUOT', 'EIO', 'ENOENT', 'ENOTDIR', 'EISDIR', 'ENOTEMPTY', 'EMFILE'])
const METADATA_TIMEOUT_MS = 30_000
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000
// Far above a real release (tens of MiB) and its manifest (a few KiB): a site that streams on and on fills no disk.
export const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024
export const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_REDIRECTS = 3

function isTimeout(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name
  return name === 'TimeoutError' || name === 'AbortError'
}

/**
 * Redirects are followed by hand and only on the site's own origin: fetch's own following would go to any host, so a
 * hijacked path could send the download anywhere. (The signature still decides what runs; this keeps the bytes local.)
 */
async function get(url: string, accept: string, timeoutMs: number, fetchImpl: typeof fetch): Promise<Response> {
  const signal = AbortSignal.timeout(timeoutMs)
  const origin = new URL(url).origin
  let at = url
  for (let hop = 0; ; hop++) {
    let res: Response
    try {
      res = await fetchImpl(at, { headers: { Accept: accept, 'User-Agent': 'ZumiBot' }, redirect: 'manual', signal })
    } catch {
      throw new SiteError('network')
    }
    // undici answers a manual redirect with the 3xx itself; a browser-style fetch gives an opaque one with no Location.
    if (res.type !== 'opaqueredirect' && (res.status < 300 || res.status > 399)) return res
    discard(res)
    const location = res.headers.get('location')
    let next: URL
    try {
      next = new URL(location ?? '', at)
    } catch {
      throw new SiteError('redirect')
    }
    if (!location || next.origin !== origin || hop >= MAX_REDIRECTS) throw new SiteError('redirect')
    at = next.href
  }
}

/** Drops the unread body so the connection is freed. */
const discard = (res: Response): void => void res.body?.cancel().catch(() => undefined)

/** A declared length past the cap fails before a byte is read; a body that only grows past it fails as it does. */
function tooLong(res: Response, max: number): boolean {
  const declared = Number(res.headers.get('content-length'))
  return Number.isFinite(declared) && declared > max
}

async function readCapped(res: Response, max: number): Promise<string> {
  if (tooLong(res, max)) {
    discard(res)
    throw new SiteError('tooBig')
  }
  if (!res.body) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      void reader.cancel().catch(() => undefined)
      throw new SiteError('tooBig')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Passes bytes through until `max`, then fails the pipeline with tooBig. */
function capBytes(max: number): Transform {
  let size = 0
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      size += chunk.length
      done(size > max ? new SiteError('tooBig') : null, size > max ? undefined : chunk)
    }
  })
}

/**
 * The manifest's tarball is a path on the site. It is only taken from the site's own origin, so a manifest can never point a
 * server at another host; https or http follows the site (http only for the tests' loopback server).
 */
export function tarballUrl(site: string, tarball: string): string {
  let base: URL
  let url: URL
  try {
    base = new URL(site)
    url = new URL(tarball, base)
  } catch {
    throw new SiteError('unusable')
  }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new SiteError('unusable')
  if (url.origin !== base.origin) throw new SiteError('otherSite')
  return url.href
}

/** null when the site has no release yet (404). The tarball's full URL is checked here, so a bad one fails the check, not the install. */
export async function fetchManifest(
  site: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ manifest: ReleaseManifest; url: string } | null> {
  let manifestUrl: string
  try {
    manifestUrl = new URL(RELEASE_MANIFEST_PATH, site).href
  } catch {
    throw new SiteError('unusable')
  }
  const res = await get(manifestUrl, 'application/json', METADATA_TIMEOUT_MS, fetchImpl)
  if (res.status === 404) {
    discard(res)
    return null
  }
  if (!res.ok) {
    discard(res)
    throw new SiteError('http', res.status)
  }
  let json: unknown
  try {
    json = JSON.parse(await readCapped(res, MAX_MANIFEST_BYTES))
  } catch (err) {
    if (err instanceof SiteError) throw err
    // A timeout is a lost connection; a cut or non-JSON body is a release we cannot use.
    throw isTimeout(err) ? new SiteError('network') : new SiteError('unusable')
  }
  const manifest = parseManifest(json)
  if (!manifest) throw new SiteError('unusable')
  return { manifest, url: tarballUrl(site, manifest.tarball) }
}

/** Streams the file to dest through a temp file next to it, so a failed or partial download never replaces dest. */
export async function downloadFile(url: string, dest: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await get(url, 'application/octet-stream', DOWNLOAD_TIMEOUT_MS, fetchImpl)
  if (!res.ok) {
    discard(res)
    throw new SiteError('http', res.status)
  }
  if (tooLong(res, MAX_DOWNLOAD_BYTES)) {
    discard(res)
    throw new SiteError('tooBig')
  }
  if (!res.body) throw new SiteError('network')
  const tmp = join(dirname(dest), `.${basename(dest)}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await pipeline(Readable.fromWeb(res.body as never), capBytes(MAX_DOWNLOAD_BYTES), createWriteStream(tmp))
    await fs.rename(tmp, dest)
  } catch (err) {
    // The partial file goes in every case, an overflow included.
    await fs.rm(tmp, { force: true })
    if (err instanceof SiteError) throw err
    const code = (err as { code?: unknown } | null)?.code
    if (typeof code === 'string' && DISK_CODES.has(code)) throw new Error('Could not save the update download')
    throw new SiteError('network')
  }
}
