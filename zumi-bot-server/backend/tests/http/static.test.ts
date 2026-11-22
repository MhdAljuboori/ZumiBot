import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { join } from 'node:path'
import { allowGate, startRig, type Rig } from './helpers'

let rig: Rig
beforeEach(async () => {
  rig = await startRig()
})
afterEach(() => rig.close())

// fetch normalises ../ away, so traversal needs a raw request line.
const raw = (path: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: rig.port, path, method: 'GET' }, (res) => {
      res.resume()
      resolve(res.statusCode!)
    })
    req.on('error', reject)
    req.end()
  })

describe('static files', () => {
  it('serves index.html for /chat/xyz', async () => {
    const res = await fetch(`${rig.base}/chat/xyz`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/html/)
    expect(await res.text()).toBe('<html>app</html>')
  })

  it('rejects ../ traversal with 404', async () => {
    expect(await raw('/../secret.txt')).toBe(404)
    expect(await raw('/assets/../../secret.txt')).toBe(404)
    expect(await raw('/%2e%2e/secret.txt')).toBe(404)
    expect(await raw('/..%2fsecret.txt')).toBe(404)
    expect(await raw('/%00')).toBe(404)
    expect(await raw('/..\\secret.txt')).toBe(404)
    expect(await raw('/assets/..%5c..%5csecret.txt')).toBe(404)
  })

  it('serves the app icons without a session, and nothing else', async () => {
    await rig.close()
    rig = await startRig({ gate: allowGate(false) })
    for (const name of ['icon-192.png', 'icon-512.png', 'badge-96.png']) await writeFile(join(rig.webDir, name), 'png')
    await writeFile(join(rig.webDir, 'manifest.webmanifest'), '{}')
    for (const name of ['icon-192.png', 'icon-512.png', 'badge-96.png']) {
      const res = await fetch(`${rig.base}/${name}`, { redirect: 'manual' })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('image/png')
    }
    for (const path of ['/manifest.webmanifest', '/index.html', '/assets/app-abc123.js', '/favicon.png']) {
      const res = await fetch(`${rig.base}${path}`, { redirect: 'manual' })
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('/login')
    }
  })

  it('a public icon that is missing is 404, never the app page', async () => {
    await rig.close()
    rig = await startRig({ gate: allowGate(false) })
    const res = await fetch(`${rig.base}/icon-512.png`, { redirect: 'manual' })
    expect(res.status).toBe(404)
  })

  it('serves a web manifest as application/manifest+json', async () => {
    await writeFile(join(rig.webDir, 'manifest.webmanifest'), '{"name":"ZumiBot"}')
    const res = await fetch(`${rig.base}/manifest.webmanifest`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/manifest+json')
  })

  it('hashed /assets/* get Cache-Control: public, max-age=31536000, immutable; index.html gets no-cache', async () => {
    const a = await fetch(`${rig.base}/assets/app-abc123.js`)
    expect(a.status).toBe(200)
    expect(a.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(a.headers.get('content-type')).toMatch(/javascript/)
    const i = await fetch(`${rig.base}/index.html`)
    expect(i.headers.get('cache-control')).toBe('no-cache')
    const fallback = await fetch(`${rig.base}/chat/xyz`)
    expect(fallback.headers.get('cache-control')).toBe('no-cache')
  })

  it('a missing asset is 404, not the index', async () => {
    expect((await fetch(`${rig.base}/assets/missing.js`)).status).toBe(404)
  })
})
