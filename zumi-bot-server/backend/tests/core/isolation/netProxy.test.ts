import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LookupAddress } from 'node:dns'
import http from 'node:http'
import net from 'node:net'
import { createNetProxy } from '../../../src/core/isolation/netProxy'

// A DNS answer without the network: tests never hit real DNS.
const answer =
  (map: Record<string, string[]>) =>
  async (h: string): Promise<LookupAddress[]> =>
    (map[h] ?? []).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))

let target: net.Server
let targetPort: number
let proxy: http.Server
let proxyPort: number
let denied: string[]
let dialed: string[]

const start = async (network: string[], map: Record<string, string[]>) => {
  proxy = createNetProxy({
    network,
    denied: (t) => denied.push(t),
    lookup: answer(map),
    // Every allowed connection lands on the test server; what it was asked to dial is what the test checks.
    connect: (port, address) => {
      dialed.push(`${address}:${port}`)
      return net.connect(targetPort, '127.0.0.1')
    }
  })
  await new Promise<void>((ok) => proxy.listen(0, '127.0.0.1', () => ok()))
  proxyPort = (proxy.address() as net.AddressInfo).port
}

beforeEach(async () => {
  denied = []
  dialed = []
  target = net.createServer((c) => c.end('HELLO'))
  await new Promise<void>((ok) => target.listen(0, '127.0.0.1', () => ok()))
  targetPort = (target.address() as net.AddressInfo).port
})
afterEach(async () => {
  await new Promise((ok) => proxy.close(ok))
  await new Promise((ok) => target.close(ok))
})

const connect = (to: string) =>
  new Promise<string>((ok) => {
    const c = net.connect(proxyPort, '127.0.0.1')
    let b = ''
    c.on('data', (d) => (b += d))
    c.on('close', () => ok(b))
    c.on('error', () => ok(b))
    c.write(`CONNECT ${to} HTTP/1.1\r\nHost: ${to}\r\n\r\n`)
  })
const get = (url: string) =>
  new Promise<number>((ok) => {
    const r = http.request({ host: '127.0.0.1', port: proxyPort, path: url, method: 'GET' }, (res) => {
      res.resume()
      ok(res.statusCode ?? 0)
    })
    r.on('error', () => ok(0))
    r.end()
  })

describe('network proxy address guard', () => {
  it('dials the checked public address, not the name', async () => {
    await start(['*.example.com'], { 'api.example.com': ['93.184.216.34'] })
    expect(await connect('api.example.com:443')).toContain('200 Connection Established')
    expect(dialed).toEqual(['93.184.216.34:443'])
    expect(denied).toEqual([])
  })

  it('refuses and reports a listed name that resolves to loopback, private, link-local or a mixed answer', async () => {
    await start(['*.example.com'], {
      'lo.example.com': ['127.0.0.1'],
      'lan.example.com': ['10.0.0.7'],
      'meta.example.com': ['169.254.169.254'],
      'mixed.example.com': ['93.184.216.34', '192.168.1.1'],
      'v6.example.com': ['::ffff:127.0.0.1']
    })
    for (const h of ['lo', 'lan', 'meta', 'mixed', 'v6']) expect(await connect(`${h}.example.com:443`)).toContain('403')
    expect(await get('http://lo.example.com/x')).toBe(403)
    expect(dialed).toEqual([])
    expect(denied).toEqual([
      'lo.example.com:443',
      'lan.example.com:443',
      'meta.example.com:443',
      'mixed.example.com:443',
      'v6.example.com:443',
      'lo.example.com:80'
    ])
  })

  it('a name that does not resolve is a bad gateway, not a refusal', async () => {
    await start(['*.example.com'], {})
    expect(await connect('gone.example.com:443')).toContain('502')
    expect(await get('http://gone.example.com/x')).toBe(502)
    expect(denied).toEqual([])
  })

  it('keeps an explicit localhost or 127.0.0.1 entry, and only to loopback', async () => {
    await start(['localhost', '127.0.0.1'], { localhost: ['127.0.0.1', '::1'] })
    expect(await connect('localhost:443')).toContain('200 Connection Established')
    expect(await connect('127.0.0.1:443')).toContain('200 Connection Established')
    expect(dialed).toEqual(['127.0.0.1:443', '127.0.0.1:443'])
    await new Promise((ok) => proxy.close(ok))
    await start(['localhost'], { localhost: ['10.0.0.1'] })
    expect(await connect('localhost:443')).toContain('403')
  })

  it('forwards plain HTTP to the checked address', async () => {
    const web = http.createServer((_req, res) => res.end('ok'))
    await new Promise<void>((ok) => web.listen(0, '127.0.0.1', () => ok()))
    targetPort = (web.address() as net.AddressInfo).port
    await start(['*.example.com'], { 'api.example.com': ['93.184.216.34'] })
    expect(await get('http://api.example.com/x')).toBe(200)
    expect(dialed).toEqual(['93.184.216.34:80'])
    await new Promise((ok) => web.close(ok))
  })
})
