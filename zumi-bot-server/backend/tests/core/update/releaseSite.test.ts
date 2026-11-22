import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { UPDATE_SITE } from '@zumibot/shared/update'
import {
  MAX_DOWNLOAD_BYTES,
  MAX_MANIFEST_BYTES,
  SiteError,
  downloadFile,
  fetchManifest,
  tarballUrl
} from '../../../src/core/update/releaseSite'

type Call = { url: string; headers: Record<string, string>; signal?: AbortSignal | null; redirect?: RequestRedirect }

function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  const impl = (async (input: unknown, init?: RequestInit) => {
    const call = {
      url: String(input),
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      signal: init?.signal,
      redirect: init?.redirect
    }
    calls.push(call)
    return respond(call)
  }) as unknown as typeof fetch
  return { calls, impl }
}

const manifest = {
  version: '0.1.2',
  publishedAt: '2026-11-18T20:31:12Z',
  notes: '### New\n- a thing',
  tarball: '/releases/0.1.2/zumibot-server.tar.gz',
  sha256: 'ab'.repeat(32)
}

describe('fetchManifest', () => {
  it('reads the manifest from the site and resolves the tarball against it', async () => {
    const f = fakeFetch(() => Response.json(manifest))
    const r = await fetchManifest(UPDATE_SITE, f.impl)
    expect(f.calls[0].url).toBe('https://zumibot.run/releases/latest.json')
    expect(f.calls[0].headers).toMatchObject({ 'User-Agent': 'ZumiBot', Accept: 'application/json' })
    expect(f.calls[0].headers).not.toHaveProperty('Authorization')
    expect(f.calls[0].signal).toBeInstanceOf(AbortSignal)
    expect(r).toEqual({ manifest, url: 'https://zumibot.run/releases/0.1.2/zumibot-server.tar.gz' })
  })

  it('takes a site with a trailing slash or an http loopback address', async () => {
    const f = fakeFetch(() => Response.json(manifest))
    expect((await fetchManifest('http://127.0.0.1:4555/', f.impl))?.url).toBe('http://127.0.0.1:4555/releases/0.1.2/zumibot-server.tar.gz')
    expect(f.calls[0].url).toBe('http://127.0.0.1:4555/releases/latest.json')
  })

  it('maps 404 to no release yet, not an error', async () => {
    const f = fakeFetch(() => new Response('nope', { status: 404 }))
    expect(await fetchManifest(UPDATE_SITE, f.impl)).toBeNull()
  })

  it('maps other statuses to a fixed http message', async () => {
    const f = fakeFetch(() => new Response('{}', { status: 500 }))
    const err = await fetchManifest(UPDATE_SITE, f.impl).catch((e) => e)
    expect(err).toBeInstanceOf(SiteError)
    expect(err).toMatchObject({ kind: 'http', status: 500 })
    expect(err.message).toBe('The update site answered 500')
  })

  it('maps a thrown fetch to network without its own text', async () => {
    const f = fakeFetch(() => {
      throw new Error('connect failed for secret-host')
    })
    const err = await fetchManifest(UPDATE_SITE, f.impl).catch((e) => e)
    expect(err).toMatchObject({ kind: 'network' })
    expect(err.message).toBe('Could not reach the update site')
  })

  it('maps a malformed body to unusable', async () => {
    const cases = [
      new Response('not json', { status: 200 }),
      Response.json(null),
      Response.json([]),
      Response.json({ ...manifest, sha256: 'xyz' }),
      Response.json({ ...manifest, sha256: manifest.sha256.toUpperCase() }),
      Response.json({ ...manifest, tarball: undefined })
    ]
    for (const body of cases) {
      const err = await fetchManifest(UPDATE_SITE, fakeFetch(() => body).impl).catch((e) => e)
      expect(err).toMatchObject({ kind: 'unusable' })
      expect(err.message).toBe('The site sent a release it cannot use')
    }
  })

  it('maps a timeout while reading the body to network', async () => {
    for (const name of ['TimeoutError', 'AbortError']) {
      const body = new ReadableStream<Uint8Array>({
        pull() {
          throw Object.assign(new Error('aborted'), { name })
        }
      })
      await expect(fetchManifest(UPDATE_SITE, fakeFetch(() => new Response(body)).impl)).rejects.toMatchObject({ kind: 'network' })
    }
  })

  it('refuses a manifest bigger than the cap, declared or streamed', async () => {
    const big = `{"notes":"${'x'.repeat(MAX_MANIFEST_BYTES)}"}`
    for (const res of [new Response(big), new Response('{}', { headers: { 'Content-Length': String(MAX_MANIFEST_BYTES + 1) } })]) {
      const err = await fetchManifest(UPDATE_SITE, fakeFetch(() => res).impl).catch((e) => e)
      expect(err).toMatchObject({ kind: 'tooBig' })
      expect(err.message).toBe('The update site sent more than an update can be')
    }
  })

  it('follows a redirect on the site itself, by hand', async () => {
    const f = fakeFetch((c) =>
      c.url.endsWith('/latest.json')
        ? new Response(null, { status: 302, headers: { Location: '/releases/latest.json?v=2' } })
        : Response.json(manifest)
    )
    expect(await fetchManifest(UPDATE_SITE, f.impl)).toMatchObject({ manifest })
    expect(f.calls.map((c) => c.url)).toEqual([`${UPDATE_SITE}/releases/latest.json`, `${UPDATE_SITE}/releases/latest.json?v=2`])
    expect(f.calls.every((c) => c.redirect === 'manual')).toBe(true)
  })

  it('refuses a redirect to another host, one with no Location, an opaque one, or a loop', async () => {
    const cases: (() => Response)[] = [
      () => new Response(null, { status: 301, headers: { Location: 'https://evil.example/releases/latest.json' } }),
      () => new Response(null, { status: 307, headers: { Location: 'http://zumibot.run/releases/latest.json' } }),
      () => new Response(null, { status: 302 }),
      () => ({ type: 'opaqueredirect', status: 0, ok: false, headers: new Headers(), body: null }) as unknown as Response,
      () => new Response(null, { status: 302, headers: { Location: '/releases/latest.json' } })
    ]
    for (const respond of cases) {
      const err = await fetchManifest(UPDATE_SITE, fakeFetch(respond).impl).catch((e) => e)
      expect(err).toMatchObject({ kind: 'redirect' })
      expect(err.message).toBe('The update site redirected to another site')
    }
  })

  it('refuses a tarball on another origin at check time', async () => {
    for (const tarball of [
      'https://evil.example/x.tar.gz',
      '//evil.example/x.tar.gz',
      'http://zumibot.run/x.tar.gz',
      'https://zumibot.run.evil.example/x.tar.gz'
    ]) {
      const f = fakeFetch(() => Response.json({ ...manifest, tarball }))
      const err = await fetchManifest(UPDATE_SITE, f.impl).catch((e) => e)
      expect(err).toMatchObject({ kind: 'otherSite' })
      expect(err.message).toBe('The update site pointed to a download on another site')
    }
  })

  it('refuses a site that is neither http nor https', async () => {
    await expect(fetchManifest('file:///etc', fakeFetch(() => Response.json(manifest)).impl)).rejects.toMatchObject({ kind: 'unusable' })
    await expect(fetchManifest('not a url', fakeFetch(() => Response.json(manifest)).impl)).rejects.toMatchObject({ kind: 'unusable' })
  })
})

