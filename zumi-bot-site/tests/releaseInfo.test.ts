import { describe, expect, it } from 'vitest'
import { toReleaseInfo } from '../src/releaseInfo.ts'

const api = {
  tag_name: 'v10.7.0',
  published_at: '2026-11-18T10:00:00Z',
  body: '## Changes\n- one',
  html_url: 'https://github.com/x/y/releases/tag/v10.7.0',
  tarball_url: 'https://api.github.com/repos/x/y/tarball/v10.7.0',
  zipball_url: 'https://api.github.com/repos/x/y/zipball/v10.7.0',
  url: 'https://api.github.com/repos/x/y/releases/1',
  assets: [{ name: 'a.tar.gz', browser_download_url: 'https://github.com/x/y/releases/download/v10.7.0/a.tar.gz' }]
}

describe('toReleaseInfo', () => {
  it('maps the version (without v), date and notes', () => {
    expect(toReleaseInfo(api)).toEqual({ version: '10.7.0', publishedAt: '2026-11-18T10:00:00Z', notes: '## Changes\n- one' })
  })

  it('keeps a tag that has no v', () => {
    expect(toReleaseInfo({ ...api, tag_name: '10.7.0' })?.version).toBe('10.7.0')
  })

  it('returns null without a tag_name', () => {
    expect(toReleaseInfo({ ...api, tag_name: undefined })).toBeNull()
    expect(toReleaseInfo({ ...api, tag_name: '' })).toBeNull()
    expect(toReleaseInfo({ ...api, tag_name: 5 })).toBeNull()
  })

  it('returns null for anything that is not an object', () => {
    for (const v of [null, undefined, 'x', 3, [], true]) expect(toReleaseInfo(v)).toBeNull()
  })

  it('falls back to empty notes and date when the release has none', () => {
    expect(toReleaseInfo({ tag_name: 'v1.0.0', body: null, published_at: null })).toEqual({ version: '1.0.0', publishedAt: '', notes: '' })
  })

  it('carries no link, asset or archive field', () => {
    const json = JSON.stringify(toReleaseInfo(api))
    for (const word of ['assets', 'url', 'tarball', 'zipball', 'browser_download_url']) expect(json).not.toContain(word)
    expect(Object.keys(toReleaseInfo(api) ?? {}).sort()).toEqual(['notes', 'publishedAt', 'version'])
  })
})
