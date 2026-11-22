// The requests behind scripts/fetchRelease.mjs, kept here (erasable TS, like releaseInfo.ts) so a test can stub fetch.
import { createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { toReleaseInfo } from './releaseInfo.ts'
import type { ReleaseInfo } from './releaseInfo.ts'

const API = 'https://api.github.com'
const LATEST_URL = `${API}/repos/MhdAljuboori/ZumiBot/releases/latest`

export interface ReleaseAsset {
  name: string
  url: string // the API's own asset URL, which serves the bytes to a token holder
}

export interface LatestRelease {
  info: ReleaseInfo
  assets: ReleaseAsset[]
}

const headers = (token: string, accept: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  Accept: accept,
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'ZumiBot-site'
})

// No token: null (a local build). A token and any failure: throws, so the build fails and Vercel keeps the last good deploy.
// Messages say what failed, never the token (it sits in a header only) or the response body.
export async function fetchLatestRelease(token: string | undefined, fetchImpl: typeof fetch = fetch): Promise<LatestRelease | null> {
  if (!token) return null
  let res: Response
  try {
    res = await fetchImpl(LATEST_URL, { headers: headers(token, 'application/vnd.github+json'), signal: AbortSignal.timeout(15_000) })
  } catch (err) {
    throw new Error(`release request failed (${err instanceof Error ? err.name : 'error'})`)
  }
  if (res.status === 404) return null // no release published yet: a fresh page, not a failure
  if (res.status !== 200) throw new Error(`GitHub answered ${res.status}`)
  let json: unknown
  try {
    json = await res.json()
  } catch {
    throw new Error('GitHub sent an answer that is not JSON')
  }
  const info = toReleaseInfo(json)
  if (info === null) throw new Error('GitHub sent a release without a tag')
  const raw = (json as { assets?: unknown }).assets
  const assets = (Array.isArray(raw) ? raw : [])
    .filter((a): a is { name: string; url: string } => typeof a?.name === 'string' && typeof a?.url === 'string')
    .map((a) => ({ name: a.name, url: a.url }))
  return { info, assets }
}

/** Streams one release asset to dest. The token only ever goes to GitHub's API; fetch drops it on the redirect to the CDN. */
export async function downloadAsset(asset: ReleaseAsset, token: string, dest: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!asset.url.startsWith(`${API}/repos/`)) throw new Error(`the release lists ${asset.name} outside api.github.com`)
  let res: Response
  try {
    res = await fetchImpl(asset.url, { headers: headers(token, 'application/octet-stream'), signal: AbortSignal.timeout(5 * 60_000) })
  } catch (err) {
    throw new Error(`downloading ${asset.name} failed (${err instanceof Error ? err.name : 'error'})`)
  }
  if (res.status !== 200 || !res.body) throw new Error(`GitHub answered ${res.status} for ${asset.name}`)
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest))
}