describe('tarballUrl', () => {
  it('keeps a same-origin relative or absolute address', () => {
    expect(tarballUrl('https://s.example', '/a/b.tar.gz')).toBe('https://s.example/a/b.tar.gz')
    expect(tarballUrl('https://s.example', 'https://s.example/a/b.tar.gz')).toBe('https://s.example/a/b.tar.gz')
  })
  it('refuses another port, scheme or host', () => {
    for (const t of ['https://s.example:8443/a', 'http://s.example/a', 'https://t.example/a'])
      expect(() => tarballUrl('https://s.example', t)).toThrow(SiteError)
  })
})

describe('downloadFile', () => {
  const URL_ = 'https://zumibot.run/releases/0.1.2/zumibot-server.tar.gz'
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-site-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('streams the file to dest and leaves no temp file', async () => {
    const f = fakeFetch(() => new Response(Buffer.from('tarball-bytes')))
    const dest = join(dir, 'zumibot-server.tar.gz')
    await downloadFile(URL_, dest, f.impl)
    expect(f.calls[0].url).toBe(URL_)
    expect(f.calls[0].headers).toMatchObject({ 'User-Agent': 'ZumiBot' })
    expect(f.calls[0].headers).not.toHaveProperty('Authorization')
    expect(f.calls[0].signal).toBeInstanceOf(AbortSignal)
    expect(await fs.readFile(dest, 'utf8')).toBe('tarball-bytes')
    expect(await fs.readdir(dir)).toEqual(['zumibot-server.tar.gz'])
  })

  it('replaces an existing file only on success', async () => {
    const dest = join(dir, 'a.tar.gz')
    await fs.writeFile(dest, 'old')
    await expect(downloadFile(URL_, dest, fakeFetch(() => new Response('{}', { status: 500 })).impl)).rejects.toMatchObject({
      kind: 'http',
      status: 500
    })
    expect(await fs.readFile(dest, 'utf8')).toBe('old')
  })

  it.each([404, 502])('maps %i to http and leaves nothing behind', async (status) => {
    await expect(downloadFile(URL_, join(dir, 'a'), fakeFetch(() => new Response('nope', { status })).impl)).rejects.toMatchObject({
      kind: 'http',
      status
    })
    expect(await fs.readdir(dir)).toEqual([])
  })

  it('maps a thrown fetch to network', async () => {
    const f = fakeFetch(() => {
      throw new Error('down')
    })
    await expect(downloadFile(URL_, join(dir, 'a'), f.impl)).rejects.toMatchObject({ kind: 'network' })
    expect(await fs.readdir(dir)).toEqual([])
  })

  it('maps a body that fails mid-stream to network and removes the temp file', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('partial'))
      },
      pull() {
        throw new Error('reset')
      }
    })
    const dest = join(dir, 'a.tar.gz')
    await expect(downloadFile(URL_, dest, fakeFetch(() => new Response(body)).impl)).rejects.toMatchObject({ kind: 'network' })
    expect(await fs.readdir(dir)).toEqual([])
  })

  it('fails with network when the response has no body', async () => {
    await expect(downloadFile(URL_, join(dir, 'a'), fakeFetch(() => new Response(null, { status: 200 })).impl)).rejects.toMatchObject({
      kind: 'network'
    })
    expect(await fs.readdir(dir)).toEqual([])
  })

  it('refuses a download declared bigger than the cap before writing anything', async () => {
    const res = new Response('x', { headers: { 'Content-Length': String(MAX_DOWNLOAD_BYTES + 1) } })
    await expect(downloadFile(URL_, join(dir, 'a'), fakeFetch(() => res).impl)).rejects.toMatchObject({ kind: 'tooBig' })
    expect(await fs.readdir(dir)).toEqual([])
  })

  it('stops a body that streams past the cap and deletes the partial file', async () => {
    const chunk = new Uint8Array(16 * 1024 * 1024)
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        sent += chunk.byteLength
        c.enqueue(chunk)
      }
    })
    const err = await downloadFile(URL_, join(dir, 'a'), fakeFetch(() => new Response(body)).impl).catch((e) => e)
    expect(err).toMatchObject({ kind: 'tooBig' })
    expect(sent).toBeLessThan(MAX_DOWNLOAD_BYTES + 4 * chunk.byteLength)
    expect(await fs.readdir(dir)).toEqual([])
  })

  it('does not follow a download redirect to another host', async () => {
    const f = fakeFetch(() => new Response(null, { status: 302, headers: { Location: 'https://cdn.evil.example/x.tar.gz' } }))
    await expect(downloadFile(URL_, join(dir, 'a'), f.impl)).rejects.toMatchObject({ kind: 'redirect' })
    expect(f.calls).toHaveLength(1)
    expect(await fs.readdir(dir)).toEqual([])
  })

  it('reports a local disk error as a plain Error, not a site one', async () => {
    const f = fakeFetch(() => new Response(Buffer.from('bytes')))
    const err = await downloadFile(URL_, join(dir, 'missing', 'a.tar.gz'), f.impl).catch((e) => e)
    expect(err).not.toBeInstanceOf(SiteError)
    expect(err.message).toBe('Could not save the update download')
    expect(await fs.readdir(dir)).toEqual([])
  })

  it('reports a failed rename as a local disk error', async () => {
    const dest = join(dir, 'taken')
    await fs.mkdir(dest)
    await fs.writeFile(join(dest, 'keep'), '')
    const err = await downloadFile(URL_, dest, fakeFetch(() => new Response(Buffer.from('bytes'))).impl).catch((e) => e)
    expect(err).not.toBeInstanceOf(SiteError)
    expect(err.message).toBe('Could not save the update download')
    expect(await fs.readdir(dir)).toEqual(['taken'])
  })
})
