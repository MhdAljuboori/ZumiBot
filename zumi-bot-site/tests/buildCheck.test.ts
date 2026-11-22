import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SITE_INPUTS, releaseFingerprint } from '../src/buildCheck.ts'
import type { LatestRelease } from '../src/latestRelease.ts'

const site = join(dirname(fileURLToPath(import.meta.url)), '..')
const rel = (version: string, assets: [string, string][]): LatestRelease => ({
  info: { version, publishedAt: '2026-01-01T00:00:00Z', notes: '' },
  assets: assets.map(([name, url]) => ({ name, url }))
})

describe('releaseFingerprint', () => {
  const base = rel('1.0.0', [['a.tar.gz', 'u/1'], ['SHA256SUMS', 'u/2']])

  it('ignores asset order and is a sha256 hex', () => {
    const swapped = rel('1.0.0', [['SHA256SUMS', 'u/2'], ['a.tar.gz', 'u/1']])
    expect(releaseFingerprint(swapped)).toBe(releaseFingerprint(base))
    expect(releaseFingerprint(base)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('changes with the version, an attached asset or a re-uploaded one', () => {
    const fp = releaseFingerprint(base)
    expect(releaseFingerprint(rel('1.0.1', [['a.tar.gz', 'u/1'], ['SHA256SUMS', 'u/2']]))).not.toBe(fp)
    expect(releaseFingerprint(rel('1.0.0', [['a.tar.gz', 'u/1'], ['SHA256SUMS', 'u/2'], ['x.exe', 'u/3']]))).not.toBe(fp)
    expect(releaseFingerprint(rel('1.0.0', [['a.tar.gz', 'u/9'], ['SHA256SUMS', 'u/2']]))).not.toBe(fp)
  })

  it('has a fixed value for no release', () => {
    expect(releaseFingerprint(null)).toBe(releaseFingerprint(null))
    expect(releaseFingerprint(null)).not.toBe(releaseFingerprint(base))
  })
})

describe('SITE_INPUTS', () => {
  it('names paths that exist', () => {
    for (const p of SITE_INPUTS) expect(existsSync(join(site, p)), p).toBe(true)
  })
})
