import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadAsset, fetchLatestRelease } from '../src/latestRelease.ts'

const TOKEN = 'ghp_secret-token-value'
const reply = (status: number, body: unknown = {}) =>
  vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as unknown as typeof fetch

describe('fetchLatestRelease', () => {
  it('gives null without a token and never calls out', async () => {
    const f = reply(200)
    expect(await fetchLatestRelease(undefined, f)).toBeNull()
    expect(await fetchLatestRelease('', f)).toBeNull()
    expect(f).not.toHaveBeenCalled()
  })

  it('sends the token and API headers and maps the release', async () => {
    const assets = [
      {
        name: 'zumibot-server.tar.gz',
        url: 'https://api.github.com/repos/o/r/releases/assets/1',
        browser_download_url: 'https://github.com/x'
      },
      { nope: 1 }
    ]
    const f = reply(200, { tag_name: 'v2.0.0', published_at: '2026-01-01T00:00:00Z', body: 'n', assets })
    expect(await fetchLatestRelease(TOKEN, f)).toEqual({
      info: { version: '2.0.0', publishedAt: '2026-01-01T00:00:00Z', notes: 'n' },
      assets: [{ name: 'zumibot-server.tar.gz', url: 'https://api.github.com/repos/o/r/releases/assets/1' }]
    })
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.github.com/repos/MhdAljuboori/ZumiBot/releases/latest')
    expect(init.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ZumiBot-site'
    })
  })

  it('throws on a non-200 answer, without the token', async () => {
    const err = await fetchLatestRelease(TOKEN, reply(500)).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('500')
    expect((err as Error).message).not.toContain(TOKEN)
  })

  it('throws on a network error, without the token or its text', async () => {
    const f = vi.fn(async () => {
      throw new TypeError(`fetch failed for ${TOKEN}`)
    }) as unknown as typeof fetch
    const err = (await fetchLatestRelease(TOKEN, f).catch((e: Error) => e)) as Error
    expect(err.message).not.toContain(TOKEN)
  })

  it('throws on a body that is not JSON or has no tag', async () => {
    await expect(fetchLatestRelease(TOKEN, reply(200, 'not json'))).rejects.toThrow()
    await expect(fetchLatestRelease(TOKEN, reply(200, { name: 'x' }))).rejects.toThrow()
  })

  it('treats 404 (no release yet) as null', async () => {
    expect(await fetchLatestRelease(TOKEN, reply(404))).toBeNull()
  })
})

describe('downloadAsset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'site-dl-'))
  const dest = join(dir, 'f')

  it('asks the API for raw bytes with the token and writes them', async () => {
    const f = reply(200, 'bytes')
    await downloadAsset({ name: 'a', url: 'https://api.github.com/repos/o/r/releases/assets/1' }, TOKEN, dest, f)
    expect(readFileSync(dest, 'utf8')).toBe('bytes')
    const [, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}`, Accept: 'application/octet-stream' })
  })

  it('never sends the token outside the API', async () => {
    const f = reply(200, 'x')
    await expect(downloadAsset({ name: 'a', url: 'https://evil.example/a' }, TOKEN, dest, f)).rejects.toThrow(/outside api.github.com/)
    expect(f).not.toHaveBeenCalled()
  })

  it('throws on a non-200 answer, without the token', async () => {
    const err = (await downloadAsset(
      { name: 'a', url: 'https://api.github.com/repos/o/r/releases/assets/1' },
      TOKEN,
      dest,
      reply(403)
    ).catch((e: Error) => e)) as Error
    expect(err.message).toContain('403')
    expect(err.message).not.toContain(TOKEN)
    rmSync(dir, { recursive: true, force: true })
  })
})
