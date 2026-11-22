import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { SECURITY_HEADERS } from '../../src/http/headers'
import { allowGate, startRig, type Rig } from './helpers'

let rig: Rig
afterEach(async () => {
  await rig?.close()
  rig = undefined as never
})

describe('SECURITY_HEADERS', () => {
  it('has the pinned values', () => {
    expect(SECURITY_HEADERS).toEqual({
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(self), geolocation=()'
    })
  })

  it('every response carries them', async () => {
    rig = await startRig()
    const urls = ['/', '/chat/x', '/assets/app-abc123.js', '/api/nope', '/api/attachments/staged/nope', '/../x']
    for (const u of urls) {
      const res = await fetch(rig.base + u)
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(res.headers.get(k), `${u} ${k}`).toBe(v)
    }
    const post = await fetch(`${rig.base}/api/attachments/stage`, { method: 'POST', body: 'x' })
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(post.headers.get(k), `post ${k}`).toBe(v)
  })

  it('also on responses the gate answers itself, and on denied ones', async () => {
    rig = await startRig({
      gate: { ...allowGate(false), handle: async (req, res) => (req.url === '/login' ? (res.end('login'), true) : false) }
    })
    for (const u of ['/login', '/api/x', '/']) {
      const res = await fetch(rig.base + u, { redirect: 'manual' })
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(res.headers.get(k), `${u} ${k}`).toBe(v)
    }
  })
})

describe('unauthorized requests', () => {
  it('unauthorized /api/x is 401 JSON, unauthorized / redirects to /login, unauthorized /ws is closed 4401', async () => {
    rig = await startRig({ gate: allowGate(false) })
    const api = await fetch(`${rig.base}/api/x`)
    expect(api.status).toBe(401)
    expect(api.headers.get('content-type')).toMatch(/^application\/json/)
    expect(await api.json()).toEqual({ error: 'Unauthorized' })

    const home = await fetch(`${rig.base}/`, { redirect: 'manual' })
    expect(home.status).toBe(302)
    expect(home.headers.get('location')).toBe('/login')

    const code = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${rig.port}/ws`)
      ws.once('close', (c) => resolve(c))
      ws.once('error', reject)
    })
    expect(code).toBe(4401)
  })

  it('attachments and upload need authorization too', async () => {
    rig = await startRig({ gate: allowGate(false) })
    expect((await fetch(`${rig.base}/api/attachments/staged/abc`)).status).toBe(401)
    expect((await fetch(`${rig.base}/api/attachments/staged/abc`, { method: 'HEAD' })).status).toBe(401)
    expect((await fetch(`${rig.base}/api/attachments/stage`, { method: 'POST', headers: { 'X-File-Name': 'a' }, body: 'x' })).status).toBe(
      401
    )
  })

  it('authorized but bad origin closes /ws with 4401', async () => {
    rig = await startRig({ gate: { authorize: async () => true, originOk: async () => false, handle: async () => false } })
    const code = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${rig.port}/ws`)
      ws.once('close', (c) => resolve(c))
      ws.once('error', () => {})
    })
    expect(code).toBe(4401)
  })

  it('gate.handle routes are served without authorization', async () => {
    rig = await startRig({
      gate: { ...allowGate(false), handle: async (req, res) => (req.url === '/login' ? (res.end('login'), true) : false) }
    })
    expect(await (await fetch(`${rig.base}/login`)).text()).toBe('login')
  })

  it('a non-GET to a static path is 405', async () => {
    rig = await startRig()
    expect((await fetch(`${rig.base}/chat/x`, { method: 'DELETE' })).status).toBe(405)
  })
})
